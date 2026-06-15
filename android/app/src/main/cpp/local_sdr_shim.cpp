// VibeSDR V4 — local-SDR shim (Stage 3) implementation.
//
// Pipeline: RTL-SDR (USB fd) → librtlsdr async IQ → dsp::stream → SDR++ Brown
// IQFrontEnd (decim/window/FFT) → dB row → UberSDR SPEC frames (full uint8) over
// a minimal localhost WebSocket server. The VibeSDR client connects to
// ws://127.0.0.1:<port>/ws/user-spectrum exactly as to a remote UberSDR.
//
// Scope notes (Stage 3): spectrum only (audio is Stage 4). Single client at a
// time. zoom retunes centre (span/decimation zoom deferred); set_rate throttles;
// ping/pong + reset handled. Control + config travel as TEXT frames; SPEC as
// BINARY frames. The client expects raw FFT order (DC at bin 0) — no fftshift.

#include "local_sdr_shim.h"

#include <android/log.h>
#include <rtl-sdr.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "signal_path/iq_frontend.h"
#include "utils/net.h"

#define LOG_TAG "VibeLocalSDR"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace vibe {

// ── SHA1 (for the WebSocket handshake accept key) ───────────────────────────
namespace {
struct Sha1 {
    uint32_t h[5] = {0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0};
    static uint32_t rol(uint32_t v, int b) { return (v << b) | (v >> (32 - b)); }
    void hash(const uint8_t* msg, size_t len, uint8_t out[20]) {
        std::vector<uint8_t> data(msg, msg + len);
        uint64_t ml = (uint64_t)len * 8;
        data.push_back(0x80);
        while (data.size() % 64 != 56) data.push_back(0x00);
        for (int i = 7; i >= 0; i--) data.push_back((uint8_t)(ml >> (i * 8)));
        for (size_t off = 0; off < data.size(); off += 64) {
            uint32_t w[80];
            for (int i = 0; i < 16; i++)
                w[i] = (data[off + i*4] << 24) | (data[off + i*4 + 1] << 16) |
                       (data[off + i*4 + 2] << 8) | data[off + i*4 + 3];
            for (int i = 16; i < 80; i++) w[i] = rol(w[i-3] ^ w[i-8] ^ w[i-14] ^ w[i-16], 1);
            uint32_t a=h[0],b=h[1],c=h[2],d=h[3],e=h[4];
            for (int i = 0; i < 80; i++) {
                uint32_t f, k;
                if (i < 20)      { f = (b & c) | (~b & d);            k = 0x5A827999; }
                else if (i < 40) { f = b ^ c ^ d;                     k = 0x6ED9EBA1; }
                else if (i < 60) { f = (b & c) | (b & d) | (c & d);   k = 0x8F1BBCDC; }
                else             { f = b ^ c ^ d;                     k = 0xCA62C1D6; }
                uint32_t t = rol(a,5) + f + e + k + w[i];
                e=d; d=c; c=rol(b,30); b=a; a=t;
            }
            h[0]+=a; h[1]+=b; h[2]+=c; h[3]+=d; h[4]+=e;
        }
        for (int i = 0; i < 5; i++) {
            out[i*4]   = (uint8_t)(h[i] >> 24); out[i*4+1] = (uint8_t)(h[i] >> 16);
            out[i*4+2] = (uint8_t)(h[i] >> 8);  out[i*4+3] = (uint8_t)(h[i]);
        }
    }
};

std::string base64(const uint8_t* in, size_t len) {
    static const char* t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    for (size_t i = 0; i < len; i += 3) {
        uint32_t n = in[i] << 16;
        if (i + 1 < len) n |= in[i+1] << 8;
        if (i + 2 < len) n |= in[i+2];
        out.push_back(t[(n >> 18) & 63]);
        out.push_back(t[(n >> 12) & 63]);
        out.push_back(i + 1 < len ? t[(n >> 6) & 63] : '=');
        out.push_back(i + 2 < len ? t[n & 63] : '=');
    }
    return out;
}

// Minimal JSON field scanners for the tiny control messages.
std::string jsonStr(const std::string& s, const char* key) {
    std::string pat = std::string("\"") + key + "\"";
    auto p = s.find(pat);
    if (p == std::string::npos) return "";
    p = s.find(':', p); if (p == std::string::npos) return "";
    p = s.find('"', p); if (p == std::string::npos) return "";
    auto q = s.find('"', p + 1); if (q == std::string::npos) return "";
    return s.substr(p + 1, q - p - 1);
}
bool jsonNum(const std::string& s, const char* key, double& out) {
    std::string pat = std::string("\"") + key + "\"";
    auto p = s.find(pat);
    if (p == std::string::npos) return false;
    p = s.find(':', p); if (p == std::string::npos) return false;
    out = strtod(s.c_str() + p + 1, nullptr);
    return true;
}
} // namespace

// ── Impl ────────────────────────────────────────────────────────────────────
struct LocalSdrShim::Impl {
    // device / params
    rtlsdr_dev_t* dev = nullptr;
    double sampleRate = 2400000.0;
    int    fftSize    = 1024;
    double fftRate    = 20.0;
    std::atomic<double> tunedFreq{100000000.0};
    std::atomic<int>    rateDivisor{1};

    // IQ + FFT
    dsp::stream<dsp::complex_t> iqStream;
    IQFrontEnd frontend;
    std::vector<float> fftBuf;
    std::thread rtlThread;
    std::atomic<bool> rtlRunning{false};

    // server
    std::shared_ptr<net::Listener> listener;
    std::thread serverThread;
    std::atomic<bool> serverRunning{false};
    int port = 0;

    // active spectrum client
    std::mutex clientMtx;
    std::shared_ptr<net::Socket> client;  // current WS client (nullptr if none)
    std::atomic<uint64_t> frameCounter{0};

    // FFT callback ----------------------------------------------------------
    static float* acquire(void* ctx) { return ((Impl*)ctx)->fftBuf.data(); }
    static void release(void* ctx) { ((Impl*)ctx)->onFFT(); }

    void onFFT() {
        // Rate throttle (set_rate divisor)
        uint64_t n = frameCounter.fetch_add(1);
        int div = rateDivisor.load();
        if (div > 1 && (n % (uint64_t)div) != 0) return;

        std::shared_ptr<net::Socket> sock;
        { std::lock_guard<std::mutex> lk(clientMtx); sock = client; }
        if (!sock || !sock->isOpen()) return;

        const int bins = fftSize;
        std::vector<uint8_t> frame(22 + bins);
        // header
        frame[0]='S'; frame[1]='P'; frame[2]='E'; frame[3]='C';
        frame[4]=0x01;       // version
        frame[5]=0x03;       // flags: full uint8
        uint64_t ts = (uint64_t)std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
        std::memcpy(&frame[6], &ts, 8);
        uint64_t f = (uint64_t)llround(tunedFreq.load());
        std::memcpy(&frame[14], &f, 8);
        // body: dBFS = u8 - 256  →  u8 = clamp(dB + 256, 0, 255). Raw FFT order.
        for (int i = 0; i < bins; i++) {
            double d = fftBuf[i] + 256.0;
            int v = (int)lround(d);
            if (v < 0) v = 0; else if (v > 255) v = 255;
            frame[22 + i] = (uint8_t)v;
        }
        sendWs(sock, 0x2, frame.data(), frame.size());
    }

    // WebSocket framing -----------------------------------------------------
    std::mutex sendMtx;
    void sendWs(const std::shared_ptr<net::Socket>& sock, uint8_t opcode,
                const uint8_t* payload, size_t len) {
        std::vector<uint8_t> hdr;
        hdr.push_back(0x80 | opcode); // FIN + opcode
        if (len < 126) {
            hdr.push_back((uint8_t)len);
        } else if (len < 65536) {
            hdr.push_back(126);
            hdr.push_back((uint8_t)(len >> 8)); hdr.push_back((uint8_t)len);
        } else {
            hdr.push_back(127);
            for (int i = 7; i >= 0; i--) hdr.push_back((uint8_t)(len >> (i*8)));
        }
        std::lock_guard<std::mutex> lk(sendMtx);
        if (!sock->isOpen()) return;
        sock->send(hdr.data(), hdr.size());
        if (len) sock->send(payload, len);
    }
    void sendText(const std::shared_ptr<net::Socket>& sock, const std::string& s) {
        sendWs(sock, 0x1, (const uint8_t*)s.data(), s.size());
    }

    void sendConfig(const std::shared_ptr<net::Socket>& sock) {
        double binBw = sampleRate / (double)fftSize;
        char buf[256];
        snprintf(buf, sizeof buf,
            "{\"type\":\"config\",\"centerFreq\":%lld,\"binCount\":%d,"
            "\"binBandwidth\":%.6f,\"totalBandwidth\":%.1f}",
            (long long)llround(tunedFreq.load()), fftSize, binBw, sampleRate);
        sendText(sock, buf);
    }

    // recv exactly n bytes (blocking). false on close/error.
    static bool recvN(const std::shared_ptr<net::Socket>& s, uint8_t* buf, size_t n) {
        size_t got = 0;
        while (got < n) {
            int r = s->recv(buf + got, n - got, true, net::NO_TIMEOUT);
            if (r <= 0) return false;
            got += (size_t)r;
        }
        return true;
    }

    // Read one client→server frame (always masked). Returns opcode, fills out.
    // Returns -1 on close/error.
    int recvWs(const std::shared_ptr<net::Socket>& s, std::string& out) {
        uint8_t h[2];
        if (!recvN(s, h, 2)) return -1;
        int opcode = h[0] & 0x0F;
        bool masked = h[1] & 0x80;
        uint64_t len = h[1] & 0x7F;
        if (len == 126) { uint8_t e[2]; if (!recvN(s,e,2)) return -1; len=(e[0]<<8)|e[1]; }
        else if (len == 127) { uint8_t e[8]; if (!recvN(s,e,8)) return -1; len=0; for(int i=0;i<8;i++) len=(len<<8)|e[i]; }
        uint8_t mask[4] = {0,0,0,0};
        if (masked && !recvN(s, mask, 4)) return -1;
        out.resize((size_t)len);
        if (len && !recvN(s, (uint8_t*)out.data(), (size_t)len)) return -1;
        if (masked) for (size_t i = 0; i < out.size(); i++) out[i] ^= mask[i & 3];
        return opcode;
    }

    void handleControl(const std::shared_ptr<net::Socket>& sock, const std::string& msg) {
        std::string type = jsonStr(msg, "type");
        if (type == "ping") {
            sendText(sock, "{\"type\":\"pong\"}");
        } else if (type == "zoom") {
            double freq;
            if (jsonNum(msg, "frequency", freq) && freq > 0) {
                tunedFreq.store(freq);
                if (dev) rtlsdr_set_center_freq(dev, (uint32_t)llround(freq));
            }
            sendConfig(sock);
        } else if (type == "set_rate") {
            double div;
            if (jsonNum(msg, "divisor", div)) rateDivisor.store(std::max(1, (int)llround(div)));
        } else if (type == "reset") {
            sendConfig(sock);
        }
    }

    // HTTP/WS accept + session loop ----------------------------------------
    void serverLoop() {
        while (serverRunning.load()) {
            std::shared_ptr<net::Socket> sock;
            try { sock = listener->accept(nullptr, 500); } catch (...) { sock = nullptr; }
            if (!sock) continue;

            // Read the HTTP request (request line + headers up to blank line).
            std::string line, reqLine, wsKey;
            if (sock->recvline(reqLine, 8192, 5000) <= 0) { sock->close(); continue; }
            while (sock->recvline(line, 8192, 5000) > 0) {
                if (line.empty() || line == "\r") break;
                // case-insensitive prefix match for Sec-WebSocket-Key
                if (line.size() > 19) {
                    std::string lk = line.substr(0, 18);
                    for (auto& c : lk) c = (char)tolower(c);
                    if (lk == "sec-websocket-key:") {
                        auto v = line.substr(18);
                        size_t a = v.find_first_not_of(" \t");
                        size_t b = v.find_last_not_of(" \t\r\n");
                        if (a != std::string::npos) wsKey = v.substr(a, b - a + 1);
                    }
                }
            }

            if (reqLine.find("/ws/user-spectrum") != std::string::npos && !wsKey.empty()) {
                acceptWs(sock, wsKey);
            } else if (reqLine.find("POST /connection") != std::string::npos ||
                       reqLine.find("/connection") != std::string::npos) {
                std::string body = "{\"allowed\":true}";
                std::string resp = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                    "Connection: close\r\nContent-Length: " + std::to_string(body.size()) +
                    "\r\n\r\n" + body;
                sock->sendstr(resp);
                sock->close();
            } else {
                std::string resp = "HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
                sock->sendstr(resp);
                sock->close();
            }
        }
    }

    void acceptWs(std::shared_ptr<net::Socket> sock, const std::string& wsKey) {
        std::string accept = wsKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
        uint8_t digest[20];
        Sha1().hash((const uint8_t*)accept.data(), accept.size(), digest);
        std::string acceptKey = base64(digest, 20);
        std::string resp =
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            "Sec-WebSocket-Accept: " + acceptKey + "\r\n\r\n";
        sock->sendstr(resp);

        { std::lock_guard<std::mutex> lk(clientMtx); client = sock; }
        sendConfig(sock);
        LOGI("spectrum WS client connected");

        // Reader loop: control frames until close. SPEC frames are pushed by
        // the FFT callback (onFFT) concurrently.
        while (serverRunning.load() && sock->isOpen()) {
            std::string payload;
            int op = recvWs(sock, payload);
            if (op < 0 || op == 0x8) break;             // error / close
            if (op == 0x9) { sendWs(sock, 0xA, (const uint8_t*)payload.data(), payload.size()); continue; } // ping→pong
            if (op == 0x1) handleControl(sock, payload); // text JSON
        }

        { std::lock_guard<std::mutex> lk(clientMtx); if (client == sock) client = nullptr; }
        sock->close();
        LOGI("spectrum WS client disconnected");
    }

    // RTL IQ worker ---------------------------------------------------------
    static void asyncHandler(unsigned char* buf, uint32_t len, void* ctx) {
        Impl* _this = (Impl*)ctx;
        int sampCount = (int)(len / 2);
        if (sampCount > STREAM_BUFFER_SIZE) sampCount = STREAM_BUFFER_SIZE;
        for (int i = 0; i < sampCount; i++) {
            _this->iqStream.writeBuf[i].re = ((float)buf[i*2]     - 127.4f) / 128.0f;
            _this->iqStream.writeBuf[i].im = ((float)buf[i*2 + 1] - 127.4f) / 128.0f;
        }
        _this->iqStream.swap(sampCount);
    }
};

// ── Public API ───────────────────────────────────────────────────────────────
LocalSdrShim& LocalSdrShim::instance() {
    static LocalSdrShim inst;
    return inst;
}

int LocalSdrShim::start(int fd, int vid, int pid,
                        double centerFreq, double sampleRate, int gainTenthDb,
                        int fftSize, double fftRate, std::string& err) {
    if (p) { err = "already running"; return -1; }
    auto* impl = new Impl();
    impl->sampleRate = sampleRate;
    impl->fftSize = fftSize;
    impl->fftRate = fftRate;
    impl->tunedFreq.store(centerFreq);
    impl->fftBuf.assign(fftSize, -256.0f);

    int ret = rtlsdr_open_sys_dev(&impl->dev, (intptr_t)fd);
    if (ret != 0 || !impl->dev) { err = "rtlsdr_open_sys_dev failed: " + std::to_string(ret); delete impl; return -1; }

    rtlsdr_set_sample_rate(impl->dev, (uint32_t)sampleRate);
    rtlsdr_set_center_freq(impl->dev, (uint32_t)llround(centerFreq));
    if (gainTenthDb < 0) {
        rtlsdr_set_tuner_gain_mode(impl->dev, 0); // auto
    } else {
        rtlsdr_set_tuner_gain_mode(impl->dev, 1);
        rtlsdr_set_tuner_gain(impl->dev, gainTenthDb);
    }
    rtlsdr_reset_buffer(impl->dev);

    // FFT front end: feed the IQ stream, NUTTALL window, no decimation/dc-block.
    impl->frontend.init(&impl->iqStream, sampleRate, true, 1, false, fftSize, fftRate,
                        IQFrontEnd::FFTWindow::NUTTALL,
                        &Impl::acquire, &Impl::release, impl);
    impl->frontend.start();

    // Spectrum server on a free localhost port.
    int chosen = -1;
    for (int port = 48000; port < 48050; port++) {
        try { impl->listener = net::listen("127.0.0.1", port); chosen = port; break; }
        catch (...) { impl->listener = nullptr; }
    }
    if (!impl->listener) {
        err = "could not bind localhost port";
        impl->frontend.stop(); rtlsdr_close(impl->dev); delete impl; return -1;
    }
    impl->port = chosen;
    impl->serverRunning.store(true);
    impl->serverThread = std::thread([impl]{ impl->serverLoop(); });

    // RTL async read worker.
    impl->rtlRunning.store(true);
    impl->rtlThread = std::thread([impl]{
        rtlsdr_read_async(impl->dev, &Impl::asyncHandler, impl, 0, 0);
        impl->rtlRunning.store(false);
    });

    p = impl;
    LOGI("local SDR started: center=%.0f rate=%.0f fft=%d port=%d", centerFreq, sampleRate, fftSize, chosen);
    return chosen;
}

void LocalSdrShim::stop() {
    if (!p) return;
    Impl* impl = p; p = nullptr;

    impl->serverRunning.store(false);
    { std::lock_guard<std::mutex> lk(impl->clientMtx); if (impl->client) impl->client->close(); }
    if (impl->listener) impl->listener->stop();
    if (impl->serverThread.joinable()) impl->serverThread.join();

    if (impl->dev) rtlsdr_cancel_async(impl->dev);
    if (impl->rtlThread.joinable()) impl->rtlThread.join();

    impl->frontend.stop();
    if (impl->dev) rtlsdr_close(impl->dev);
    delete impl;
    LOGI("local SDR stopped");
}

bool LocalSdrShim::isRunning() const { return p != nullptr; }

} // namespace vibe
