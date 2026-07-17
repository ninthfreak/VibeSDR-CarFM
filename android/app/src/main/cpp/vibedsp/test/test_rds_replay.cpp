// VibeSDR host test — RDS block-group REPLAY harness (tuner-backends addendum
// §8). A recorded log of block groups (one "A B C D okmask" hex line per
// group, as either backend would capture) is replayed via pushGroup() and the
// decoder's outputs are asserted deterministically. Also proves the hardware-
// RDS entry point (Si470x path) drives the identical PS/RT/RT+/flags pipeline
// as the bit-level SDR path. Usage: ./test [logfile]  (no arg = built-in log).
#include "../vibedsp.h"
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

using namespace vibedsp;

static int failures = 0;
static void check(bool ok, const char* what) {
    std::printf("  [%s] %s\n", ok ? "PASS" : "FAIL", what);
    if (!ok) ++failures;
}

struct Cap {
    uint16_t pi = 0; char ps[9] = {0}; char rt[65] = {0};
    char artist[65] = {0}; char title[65] = {0};
    bool tp = false, ta = false; int pty = -1;
};

// Built-in "recording": KBBB 101.1, PS "KBBB-FM ", RT names a song, RT+ (11A)
// tags it, TP=1 PTY=5. Format: A B C D okmask(bit0=A..bit3=D), hex.
static const char* BUILTIN_LOG =
    // 3A: RT+ ODA -> group 11A
    "4799 3016 0000 4BD7 f\n"
    // 0A x4: PS "KBBB-FM " (TP=1, PTY=5, addr 0..3), AF pair 98.5/94.1
    "4799 04A0 6E42 4B42 f\n"
    "4799 04A1 6E42 4242 f\n"
    "4799 04A2 6E42 2D46 f\n"
    "4799 04A3 6E42 4D20 f\n"
    // 2A x7: RT = "Enter Sandman by Metallica  " (addr 0..6)
    "4799 24A0 456E 7465 f\n"
    "4799 24A1 7220 5361 f\n"
    "4799 24A2 6E64 6D61 f\n"
    "4799 24A3 6E20 6279 f\n"
    "4799 24A4 204D 6574 f\n"
    "4799 24A5 616C 6C69 f\n"
    "4799 24A6 6361 2020 f\n"
    // 11A: RT+ running, TITLE @0 len12, ARTIST @17 len8
    "4799 B4A8 2018 2228 f\n";

int main(int argc, char** argv) {
    std::printf("== vibedsp RDS block-group replay harness ==\n");

    std::string log;
    if (argc > 1) {
        FILE* f = std::fopen(argv[1], "r");
        if (!f) { std::printf("cannot open %s\n", argv[1]); return 1; }
        char buf[256];
        while (std::fgets(buf, sizeof buf, f)) log += buf;
        std::fclose(f);
    } else {
        log = BUILTIN_LOG;
    }

    RdsDecoder dec;
    Cap cap;
    RdsDecoder::Callbacks cb; cb.ctx = &cap;
    cb.ps = [](void* c, uint16_t pi, const char* ps) {
        auto* p = (Cap*)c; p->pi = pi; std::strncpy(p->ps, ps, 8);
    };
    cb.radiotext = [](void* c, const char* rt) {
        std::strncpy(((Cap*)c)->rt, rt, 64);
    };
    cb.rtPlus = [](void* c, const char* a, const char* t) {
        auto* p = (Cap*)c; std::strncpy(p->artist, a, 64); std::strncpy(p->title, t, 64);
    };
    cb.flags = [](void* c, bool tp, bool ta, uint8_t pty, bool) {
        auto* p = (Cap*)c; p->tp = tp; p->ta = ta; p->pty = pty;
    };
    dec.setCallbacks(cb);
    dec.reset();

    // Replay: every line is one block group, fed exactly as a hardware-RDS
    // backend (Si470x RDSA..RDSD registers) would deliver it.
    int groups = 0;
    size_t pos = 0;
    while (pos < log.size()) {
        size_t eol = log.find('\n', pos);
        if (eol == std::string::npos) eol = log.size();
        std::string line = log.substr(pos, eol - pos);
        pos = eol + 1;
        unsigned a, b, c, d, ok;
        if (std::sscanf(line.c_str(), "%x %x %x %x %x", &a, &b, &c, &d, &ok) == 5) {
            const uint16_t blocks[4] = { (uint16_t)a, (uint16_t)b, (uint16_t)c, (uint16_t)d };
            const bool okf[4] = { (ok & 1) != 0, (ok & 2) != 0, (ok & 4) != 0, (ok & 8) != 0 };
            dec.pushGroup(blocks, okf);
            ++groups;
        }
    }
    std::printf("  replayed %d groups\n", groups);

    if (argc > 1) {   // external log: just report what decoded
        std::printf("  PI=0x%04X PS=\"%s\" RT=\"%s\" artist=\"%s\" title=\"%s\" tp=%d ta=%d pty=%d\n",
            cap.pi, cap.ps, cap.rt, cap.artist, cap.title, cap.tp, cap.ta, cap.pty);
        return 0;
    }

    check(groups == 13, "all 13 recorded groups replayed");
    check(cap.pi == 0x4799, "PI recovered");
    check(std::strcmp(cap.ps, "KBBB-FM ") == 0, "PS recovered");
    check(std::strncmp(cap.rt, "Enter Sandman by Metallica", 26) == 0, "RadioText recovered");
    check(std::strcmp(cap.title, "Enter Sandman") == 0, "RT+ TITLE via group entry point");
    check(std::strcmp(cap.artist, "Metallica") == 0, "RT+ ARTIST via group entry point");
    check(cap.tp && !cap.ta && cap.pty == 5, "TP/TA/PTY flags via group entry point");

    std::printf(failures ? "\n%d FAILURE(S)\n" : "\nALL PASS\n", failures);
    return failures ? 1 : 0;
}
