// VibeSDR V4 — self-contained audio noise reduction.
//
// MMSE spectral-weighting denoiser (Kim & Ruwisch 2002, on the Ephraim & Malah
// 1984 / Romanin 2009 lineage — the same algorithm KiwiSDR ships as "spectral
// NR"). STFT with a sqrt-Hann window at 50% overlap; the noise PSD is tracked
// per-bin via an MMSE speech-presence probability (NOT a biased minimum
// tracker, which is why the old spectral-subtraction version barely reduced
// anything); a decision-directed a-priori SNR feeds an MMSE-STSA gain; and a
// dynamic cross-bin average suppresses musical noise. Uses the vendored
// kiss_fftr — no external resource files, so it can't fail to init. Mono, opt-in.
//
// N=2048 @ 48 kHz → 23 Hz/bin, 21 ms hop: matches the Kiwi reference's
// resolution exactly, so its tuned bin constants carry over unchanged.
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
    // Strength: 0..1 lowers the residual-noise floor; 1..~1.33 (slider 16..20)
    // adds extra over-subtraction on top of the already-deep floor.
    void setStrength(float s) { strength = s < 0 ? 0 : (s > 1.4f ? 1.4f : s); }
private:
    static const int N   = 2048;     // FFT size
    static const int HOP = 1024;     // 50% overlap
    static const int K   = N / 2 + 1;
    kiss_fftr_cfg fwd = nullptr, inv = nullptr;
    std::vector<float> win;          // sqrt-Hann (analysis + synthesis)
    std::vector<float> inBuf;        // accumulated input
    std::vector<float> ola;          // overlap-add accumulator (N)
    std::vector<float> frame;        // windowed time frame (N)
    std::vector<kiss_fft_cpx> spec;  // K
    // MMSE per-bin state (K)
    std::vector<float> pw;           // |X|^2 power of the current frame
    std::vector<float> xt;           // noise PSD estimate
    std::vector<float> pslp;         // smoothed speech-presence probability
    std::vector<float> hkOld;        // previous a-posteriori gain term (DD)
    std::vector<float> gain;         // current per-bin gains
    std::vector<float> gtmp;         // scratch for the musical-noise average
    // a-priori-SNR (H1) derived constants
    float xih1 = 0, xih1r = 0, pfac = 0;
    int  initStage = 0;              // 0 = (re)set arrays, 1 = priming noise, 2 = running
    int  initCount = 0;
    bool primed = false;
    float strength = 0.5f;           // 0..1 aggressiveness
};

} // namespace vibe
