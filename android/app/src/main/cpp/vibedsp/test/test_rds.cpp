// VibeSDR V5 host test — RDS data-link layer. Encodes group 0A frames carrying
// a known PI + PS name, feeds the bits to RdsDecoder, checks PS is recovered.
// Validates syndrome/checkword, block sync, and group-0A parsing end to end.
#include "../vibedsp.h"
#include <cstdio>
#include <cstring>
#include <vector>

using namespace vibedsp;

static int failures = 0;
static void check(bool ok, const char* what) {
    std::printf("  [%s] %s\n", ok ? "PASS" : "FAIL", what);
    if (!ok) ++failures;
}

// Build a 26-bit RDS block: data<<10 | (checkword ^ offset).
static uint32_t encodeBlock(uint16_t data, int offsetIdx) {
    uint16_t cw = RdsDecoder::checkword(data) ^ RdsDecoder::OFFSET[offsetIdx];
    return ((uint32_t)data << 10) | cw;
}

static void feedBlock(RdsDecoder& d, uint32_t blk) {
    for (int i = 25; i >= 0; --i) d.pushBit((blk >> i) & 1);
}

struct Cap { uint16_t pi = 0; char ps[9] = {0}; int psCalls = 0; };
static void onPs(void* c, uint16_t pi, const char* ps) {
    auto* p = (Cap*)c; p->pi = pi; std::strncpy(p->ps, ps, 8); p->psCalls++;
}

int main() {
    std::printf("== vibedsp RDS data-link host test ==\n");

    // Self-consistency: a valid block's syndrome equals its offset word.
    {
        bool allOk = true;
        for (int o = 0; o < 5; ++o)
            if (RdsDecoder::syndrome(encodeBlock(0xABCD, o)) != RdsDecoder::OFFSET[o]) allOk = false;
        check(allOk, "syndrome(valid block) == offset word (all A/B/C/C'/D)");
    }

    const uint16_t PI = 0x1234;
    const char* PS = "TESTFM12";       // 8 chars

    RdsDecoder dec;
    Cap cap;
    RdsDecoder::Callbacks cb; cb.ctx = &cap; cb.ps = onPs;
    dec.setCallbacks(cb);
    dec.reset();

    // Send the four 0A segments (addr 0..3), repeated a few times so the decoder
    // syncs and fills all PS positions.
    for (int rep = 0; rep < 4; ++rep) {
        for (int addr = 0; addr < 4; ++addr) {
            const uint16_t A = PI;
            const uint16_t B = (0 << 12) | (0 << 11) | (addr & 0x3);   // group 0A
            const uint16_t C = 0xCDEF;                                  // alt freq (unused)
            const uint16_t D = ((uint8_t)PS[addr * 2] << 8) | (uint8_t)PS[addr * 2 + 1];
            feedBlock(dec, encodeBlock(A, 0));   // offset A
            feedBlock(dec, encodeBlock(B, 1));   // offset B
            feedBlock(dec, encodeBlock(C, 2));   // offset C
            feedBlock(dec, encodeBlock(D, 4));   // offset D
        }
    }

    std::printf("  PI=0x%04X  PS=\"%s\"  (ps callbacks=%d)\n", cap.pi, cap.ps, cap.psCalls);
    check(cap.psCalls > 0, "PS callback fired");
    check(cap.pi == PI, "PI recovered");
    check(std::strcmp(cap.ps, PS) == 0, "PS name recovered exactly");

    std::printf(failures ? "\n%d FAILURE(S)\n" : "\nALL PASS\n", failures);
    return failures ? 1 : 0;
}
