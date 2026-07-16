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

struct Cap {
    uint16_t pi = 0; char ps[9] = {0}; int psCalls = 0;
    char artist[65] = {0}; char title[65] = {0}; int rtpCalls = 0;
};
static void onPs(void* c, uint16_t pi, const char* ps) {
    auto* p = (Cap*)c; p->pi = pi; std::strncpy(p->ps, ps, 8); p->psCalls++;
}
static void onRtPlus(void* c, const char* artist, const char* title) {
    auto* p = (Cap*)c;
    std::strncpy(p->artist, artist, 64); std::strncpy(p->title, title, 64);
    p->rtpCalls++;
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

    // ── RadioText Plus (ODA 0x4BD7): 2A fills RT, 3A registers, 11A tags ──────
    {
        RdsDecoder d2;
        Cap c2;
        RdsDecoder::Callbacks cb2; cb2.ctx = &c2; cb2.rtPlus = onRtPlus;
        d2.setCallbacks(cb2);
        d2.reset();

        //           0123456789012345678901234567
        const char* RT = "Enter Sandman by Metallica  ";   // 28 chars = 7 x 2A segments
        for (int rep = 0; rep < 2; ++rep) {
            for (int addr = 0; addr < 7; ++addr) {
                const uint16_t B = (2 << 12) | (0 << 11) | (addr & 0xF);           // 2A
                const uint16_t C = ((uint8_t)RT[addr*4]   << 8) | (uint8_t)RT[addr*4+1];
                const uint16_t D = ((uint8_t)RT[addr*4+2] << 8) | (uint8_t)RT[addr*4+3];
                feedBlock(d2, encodeBlock(PI, 0)); feedBlock(d2, encodeBlock(B, 1));
                feedBlock(d2, encodeBlock(C, 2));  feedBlock(d2, encodeBlock(D, 4));
            }
        }

        // 3A: RT+ (AID 0x4BD7) rides in group 11A (application group code 0x16).
        {
            const uint16_t B = (3 << 12) | (0 << 11) | 0x16;
            feedBlock(d2, encodeBlock(PI, 0)); feedBlock(d2, encodeBlock(B, 1));
            feedBlock(d2, encodeBlock(0, 2));  feedBlock(d2, encodeBlock(0x4BD7, 4));
        }
        check(c2.rtpCalls == 0, "RT+ not fired before a tag group arrives");

        // 11A: toggle=0 running=1; tag1 = ITEM.TITLE(1) start 0 len 12 ("Enter Sandman"),
        // tag2 = ITEM.ARTIST(4) start 17 len 8 ("Metallica"). Type 1 = hi3 000 lo3 001;
        // type 4 = hi1 0 lo5 00100. Length markers are length-1.
        {
            const uint16_t B = (11 << 12) | (0 << 11) | (0 << 4) | (1 << 3) | 0x0;
            const uint16_t C = (uint16_t)((1 << 13) | (0 << 7) | (12 << 1) | 0);
            const uint16_t D = (uint16_t)((4 << 11) | (17 << 5) | 8);
            feedBlock(d2, encodeBlock(PI, 0)); feedBlock(d2, encodeBlock(B, 1));
            feedBlock(d2, encodeBlock(C, 2));  feedBlock(d2, encodeBlock(D, 4));
        }
        std::printf("  RT+ artist=\"%s\" title=\"%s\" (callbacks=%d)\n", c2.artist, c2.title, c2.rtpCalls);
        check(c2.rtpCalls == 1, "RT+ callback fired once");
        check(std::strcmp(c2.artist, "Metallica") == 0, "RT+ ITEM.ARTIST sliced correctly");
        check(std::strcmp(c2.title, "Enter Sandman") == 0, "RT+ ITEM.TITLE sliced correctly");

        // Re-sending the SAME tags must not re-fire (change detection).
        {
            const uint16_t B = (11 << 12) | (0 << 11) | (0 << 4) | (1 << 3) | 0x0;
            const uint16_t C = (uint16_t)((1 << 13) | (0 << 7) | (12 << 1) | 0);
            const uint16_t D = (uint16_t)((4 << 11) | (17 << 5) | 8);
            feedBlock(d2, encodeBlock(PI, 0)); feedBlock(d2, encodeBlock(B, 1));
            feedBlock(d2, encodeBlock(C, 2));  feedBlock(d2, encodeBlock(D, 4));
        }
        check(c2.rtpCalls == 1, "identical RT+ group does not re-fire");

        // Item toggle flip with dummy tags = new item -> tags cleared (both empty).
        {
            const uint16_t B = (11 << 12) | (0 << 11) | (1 << 4) | (1 << 3) | 0x0;
            feedBlock(d2, encodeBlock(PI, 0)); feedBlock(d2, encodeBlock(B, 1));
            feedBlock(d2, encodeBlock(0, 2));  feedBlock(d2, encodeBlock(0, 4));
        }
        check(c2.rtpCalls == 2, "toggle flip fires a clear");
        check(c2.artist[0] == 0 && c2.title[0] == 0, "toggle flip clears artist/title");
    }

    std::printf(failures ? "\n%d FAILURE(S)\n" : "\nALL PASS\n", failures);
    return failures ? 1 : 0;
}
