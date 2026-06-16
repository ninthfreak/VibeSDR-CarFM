// VibeSDR V4 — self-contained audio noise reduction.
//
// Spectral-subtraction (Wiener-style) denoiser on mono audio: STFT with a
// sqrt-Hann window and 50% overlap, per-bin noise floor tracking (fast-down /
// slow-up minima), a power gain that suppresses noise-dominated bins, and
// overlap-add resynthesis. Uses the vendored kiss_fftr — NO external resource
// files (unlike the OMLSA module), so it can't fail to init. Mono, opt-in.
#pragma once
#include <cstdint>
#include <vector>

extern "C" {
#include "fft/kiss_fftr.h"
}

namespace vibe {

class AudioNR {
public:
    AudioNR();
    ~AudioNR();
    // Feed mono floats; appends denoised output (variable count, STFT latency).
    void process(const float* in, int count, std::vector<float>& out);
    void reset();
private:
    static const int N = 512;        // FFT size
    static const int HOP = 256;      // 50% overlap
    kiss_fftr_cfg fwd = nullptr, inv = nullptr;
    std::vector<float> win;          // sqrt-Hann (analysis + synthesis)
    std::vector<float> inBuf;        // accumulated input
    std::vector<float> ola;          // overlap-add accumulator (N)
    std::vector<float> frame;        // windowed time frame (N)
    std::vector<float> noise;        // per-bin noise power (N/2+1)
    std::vector<kiss_fft_cpx> spec;  // N/2+1
    bool primed = false;
};

} // namespace vibe
