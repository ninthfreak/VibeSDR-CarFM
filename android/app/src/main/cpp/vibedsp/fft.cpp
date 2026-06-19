// VibeSDR V5 — RealFFT + windows. Original VibeSDR code; FFT kernel = KissFFT.
#include "vibedsp.h"
#include <cmath>
#include <cstring>

// KissFFT real transform (BSD-3). kiss_fft_scalar defaults to float.
#include "third_party/kissfft/kiss_fftr.h"

namespace vibedsp {

RealFFT::RealFFT(int size) : n_(size) {
    // inverse=0 (forward), no preallocated mem/lenmem -> KissFFT mallocs cfg.
    cfg_ = kiss_fftr_alloc(n_, 0, nullptr, nullptr);
    scratch_.resize(bins());
}

RealFFT::~RealFFT() {
    if (cfg_) kiss_fftr_free((kiss_fftr_cfg)cfg_);
}

void RealFFT::forward(const float* in, cf32* out) {
    // kiss_fft_cpx is {float r, i}; std::complex<float> is layout-compatible.
    kiss_fftr((kiss_fftr_cfg)cfg_,
              reinterpret_cast<const kiss_fft_scalar*>(in),
              reinterpret_cast<kiss_fft_cpx*>(out));
}

void RealFFT::powerDb(const float* in, float* outDb, float scale) {
    forward(in, scratch_.data());
    const int b = bins();
    for (int i = 0; i < b; ++i) {
        const float re = scratch_[i].real();
        const float im = scratch_[i].imag();
        float p = (re * re + im * im) * scale;
        if (p < 1e-20f) p = 1e-20f;        // floor to avoid -inf
        outDb[i] = 10.0f * std::log10(p);
    }
}

// 4-term Nuttall window (matches SDR++ IQFrontEnd NUTTALL).
void nuttallWindow(float* w, int n) {
    const double a0 = 0.355768, a1 = 0.487396, a2 = 0.144232, a3 = 0.012604;
    for (int i = 0; i < n; ++i) {
        const double t = 2.0 * M_PI * i / (n - 1);
        w[i] = (float)(a0 - a1 * std::cos(t) + a2 * std::cos(2 * t) - a3 * std::cos(3 * t));
    }
}

double windowCoherentGain(const float* w, int n) {
    double s = 0.0;
    for (int i = 0; i < n; ++i) s += w[i];
    return s / n;
}

} // namespace vibedsp
