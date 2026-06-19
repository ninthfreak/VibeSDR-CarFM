// VibeSDR V5 — DDC: NCO (complex mixer) + windowed-sinc low-pass + decimator.
// Original VibeSDR code.
#include "vibedsp.h"
#include <cmath>

namespace vibedsp {

// ── NCO ──────────────────────────────────────────────────────────────────--
void NCO::setFreq(double normFreq) {
    step_ = 2.0 * M_PI * normFreq;     // radians/sample
}

void NCO::mix(const cf32* in, cf32* out, int n) {
    for (int i = 0; i < n; ++i) {
        // exp(-j*phase): shift +f down to 0.
        const float c = (float)std::cos(phase_);
        const float s = (float)std::sin(phase_);
        const cf32 rot(c, -s);
        out[i] = in[i] * rot;
        phase_ += step_;
        if (phase_ > M_PI) phase_ -= 2.0 * M_PI;        // keep bounded
        else if (phase_ < -M_PI) phase_ += 2.0 * M_PI;
    }
}

// ── FIR low-pass design (windowed sinc, Hamming) ─────────────────────────--
std::vector<float> designLowpass(double cutoff, double transition) {
    // Tap count from transition width (Hamming ~ 3.3/BW), force odd for symmetry.
    int n = (int)std::ceil(3.3 / std::max(transition, 1e-4));
    if ((n & 1) == 0) ++n;
    if (n < 9) n = 9;
    std::vector<float> h(n);
    const double mid = (n - 1) / 2.0;
    const double wc = 2.0 * M_PI * cutoff;
    double sum = 0.0;
    for (int i = 0; i < n; ++i) {
        const double k = i - mid;
        double sinc = (k == 0.0) ? (wc / M_PI) : std::sin(wc * k) / (M_PI * k);
        const double win = 0.54 - 0.46 * std::cos(2.0 * M_PI * i / (n - 1)); // Hamming
        h[i] = (float)(sinc * win);
        sum += h[i];
    }
    for (auto& v : h) v /= (float)sum;   // unity DC gain
    return h;
}

// ── FIR decimator (complex stream, real taps) ────────────────────────────--
FirDecimator::FirDecimator(std::vector<float> taps, int decim)
    : taps_(std::move(taps)), decim_(decim), count_(decim) {
    hist_.assign(taps_.size(), cf32(0.0f, 0.0f));
}

void FirDecimator::reset() {
    std::fill(hist_.begin(), hist_.end(), cf32(0.0f, 0.0f));
    head_ = 0;
    count_ = decim_;
}

int FirDecimator::process(const cf32* in, int n, cf32* out) {
    const int K = (int)taps_.size();
    int outn = 0;
    for (int i = 0; i < n; ++i) {
        hist_[head_] = in[i];
        head_ = (head_ + 1) % K;
        if (--count_ == 0) {
            count_ = decim_;
            // Convolve newest-first: taps_[0] aligns with most-recent sample.
            cf32 acc(0.0f, 0.0f);
            int idx = head_ - 1;
            for (int j = 0; j < K; ++j) {
                if (idx < 0) idx += K;
                acc += taps_[j] * hist_[idx];
                --idx;
            }
            out[outn++] = acc;
        }
    }
    return outn;
}

// ── AM demod ─────────────────────────────────────────────────────────────--
void AmDemod::process(const cf32* in, float* out, int n) {
    for (int i = 0; i < n; ++i) {
        const float mag = std::sqrt(in[i].real() * in[i].real() +
                                    in[i].imag() * in[i].imag());
        // One-pole DC blocker removes the carrier term, leaving the modulation.
        dc_ = kPole * dc_ + (1.0f - kPole) * mag;
        out[i] = (mag - dc_) * kGain;
    }
}

} // namespace vibedsp
