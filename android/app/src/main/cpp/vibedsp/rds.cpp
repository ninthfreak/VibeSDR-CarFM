// VibeSDR V5 — RDS data-link layer (block sync + group parsing).
// Clean-room implementation of EN 50067 / IEC 62106. Original VibeSDR code.
#include "vibedsp.h"
#include <cstring>

namespace vibedsp {

// Generator g(x) = x^10+x^8+x^7+x^5+x^4+x^3+1 = 0x5B9. Offset words A,B,C,C',D.
// For a valid block the syndrome (block mod g) equals the offset word value.
static constexpr uint32_t kGen = 0x5B9;
const uint16_t RdsDecoder::OFFSET[5] = { 0x0FC, 0x198, 0x168, 0x350, 0x1B4 };

uint16_t RdsDecoder::syndrome(uint32_t b) {
    uint32_t r = b & 0x3FFFFFF;                 // 26-bit codeword
    for (int i = 25; i >= 10; --i)
        if ((r >> i) & 1) r ^= (kGen << (i - 10));
    return (uint16_t)(r & 0x3FF);
}

uint16_t RdsDecoder::checkword(uint16_t data) {
    uint32_t r = (uint32_t)data << 10;
    for (int i = 25; i >= 10; --i)
        if ((r >> i) & 1) r ^= (kGen << (i - 10));
    return (uint16_t)(r & 0x3FF);
}

void RdsDecoder::reset() {
    reg_ = 0; synced_ = false; bitsLeft_ = 0; nextBlk_ = 0; badRun_ = 0;
    for (int i = 0; i < 4; ++i) { blk_[i] = 0; blkOk_[i] = false; }
    std::memset(ps_, 0, sizeof ps_);
    std::memset(rt_, 0, sizeof rt_);
}

void RdsDecoder::pushBit(int bit) {
    reg_ = ((reg_ << 1) | (bit & 1)) & 0x3FFFFFF;

    if (!synced_) {
        // Hunt for a block-A syndrome to align to the group grid.
        if (syndrome(reg_) == OFFSET[0]) {
            synced_ = true; badRun_ = 0;
            blk_[0] = (reg_ >> 10) & 0xFFFF; blkOk_[0] = true;
            nextBlk_ = 1; bitsLeft_ = 26;
        }
        return;
    }

    if (--bitsLeft_ > 0) return;
    bitsLeft_ = 26;

    const uint16_t syn = syndrome(reg_);
    const uint16_t data = (reg_ >> 10) & 0xFFFF;
    bool ok;
    switch (nextBlk_) {
        case 0:  ok = (syn == OFFSET[0]); break;                       // A
        case 1:  ok = (syn == OFFSET[1]); break;                       // B
        case 2:  ok = (syn == OFFSET[2] || syn == OFFSET[3]); break;   // C or C'
        default: ok = (syn == OFFSET[4]); break;                       // D
    }
    blk_[nextBlk_] = data; blkOk_[nextBlk_] = ok;
    if (ok) badRun_ = 0;
    else if (++badRun_ >= 4) { synced_ = false; nextBlk_ = 0; return; }

    if (++nextBlk_ == 4) { parseGroup(); nextBlk_ = 0; }
}

void RdsDecoder::parseGroup() {
    if (!(blkOk_[0] && blkOk_[1])) return;
    const uint16_t pi = blk_[0];
    const int gtype = (blk_[1] >> 12) & 0xF;
    const int ver   = (blk_[1] >> 11) & 1;

    if (gtype == 0) {                                  // 0A/0B — programme service name
        const int addr = blk_[1] & 0x3;
        if (blkOk_[3]) {
            ps_[addr * 2]     = (char)((blk_[3] >> 8) & 0xFF);
            ps_[addr * 2 + 1] = (char)(blk_[3] & 0xFF);
            if (cb_.ps) cb_.ps(cb_.ctx, pi, ps_);
        }
    } else if (gtype == 2) {                            // 2A/2B — RadioText
        const int addr = blk_[1] & 0xF;
        if (ver == 0 && blkOk_[2] && blkOk_[3]) {       // 2A: 4 chars (C,D)
            rt_[addr * 4 + 0] = (char)((blk_[2] >> 8) & 0xFF);
            rt_[addr * 4 + 1] = (char)(blk_[2] & 0xFF);
            rt_[addr * 4 + 2] = (char)((blk_[3] >> 8) & 0xFF);
            rt_[addr * 4 + 3] = (char)(blk_[3] & 0xFF);
            if (cb_.radiotext) cb_.radiotext(cb_.ctx, rt_);
        } else if (ver == 1 && blkOk_[3]) {             // 2B: 2 chars (D)
            rt_[addr * 2 + 0] = (char)((blk_[3] >> 8) & 0xFF);
            rt_[addr * 2 + 1] = (char)(blk_[3] & 0xFF);
            if (cb_.radiotext) cb_.radiotext(cb_.ctx, rt_);
        }
    }
}

} // namespace vibedsp
