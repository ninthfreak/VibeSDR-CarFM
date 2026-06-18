// VibeSDR V4 — NLMS automatic notch filter (adaptive line enhancer, notch mode).
#include "auto_notch.h"
#include <algorithm>

namespace vibe {

AutoNotch::AutoNotch() { buf.assign(2 * M, 0.0f); w.assign(L, 0.0f); }

void AutoNotch::reset() {
    std::fill(buf.begin(), buf.end(), 0.0f);
    std::fill(w.begin(), w.end(), 0.0f);
    p = 0;
}

void AutoNotch::process(float* x, int count) {
    for (int n = 0; n < count; n++) {
        // Decreasing write pointer + mirror at p+M: the most recent M samples are
        // always contiguous at buf[p .. p+M-1], newest first — so x[n-d] = buf[p+d]
        // with no per-tap modulo.
        p = (p == 0) ? M - 1 : p - 1;
        float in = x[n];
        buf[p] = in; buf[p + M] = in;

        // FIR predicts the periodic part from samples delayed by D..D+L-1;
        // pwr is the energy of those same taps for the NLMS normalisation.
        int base = p + D;                // index of x[n-D]; base+i = x[n-D-i]
        float fir = 0.0f, pwr = 0.0f;
        for (int i = 0; i < L; i++) {
            float s = buf[base + i];
            fir += w[i] * s;
            pwr += s * s;
        }
        float err = in - fir;            // tones removed → notch output
        x[n] = err;

        // Leaky NLMS coefficient update.
        float g = mu * err / (eps + pwr);
        for (int i = 0; i < L; i++) w[i] = leak * w[i] + g * buf[base + i];
    }
}

} // namespace vibe
