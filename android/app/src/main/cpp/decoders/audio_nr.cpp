// VibeSDR V4 — self-contained spectral-subtraction audio NR.
#include "audio_nr.h"
#include <cmath>

namespace vibe {

AudioNR::AudioNR() {
    fwd = kiss_fftr_alloc(N, 0, nullptr, nullptr);
    inv = kiss_fftr_alloc(N, 1, nullptr, nullptr);
    win.resize(N);
    for (int i = 0; i < N; i++) {
        float h = 0.5f * (1.0f - std::cos(2.0f * (float)M_PI * i / (N - 1)));
        win[i] = std::sqrt(h);                 // sqrt-Hann: COLA at 50% overlap
    }
    ola.assign(N, 0.0f);
    frame.resize(N);
    noise.assign(N / 2 + 1, 0.0f);
    spec.resize(N / 2 + 1);
}

AudioNR::~AudioNR() {
    if (fwd) kiss_fftr_free(fwd);
    if (inv) kiss_fftr_free(inv);
}

void AudioNR::reset() {
    inBuf.clear();
    std::fill(ola.begin(), ola.end(), 0.0f);
    std::fill(noise.begin(), noise.end(), 0.0f);
    primed = false;
}

void AudioNR::process(const float* in, int count, std::vector<float>& out) {
    inBuf.insert(inBuf.end(), in, in + count);
    const float gmin = 0.06f;                  // floor gain (~ -12 dB) — limits musical noise
    const float invN = 1.0f / (float)N;

    while ((int)inBuf.size() >= N) {
        // Analysis: window the current frame.
        for (int i = 0; i < N; i++) frame[i] = inBuf[i] * win[i];
        kiss_fftr(fwd, frame.data(), spec.data());

        // Per-bin spectral subtraction.
        for (int k = 0; k <= N / 2; k++) {
            float P = spec[k].r * spec[k].r + spec[k].i * spec[k].i;
            float& Nn = noise[k];
            if (Nn <= 0.0f) Nn = P;
            if (P < Nn) Nn = P; else Nn += 0.02f * (P - Nn);   // fast-down / slow-up
            float g = (P > Nn) ? (P - Nn) / P : 0.0f;          // power gain
            if (g < gmin) g = gmin;
            float ag = std::sqrt(g);                            // amplitude gain
            spec[k].r *= ag; spec[k].i *= ag;
        }

        kiss_fftri(inv, spec.data(), frame.data());

        // Synthesis window + overlap-add; emit HOP samples.
        for (int i = 0; i < N; i++) ola[i] += frame[i] * invN * win[i];
        if (primed) {
            for (int i = 0; i < HOP; i++) out.push_back(ola[i]);
        }
        primed = true;
        // Shift OLA buffer left by HOP, zero the tail.
        for (int i = 0; i < N - HOP; i++) ola[i] = ola[i + HOP];
        for (int i = N - HOP; i < N; i++) ola[i] = 0.0f;
        // Consume HOP input samples.
        inBuf.erase(inBuf.begin(), inBuf.begin() + HOP);
    }
}

} // namespace vibe
