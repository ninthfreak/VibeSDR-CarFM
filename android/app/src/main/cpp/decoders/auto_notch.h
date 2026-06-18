// VibeSDR V4 — automatic notch filter (adaptive line enhancer, notch mode).
//
// A normalized-LMS adaptive predictor: a decorrelation delay then an FIR that
// predicts the *periodic* part of the audio (steady carriers, heterodynes,
// tuning whistles). The prediction is subtracted, so the predictable tones are
// notched out while broadband speech — which can't be predicted from delayed
// samples — passes through. Time-domain, ~3 ms latency, no FFT, so it drops into
// any audio path (local shim today, network engines next).
//
// NLMS (normalised) keeps the step size independent of signal level, so it
// adapts the same on a whisper or a loud SSB peak without the manual beta
// tuning a plain LMS needs. Structure follows KiwiSDR's CLMS auto-notch, scaled
// from 12 kHz to 48 kHz and normalised. Mono, in-place, opt-in.
#pragma once
#include <vector>

namespace vibe {

class AutoNotch {
public:
    AutoNotch();
    void process(float* x, int count);   // mono, in-place
    void reset();
private:
    // Tap span MUST stay below the voice pitch period (~4 ms for a high female
    // voice), or the FIR predicts voiced speech from its previous pitch cycle and
    // subtracts it — a harmonic-comb removal that sounds "heavily compressed",
    // worst on female voices. D small (just decorrelate the broadband part),
    // D+L ≈ 3.5 ms so it can still model the (sub-ms-period) squeal but can't
    // reach a voice pitch cycle.
    static const int D = 8;              // decorrelation delay (~0.17 ms)
    static const int L = 160;            // FIR taps (span ≈ 3.5 ms @ 48 kHz)
    static const int M = D + L;
    std::vector<float> buf;              // mirrored history (2*M) for contiguous taps
    std::vector<float> w;                // L adaptive coefficients
    int p = 0;                           // write index, decrements [0, M)
    // SLOW adaptation: converges on a stationary tone over ~1 s but can't follow
    // the constantly-shifting formants of voiced speech, so speech passes through.
    // A fast step here notches the voice too (its harmonics are predictable).
    // Very slow adaptation + gentle leakage. Tiny mu means transient voice can
    // neither build its own notch (voice is spared) NOR pull the coefficients off
    // a locked tone when it's loud (the squeal stays notched *through* speech
    // instead of leaking back in). Gentle leakage lets the tone notch persist
    // deeply once acquired (takes a couple of seconds to lock — fine for a
    // permanent carrier). Depth ~ mu/(1-leak) stays high despite the small step.
    float mu   = 0.003f;                 // NLMS step (very gentle — stationary tones only)
    float leak = 0.9999f;                // gentle leakage (hold the lock)
    float eps  = 1e-6f;                  // NLMS denominator floor
};

} // namespace vibe
