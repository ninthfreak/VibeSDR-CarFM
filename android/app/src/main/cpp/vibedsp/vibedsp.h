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
#include <memory>
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

// ── ComplexFFT ───────────────────────────────────────────────────────────--
// Forward complex-to-complex FFT for the IQ WATERFALL. Output spans the full
// band -fs/2 .. +fs/2 (positive AND negative frequencies), so this — not RealFFT
// — is what the spectrum display uses. `size` is the bin count (power of two).
class ComplexFFT {
public:
    explicit ComplexFFT(int size);
    ~ComplexFFT();
    ComplexFFT(const ComplexFFT&) = delete;
    ComplexFFT& operator=(const ComplexFFT&) = delete;

    int size() const { return n_; }
    void forward(const cf32* in, cf32* out);  // raw, DC at bin 0

    // Power spectrum in dB, fftshifted so bin 0 = -fs/2 and bin n/2 = DC (the
    // layout a waterfall expects). `win` (length size) is applied if non-null.
    void powerDbShifted(const cf32* in, const float* win, float* outDb, float scale = 1.0f);

private:
    int n_;
    void* cfg_ = nullptr;            // kiss_fft_cfg
    std::vector<cf32> in_, out_;     // working buffers (length n_)
};

// ── Windows ──────────────────────────────────────────────────────────────--
// Fill `w` (length n) with the named window. Nuttall matches the current
// IQFrontEnd::FFTWindow::NUTTALL used by the shim so waterfall look is preserved.
void nuttallWindow(float* w, int n);
double windowCoherentGain(const float* w, int n); // sum(w)/n, for normalisation

// ── NCO / complex mixer ──────────────────────────────────────────────────--
// Frequency translation: multiplies the input by exp(-j*2*pi*f*n), i.e. shifts
// a signal at normalised frequency +f (cycles/sample, Hz/fs) down to 0 Hz.
// This is the "tune" stage of the DDC. Streaming; keeps phase across calls.
class NCO {
public:
    explicit NCO(double normFreq = 0.0) { setFreq(normFreq); }
    void setFreq(double normFreq);               // cycles/sample
    void mix(const cf32* in, cf32* out, int n);  // out[i] = in[i]*exp(-j*phase)
    void reset() { phase_ = 0.0; }
private:
    double phase_ = 0.0, step_ = 0.0;            // radians, radians/sample
};

// ── FIR low-pass design ──────────────────────────────────────────────────--
// Windowed-sinc real low-pass. `cutoff` and `transition` are normalised
// (cycles/sample). Returns unity-DC-gain taps. Used as the DDC anti-alias /
// channel filter ahead of decimation, and reusable for audio shaping.
std::vector<float> designLowpass(double cutoff, double transition);

// ── FIR decimator (complex) ──────────────────────────────────────────────--
// Applies a real-tap low-pass to a complex stream and keeps every Dth sample.
// Streaming: state persists across process() calls. Only computes the outputs
// it keeps (no wasted MACs on discarded samples).
class FirDecimator {
public:
    FirDecimator(std::vector<float> taps, int decim);
    // Filters `n` inputs; writes up to n/D (+/-1) outputs; returns the count.
    // `out` must hold at least n/decim + 1 samples.
    int process(const cf32* in, int n, cf32* out);
    int decim() const { return decim_; }
    int maxOut(int n) const { return n / decim_ + 1; }
    void reset();
private:
    std::vector<float> taps_;
    std::vector<cf32> hist_;     // circular delay line, length == taps
    int decim_, head_ = 0, count_;
};

// ── Rational resampler (real/mono) ───────────────────────────────────────--
// Polyphase up-by-L / down-by-M resampler giving an output rate of exactly
// inRate*L/M, with L/M = outRate/inRate reduced. Used to land demod audio on an
// exact 48 kHz so playback pitch is correct regardless of channel rate.
class RationalResampler {
public:
    RationalResampler(int inRate, int outRate);
    int process(const float* in, int n, float* out);   // returns #outputs
    int maxOut(int n) const { return (int)((long long)n * L_ / M_) + 2; }
    int L() const { return L_; }
    int M() const { return M_; }
    void reset();
private:
    int L_, M_, phaseLen_, cap_, head_ = 0;
    long long inCount_ = 0, outCount_ = 0;
    std::vector<float> h_;       // prototype low-pass, length phaseLen_*L_
    std::vector<float> hist_;    // ring of last cap_ inputs
};

// ── AM demodulator ───────────────────────────────────────────────────────--
// Envelope detector: audio = |z| with the carrier DC removed (one-pole DC
// blocker), then a fixed gain. Input is the DDC'd baseband channel; output is
// mono float audio at the channel rate. Streaming.
class AmDemod {
public:
    AmDemod() = default;
    void process(const cf32* in, float* out, int n);
    void reset() { dc_ = 0.0f; }
private:
    float dc_ = 0.0f;                  // DC-blocker state (running carrier level)
    static constexpr float kPole = 0.9995f;  // DC-blocker pole (~carrier removal)
    static constexpr float kGain = 2.0f;
};

// ── RxPipeline (the native engine) ───────────────────────────────────────--
// The complete IQ -> {spectrum, audio} chain that the shim's "Local Hardware
// (Native)" path runs, replacing the SDR++ Brown graph. Feed it raw IQ from the
// same source the shim already has (USB/rtl_tcp); it calls back with fftshifted
// spectrum dB rows and exact-48 kHz mono PCM. Phase 2 supports AM; more modes
// land in later phases behind the same interface.
class RxPipeline {
public:
    enum class Mode { AM /*, SSB_USB, SSB_LSB, CW, NFM, WFM (later phases) */ };

    struct Callbacks {
        void* ctx = nullptr;
        // fftshifted dB row, length == fftSize (bin 0 = -fs/2, fftSize/2 = DC).
        void (*spectrum)(void* ctx, const float* dbRow, int bins) = nullptr;
        // mono float audio at exactly outRate Hz.
        void (*audio)(void* ctx, const float* mono, int n, int outRate) = nullptr;
    };

    // sampleRate = input IQ rate; fftSize = waterfall bins; fftRate = frames/sec;
    // outRate = audio rate (48000). Safe to call once before feed().
    void start(double sampleRate, int fftSize, double fftRate, int outRate,
               const Callbacks& cb);
    // Tune the demod channel: offsetHz from band centre, mode, channel bandwidth.
    void setTune(double offsetHz, Mode mode, double bwHz);
    void feed(const cf32* iq, int n);   // raw IQ from the source
    void stop();
    int outRate() const { return outRate_; }

private:
    void rebuildAudio();
    // config
    double sampleRate_ = 0.0, fftRate_ = 20.0, offsetHz_ = 0.0, bwHz_ = 10000.0;
    int fftSize_ = 1024, outRate_ = 48000;
    Mode mode_ = Mode::AM;
    Callbacks cb_{};
    bool dirty_ = true;

    // spectrum
    std::unique_ptr<ComplexFFT> cfft_;
    std::vector<float> win_, specBuf_, specDb_;
    int specFill_ = 0;          // samples gathered toward the next frame
    int specStride_ = 0;        // input samples between emitted frames
    long long sinceFrame_ = 0;

    // audio DDC chain
    NCO nco_;
    std::unique_ptr<FirDecimator> dec_;
    std::unique_ptr<AmDemod> am_;
    std::unique_ptr<RationalResampler> resamp_;
    int chDecim_ = 1;
    double chFs_ = 0.0;
    std::vector<cf32> baseBuf_, chBuf_;
    std::vector<float> demodBuf_, audioBuf_;
};

} // namespace vibedsp
