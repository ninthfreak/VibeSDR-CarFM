// VibeSDR V5 — internal SIMD + fast-math kernels (NOT a public API).
//
// One home for the vectorised inner loops and fast approximations the engine's
// hot paths share. ARM NEON (AArch64) with scalar fallback; all GPL-free,
// original VibeSDR code except where a well-known public-domain approximation is
// noted. Accuracy of every approximation here is verified by the host test
// suite (FFT power, demod tones, WFM stereo separation, RDS).
#pragma once
#include "vibedsp.h"
#include <cmath>
#include <cstdint>

#if defined(__aarch64__)
  #include <arm_neon.h>
  #define VIBE_NEON 1
#endif

namespace vibedsp {

// ── Dot products ────────────────────────────────────────────────────────────
// Real: sum(a[j]*b[j]). Complex: sum(t[j]*z[j]), z interleaved re/im (len 2K).
static inline float dotReal(const float* a, const float* b, int K) {
#if VIBE_NEON
    float32x4_t acc = vdupq_n_f32(0.0f);
    int j = 0;
    for (; j + 4 <= K; j += 4)
        acc = vmlaq_f32(acc, vld1q_f32(a + j), vld1q_f32(b + j));
    float s = vaddvq_f32(acc);
    for (; j < K; ++j) s += a[j] * b[j];
    return s;
#else
    float s = 0.0f;
    for (int j = 0; j < K; ++j) s += a[j] * b[j];
    return s;
#endif
}

static inline cf32 dotCplx(const float* t, const float* z, int K) {
#if VIBE_NEON
    float32x4_t ar = vdupq_n_f32(0.0f), ai = vdupq_n_f32(0.0f);
    int j = 0;
    for (; j + 4 <= K; j += 4) {
        const float32x4_t tv = vld1q_f32(t + j);
        const float32x4x2_t zv = vld2q_f32(z + 2 * j);   // de-interleave re/im
        ar = vmlaq_f32(ar, tv, zv.val[0]);
        ai = vmlaq_f32(ai, tv, zv.val[1]);
    }
    float re = vaddvq_f32(ar), im = vaddvq_f32(ai);
    for (; j < K; ++j) { re += t[j] * z[2 * j]; im += t[j] * z[2 * j + 1]; }
    return cf32(re, im);
#else
    float re = 0.0f, im = 0.0f;
    for (int j = 0; j < K; ++j) { re += t[j] * z[2 * j]; im += t[j] * z[2 * j + 1]; }
    return cf32(re, im);
#endif
}

// ── Complex × real (windowing): out[i] = in[i] * w[i] ───────────────────────
static inline void mulComplexReal(const cf32* in, const float* w, cf32* out, int n) {
    const float* zin = reinterpret_cast<const float*>(in);
    float* zout = reinterpret_cast<float*>(out);
#if VIBE_NEON
    int i = 0;
    for (; i + 4 <= n; i += 4) {
        const float32x4_t wv = vld1q_f32(w + i);
        float32x4x2_t z = vld2q_f32(zin + 2 * i);
        z.val[0] = vmulq_f32(z.val[0], wv);
        z.val[1] = vmulq_f32(z.val[1], wv);
        vst2q_f32(zout + 2 * i, z);
    }
    for (; i < n; ++i) { zout[2*i] = zin[2*i] * w[i]; zout[2*i+1] = zin[2*i+1] * w[i]; }
#else
    for (int i = 0; i < n; ++i) { zout[2*i] = zin[2*i] * w[i]; zout[2*i+1] = zin[2*i+1] * w[i]; }
#endif
}

// ── Fast log2 (Mineiro, public domain) — ~3e-4 max error ────────────────────
// Used for the waterfall power->dB (a uint8 display; tiny error is invisible)
// at ~millions of bins/sec, replacing std::log10.
static inline float fastLog2(float x) {
    union { float f; uint32_t i; } vx = { x };
    union { uint32_t i; float f; } mx = { (vx.i & 0x007FFFFFu) | 0x3f000000u };
    float y = (float)vx.i * 1.1920928955078125e-7f;
    return y - 124.22551499f - 1.498030302f * mx.f - 1.72587999f / (0.3520887068f + mx.f);
}
static constexpr float kDbPerLog2 = 3.0102999566398120f;   // 10*log10(2)
static inline float powerToDb(float p) {
    if (p < 1e-20f) p = 1e-20f;
    return kDbPerLog2 * fastLog2(p);
}

// ── Accurate fast atan2 — ~1e-6 max error (inaudible for FM) ─────────────────
// Minimax atan core on [-1,1] + octant reconstruction. Far cheaper than
// std::atan2 at the channel rate, without the gross error of cruder approxes
// (which corrupted the stereo L-R difference).
static inline float fastAtan2(float y, float x) {
    if (x == 0.0f && y == 0.0f) return 0.0f;
    const float ax = std::fabs(x), ay = std::fabs(y);
    const float z = (ax > ay) ? (ay / ax) : (ax / ay);      // |t| in [0,1]
    const float z2 = z * z;
    // 7th-order odd minimax for atan(z), z in [0,1].
    float a = z * (0.99997726f + z2 * (-0.33262347f + z2 * (0.19354346f +
              z2 * (-0.11643287f + z2 * (0.05265332f - z2 * 0.01172120f)))));
    if (ay > ax) a = 1.57079632679f - a;     // fold into [0,pi/4] region
    if (x < 0.0f) a = 3.14159265359f - a;
    return (y < 0.0f) ? -a : a;
}

} // namespace vibedsp
