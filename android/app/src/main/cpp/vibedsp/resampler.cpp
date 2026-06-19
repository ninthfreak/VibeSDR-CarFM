// VibeSDR V5 — polyphase rational resampler (real/mono). Original VibeSDR code.
#include "vibedsp.h"
#include <cmath>

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
    h_.assign((size_t)phaseLen_ * L_, 0.0f);
    for (size_t i = 0; i < proto.size(); ++i) h_[i] = proto[i] * (float)L_; // gain comp

    cap_ = phaseLen_;
    hist_.assign(cap_, 0.0f);
}

void RationalResampler::reset() {
    std::fill(hist_.begin(), hist_.end(), 0.0f);
    head_ = 0; inCount_ = 0; outCount_ = 0;
}

int RationalResampler::process(const float* in, int n, float* out) {
    int outn = 0;
    for (int i = 0; i < n; ++i) {
        hist_[head_] = in[i];
        head_ = (head_ + 1) % cap_;
        ++inCount_;
        // Emit every output whose base input index is now available.
        while ((outCount_ * (long long)M_) / L_ <= inCount_ - 1) {
            const long long u = outCount_ * (long long)M_;
            const long long base = u / L_;          // newest input index used
            const int branch = (int)(u % L_);
            float acc = 0.0f;
            for (int j = 0; j < phaseLen_; ++j) {
                const long long inIdx = base - j;
                if (inIdx < 0) break;
                const long long back = (inCount_ - 1) - inIdx;
                if (back >= cap_) break;            // older than history (startup)
                int pos = (head_ - 1 - (int)back) % cap_;
                if (pos < 0) pos += cap_;
                acc += h_[branch + j * L_] * hist_[pos];
            }
            out[outn++] = acc;
            ++outCount_;
        }
    }
    return outn;
}

} // namespace vibedsp
