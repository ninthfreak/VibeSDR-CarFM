// mDNS hostname responder — makes the server reachable as "vibesdr.local".
//
// WHY THIS EXISTS AT ALL
//
// We already advertise a SERVICE (_vibesdr._tcp) through Android's NsdManager, and that
// is what makes the phone appear in the app's Discovered list. But a browser typing
// "vibesdr.local" is not looking for a service — it is resolving a HOSTNAME, which needs
// an A record. NsdManager cannot publish one: it registers services, not hosts. So the
// only way to answer that query is to speak mDNS ourselves.
//
// WHAT IT DOES
//
// Joins 224.0.0.251:5353, and answers QTYPE=A (and ANY) questions for our own name with
// our IPv4 address. Nothing more — this is not a general mDNS stack and does not try to
// be one. It does not browse, it does not cache, it does not serve PTR/SRV/TXT (the
// NsdManager registration already covers those).
//
// NAME COLLISIONS (RFC 6762 §8)
//
// Two phones both called "vibesdr" would otherwise both answer the same query, and the
// resolver would get whichever reply arrived first — a coin toss. So on start-up we
// PROBE: ask the network whether anyone already answers for our name, three times,
// 250 ms apart. If anybody does, we take the next name (vibesdr-2, vibesdr-3, …) and
// probe again. This is the standard mechanism and it is why the second phone on the
// network names itself without being told to.

#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <string>
#include <thread>
#include <vector>

#include <android/log.h>
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, "VibeMdns", __VA_ARGS__)

namespace vibe {
namespace {

constexpr const char* kGroup = "224.0.0.251";
constexpr uint16_t    kPort  = 5353;
constexpr int         kTtl   = 120;      // seconds; RFC 6762 recommends 120 for A records

std::thread            g_thread;
std::atomic<bool>      g_run{false};
std::string            g_host;           // "vibesdr" — WITHOUT the .local
uint32_t               g_addr = 0;       // our IPv4, network byte order
std::atomic<bool>      g_conflict{false};

/** Encode "vibesdr.local" as DNS labels: \7vibesdr\5local\0 */
std::string encodeName(const std::string& host) {
    std::string out;
    out += (char)host.size();
    out += host;
    out += (char)5;
    out += "local";
    out += '\0';
    return out;
}

/** Case-insensitive compare of a DNS-encoded name in `buf` at `pos` against ours.
 *  Returns the length consumed, or 0 if it doesn't match. Compression pointers are
 *  not followed: a QUESTION never uses them. */
size_t matchName(const uint8_t* buf, size_t len, size_t pos, const std::string& want) {
    size_t i = pos, w = 0;
    while (i < len) {
        uint8_t l = buf[i];
        if (l == 0) {
            return (w == want.size() - 1) ? (i + 1 - pos) : 0;   // want ends with the \0
        }
        if ((l & 0xC0) != 0) return 0;                            // pointer — not expected
        if (i + 1 + l > len) return 0;
        if (w >= want.size() || (uint8_t)want[w] != l) return 0;
        for (uint8_t k = 0; k < l; ++k) {
            char a = (char)buf[i + 1 + k];
            char b = want[w + 1 + k];
            if (a >= 'A' && a <= 'Z') a += 32;                    // mDNS names are case-insensitive
            if (b >= 'A' && b <= 'Z') b += 32;
            if (a != b) return 0;
        }
        w += 1 + l;
        i += 1 + l;
    }
    return 0;
}

/** Build an mDNS response carrying one A record for our name. */
std::string buildAnswer(const std::string& host, uint32_t addr, uint16_t txid) {
    const std::string name = encodeName(host);
    std::string p;
    auto u16 = [&](uint16_t v) { p += (char)(v >> 8); p += (char)(v & 0xFF); };
    auto u32 = [&](uint32_t v) {
        p += (char)(v >> 24); p += (char)((v >> 16) & 0xFF);
        p += (char)((v >> 8) & 0xFF); p += (char)(v & 0xFF);
    };
    u16(txid);
    u16(0x8400);        // response, authoritative
    u16(0);             // questions
    u16(1);             // answers
    u16(0);             // authority
    u16(0);             // additional
    p += name;
    u16(1);             // TYPE A
    u16(0x8001);        // CLASS IN, cache-flush bit — we are authoritative for this name
    u32(kTtl);
    u16(4);
    p.append((const char*)&addr, 4);     // already network byte order
    return p;
}

/**
 * A NEGATIVE answer: "this name exists, and the only record type it has is A".
 *
 * Without this, an AAAA (IPv6) query for our name goes UNANSWERED — and a resolver asks
 * for A and AAAA together, then WAITS for the missing reply to time out before using the
 * IPv4 address it already had. That wait is why connecting by .local felt markedly
 * slower than connecting by IP. Silence is not "no"; NSEC is how mDNS says "no".
 *
 * RDATA = <next domain name> <window 0> <bitmap length 1> <bitmap>, and the bitmap's
 * high bit of byte 0 is type 1 (A) — so 0x40.
 */
std::string buildNsec(const std::string& host, uint16_t txid) {
    const std::string name = encodeName(host);
    std::string p;
    auto u16 = [&](uint16_t v) { p += (char)(v >> 8); p += (char)(v & 0xFF); };
    auto u32 = [&](uint32_t v) {
        p += (char)(v >> 24); p += (char)((v >> 16) & 0xFF);
        p += (char)((v >> 8) & 0xFF); p += (char)(v & 0xFF);
    };
    u16(txid);
    u16(0x8400);            // response, authoritative
    u16(0); u16(1); u16(0); u16(0);
    p += name;
    u16(47);                // TYPE NSEC
    u16(0x8001);            // CLASS IN + cache-flush
    u32(kTtl);
    std::string rdata = name;      // "next name" is our own, as mDNS does
    rdata += (char)0x00;           // window 0
    rdata += (char)0x01;           // bitmap length
    rdata += (char)0x40;           // bit for type 1 (A) only — no AAAA
    u16((uint16_t)rdata.size());
    p += rdata;
    return p;
}

/** Ask whether anyone else already answers for `host`. */
std::string buildProbe(const std::string& host) {
    const std::string name = encodeName(host);
    std::string p;
    auto u16 = [&](uint16_t v) { p += (char)(v >> 8); p += (char)(v & 0xFF); };
    u16(0);
    u16(0);             // standard query
    u16(1);             // one question
    u16(0); u16(0); u16(0);
    p += name;
    u16(255);           // QTYPE ANY — "does ANYTHING exist under this name?"
    u16(1);             // CLASS IN
    return p;
}

int openSocket() {
    int fd = socket(AF_INET, SOCK_DGRAM, 0);
    if (fd < 0) return -1;

    int on = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &on, sizeof on);
#ifdef SO_REUSEPORT
    // Essential: the system's own mDNS daemon is already bound to 5353. Without this we
    // simply fail to bind and never see a single query.
    setsockopt(fd, SOL_SOCKET, SO_REUSEPORT, &on, sizeof on);
#endif

    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_addr.s_addr = htonl(INADDR_ANY);
    a.sin_port = htons(kPort);
    if (bind(fd, (sockaddr*)&a, sizeof a) < 0) {
        LOGI("mDNS bind failed: %s", strerror(errno));
        close(fd);
        return -1;
    }

    ip_mreq mreq{};
    mreq.imr_multiaddr.s_addr = inet_addr(kGroup);
    mreq.imr_interface.s_addr = htonl(INADDR_ANY);
    if (setsockopt(fd, IPPROTO_IP, IP_ADD_MEMBERSHIP, &mreq, sizeof mreq) < 0) {
        LOGI("mDNS join failed: %s (is the MulticastLock held?)", strerror(errno));
    }
    unsigned char ttl = 255;                      // RFC 6762: mDNS uses TTL 255
    setsockopt(fd, IPPROTO_IP, IP_MULTICAST_TTL, &ttl, sizeof ttl);
    unsigned char loop = 1;
    setsockopt(fd, IPPROTO_IP, IP_MULTICAST_LOOP, &loop, sizeof loop);
    return fd;
}

void sendTo(int fd, const std::string& pkt, const sockaddr_in& dst) {
    sendto(fd, pkt.data(), pkt.size(), 0, (const sockaddr*)&dst, sizeof dst);
}

void loop(std::string base, uint32_t addr) {
    int fd = openSocket();
    if (fd < 0) return;

    sockaddr_in group{};
    group.sin_family = AF_INET;
    group.sin_addr.s_addr = inet_addr(kGroup);
    group.sin_port = htons(kPort);

    // ── Probe, then rename on conflict (RFC 6762 §8) ─────────────────────────
    // This is what makes a SECOND phone on the network call itself vibesdr-2 without
    // anybody configuring it.
    std::string host = base;
    for (int attempt = 1; attempt <= 9 && g_run.load(); ++attempt) {
        g_conflict.store(false);
        const std::string probe = buildProbe(host);
        std::string want = encodeName(host);

        for (int i = 0; i < 3 && g_run.load(); ++i) {
            sendTo(fd, probe, group);
            // Listen 250ms for somebody answering for this name.
            for (int t = 0; t < 25 && g_run.load(); ++t) {
                timeval tv{0, 10000};
                fd_set rd;
                FD_ZERO(&rd);
                FD_SET(fd, &rd);
                if (select(fd + 1, &rd, nullptr, nullptr, &tv) <= 0) continue;
                uint8_t buf[1500];
                sockaddr_in from{};
                socklen_t fl = sizeof from;
                ssize_t n = recvfrom(fd, buf, sizeof buf, 0, (sockaddr*)&from, &fl);
                if (n < 12) continue;
                // A RESPONSE (QR bit) whose answer name is ours = somebody else owns it.
                if ((buf[2] & 0x80) && from.sin_addr.s_addr != addr) {
                    size_t off = 12;
                    uint16_t qd = (buf[4] << 8) | buf[5];
                    for (uint16_t q = 0; q < qd && off < (size_t)n; ++q) {
                        while (off < (size_t)n && buf[off]) off += 1 + buf[off];
                        off += 5;
                    }
                    if (off < (size_t)n && matchName(buf, n, off, want)) {
                        g_conflict.store(true);
                    }
                }
            }
            if (g_conflict.load()) break;
        }
        if (!g_conflict.load()) break;                 // the name is ours
        host = base + "-" + std::to_string(attempt + 1);
        LOGI("mDNS name taken, trying %s.local", host.c_str());
    }
    if (!g_run.load()) { close(fd); return; }

    g_host = host;
    LOGI("mDNS responder up: %s.local -> %s", host.c_str(),
         inet_ntoa(*(in_addr*)&addr));

    // Announce ourselves twice, a second apart, so resolvers learn the name without
    // having to ask (RFC 6762 §8.3).
    const std::string want = encodeName(host);
    for (int i = 0; i < 2 && g_run.load(); ++i) {
        sendTo(fd, buildAnswer(host, addr, 0), group);
        std::this_thread::sleep_for(std::chrono::seconds(1));
    }

    // ── Serve ────────────────────────────────────────────────────────────────
    while (g_run.load()) {
        timeval tv{1, 0};
        fd_set rd;
        FD_ZERO(&rd);
        FD_SET(fd, &rd);
        if (select(fd + 1, &rd, nullptr, nullptr, &tv) <= 0) continue;

        uint8_t buf[1500];
        sockaddr_in from{};
        socklen_t fl = sizeof from;
        ssize_t n = recvfrom(fd, buf, sizeof buf, 0, (sockaddr*)&from, &fl);
        if (n < 12) continue;
        if (buf[2] & 0x80) continue;                   // a response, not a question

        uint16_t qd = (buf[4] << 8) | buf[5];
        size_t off = 12;
        for (uint16_t q = 0; q < qd && off + 4 < (size_t)n; ++q) {
            size_t used = matchName(buf, n, off, want);
            // Skip this question's name however it turned out.
            size_t skip = off;
            while (skip < (size_t)n && buf[skip]) skip += 1 + buf[skip];
            skip += 1;
            if (skip + 4 > (size_t)n) break;
            uint16_t qtype = (buf[skip] << 8) | buf[skip + 1];
            const bool unicast = (buf[skip + 2] & 0x80) != 0;   // QU bit
            off = skip + 4;

            if (!used) continue;

            std::string ans;
            if (qtype == 1 || qtype == 255) {
                ans = buildAnswer(host, addr, 0);          // A
            } else if (qtype == 28) {
                // AAAA — we have none. ANSWER anyway, with NSEC: leaving it unanswered
                // makes the resolver wait out a timeout before using the A record it
                // already holds, which is exactly what made .local feel slow.
                ans = buildNsec(host, 0);
            } else {
                continue;
            }
            // Honour the QU bit: a resolver that asked for a unicast reply gets one.
            if (unicast) { from.sin_port = htons(kPort); sendTo(fd, ans, from); }
            else         sendTo(fd, ans, group);
        }
    }
    close(fd);
}

}  // namespace

/** Start answering for "<host>.local" with `ipv4` (dotted string). Idempotent. */
void mdnsStart(const std::string& host, const std::string& ipv4) {
    if (g_run.load()) return;
    if (host.empty() || ipv4.empty()) return;
    uint32_t addr = inet_addr(ipv4.c_str());
    if (addr == INADDR_NONE) return;
    g_addr = addr;
    g_run.store(true);
    g_thread = std::thread(loop, host, addr);
}

void mdnsStop() {
    if (!g_run.load()) return;
    g_run.store(false);
    if (g_thread.joinable()) g_thread.join();
    g_host.clear();
}

/** The name we actually took — may differ from the one asked for, if it was taken. */
std::string mdnsHost() { return g_host; }

}  // namespace vibe
