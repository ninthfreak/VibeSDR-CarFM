// VibeSDR V5 — polyphase rational resampler (real/mono). Original VibeSDR code.
#include "vibedsp.h"
#include "simd_internal.h"   // dotReal (NEON)
#include <cmath>
#include <algorithm>

namespace vibedsp {

static int gcd_(int a, int b) { while (b) { int t = a % b; a = b; b = t; } return a; }

RationalResampler::RationalResampler(int inRate, int outRate) {
    const int g = gcd_(inRate, outRate);
    L_ = outRate / g;
    M_ = inRate / g;

    // Prototype low-pass at the L-upsampled rate. Cutoff must anti-alias both the
    // interpolation images (0.5/L) and the decimation (0.5/M); take the lower.
    const double cutoff = 0.5 / std::max(L_, M_) * 0.90;   // small guard margin
    const double trans  = 0.5 / std::max(L_, M_) * 0.40;
    std::vector<float> proto = designLowpass(cutoff, trans);

    // Pad to a whole number of polyphase branches (length multiple of L_).
    phaseLen_ = (int)std::ceil((double)proto.size() / L_);
    std::vector<float> h((size_t)phaseLen_ * L_, 0.0f);
    for (size_t i = 0; i < proto.size(); ++i) h[i] = proto[i] * (float)L_;  // gain comp

    // Reorganise the strided polyphase taps into L_ CONTIGUOUS, REVERSED branches:
    // rBranch_[b*phaseLen + m] = h[b + (phaseLen-1-m)*L]. Then output(base,branch)
    // = dot(rBranch_[branch], &buf_[windowStart], phaseLen) over contiguous samples.
    rBranch_.assign((size_t)L_ * phaseLen_, 0.0f);
    for (int b = 0; b < L_; ++b)
        for (int m = 0; m < phaseLen_; ++m)
            rBranch_[(size_t)b * phaseLen_ + m] = h[b + (phaseLen_ - 1 - m) * L_];

    buf_.assign(phaseLen_, 0.0f);   // phaseLen samples of history
}

void RationalResampler::reset() {
    std::fill(buf_.begin(), buf_.end(), 0.0f);
    buf_.resize(phaseLen_);
    inCount_ = 0; outCount_ = 0;
}

int RationalResampler::process(const float* in, int n, float* out) {
    // buf_ = [phaseLen_ history][block]; buf_[p] is global input index
    // (inCount_ - phaseLen_) + p. Emit every output whose support is now available.
    buf_.resize((size_t)phaseLen_ + n);
    std::copy(in, in + n, buf_.begin() + phaseLen_);
    const long long avail = inCount_ + n - 1;   // newest global input index
    int outn = 0;
    while (true) {
        const long long u = outCount_ * (long long)M_;
        const long long base = u / L_;          // newest input index this output uses
        if (base > avail) break;
        const int branch = (int)(u % L_);
        const int windowStart = (int)(base - inCount_ + 1);   // >=0 once warmed up
        if (windowStart < 0) { ++outCount_; out[outn++] = 0.0f; continue; }  // startup guard
        out[outn++] = dotReal(&rBranch_[(size_t)branch * phaseLen_], &buf_[windowStart], phaseLen_);
        ++outCount_;
    }
    // Carry the last phaseLen_ samples as history.
    std::copy(buf_.end() - phaseLen_, buf_.end(), buf_.begin());
    buf_.resize(phaseLen_);
    inCount_ += n;
    return outn;
}

} // namespace vibedsp
