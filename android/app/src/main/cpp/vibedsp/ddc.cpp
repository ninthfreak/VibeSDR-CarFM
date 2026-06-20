// VibeSDR V5 — DDC: NCO (complex mixer) + windowed-sinc low-pass + decimator.
// Original VibeSDR code. The FIR inner loops and the NCO are the per-sample hot
// paths (they run at the full IQ rate), so they are SIMD-friendly + trig-free.
#include "vibedsp.h"
#include <cmath>
#include <algorithm>

#if defined(__aarch64__)
  #include <arm_neon.h>
  #define VIBE_NEON 1
#endif

namespace vibedsp {

// ── SIMD dot products ──────────────────────────────────────────────────────-
// Real: sum(a[j]*b[j]). Complex: sum(t[j]*z[j]) where z is interleaved re/im.
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
        const float32x4x2_t zv = vld2q_f32(z + 2 * j);  // de-interleave re/im
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

// Fast atan2 (Rajan polynomial), max error ~0.0038 rad — inaudible for FM, and
// far cheaper than std::atan2 at the channel rate.
static inline float fastAtan2(float y, float x) {
    if (x == 0.0f && y == 0.0f) return 0.0f;
    const float ax = std::fabs(x), ay = std::fabs(y);
    const float a  = std::min(ax, ay) / (std::max(ax, ay) + 1e-20f);
    const float s  = a * a;
    float r = ((-0.0464964749f * s + 0.15931422f) * s - 0.327622764f) * s * a + a;
    if (ay > ax) r = 1.57079637f - r;
    if (x < 0.0f) r = 3.14159274f - r;
    if (y < 0.0f) r = -r;
    return r;
}

// ── NCO ──────────────────────────────────────────────────────────────────--
void NCO::setFreq(double normFreq) {
    const double step = 2.0 * M_PI * normFreq;     // radians/sample
    rot_ = cf32((float)std::cos(step), (float)-std::sin(step));  // exp(-j*step)
}

void NCO::mix(const cf32* in, cf32* out, int n) {
    cf32 cur = cur_;
    const cf32 rot = rot_;
    for (int i = 0; i < n; ++i) {
        out[i] = in[i] * cur;     // multiply by running phasor (no per-sample trig)
        cur *= rot;
        // Renormalise occasionally so |cur| doesn't drift from 1 (recursion error).
        if (++sinceNorm_ >= 1024) {
            sinceNorm_ = 0;
            const float m = 1.0f / std::sqrt(cur.real() * cur.real() + cur.imag() * cur.imag());
            cur *= m;
        }
    }
    cur_ = cur;
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
    : decim_(decim), phase_(decim), K_((int)taps.size()) {
    rtaps_.assign(taps.rbegin(), taps.rend());   // reversed for contiguous dot
    buf_.assign(K_ - 1, cf32(0.0f, 0.0f));        // K-1 sample history
}

void FirDecimator::reset() {
    std::fill(buf_.begin(), buf_.end(), cf32(0.0f, 0.0f));
    buf_.resize(K_ - 1);
    phase_ = decim_;
}

int FirDecimator::process(const cf32* in, int n, cf32* out) {
    // buf_ = [K-1 history][block]; y[i] = dot(rtaps_, &buf_[i]) over K samples.
    buf_.resize((size_t)(K_ - 1 + n));
    std::copy(in, in + n, buf_.begin() + (K_ - 1));
    const float* z = reinterpret_cast<const float*>(buf_.data());  // interleaved re/im
    int outn = 0;
    for (int i = 0; i < n; ++i) {
        if (--phase_ == 0) {
            phase_ = decim_;
            out[outn++] = dotCplx(rtaps_.data(), z + 2 * i, K_);
        }
    }
    // Carry the last K-1 samples as the next call's history.
    std::copy(buf_.end() - (K_ - 1), buf_.end(), buf_.begin());
    buf_.resize(K_ - 1);
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

// ── FM demod (quadrature discriminator) ──────────────────────────────────--
void FmDemod::process(const cf32* in, float* out, int n) {
    // Accurate atan2: the discriminator runs at the channel rate (cheap), and any
    // approximation error spreads into the 23-53 kHz MPX -> straight into the L-R
    // stereo difference. Quality here matters more than the few % CPU it costs.
    for (int i = 0; i < n; ++i) {
        const cf32 d = in[i] * std::conj(prev_);
        out[i] = gain_ * std::atan2(d.imag(), d.real());
        prev_ = in[i];
    }
}

// ── SSB / CW demod (Weaver / third method) ───────────────────────────────--
void SsbDemod::configure(Side side, double bwHz, double rate) {
    side_ = side;
    const double fc = bwHz * 0.5;              // sub-carrier = half the SSB bandwidth
    omega_ = 2.0 * M_PI * fc / rate;
    phase_ = 0.0;
    // Low-pass at bw/2 (normalised): keeps the centred wanted sideband, rejects
    // the image (which the down-mix pushed past +/- bw/2).
    const double cutoff = fc / rate;
    const double trans  = std::max(cutoff * 0.25, 0.0015);
    std::vector<float> taps = designLowpass(cutoff, trans);
    lpfI_ = std::make_unique<RealFir>(taps);
    lpfQ_ = std::make_unique<RealFir>(taps);
}

void SsbDemod::reset() {
    phase_ = 0.0;
    if (lpfI_) lpfI_->reset();
    if (lpfQ_) lpfQ_->reset();
}

void SsbDemod::process(const cf32* in, float* out, int n) {
    aI_.resize(n); aQ_.resize(n); cbuf_.resize(n); sbuf_.resize(n);
    // Mix DOWN by bw/2: a = z * conj(e^{j*phase}) = z * (cos - j sin).
    for (int i = 0; i < n; ++i) {
        const float c = std::cos(phase_), s = std::sin(phase_);
        cbuf_[i] = c; sbuf_[i] = s;
        const float zr = in[i].real(), zi = in[i].imag();
        aI_[i] = zr * c + zi * s;
        aQ_[i] = zi * c - zr * s;
        phase_ += omega_;
        if (phase_ > 2.0 * M_PI) phase_ -= 2.0 * M_PI;
    }
    fI_.resize(n); fQ_.resize(n);
    lpfI_->process(aI_.data(), n, fI_.data());
    lpfQ_->process(aQ_.data(), n, fQ_.data());
    // Mix UP and take real: USB = Re{aLPF * e^{j*phase}} = fI*c - fQ*s;
    // LSB = Re{aLPF * e^{-j*phase}} = fI*c + fQ*s.
    if (side_ == Side::USB) for (int i = 0; i < n; ++i) out[i] = fI_[i] * cbuf_[i] - fQ_[i] * sbuf_[i];
    else                    for (int i = 0; i < n; ++i) out[i] = fI_[i] * cbuf_[i] + fQ_[i] * sbuf_[i];
}

// ── Real FIR (low-pass / optional decimate) ──────────────────────────────--
RealFir::RealFir(std::vector<float> taps, int decim)
    : decim_(decim), phase_(decim), K_((int)taps.size()) {
    rtaps_.assign(taps.rbegin(), taps.rend());   // reversed for contiguous dot
    buf_.assign(K_ - 1, 0.0f);                     // K-1 sample history
}

void RealFir::reset() {
    std::fill(buf_.begin(), buf_.end(), 0.0f);
    buf_.resize(K_ - 1);
    phase_ = decim_;
}

int RealFir::process(const float* in, int n, float* out) {
    // buf_ = [K-1 history][block]; y[i] = dot(rtaps_, &buf_[i]) over K samples.
    buf_.resize((size_t)(K_ - 1 + n));
    std::copy(in, in + n, buf_.begin() + (K_ - 1));
    int outn = 0;
    for (int i = 0; i < n; ++i) {
        if (--phase_ == 0) {
            phase_ = decim_;
            out[outn++] = dotReal(rtaps_.data(), buf_.data() + i, K_);
        }
    }
    std::copy(buf_.end() - (K_ - 1), buf_.end(), buf_.begin());
    buf_.resize(K_ - 1);
    return outn;
}

} // namespace vibedsp
