// VibeSDR V5 — clean-room, GPL-free on-device DSP.
//
// This module replaces the SDR++ Brown / FFTW / VOLK DSP used by
// local_sdr_shim.cpp. It is platform-independent C++17 (Android + iOS) and
// depends only on permissively-licensed code (KissFFT, BSD-3, vendored under
// third_party/). Everything here is original VibeSDR code unless noted.
//
// Build order (see Reference/VibeSDR_v5_Clean_DSP_Brief.md):
//   Phase 1  RealFFT (waterfall)            <-- this file starts here
//   Phase 2  DDC (NCO + decimate) + AM/SSB/CW/NFM
//   Phase 3  WFM mono + de-emphasis
//   Phase 4  WFM stereo (MPX)
//   Phase 5  RDS (redsea)
#pragma once
#include <cstdint>
#include <cstddef>
#include <complex>
#include <vector>

namespace vibedsp {

// Sample types. Match the layout the shim already uses (interleaved float I/Q,
// stereo float L/R) so the swap into local_sdr_shim.cpp is mechanical.
using cf32 = std::complex<float>;
struct stereo { float l, r; };

// ── RealFFT ────────────────────────────────────────────────────────────────
// Forward real-to-complex FFT for the waterfall. Wraps KissFFT's kiss_fftr.
// `size` must be even (we always use powers of two). Not thread-safe; one
// instance per pipeline thread.
class RealFFT {
public:
    explicit RealFFT(int size);
    ~RealFFT();
    RealFFT(const RealFFT&) = delete;
    RealFFT& operator=(const RealFFT&) = delete;

    int size() const { return n_; }
    int bins() const { return n_ / 2 + 1; } // unique non-negative-freq bins

    // Transform `n` real input samples -> `bins()` complex outputs.
    // Caller supplies input length == size(); out length == bins().
    void forward(const float* in, cf32* out);

    // Convenience: power spectrum in dB (10*log10(|X|^2)), length bins().
    // `scale` normalises for FFT size + window gain (caller-computed).
    void powerDb(const float* in, float* outDb, float scale = 1.0f);

private:
    int n_;
    void* cfg_ = nullptr;            // kiss_fftr_cfg
    std::vector<cf32> scratch_;      // bins() complex outputs
};

// ── Windows ──────────────────────────────────────────────────────────────--
// Fill `w` (length n) with the named window. Nuttall matches the current
// IQFrontEnd::FFTWindow::NUTTALL used by the shim so waterfall look is preserved.
void nuttallWindow(float* w, int n);
double windowCoherentGain(const float* w, int n); // sum(w)/n, for normalisation

} // namespace vibedsp
