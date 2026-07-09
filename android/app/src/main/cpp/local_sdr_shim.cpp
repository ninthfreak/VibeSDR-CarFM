// VibeSDR V5 — local-SDR shim implementation (NATIVE-ONLY, GPL-free).
//
// Pipeline (SDR++ Brown / FFTW / VOLK all removed as of V5):
//   RTL-SDR (USB fd) / RTL-TCP → u8 IQ → cf32 → vibedsp::RxPipeline
//     ├─ fftshifted FFT dB row → SPEC full-uint8 frames → /ws/user-spectrum
//     └─ DDC → demod (AM/SSB/CW/NFM/WFM stereo+RDS) → 48k float PCM
//                → /ws/audio  (WFM stereo, others mono)
//
// The on-device DSP is the clean-room `vibedsp` engine; the localhost HTTP/
// WebSocket server + RTL-TCP client use the clean-room `net_shim`. A minimal
// server (one thread per connection) speaks the UberSDR contract so the VibeSDR
// client connects unchanged. Control (zoom/tune/mode/bandwidth/set_rate/ping/
// reset) arrives as JSON text frames. librtlsdr (USB driver + HW controls) is
// the only remaining native dependency.

#include "local_sdr_shim.h"

// Android builds the USB/librtlsdr local-hardware path; iOS builds only the
// RTL-TCP path (no USB host SDR on iOS). The USB code stays compiled on iOS via a
// no-op rtl-sdr stub (start() is never invoked there), so the shared DSP/net/
// RTL-TCP code below needs no per-call-site #ifdefs.
#ifdef __ANDROID__
  #include <android/log.h>
  #include <rtl-sdr.h>
#else
  #include "rtl_sdr_stub.h"   // iOS: no-op rtlsdr_* decls so the USB path compiles
#endif
#include <unistd.h>
// Thread naming + audio priority are Android/Linux-only (Darwin/iOS has no
// <sys/prctl.h> / PR_SET_NAME). Guard so the shared shim still compiles for the
// iOS prebuilt lib, where these are no-ops. `vibeAudioThread` = name + real
// URGENT_AUDIO priority (nice -19) for the DSP/audio thread; `vibeThreadName` =
// name only, so a spinning thread is identifiable in `top -H` / systrace instead
// of showing as the inherited RN "mqt_v_native".
#if defined(__ANDROID__)
  #include <sys/resource.h>   // setpriority
  #include <sys/prctl.h>      // PR_SET_NAME
  static inline void vibeAudioThread(const char* name) {
      prctl(PR_SET_NAME, name);
      setpriority(PRIO_PROCESS, 0, -19); // = Process.THREAD_PRIORITY_URGENT_AUDIO
  }
  static inline void vibeThreadName(const char* name) { prctl(PR_SET_NAME, name); }
#else
  static inline void vibeAudioThread(const char*) {}
  static inline void vibeThreadName(const char*) {}
#endif

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <deque>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#if defined(__aarch64__)
  #include <arm_neon.h>             // NEON u8->f32 IQ conversion
#endif

#include "vibedsp/vibedsp.h"        // V5 clean-room GPL-free DSP engine (RxPipeline)
#include "net_shim.h"
#include "spyserver/spyserver_client.h"               // V5 clean-room GPL-free TCP socket wrapper
#include "decoders/fsk_decoder.h"   // RTTY/NAVTEX (audio-extension decoder)
#include "decoders/wefax_decoder.h" // WEFAX (audio-extension decoder)
#include "decoders/ft8_decoder.h"   // FT8/FT4 → digital spots
#include "decoders/sstv_decoder.h"  // SSTV (audio-extension image decoder)
#include "decoders/audio_nr.h"      // self-contained spectral-subtraction audio NR
#include "decoders/auto_notch.h"    // NLMS automatic notch (adaptive line enhancer)

#define LOG_TAG "VibeLocalSDR"
#ifdef __ANDROID__
  #define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  LOG_TAG, __VA_ARGS__)
  #define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)
#else
  #include <cstdio>
  #define LOGI(...) do { fprintf(stderr, "[" LOG_TAG "] "); fprintf(stderr, __VA_ARGS__); fprintf(stderr, "\n"); } while (0)
  #define LOGE(...) do { fprintf(stderr, "[" LOG_TAG " E] "); fprintf(stderr, __VA_ARGS__); fprintf(stderr, "\n"); } while (0)
#endif

namespace vibe {
namespace {

// V5: the on-device DSP is now the clean-room GPL-free engine. These local
// aliases replace the old SDR++ dsp:: sample types so the decoder/audio feed
// code below is unchanged (it only ever touched .l / .r).
using cf32     = vibedsp::cf32;       // interleaved IQ sample (std::complex<float>)
using stereo_t = vibedsp::stereo;     // { float l, r; }
// Cap on samples copied out of one IQ buffer (was SDR++'s STREAM_BUFFER_SIZE).
constexpr int STREAM_BUFFER_SIZE = 1000000;

// Convert `nF` interleaved u8 I/Q bytes to floats: f = (b - 127.4)/128. Runs at
// the full IQ rate (2.4 MHz) for every mode, so NEON it on AArch64.
static inline void convU8ToF32(const uint8_t* in, float* out, int nF) {
#if defined(__aarch64__)
    const float32x4_t bias = vdupq_n_f32(127.4f), inv = vdupq_n_f32(1.0f / 128.0f);
    int i = 0;
    for (; i + 16 <= nF; i += 16) {
        const uint8x16_t b = vld1q_u8(in + i);
        const uint16x8_t lo = vmovl_u8(vget_low_u8(b)), hi = vmovl_u8(vget_high_u8(b));
        const float32x4_t f0 = vcvtq_f32_u32(vmovl_u16(vget_low_u16(lo)));
        const float32x4_t f1 = vcvtq_f32_u32(vmovl_u16(vget_high_u16(lo)));
        const float32x4_t f2 = vcvtq_f32_u32(vmovl_u16(vget_low_u16(hi)));
        const float32x4_t f3 = vcvtq_f32_u32(vmovl_u16(vget_high_u16(hi)));
        vst1q_f32(out + i,      vmulq_f32(vsubq_f32(f0, bias), inv));
        vst1q_f32(out + i + 4,  vmulq_f32(vsubq_f32(f1, bias), inv));
        vst1q_f32(out + i + 8,  vmulq_f32(vsubq_f32(f2, bias), inv));
        vst1q_f32(out + i + 12, vmulq_f32(vsubq_f32(f3, bias), inv));
    }
    for (; i < nF; ++i) out[i] = ((float)in[i] - 127.4f) * (1.0f / 128.0f);
#else
    for (int i = 0; i < nF; ++i) out[i] = ((float)in[i] - 127.4f) * (1.0f / 128.0f);
#endif
}

// ── SHA1 + base64 (WebSocket handshake) ─────────────────────────────────────
struct Sha1 {
    uint32_t h[5] = {0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0};
    static uint32_t rol(uint32_t v, int b) { return (v << b) | (v >> (32 - b)); }
    void hash(const uint8_t* msg, size_t len, uint8_t out[20]) {
        std::vector<uint8_t> data(msg, msg + len);
        uint64_t ml = (uint64_t)len * 8;
        data.push_back(0x80);
        while (data.size() % 64 != 56) data.push_back(0x00);
        for (int i = 7; i >= 0; i--) data.push_back((uint8_t)(ml >> (i * 8)));
        for (size_t off = 0; off < data.size(); off += 64) {
            uint32_t w[80];
            for (int i = 0; i < 16; i++)
                w[i] = (data[off+i*4]<<24)|(data[off+i*4+1]<<16)|(data[off+i*4+2]<<8)|data[off+i*4+3];
            for (int i = 16; i < 80; i++) w[i] = rol(w[i-3]^w[i-8]^w[i-14]^w[i-16], 1);
            uint32_t a=h[0],b=h[1],c=h[2],d=h[3],e=h[4];
            for (int i = 0; i < 80; i++) {
                uint32_t f, k;
                if (i<20){f=(b&c)|(~b&d);k=0x5A827999;}
                else if(i<40){f=b^c^d;k=0x6ED9EBA1;}
                else if(i<60){f=(b&c)|(b&d)|(c&d);k=0x8F1BBCDC;}
                else{f=b^c^d;k=0xCA62C1D6;}
                uint32_t t=rol(a,5)+f+e+k+w[i]; e=d;d=c;c=rol(b,30);b=a;a=t;
            }
            h[0]+=a;h[1]+=b;h[2]+=c;h[3]+=d;h[4]+=e;
        }
        for (int i=0;i<5;i++){out[i*4]=(uint8_t)(h[i]>>24);out[i*4+1]=(uint8_t)(h[i]>>16);
                              out[i*4+2]=(uint8_t)(h[i]>>8);out[i*4+3]=(uint8_t)h[i];}
    }
};
std::string base64(const uint8_t* in, size_t len) {
    static const char* t = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    for (size_t i = 0; i < len; i += 3) {
        uint32_t n = in[i] << 16;
        if (i+1 < len) n |= in[i+1] << 8;
        if (i+2 < len) n |= in[i+2];
        out.push_back(t[(n>>18)&63]); out.push_back(t[(n>>12)&63]);
        out.push_back(i+1<len ? t[(n>>6)&63] : '=');
        out.push_back(i+2<len ? t[n&63] : '=');
    }
    return out;
}
std::string jsonStr(const std::string& s, const char* key) {
    std::string pat = std::string("\"") + key + "\"";
    auto p = s.find(pat); if (p == std::string::npos) return "";
    p = s.find(':', p); if (p == std::string::npos) return "";
    p = s.find('"', p); if (p == std::string::npos) return "";
    auto q = s.find('"', p+1); if (q == std::string::npos) return "";
    return s.substr(p+1, q-p-1);
}
bool jsonNum(const std::string& s, const char* key, double& out) {
    std::string pat = std::string("\"") + key + "\"";
    auto p = s.find(pat); if (p == std::string::npos) return false;
    p = s.find(':', p); if (p == std::string::npos) return false;
    out = strtod(s.c_str() + p + 1, nullptr);
    return true;
}

constexpr double AUDIO_SR = 48000.0;
// FFT averaging: the front end runs FFT_AVG× the emit rate and we block-average
// that many independent FFTs per emitted frame. Cuts per-frame variance so the
// spectrum/waterfall doesn't shimmer (UberSDR/SDR++ average similarly).
constexpr int FFT_AVG = 4;
// Bins actually sent to the client (= waterfall texture width). Kept GPU-safe
// (a 32768-wide texture exceeds mobile GPU max texture size → blank waterfall).
// The internal FFT is finer (fftSizeForRate); we downsample/crop to this.
constexpr int OUT_BINS = 4096;

// Per-mode demod parameters.
struct ModeParams {
    enum Kind { AM, SSB_USB, SSB_LSB, CW, NFM, WFM } kind;
    double ifRate;
    double bandwidth;
    int channels;
};
// Pick the FFT size for a given sample rate to hold ~constant Hz/bin so detail
// stays uniform and scales with bandwidth. ~75 Hz/bin → fine enough that
// zoomed-in views (crop-zoom stretches existing bins, it doesn't add resolution)
// still have plenty of bins. Smallest power-of-2 >= rate/75, clamped [4096, 32768].
int fftSizeForRate(double rate) {
    double want = rate / 75.0;
    int s = 4096;
    while (s < (int)want && s < 32768) s *= 2;
    return s;
}

ModeParams paramsFor(const std::string& mode) {
    if (mode == "usb")            return {ModeParams::SSB_USB, 24000, 2700, 1};
    if (mode == "lsb")            return {ModeParams::SSB_LSB, 24000, 2700, 1};
    if (mode == "am" || mode == "sam") return {ModeParams::AM, 15000, 10000, 1};
    if (mode == "cwu" || mode == "cwl" || mode == "cw") return {ModeParams::CW, 8000, 1200, 1};
    if (mode == "wfm")            return {ModeParams::WFM, 250000, 200000, 2};  // NB: ifRate field is unused/dead
    /* nfm / fm */                return {ModeParams::NFM, 50000, 12500, 1};
}

// Map the shim's mode kind onto the V5 engine's demod mode.
vibedsp::RxPipeline::Mode rxModeFor(ModeParams::Kind k) {
    using M = vibedsp::RxPipeline::Mode;
    switch (k) {
        case ModeParams::AM:       return M::AM;
        case ModeParams::SSB_USB:  return M::SSB_USB;
        case ModeParams::SSB_LSB:  return M::SSB_LSB;
        case ModeParams::CW:       return M::CW;
        case ModeParams::WFM:      return M::WFM;
        case ModeParams::NFM:      default: return M::NFM;
    }
}

} // namespace

// ── Impl ────────────────────────────────────────────────────────────────────
struct LocalSdrShim::Impl {
    bool decoderOnly = false;             // sidecar mode: decoders only, no RTL
    std::vector<float> pcmResid;          // upsample carry (fractional sample pos)
    double pcmAcc = 0.0;
    // device / params
    rtlsdr_dev_t* dev = nullptr;
    // Our OWN dup() of the USB fd. rtlsdr_open_sys_dev → libusb_wrap_sys_device
    // does NOT take ownership of the fd, so if we used Kotlin's fd directly the
    // detached teardown thread (rtlsdr_cancel_async / joins / rtlsdr_close) would
    // race Kotlin's UsbDeviceConnection.close() on that same fd → use-after-free
    // SIGSEGV. dup() gives us an independent fd to the same open file description:
    // Kotlin closing its copy can't pull the rug from libusb, and we close ours
    // after rtlsdr_close on the teardown thread.
    int usbFd = -1;
    // RTL-TCP source (rtl_tcp protocol over the network, no USB/librtlsdr — so it
    // works on iOS too). When tcpSock is set, the IQ comes from this socket and the
    // hardware setters send rtl_tcp commands instead of calling rtlsdr_*.
    std::shared_ptr<net::Socket> tcpSock;
    std::atomic<bool> tcpRunning{false};

    // SpyServer client path. Mutually exclusive with tcpSock/dev — the shim drives
    // exactly one IQ source. IQ arrives as u8 (we negotiate FORMAT_UINT8), which is
    // byte-identical to what the USB and rtl_tcp paths feed enqueueIq().
    std::unique_ptr<spyserver::SpyServerClient> spy;
    bool useSpy() const { return (bool)spy; }
    std::vector<int> spyGains;             // device gain table (tenths dB)
    int lastGainTenthDb = -1;              // re-applied across a stream restart

    // Wide-waterfall geometry. The server's FFT stream spans maximumBandwidth and
    // is centred on SETTING_FFT_FREQUENCY, INDEPENDENTLY of the narrow IQ we
    // demodulate (verified on the wire — see spyserver/PROTOCOL_NOTES.md). That
    // split is the entire point: 2 MHz of waterfall for ~30 KB/s while the IQ
    // stays narrow enough to stream over cellular.
    double spyFftSpan = 0.0;               // 0 = not a SpyServer session
    uint32_t spyIqFormat = 1;              // FORMAT_UINT8 / FORMAT_INT16, per device resolution
    std::atomic<double> spyFftCenter{0.0};
    int spyDecim = 0;
    uint32_t spyDbRange = 140;

    // The span the CLIENT thinks it is looking at. Everywhere except SpyServer the
    // display span is just the IQ rate; there it is the server's FFT span.
    double displaySpan() const { return spyFftSpan > 0.0 ? spyFftSpan : sampleRate; }

    int tcpTunerType = 0;
    std::vector<int> tcpGains;            // tuner gains (tenths dB) from the header
    // rtl_tcp 5-byte command: [code][param big-endian u32].
    void sendTcpCmd(uint8_t code, uint32_t param) {
        auto s = tcpSock; if (!s) return;
        uint8_t c[5] = { code, (uint8_t)(param >> 24), (uint8_t)(param >> 16),
                         (uint8_t)(param >> 8), (uint8_t)param };
        s->send(c, 5);
    }
    bool useTcp() const { return (bool)tcpSock; }
    double sampleRate = 2400000.0;
    int    fftSize    = 1024;
    double fftRate    = 20.0;
    std::atomic<double> rtlCenter{100000000.0}; // RTL tuned (dongle) centre — the DC of the capture
    std::atomic<double> viewCenter{100000000.0};// DISPLAY centre — may sit off the dongle centre so
                                                // the user can pan the view across the captured band
                                                // while a station stays tuned (RF-centre marker = dongle).
    std::atomic<double> audioFreq{100000000.0}; // demod dial frequency (VFO)
    std::atomic<int>    rateDivisor{1};
    std::atomic<double> zoomFactor{1.0}; // spectrum zoom: FFT-crop factor (>=1)
    std::string mode = "nfm";
    double demodOffset = 0.0;             // VFO offset for the mode (SSB = ±bw/2)
    // Recursive: setSampleRate holds it across its full teardown+rebuild and then
    // calls buildAudio() (which re-locks). Serialises EVERY audio-chain rebuild
    // (WS handleControl mode/tune AND the JS-driven HW setters) so they can't race
    // the shared resamp/demod members → dsp registerInput() double-init abort.
    std::recursive_mutex modeMtx;
    // Squelch — keys off the pre-AGC tuned-channel power from the FFT (post-demod
    // audio is AGC-flattened, so its level can't gate). channelDb is the peak
    // dB in the demod passband, updated in onFFT.
    std::atomic<bool>  squelchOn{false};
    std::atomic<float> squelchDb{-50.0f};
    std::atomic<double> vfoBwHz{12000.0};   // current demod bandwidth
    std::atomic<float>  channelDb{-200.0f};  // peak passband power (dB), pre-AGC
    // Audio noise reduction (self-contained spectral subtraction). Mono only;
    // off by default. No external resources → can't fail to init.
    std::atomic<bool>  nrOn{false};
    std::atomic<float> nrCpuPct{0.0f};      // rolling CPU% (NR time / wall time)
    std::mutex         nrMtx;
    AudioNR*           nrEng = nullptr;
    double nrBusyNs = 0.0, nrWallNs = 0.0;  // CPU% accumulators

    // Auto notch (NLMS adaptive line enhancer). Mono only; off by default.
    // Listening-path only — applied AFTER the decoder taps so tone decoders
    // (FT8/RTTY/CW) still see un-notched audio.
    std::atomic<bool>  notchOn{false};
    std::mutex         notchMtx;
    AutoNotch*         notchEng = nullptr;

    // V5 engine: the IQ -> {spectrum, audio} chain (replaces SDR++ IQFrontEnd +
    // VFO + demod graph). Fed raw IQ from the USB/TCP worker; calls back with a
    // fftshifted dB row (-> onSpectrum) and float PCM (-> onAudioPcm). Touch only
    // under modeMtx — feed() runs rebuildAudio() inline, so setTune from the WS/HW
    // threads must be serialised against the IQ worker.
    vibedsp::RxPipeline rx;
    std::vector<float> fftAccum;    // running sum for FFT averaging (fftshifted)
    int accumCount = 0;
    std::thread rtlThread;

    // IQ producer/consumer. CRITICAL: rtlsdr_read_async's callback runs on
    // libusb's event-handling thread, so it must return fast — running the heavy
    // DSP (rx.feed: FFT + WFM/RDS demod) inline there starves libusb and corrupts
    // its locks (HW control transfers then stall for seconds and SIGABRT on a
    // "destroyed mutex"). So the USB/TCP reader only CONVERTS + ENQUEUES IQ here;
    // a dedicated dspThread drains the queue and runs rx.feed off the libusb path
    // (mirrors how SDR++ ran the DSP on its own threads).
    std::deque<std::vector<cf32>> iqQueue;
    std::mutex iqMtx;
    std::condition_variable iqCv;
    std::condition_variable iqSpaceCv;          // TCP reader waits here when full
    std::atomic<bool> dspRunning{false};
    std::thread dspThread;
    static constexpr size_t IQ_QUEUE_MAX = 8;   // USB: drop oldest beyond this (overrun)

    // ── Network jitter buffer (TCP path only) ────────────────────────────────
    // USB IQ arrives on a hardware clock and the queue idles near empty, so 8
    // chunks is plenty. NETWORK IQ arrives in bursts around WiFi stalls, and the
    // DSP thread is NOT paced by the audio sink (audio is pushed non-blocking to
    // the WebView over the localhost WS) — it drains as fast as the CPU allows and
    // then blocks on iqCv. So the stream's timing comes straight from the socket:
    // a 200 ms radio stall punches a 200 ms hole in the audio.
    //
    // Fix: prefill a standing backlog before the DSP starts draining. Because the
    // DSP can only consume what arrives (it blocks when empty), that backlog then
    // PERSISTS as a delay line — a stall eats the backlog instead of the audio,
    // and the recovery burst refills it. Costs `prefill` of latency, buys `prefill`
    // of stall tolerance.
    //
    // Sized in samples, not chunks: TCP recv() returns whatever is available, so
    // chunk counts wouldn't pin the latency. cf32 = 8 bytes/sample, so at 2.4 MSPS
    // 250 ms is ~4.8 MB and the 2x cap ~9.6 MB.
    size_t iqQueuedSamples = 0;
    size_t iqPrefillSamples = 0;                // 0 = no prefill (USB path)
    size_t iqMaxSamples     = 0;                // 0 = unused (USB path)
    bool   iqPrefilled      = false;            // set once the backlog is built
    std::atomic<uint64_t> iqDroppedSamples{0};  // client-side overruns (was silent)

    // Network stalls: the socket delivered NOTHING for longer than this. Measured on
    // the reader thread, which is the only place that sees the network directly.
    //
    // Do NOT measure this as "iqQueue went empty" — the DSP drains faster than real
    // time and parks on iqCv, so an empty queue is the normal resting state and
    // would read as a permanent stall.
    static constexpr int64_t kStallMs = 120;    // ~2 WiFi beacon intervals
    std::atomic<uint64_t> netStalls{0};

    // Offset tuning: the RTL is physically tuned HW_OFFSET_HZ ABOVE the logical
    // centre (rtlCenter) so the zero-IF DC spike never lands on the channel —
    // on-carrier AM otherwise breaks up. This is purely internal: the client
    // protocol (rtlCenter as the display centre) is unchanged; we compensate in
    // the VFO offset and shift the displayed FFT crop back by the same amount.
    static constexpr double HW_OFFSET_HZ = 15000.0;

    // Physical DC of the FFT = rtlCenter + HW_OFFSET_HZ, so the VFO (at audioFreq)
    // sits HW_OFFSET_HZ below DC.
    double vfoOffsetNow() { return audioFreq.load() - rtlCenter.load() - HW_OFFSET_HZ + demodOffset; }

    // Margin keeping the VFO inside the usable capture: above the 50 kHz auto-
    // retune threshold AND clear of the RTL anti-alias rolloff (~10%). MUST
    // match the JS client (UberSDRClient panSpan / rfCenter derivation).
    double viewDongleMargin() { return std::max(sampleRate * 0.10, 60000.0); }

    // Dongle (RTL) centre for a requested DISPLAY centre: the dongle follows the
    // view, but is clamped so the VFO never leaves the usable capture — at which
    // point it "locks" and the view keeps panning across the captured band.
    double dongleForView(double view) {
        double lim = sampleRate / 2.0 - viewDongleMargin();
        double v = audioFreq.load();
        return std::min(v + lim, std::max(v - lim, view));
    }

    // Tune the radio to (logical centre + HW_OFFSET_HZ).
    void tuneHw(double logicalCenter) {
        uint32_t hz = (uint32_t)llround(logicalCenter + HW_OFFSET_HZ);
        if (useSpy()) {
            // ONLY the IQ centre. The server's FFT centre stays where it is, so the
            // wide waterfall does not jump when the VFO drags the narrow IQ window
            // around. (Verified: the two centres are independent. SDR# does this.)
            spy->setIqFrequency(hz);
        }
        else if (useTcp()) sendTcpCmd(0x01, hz);
        else if (dev) rtlsdr_set_center_freq(dev, hz);
    }

    // audio chain config (the engine itself lives in `rx`). buildAudio() maps the
    // mode string -> these + rx.setTune(); retune/setBandwidth re-issue setTune
    // with the cached mode/bw so a dial move doesn't need a full mode rebuild.
    vibedsp::RxPipeline::Mode rxMode = vibedsp::RxPipeline::Mode::NFM;
    double rxBwHz = 12500.0;
    std::atomic<int> audioChannels{1};
    std::atomic<float> audioGain{1.0f};   // per-mode output trim (AM is hotter)
    double deempTau = 50e-6;   // FM de-emphasis time constant (0 = off); 50us EU / 75us US

    // WFM RDS (fed by the engine's rdsPs/rdsText callbacks) + stereo-pilot lock.
    std::mutex rdsMtx;
    std::string rdsPsName, rdsText;
    int rdsPi = -1;
    int rdsEcc = 0;                          // RDS Extended Country Code (0 = none)
    std::atomic<bool> stereoDetected{false};
    std::atomic<float> spectrumSnr{0.0f};   // peak−floor (dB), centre vs edges

    // Audio-extension decoder (RTTY etc.) on /ws/dxcluster — fed the demod audio.
    std::mutex decoderMtx;
    FskDecoder* decoder = nullptr;
    WefaxDecoder* wefax = nullptr;          // active image decoder (WEFAX), or null
    // FT8/FT4 digital-spots decoders (independent of the text/image decoders).
    std::mutex spotsMtx;
    Ft8Decoder* ft8 = nullptr;
    Ft8Decoder* ft4 = nullptr;
    bool spotsActive = false;
    int  spotDecim = 0;                      // 48k→12k decimation counter
    float spotAcc = 0.0f;                    // box-average accumulator
    // SSTV image decoder (audio-extension). Runs a video-decode thread, so all
    // dxClient sends are serialised through dxSendMtx.
    SstvDecoder* sstv = nullptr;
    int  sstvDecim = 0; float sstvAcc = 0.0f;
    std::mutex dxSendMtx;
    std::shared_ptr<net::Socket> dxClient;
    std::string decTextBuf;                 // decoded chars awaiting flush (UTF-8)
    std::mutex decBufMtx;

    // server
    std::shared_ptr<net::Listener> listener;
    std::thread acceptThread;
    std::vector<std::thread> connThreads;
    std::mutex connMtx;
    std::atomic<bool> serverRunning{false};
    int port = 0;

    // clients
    std::mutex clientMtx;
    std::shared_ptr<net::Socket> specClient;
    std::shared_ptr<net::Socket> audioClient;
    std::atomic<uint64_t> frameCounter{0};

    std::mutex sendMtx; // serialises all WS writes (both directions are split, sends here)

    // ── Spectrum callback (Stage 3) ────────────────────────────────────────
    // The V5 engine hands us a fftshifted dB row (bin 0 = -fs/2, bins/2 = DC),
    // one per FFT, at FFT_AVG× the emit rate. We block-average FFT_AVG of them to
    // kill shimmer, then crop/zoom to OUT_BINS and key squelch/SNR — all in the
    // fftshifted layout (DC at bins/2), unlike the old raw-order IQFrontEnd path.
    static void specCb(void* ctx, const float* db, int bins) { ((Impl*)ctx)->onSpectrum(db, bins); }
    void onSpectrum(const float* db, int bins) {
        if ((int)fftAccum.size() != bins) { fftAccum.assign(bins, 0.0f); accumCount = 0; }
        for (int i = 0; i < bins; i++) fftAccum[i] += db[i];
        if (++accumCount < FFT_AVG) return;
        float inv = 1.0f / (float)accumCount;
        // Averaged dB at a signed bin offset from DC (DC = bins/2 in fftshifted).
        auto dbAt = [&](int sOff) -> float {
            int idx = bins / 2 + sOff;
            if (idx < 0) idx = 0; else if (idx >= bins) idx = bins - 1;
            return fftAccum[idx] * inv;
        };

        uint64_t n = frameCounter.fetch_add(1);
        int div = rateDivisor.load();
        bool emit = !(div > 1 && (n % (uint64_t)div) != 0);
        std::shared_ptr<net::Socket> sock;
        { std::lock_guard<std::mutex> lk(clientMtx); sock = specClient; }

        // Hybrid waterfall: the IQ FFT only covers `sampleRate` of spectrum. When the
        // user is zoomed out past that (SpyServer only, where displaySpan is wider),
        // the server's FFT stream paints the frame instead — see emitServerFft().
        // Zoomed in, we win: our own FFT of the narrow IQ has far finer bins than
        // the server's ~977 Hz.
        const double shownHz = displaySpan() / zoomFactor.load();
        if (emit && shownHz > sampleRate * 0.95) emit = false;

        if (emit && sock && sock->isOpen()) {
            // Emit a FIXED OUT_BINS bins (GPU-safe waterfall texture width — a
            // 32768-wide texture exceeds mobile GPU limits and the waterfall
            // silently fails). Map the fine internal FFT (bins) to the output,
            // applying zoom: each output bin covers `step` source bins; peak-hold
            // when downsampling (don't drop narrow carriers).
            double zoom = zoomFactor.load();
            const int outBins = OUT_BINS;
            // Source bins per output bin. Written in terms of the DISPLAY span so it
            // stays correct when that is decoupled from the IQ rate (SpyServer).
            // Reduces to bins/(zoom*outBins) whenever displaySpan == sampleRate.
            const double srcBinHz = sampleRate / (double)bins;
            const double step = (shownHz / (double)outBins) / srcBinHz;  // src bins / out bin
            std::vector<uint8_t> frame(22 + outBins);
            frame[0]='S';frame[1]='P';frame[2]='E';frame[3]='C';frame[4]=0x01;frame[5]=0x03;
            uint64_t ts = (uint64_t)std::chrono::duration_cast<std::chrono::nanoseconds>(
                std::chrono::system_clock::now().time_since_epoch()).count();
            std::memcpy(&frame[6], &ts, 8);
            // Offset tuning: the physical DC sits HW_OFFSET_HZ above rtlCenter, so
            // shift the crop down by that many source bins to keep the display
            // centred on the logical centre (rtlCenter) — the DC spike then draws
            // HW_OFFSET_HZ off-centre, harmlessly outside the channel.
            const double hwOffsetBin = HW_OFFSET_HZ * (double)bins / sampleRate;
            // The display centre is viewCenter, which may sit off the dongle
            // centre (rtlCenter) — shift the crop by their difference so the user
            // can pan the view across the captured band while the dongle (and the
            // tuned VFO) stay put. dbAt clamps past the capture edge → floor.
            const double viewOffsetBin = (viewCenter.load() - rtlCenter.load()) * (double)bins / sampleRate;
            uint64_t f = (uint64_t)llround(viewCenter.load());   // display centre = view centre
            std::memcpy(&frame[14], &f, 8);
            for (int i = 0; i < outBins; i++) {
                int signedOut = (i <= outBins / 2) ? i : i - outBins;
                double center = signedOut * step - hwOffsetBin + viewOffsetBin;  // signed src offset from DC
                int lo = (int)std::floor(center - step / 2.0);
                int hi = (int)std::ceil(center + step / 2.0);
                if (hi <= lo) hi = lo + 1;
                float best = -1e9f;
                for (int s = lo; s < hi; s++) {
                    float val = dbAt(s);                    // averaged dB
                    if (val > best) best = val;             // peak-hold
                }
                int v = (int)lround(best + 256.0);
                frame[22+i] = (uint8_t)(v < 0 ? 0 : (v > 255 ? 255 : v));
            }
            // Station presence (full-span, zoom-independent): a station is a broad
            // hump at centre, static is flat. Compare centre band (±100 kHz, less
            // the ±3 kHz DC spike) to the band edges.
            {
                double binHz = sampleRate / (double)bins;
                int half = std::min(bins / 4, (int)(100000.0 / binHz));
                int skip = std::min(half - 1, std::max(1, (int)(3000.0 / binHz)));
                double cSum = 0; int cN = 0;
                for (int i = skip; i <= half; i++)           { cSum += dbAt(i); cSum += dbAt(-i); cN += 2; }
                double eSum = 0; int eN = 0;
                for (int i = 0; i <= half / 2; i++)          { eSum += dbAt(-(bins/2) + i); eSum += dbAt((bins/2 - 1) - i); eN += 2; }
                spectrumSnr.store((cN && eN) ? (float)(cSum/cN - eSum/eN) : 0.0f);
            }
            sendWs(sock, 0x2, frame.data(), frame.size());
            if (n % 10 == 0) sendFmMeta(sock);   // RDS + stereo ~1/sec
        }
        // Tuned-channel power for squelch (peak dB in the demod passband).
        {
            double binHz = sampleRate / (double)bins;
            int cbin = (int)llround(vfoOffsetNow() / binHz);
            int hw = std::max(1, (int)(vfoBwHz.load() / 2.0 / binHz));
            float peak = -1e9f;
            for (int o = -hw; o <= hw; o++) {
                float v = dbAt(cbin + o);
                if (v > peak) peak = v;
            }
            channelDb.store(peak);
        }
        std::fill(fftAccum.begin(), fftAccum.end(), 0.0f);
        accumCount = 0;
    }

    // Re-negotiate the IQ decimation for the current mode (SpyServer only).
    //
    // Decimation is chosen from the demod bandwidth, so a mode change can demand a
    // different rate — NFM at stage 5 gives 75 kHz of IQ, which cannot carry WFM's
    // 200 kHz. The protocol has no in-place decimation change (stock clients always
    // stop, resend every setting, and restart), so that is what we do. Brief audio
    // gap, exactly as SDR#/SDR++ exhibit.
    //
    // Caller must NOT hold modeMtx: stopDspThread() joins the DSP thread, which
    // takes modeMtx per buffer, so holding it here would deadlock (the same trap
    // setSampleRate() documents). Returns true if the stream was restarted.
    bool spyRetuneDecimation() {
        if (!useSpy()) return false;
        const auto& info = spy->deviceInfo();
        const auto mp = paramsFor(mode);
        const double needHz = std::max(mp.bandwidth * 1.6, 48000.0);
        const uint32_t maxStage = std::max(info.decimationStageCount, info.minimumIQDecimation);
        int decim = (int)info.minimumIQDecimation;      // never below the server's floor
        for (uint32_t st = info.minimumIQDecimation; st <= maxStage; ++st) {
            const double r = (double)info.maximumSampleRate / (double)(1u << st);
            if (r < needHz) break;
            decim = (int)st;
        }
        if (decim == spyDecim) return false;

        const double newRate = (double)info.maximumSampleRate / (double)(1u << decim);
        LOGI("SpyServer mode=%s -> decim %d..%d (%.0f -> %.0f S/s)",
             mode.c_str(), spyDecim, decim, sampleRate, newRate);

        // Quiesce the DSP before the rate changes underneath it, exactly as
        // setSampleRate() does for the USB path.
        tcpRunning.store(false);
        stopDspThread();

        spyDecim   = decim;
        sampleRate = newRate;
        fftSize    = fftSizeForRate(sampleRate);
        iqPrefillSamples = (size_t)(sampleRate * 0.25);
        iqMaxSamples     = iqPrefillSamples * 2;

        const uint32_t iqHz  = (uint32_t)llround(rtlCenter.load() + HW_OFFSET_HZ);
        const uint32_t fftHz = (uint32_t)llround(spyFftCenter.load());
        const uint32_t gainIdx = lastGainTenthDb < 0
            ? (uint32_t)(spyGains.size() / 2)
            : spyserver::SpyServerClient::gainIndexForTenthDb(spyGains, lastGainTenthDb);
        spy->startStream(spyserver::STREAM_MODE_IQ | spyserver::STREAM_MODE_FFT,
                         spyIqFormat, (uint32_t)decim, iqHz, gainIdx, 2048, fftHz);

        rx.stop();
        startEngine();
        startDspThread();
        tcpRunning.store(true);
        { std::lock_guard<std::mutex> lk(clientMtx); if (specClient) sendConfig(specClient); }
        return true;
    }

    // Paint the waterfall from the SERVER's FFT stream (SpyServer wide view).
    // Mirrors onSpectrum's frame format exactly — same SPEC header, same OUT_BINS,
    // same peak-hold downsample — but reads u8 dB bins spanning spyFftSpan around
    // spyFftCenter instead of our own FFT of the IQ.
    //
    // Skipped whenever the view fits inside the IQ window: there onSpectrum's own
    // FFT is far finer (36 Hz vs ~977 Hz bins), so the zoom drum stays smooth.
    void emitServerFft(const uint8_t* bins, int n) {
        if (n <= 1 || spyFftSpan <= 0.0) return;
        const double shownHz = displaySpan() / zoomFactor.load();
        if (shownHz <= sampleRate * 0.95) return;      // zoomed in: IQ FFT owns it

        std::shared_ptr<net::Socket> sock;
        { std::lock_guard<std::mutex> lk(clientMtx); sock = specClient; }
        if (!sock || !sock->isOpen()) return;
        uint64_t frameNo = frameCounter.fetch_add(1);
        int div = rateDivisor.load();
        if (div > 1 && (frameNo % (uint64_t)div) != 0) return;

        const int outBins = OUT_BINS;
        const double srcBinHz = spyFftSpan / (double)n;
        const double step = (shownHz / (double)outBins) / srcBinHz;   // src bins / out bin
        // Signed source-bin offset of the display centre from the FFT centre.
        const double viewOffsetBin = (viewCenter.load() - spyFftCenter.load()) / srcBinHz;

        // u8 -> dB (linear over [-dbRange, 0]); then the client's own +256 encoding.
        const double dbPerCount = (double)spyDbRange / 255.0;
        auto dbAt = [&](int sOff) -> float {
            int idx = n / 2 + sOff;
            if (idx < 0) idx = 0; else if (idx >= n) idx = n - 1;
            return (float)(bins[idx] * dbPerCount - (double)spyDbRange);
        };

        std::vector<uint8_t> frame(22 + outBins);
        frame[0]='S';frame[1]='P';frame[2]='E';frame[3]='C';frame[4]=0x01;frame[5]=0x03;
        uint64_t ts = (uint64_t)std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
        std::memcpy(&frame[6], &ts, 8);
        uint64_t f = (uint64_t)llround(viewCenter.load());
        std::memcpy(&frame[14], &f, 8);
        for (int i = 0; i < outBins; i++) {
            int signedOut = (i <= outBins / 2) ? i : i - outBins;
            double center = signedOut * step + viewOffsetBin;
            int lo = (int)std::floor(center - step / 2.0);
            int hi = (int)std::ceil(center + step / 2.0);
            if (hi <= lo) hi = lo + 1;
            float best = -1e9f;
            for (int sB = lo; sB < hi; sB++) { float v = dbAt(sB); if (v > best) best = v; }
            int v = (int)lround(best + 256.0);
            frame[22+i] = (uint8_t)(v < 0 ? 0 : (v > 255 ? 255 : v));
        }
        sendWs(sock, 0x2, frame.data(), frame.size());
        if (frameNo % 10 == 0) sendFmMeta(sock);
    }

    // ── Audio callback (Stage 4) ───────────────────────────────────────────
    // The V5 engine delivers float PCM (mono, or interleaved L/R for WFM stereo)
    // at exactly AUDIO_SR. We re-pack it into the {l,r} buffer the existing
    // decoder / NR / notch / squelch / PCM-send body already works on.
    std::vector<stereo_t> audioPack;        // engine PCM -> {l,r} for onAudio()
    static void audioCb(void* ctx, const float* pcm, int frames, int channels, int /*outRate*/) {
        ((Impl*)ctx)->onEnginePcm(pcm, frames, channels);
    }
    void onEnginePcm(const float* pcm, int frames, int channels) {
        if (frames <= 0) return;
        audioPack.resize((size_t)frames);
        if (channels == 2) {
            for (int i = 0; i < frames; i++) { audioPack[i].l = pcm[2*i]; audioPack[i].r = pcm[2*i+1]; }
        } else {
            for (int i = 0; i < frames; i++) { audioPack[i].l = pcm[i]; audioPack[i].r = pcm[i]; }
        }
        onAudio(audioPack.data(), frames, channels);
    }
    // RDS programme-service name / RadioText / stereo-pilot lock from the engine.
    static void rdsPsCb(void* ctx, uint16_t pi, const char* ps8) {
        Impl* t = (Impl*)ctx; std::lock_guard<std::mutex> lk(t->rdsMtx);
        t->rdsPi = pi; t->rdsPsName = ps8 ? ps8 : "";
    }
    static void rdsTextCb(void* ctx, const char* rt64) {
        Impl* t = (Impl*)ctx; std::lock_guard<std::mutex> lk(t->rdsMtx);
        t->rdsText = rt64 ? rt64 : "";
    }
    static void rdsEccCb(void* ctx, uint8_t ecc) {
        Impl* t = (Impl*)ctx; std::lock_guard<std::mutex> lk(t->rdsMtx);
        t->rdsEcc = ecc;
    }
    static void stereoCb(void* ctx, bool locked) { ((Impl*)ctx)->stereoDetected.store(locked); }

    void onAudio(stereo_t* data, int count, int ch) {
        if (count <= 0) return;
        // Feed the audio-extension decoder (mono int16) — runs even with no audio
        // WS client. The decoder's onChar/onState push frames to the dxcluster WS.
        feedDecoder(data, count);
        feedSpots(data, count);

        // Squelch: mute the audio when the tuned-channel power (pre-AGC, from the
        // FFT) is below threshold. Applied AFTER the decoders so they see raw audio.
        if (squelchOn.load() && channelDb.load() < squelchDb.load()) {
            for (int i = 0; i < count; i++) { data[i].l = 0.0f; data[i].r = 0.0f; }
        }

        std::shared_ptr<net::Socket> sock;
        { std::lock_guard<std::mutex> lk(clientMtx); sock = audioClient; }
        if (!sock || !sock->isOpen()) return;

        // Auto notch (mono listening path, opt-in): removes steady tones before NR.
        if (notchOn.load() && ch == 1) {
            std::lock_guard<std::mutex> lk(notchMtx);
            if (!notchEng) notchEng = new AutoNotch();
            std::vector<float> mono((size_t)count);
            for (int i = 0; i < count; i++) mono[i] = data[i].l;
            notchEng->process(mono.data(), count);
            for (int i = 0; i < count; i++) data[i].l = mono[i];
        }

        // Audio NR (mono only, opt-in). Spectral subtraction with STFT latency —
        // output count differs from input, so the NR branch sends its own frame.
        if (nrOn.load() && ch == 1) {
            std::vector<float> nrOut;
            {
                std::lock_guard<std::mutex> lk(nrMtx);
                if (!nrEng) nrEng = new AudioNR();
                std::vector<float> mono((size_t)count);
                for (int i = 0; i < count; i++) mono[i] = data[i].l;
                auto t0 = std::chrono::steady_clock::now();
                nrEng->process(mono.data(), count, nrOut);
                auto t1 = std::chrono::steady_clock::now();
                nrBusyNs += std::chrono::duration<double, std::nano>(t1 - t0).count();
                nrWallNs += (double)count / AUDIO_SR * 1e9;
                if (nrWallNs > 5e8) { nrCpuPct.store((float)(nrBusyNs / nrWallNs * 100.0)); nrBusyNs = nrWallNs = 0.0; }
            }
            if (nrOut.empty()) return;          // still filling the first STFT frame
            int n2 = (int)nrOut.size();
            std::vector<uint8_t> frame(6 + (size_t)n2 * 2);
            frame[0] = 1; frame[1] = 0;
            uint32_t sr0 = (uint32_t)AUDIO_SR; std::memcpy(&frame[2], &sr0, 4);
            int16_t* pcm0 = (int16_t*)(frame.data() + 6);
            for (int i = 0; i < n2; i++) {
                int s = (int)lround(nrOut[i] * 32767.0f);
                pcm0[i] = (int16_t)(s < -32768 ? -32768 : (s > 32767 ? 32767 : s));
            }
            sendWs(sock, 0x2, frame.data(), frame.size());
            return;
        }

        // header: [0]=channels, [1]=0, [2..5]=sampleRate u32 LE, then int16 PCM
        std::vector<uint8_t> frame(6 + (size_t)count * ch * 2);
        frame[0] = (uint8_t)ch; frame[1] = 0;
        uint32_t sr = (uint32_t)AUDIO_SR; std::memcpy(&frame[2], &sr, 4);
        int16_t* pcm = (int16_t*)(frame.data() + 6);
        const float g = audioGain.load();
        auto cvt = [g](float v) -> int16_t {
            int s = (int)lround(v * g * 32767.0f);
            return (int16_t)(s < -32768 ? -32768 : (s > 32767 ? 32767 : s));
        };
        if (ch == 2) {
            // Stereo lock comes from the engine's pilot-PLL callback (stereoCb),
            // so we just pack the decoded L/R here.
            for (int i = 0; i < count; i++) { pcm[i*2] = cvt(data[i].l); pcm[i*2+1] = cvt(data[i].r); }
        } else {
            for (int i = 0; i < count; i++) pcm[i] = cvt(data[i].l);
        }
        sendWs(sock, 0x2, frame.data(), frame.size());
    }

    // ── Audio-extension decoder (RTTY) ─────────────────────────────────────
    void feedDecoder(stereo_t* data, int count) {
        std::lock_guard<std::mutex> lk(decoderMtx);
        if (!decoder && !wefax && !sstv) return;
        // SSTV runs at 12 kHz — decimate 48k→12k (box-average 4) and feed.
        if (sstv) {
            std::vector<int16_t> dec; dec.reserve((size_t)count/4 + 1);
            for (int i = 0; i < count; i++) {
                sstvAcc += data[i].l;
                if (++sstvDecim >= 4) {
                    int s = (int)lround(sstvAcc / 4.0f * 32767.0f);
                    dec.push_back((int16_t)(s < -32768 ? -32768 : (s > 32767 ? 32767 : s)));
                    sstvDecim = 0; sstvAcc = 0.0f;
                }
            }
            if (!dec.empty()) sstv->process(dec.data(), (int)dec.size());
            return;
        }
        std::vector<int16_t> mono((size_t)count);
        for (int i = 0; i < count; i++) {
            int s = (int)lround(data[i].l * 32767.0f);
            mono[i] = (int16_t)(s < -32768 ? -32768 : (s > 32767 ? 32767 : s));
        }
        if (wefax) { wefax->process(mono.data(), count); return; }
        decoder->process(mono.data(), count);
        // Flush any decoded text to the dxcluster client.
        std::string text;
        { std::lock_guard<std::mutex> bl(decBufMtx); if (!decTextBuf.empty()) { text.swap(decTextBuf); } }
        if (!text.empty()) {
            std::shared_ptr<net::Socket> dx;
            { std::lock_guard<std::mutex> lk2(clientMtx); dx = dxClient; }
            if (dx && dx->isOpen()) {
                std::vector<uint8_t> msg(13 + text.size());
                msg[0] = 0x01;
                uint64_t ts = (uint64_t)std::chrono::duration_cast<std::chrono::seconds>(
                    std::chrono::system_clock::now().time_since_epoch()).count();
                for (int i = 0; i < 8; i++) msg[1 + i] = (uint8_t)(ts >> ((7 - i) * 8));   // big-endian
                uint32_t len = (uint32_t)text.size();
                msg[9] = (uint8_t)(len >> 24); msg[10] = (uint8_t)(len >> 16);
                msg[11] = (uint8_t)(len >> 8); msg[12] = (uint8_t)len;
                std::memcpy(msg.data() + 13, text.data(), text.size());
                sendWs(dx, 0x2, msg.data(), msg.size());
            }
        }
    }
    void sendDecoderState(int st) {
        std::shared_ptr<net::Socket> dx;
        { std::lock_guard<std::mutex> lk2(clientMtx); dx = dxClient; }
        if (dx && dx->isOpen()) { uint8_t m[2] = { 0x03, (uint8_t)st }; sendWs(dx, 0x2, m, 2); }
    }

    // ── FT8/FT4 digital spots ──────────────────────────────────────────────
    static const char* bandFor(double hz) {
        double m = hz / 1e6;
        if (m >= 1.8  && m < 2.0)   return "160m";
        if (m >= 3.5  && m < 4.0)   return "80m";
        if (m >= 5.3  && m < 5.5)   return "60m";
        if (m >= 7.0  && m < 7.3)   return "40m";
        if (m >= 10.1 && m < 10.15) return "30m";
        if (m >= 14.0 && m < 14.35) return "20m";
        if (m >= 18.0 && m < 18.2)  return "17m";
        if (m >= 21.0 && m < 21.45) return "15m";
        if (m >= 24.8 && m < 25.0)  return "12m";
        if (m >= 28.0 && m < 29.7)  return "10m";
        if (m >= 50.0 && m < 54.0)  return "6m";
        return "";
    }
    void emitSpot(bool isFt4, const std::string& callTo, const std::string& callDe,
                  const std::string& grid, int snr, float audioHz) {
        (void)callTo;
        std::shared_ptr<net::Socket> dx;
        { std::lock_guard<std::mutex> lk2(clientMtx); dx = dxClient; }
        if (!dx || !dx->isOpen()) return;
        double rfHz = audioFreq.load() + audioHz;     // dial (USB) + audio offset
        uint64_t ts = (uint64_t)std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
        char buf[384];
        int n = snprintf(buf, sizeof(buf),
            "{\"type\":\"digital_spot\",\"data\":{\"mode\":\"%s\",\"callsign\":\"%s\","
            "\"snr\":%d,\"frequency\":%.0f,\"band\":\"%s\",\"grid\":\"%s\",\"timestamp\":%llu}}",
            isFt4 ? "FT4" : "FT8", callDe.c_str(), snr, rfHz, bandFor(rfHz),
            grid.c_str(), (unsigned long long)ts);
        if (n > 0) sendText(dx, std::string(buf, (size_t)n));
    }
    void startSpots() {
        std::lock_guard<std::mutex> lk(spotsMtx);
        if (spotsActive) return;
        delete ft8; delete ft4;
        ft8 = new Ft8Decoder(12000, false);
        ft4 = new Ft8Decoder(12000, true);
        ft8->onSpot = [this](const std::string& to, const std::string& de, const std::string& g, int s, float f) { emitSpot(false, to, de, g, s, f); };
        ft4->onSpot = [this](const std::string& to, const std::string& de, const std::string& g, int s, float f) { emitSpot(true,  to, de, g, s, f); };
        spotDecim = 0; spotAcc = 0.0f;
        spotsActive = true;
        LOGI("digital spots (FT8/FT4) started");
    }
    void stopSpots() {
        std::lock_guard<std::mutex> lk(spotsMtx);
        spotsActive = false;
        delete ft8; ft8 = nullptr;
        delete ft4; ft4 = nullptr;
    }
    void feedSpots(stereo_t* data, int count) {
        std::lock_guard<std::mutex> lk(spotsMtx);
        if (!spotsActive) return;
        // Decimate 48k→12k by box-averaging 4 samples (mono).
        std::vector<int16_t> dec;
        dec.reserve((size_t)count / 4 + 1);
        for (int i = 0; i < count; i++) {
            spotAcc += data[i].l;
            if (++spotDecim >= 4) {
                int s = (int)lround(spotAcc / 4.0f * 32767.0f);
                dec.push_back((int16_t)(s < -32768 ? -32768 : (s > 32767 ? 32767 : s)));
                spotDecim = 0; spotAcc = 0.0f;
            }
        }
        if (dec.empty()) return;
        if (ft8) ft8->process(dec.data(), (int)dec.size());
        if (ft4) ft4->process(dec.data(), (int)dec.size());
    }

    // ── Demod chain (re)build ──────────────────────────────────────────────
    // With the V5 engine there are no per-block dsp objects to destroy — the
    // engine reconfigures itself on the next feed() after setTune(). teardownAudio
    // just resets the derived UI state; the engine retains no audio across modes.
    void teardownAudio() {
        std::lock_guard<std::mutex> lk(rdsMtx);
        rdsPsName.clear(); rdsText.clear(); rdsPi = -1; rdsEcc = 0;
        stereoDetected.store(false);
    }

    void buildAudio() {
        std::lock_guard<std::recursive_mutex> lk(modeMtx);
        teardownAudio();
        ModeParams mp = paramsFor(mode);
        audioChannels.store(mp.channels);
        // AM envelope-detected audio (DSB full-carrier) lands ~2x hotter than the
        // SSB/FM paths, so trim it to match level with the rest.
        audioGain.store(mp.kind == ModeParams::AM ? 0.5f : 1.0f);
        // CW: tune a beat-note offset off the carrier so the engine's real-part
        // (SSB) detector produces an audible tone. The USB-side SSB demod passes
        // 0..+bw (it mixes down by bw/2 then low-passes at bw/2), so the carrier
        // must appear at a POSITIVE audio frequency. The channel is tuned to
        // (dial + demodOffset), so a carrier on the dial lands at baseband
        // -demodOffset — meaning we need a NEGATIVE offset to push it up into the
        // passband. Use -bw/2 so the carrier sits at +bw/2 (here +600 Hz with the
        // 1200 Hz CW bandwidth): the CENTRE of the passband, with symmetric ±bw/2
        // filtering around the tone. (A positive offset put the carrier at a
        // negative audio freq the USB filter rejected — silent on-signal, audible
        // only when tuned below the carrier.) A true narrow band-pass around the
        // pitch is a future engine refinement.
        demodOffset = (mp.kind == ModeParams::CW) ? -mp.bandwidth * 0.5 : 0.0;

        rxMode = rxModeFor(mp.kind);
        rxBwHz = mp.bandwidth;
        vfoBwHz.store(mp.bandwidth);
        rx.setTune(vfoOffsetNow(), rxMode, rxBwHz);
        LOGI("audio chain: mode=%s bw=%.0f ch=%d", mode.c_str(), mp.bandwidth, mp.channels);
    }

    // (Re)start the V5 engine at the current sampleRate/fftSize. Wires the
    // spectrum/audio/RDS/stereo callbacks. The engine emits FFT frames at FFT_AVG×
    // the target rate; onSpectrum block-averages FFT_AVG of them.
    void startEngine() {
        vibedsp::RxPipeline::Callbacks cb;
        cb.ctx      = this;
        cb.spectrum = &Impl::specCb;
        cb.audio    = &Impl::audioCb;
        cb.rdsPs    = &Impl::rdsPsCb;
        cb.rdsText  = &Impl::rdsTextCb;
        cb.rdsEcc   = &Impl::rdsEccCb;
        cb.stereo   = &Impl::stereoCb;
        fftAccum.assign(fftSize, 0.0f); accumCount = 0;
        rx.start(sampleRate, fftSize, fftRate * FFT_AVG, (int)AUDIO_SR, cb);
    }

    // FM RDS + stereo status → client (reuses the OWRX metadata display).
    static std::string jsonEscape(const std::string& s) {
        std::string o;
        for (char c : s) {
            if (c == '"' || c == '\\') { o.push_back('\\'); o.push_back(c); }
            else if ((unsigned char)c >= 0x20) o.push_back(c);
        }
        return o;
    }
    void sendFmMeta(const std::shared_ptr<net::Socket>& sock) {
        std::string ps, rt; int pi = -1, ecc = 0;
        bool wfm = (mode == "wfm");
        if (wfm) {
            std::lock_guard<std::mutex> lk(rdsMtx);
            ps = rdsPsName; rt = rdsText; pi = rdsPi; ecc = rdsEcc;
        }
        // trim trailing spaces RDS pads with
        auto trim = [](std::string s){ size_t e = s.find_last_not_of(" \t\r\n"); return e==std::string::npos?std::string():s.substr(0,e+1); };
        ps = trim(ps); rt = trim(rt);
        const bool st = wfm && stereoDetected.load();
        // Only send when something actually CHANGED — re-sending identical RDS each
        // second re-triggers the client's notification marquee (text "repopulates"
        // and flickers). Change-detect ps/rt/pi/ecc/stereo and skip otherwise.
        if (ps == lastSentPs_ && rt == lastSentRt_ && pi == lastSentPi_ && ecc == lastSentEcc_ && st == lastSentStereo_) return;
        lastSentPs_ = ps; lastSentRt_ = rt; lastSentPi_ = pi; lastSentEcc_ = ecc; lastSentStereo_ = st;
        char buf[512];
        snprintf(buf, sizeof buf,
            "{\"type\":\"rds\",\"stereo\":%s,\"ps\":\"%s\",\"radiotext\":\"%s\",\"pi\":%d,\"ecc\":%d}",
            st ? "true" : "false",
            jsonEscape(ps).c_str(), jsonEscape(rt).c_str(), pi, ecc);
        sendText(sock, buf);
    }
    // Last RDS values pushed to the client (change-detect to avoid marquee re-trigger).
    std::string lastSentPs_, lastSentRt_; int lastSentPi_ = -2; int lastSentEcc_ = -1; bool lastSentStereo_ = false;

    // retune the demod (and RTL centre if the offset would fall outside span)
    void retune(double freq) {
        // Hold modeMtx across the WHOLE placement (rtlCenter/viewCenter store +
        // tuneHw + rx.setTune), not just rx.setTune. retune() runs on the audio-WS
        // thread while the "zoom" handler runs on the spectrum-WS thread, and BOTH
        // call tuneHw() (an rtl-sdr USB control transfer that is NOT thread-safe).
        // With the placement outside the lock the two threads raced: the tuner PLL
        // landed at a corrupted centre → the station came up a few hundred kHz off
        // and one VFO nudge (a fresh single tune) fixed it. Serialising here means
        // whichever handler runs second re-reads the other's committed audioFreq/
        // rtlCenter and there is never a concurrent hardware tune.
        std::lock_guard<std::recursive_mutex> lk(modeMtx);
        audioFreq.store(freq);
        // Guard band before we recentre the capture. The fixed 50 kHz was fine at
        // 2.4 MSPS but goes NEGATIVE once decimation makes the IQ narrow (SpyServer),
        // which would retune on every tiny nudge.
        double limit = sampleRate / 2.0 - std::min(50000.0, sampleRate * 0.15);
        if (std::fabs(freq - rtlCenter.load()) > limit) {
            // The VFO has tuned outside the captured window — recentre the capture
            // on it so we don't end up showing dead air.
            rtlCenter.store(freq);
            // On SpyServer the display is the server's WIDE FFT, which the narrow IQ
            // window slides underneath. Moving viewCenter here would yank the
            // waterfall sideways on every recentre; the view only follows when the
            // VFO leaves the FFT span entirely (handled in the zoom/pan path).
            if (!useSpy()) viewCenter.store(freq);
            tuneHw(freq);
        }
        rx.setTune(vfoOffsetNow(), rxMode, rxBwHz);
        // New frequency -> drop the cached RDS so a different station doesn't keep
        // showing the previous one's PS/RadioText until its own RDS re-syncs.
        { std::lock_guard<std::mutex> rl(rdsMtx); rdsPsName.clear(); rdsText.clear(); rdsPi = -1; }
        stereoDetected.store(false);
    }

    // ── WebSocket framing ──────────────────────────────────────────────────
    void sendWs(const std::shared_ptr<net::Socket>& sock, uint8_t opcode,
                const uint8_t* payload, size_t len) {
        std::vector<uint8_t> hdr;
        hdr.push_back(0x80 | opcode);
        if (len < 126) hdr.push_back((uint8_t)len);
        else if (len < 65536) { hdr.push_back(126); hdr.push_back((uint8_t)(len>>8)); hdr.push_back((uint8_t)len); }
        else { hdr.push_back(127); for (int i=7;i>=0;i--) hdr.push_back((uint8_t)(len>>(i*8))); }
        std::lock_guard<std::mutex> lk(sendMtx);
        if (!sock->isOpen()) return;
        sock->send(hdr.data(), hdr.size());
        if (len) sock->send(payload, len);
    }
    void sendText(const std::shared_ptr<net::Socket>& sock, const std::string& s) {
        sendWs(sock, 0x1, (const uint8_t*)s.data(), s.size());
    }
    void sendConfig(const std::shared_ptr<net::Socket>& sock) {
        // NB: displaySpan(), not sampleRate. On SpyServer the waterfall is the
        // server's wide FFT while the IQ is narrow, so the client's zoom/pan model
        // must be built on the span it can actually SEE.
        const double span = displaySpan();
        double effective = span / zoomFactor.load();                  // zoom-aware span
        double binBw = effective / (double)OUT_BINS;                  // we emit OUT_BINS bins
        char buf[320];
        // maxBandwidth = full (unzoomed) device span — the client caps zoom-out
        // to this so you can't zoom out past the actual RTL bandwidth.
        snprintf(buf, sizeof buf,
            "{\"type\":\"config\",\"centerFreq\":%lld,\"binCount\":%d,"
            "\"binBandwidth\":%.6f,\"totalBandwidth\":%.1f,\"maxBandwidth\":%.1f}",
            (long long)llround(viewCenter.load()), OUT_BINS, binBw, effective, span);
        sendText(sock, buf);
    }

    // Waterfall zoom: set the FFT-crop factor to match the requested span
    // (binBandwidth*fftSize). Pure display-side crop in onFFT — no IQ
    // decimation, no IQFrontEnd reconfig (which would touch the uninitialised
    // headless core), no effect on audio. Capped so the crop keeps >= 16 bins.
    void setSpan(double binBw) {
        if (binBw <= 0) return;
        // The client sees OUT_BINS bins, so its requested span = binBw*OUT_BINS;
        // zoom = full span / requested span. (Using fftSize here made the reported
        // span 8x too wide → zoom snapped straight back out / wouldn't go deep.)
        double want = sampleRate / (binBw * (double)OUT_BINS);
        double maxZoom = (double)fftSize / 16.0;
        if (want < 1.0) want = 1.0;
        if (want > maxZoom) want = maxZoom;
        zoomFactor.store(want);
    }

    static bool recvN(const std::shared_ptr<net::Socket>& s, uint8_t* buf, size_t n) {
        size_t got = 0;
        while (got < n) { int r = s->recv(buf+got, n-got, true, net::NO_TIMEOUT); if (r <= 0) return false; got += (size_t)r; }
        return true;
    }
    int recvWs(const std::shared_ptr<net::Socket>& s, std::string& out) {
        uint8_t h[2]; if (!recvN(s, h, 2)) return -1;
        int opcode = h[0] & 0x0F; bool masked = h[1] & 0x80; uint64_t len = h[1] & 0x7F;
        if (len == 126) { uint8_t e[2]; if(!recvN(s,e,2)) return -1; len=(e[0]<<8)|e[1]; }
        else if (len == 127) { uint8_t e[8]; if(!recvN(s,e,8)) return -1; len=0; for(int i=0;i<8;i++) len=(len<<8)|e[i]; }
        uint8_t mask[4]={0,0,0,0}; if (masked && !recvN(s,mask,4)) return -1;
        out.resize((size_t)len);
        if (len && !recvN(s,(uint8_t*)out.data(),(size_t)len)) return -1;
        if (masked) for (size_t i=0;i<out.size();i++) out[i] ^= mask[i&3];
        return opcode;
    }

    void handleControl(const std::shared_ptr<net::Socket>& sock, const std::string& msg) {
        std::string type = jsonStr(msg, "type");
        double v;
        if (type == "ping") { sendText(sock, "{\"type\":\"pong\"}"); return; }
        if (type == "set_rate") { if (jsonNum(msg,"divisor",v)) rateDivisor.store(std::max(1,(int)llround(v))); return; }
        if (type == "reset") { zoomFactor.store(1.0); sendConfig(sock); return; }
        if (type == "zoom") { // spectrum view-centre move (+ span via binBandwidth)
            if (jsonNum(msg,"frequency",v) && v > 0) {
                // The requested frequency is the DISPLAY centre. Park the dongle
                // so the VFO stays captured (follow the view, then lock), and let
                // the crop offset (viewCenter − rtlCenter, applied in onSpectrum)
                // carry the view on past the dongle once it's locked. Retune the
                // RTL only when the dongle actually has to move (no per-pan clicks).
                // modeMtx serialises this against retune() on the audio-WS thread —
                // both call the non-thread-safe tuneHw(); racing them corrupted the
                // tuner PLL (off-tune-until-nudged bug). Under the lock, dongleForView
                // reads a consistent audioFreq and there is one hardware tune at a time.
                std::lock_guard<std::recursive_mutex> lk(modeMtx);
                viewCenter.store(v);
                double dongle = dongleForView(v);
                bool moved = std::fabs(dongle - rtlCenter.load()) > 1.0;
                if (moved) {
                    rtlCenter.store(dongle);
                    tuneHw(dongle);
                    rx.setTune(vfoOffsetNow(), rxMode, rxBwHz);
                }
            }
            double bb;
            if (jsonNum(msg,"binBandwidth",bb) && bb > 0) setSpan(bb);
            sendConfig(sock);
            return;
        }
        if (type == "tune") {
            std::string m = jsonStr(msg, "mode");
            bool rebuilt = false;
            if (!m.empty() && m != mode) { mode = m; buildAudio(); rebuilt = true; }
            if (jsonNum(msg, "frequency", v) && v > 0) retune(v);
            double lo, hi;
            if (!rebuilt && jsonNum(msg,"bandwidthLow",lo) && jsonNum(msg,"bandwidthHigh",hi)) setBandwidth(hi - lo);
            return;
        }
        if (type == "mode") {
            std::string m = jsonStr(msg, "mode");
            // Decimation is derived from the mode's bandwidth, so re-negotiate it
            // BEFORE rebuilding the audio chain (it may change sampleRate/fftSize).
            if (!m.empty() && m != mode) { mode = m; spyRetuneDecimation(); buildAudio(); }
            return;
        }
        if (type == "bandwidth") {
            double lo, hi, bw;
            if (jsonNum(msg,"bandwidthLow",lo) && jsonNum(msg,"bandwidthHigh",hi)) setBandwidth(hi - lo);
            else if (jsonNum(msg,"bandwidth",bw)) setBandwidth(bw);
            return;
        }
    }

    void setBandwidth(double bw) {
        if (bw <= 0) return;
        std::lock_guard<std::recursive_mutex> lk(modeMtx);
        rxBwHz = std::min(bw, sampleRate);
        vfoBwHz.store(rxBwHz);
        // CW: ignore the client's narrow passband override (cwu/cwl send ±200 Hz =
        // 400 Hz wide). With the USB demod the carrier must sit at a POSITIVE audio
        // freq inside the 0..bw passband; a 400 Hz filter forces the beat note down
        // to ~200 Hz, which a phone speaker barely reproduces (it sounded silent).
        // Keep the mode's fixed CW filter (buildAudio's 1200 Hz) and -bw/2 beat-note
        // offset so the tone stays a clear ~600 Hz, centred, audible on-signal.
        if (rxMode == vibedsp::RxPipeline::Mode::CW) {
            rxBwHz = paramsFor(mode).bandwidth;     // restore the CW filter width
            vfoBwHz.store(rxBwHz);
            demodOffset = -rxBwHz * 0.5;
            rx.setTune(vfoOffsetNow(), rxMode, rxBwHz);
            return;
        }
        rx.setTune(vfoOffsetNow(), rxMode, rxBwHz);
    }

    // ── HTTP/WS server ─────────────────────────────────────────────────────
    void acceptLoop() {
        vibeThreadName("vibe-accept");
        while (serverRunning.load()) {
            std::shared_ptr<net::Socket> sock;
            try { sock = listener->accept(nullptr, 500); } catch (...) { sock = nullptr; }
            if (!sock) continue;
            std::lock_guard<std::mutex> lk(connMtx);
            connThreads.emplace_back([this, sock]{ handleConnection(sock); });
        }
    }

    void handleConnection(std::shared_ptr<net::Socket> sock) {
        vibeThreadName("vibe-conn");
        std::string reqLine, line, wsKey;
        if (sock->recvline(reqLine, 8192, 5000) <= 0) { sock->close(); return; }
        while (sock->recvline(line, 8192, 5000) > 0) {
            if (line.empty() || line == "\r") break;
            if (line.size() > 18) {
                std::string lk = line.substr(0, 18);
                for (auto& c : lk) c = (char)tolower(c);
                if (lk == "sec-websocket-key:") {
                    auto vv = line.substr(18);
                    size_t a = vv.find_first_not_of(" \t");
                    size_t b = vv.find_last_not_of(" \t\r\n");
                    if (a != std::string::npos) wsKey = vv.substr(a, b - a + 1);
                }
            }
        }
        bool wsSpec  = reqLine.find("/ws/user-spectrum") != std::string::npos;
        bool wsAudio = reqLine.find("/ws/audio") != std::string::npos;
        bool wsDx    = reqLine.find("/ws/dxcluster") != std::string::npos;
        if (wsDx && !wsKey.empty()) {
            acceptDxcluster(sock, wsKey);
        } else if ((wsSpec || wsAudio) && !wsKey.empty()) {
            acceptWs(sock, wsKey, wsAudio);
        } else if (reqLine.find("/connection") != std::string::npos) {
            std::string body = "{\"allowed\":true}";
            sock->sendstr("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: "
                          + std::to_string(body.size()) + "\r\n\r\n" + body);
            sock->close();
        } else {
            sock->sendstr("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
            sock->close();
        }
    }

    void acceptWs(std::shared_ptr<net::Socket> sock, const std::string& wsKey, bool isAudio) {
        std::string acc = wsKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
        uint8_t digest[20]; Sha1().hash((const uint8_t*)acc.data(), acc.size(), digest);
        sock->sendstr("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      "Sec-WebSocket-Accept: " + base64(digest, 20) + "\r\n\r\n");

        if (isAudio) { std::lock_guard<std::mutex> lk(clientMtx); audioClient = sock; LOGI("audio WS connected"); }
        else { std::lock_guard<std::mutex> lk(clientMtx); specClient = sock; sendConfig(sock); LOGI("spectrum WS connected"); }

        while (serverRunning.load() && sock->isOpen()) {
            std::string payload;
            int op = recvWs(sock, payload);
            if (op < 0 || op == 0x8) break;
            if (op == 0x9) { sendWs(sock, 0xA, (const uint8_t*)payload.data(), payload.size()); continue; }
            if (op == 0x1) handleControl(sock, payload);
        }
        { std::lock_guard<std::mutex> lk(clientMtx);
          if (specClient == sock) specClient = nullptr;
          if (audioClient == sock) audioClient = nullptr; }
        sock->close();
        LOGI("%s WS disconnected", isAudio ? "audio" : "spectrum");
    }

    void startDecoder(const std::string& msg) {
        std::string ext = jsonStr(msg, "extension_name");
        if (ext == "wefax") { startWefax(msg); return; }
        if (ext == "sstv")  { startSstv(msg);  return; }
        bool navtex = (ext == "navtex");
        if (ext != "fsk" && !navtex) return;   // RTTY / NAVTEX
        double cf, sh, baud; bool inv = msg.find("\"inverted\":true") != std::string::npos;
        if (!jsonNum(msg, "center_frequency", cf)) cf = navtex ? 500.0 : 1000.0;
        if (!jsonNum(msg, "shift", sh)) sh = navtex ? 170.0 : 170.0;
        if (!jsonNum(msg, "baud_rate", baud)) baud = navtex ? 100.0 : 45.45;
        std::string enc = jsonStr(msg, "encoding"); if (enc.empty()) enc = navtex ? "CCIR476" : "ITA2";
        std::string framing = jsonStr(msg, "framing"); if (framing.empty()) framing = navtex ? "4/7" : "5N1.5";
        std::lock_guard<std::mutex> lk(decoderMtx);
        delete decoder;
        decoder = new FskDecoder(48000, cf, sh, baud, framing, enc, inv);
        decoder->onChar = [this](char32_t ch) {
            std::lock_guard<std::mutex> bl(decBufMtx);
            // RTTY/ITA2 is ASCII; encode minimally as UTF-8.
            if (ch < 0x80) decTextBuf.push_back((char)ch);
            else if (ch < 0x800) { decTextBuf.push_back((char)(0xC0|(ch>>6))); decTextBuf.push_back((char)(0x80|(ch&0x3F))); }
        };
        decoder->onState = [this](int st) { sendDecoderState(st); };
        LOGI("decoder attached: fsk cf=%.0f shift=%.0f baud=%.2f enc=%s", cf, sh, baud, enc.c_str());
    }
    void startWefax(const std::string& msg) {
        WefaxDecoder::Config cfg;
        double v;
        if (jsonNum(msg, "lpm", v))         cfg.lpm        = (int)v;
        if (jsonNum(msg, "image_width", v)) cfg.imageWidth = (int)v;
        if (jsonNum(msg, "carrier", v))     cfg.carrier    = v;
        if (jsonNum(msg, "deviation", v))   cfg.deviation  = v;
        if (jsonNum(msg, "bandwidth", v))   cfg.bandwidth  = (int)v;
        cfg.usePhasing = msg.find("\"use_phasing\":false") == std::string::npos;
        cfg.autoStop   = msg.find("\"auto_stop\":true")    != std::string::npos;
        cfg.autoStart  = msg.find("\"auto_start\":true")   != std::string::npos;
        std::lock_guard<std::mutex> lk(decoderMtx);
        delete decoder; decoder = nullptr;
        delete wefax;
        wefax = new WefaxDecoder(48000, cfg);
        wefax->onLine = [this](uint32_t ln, uint32_t w, const uint8_t* px) {
            std::shared_ptr<net::Socket> dx;
            { std::lock_guard<std::mutex> lk2(clientMtx); dx = dxClient; }
            if (!dx || !dx->isOpen()) return;
            std::vector<uint8_t> m(9 + w);
            m[0] = 0x01;
            m[1] = (uint8_t)(ln >> 24); m[2] = (uint8_t)(ln >> 16); m[3] = (uint8_t)(ln >> 8); m[4] = (uint8_t)ln;
            m[5] = (uint8_t)(w >> 24);  m[6] = (uint8_t)(w >> 16);  m[7] = (uint8_t)(w >> 8);  m[8] = (uint8_t)w;
            std::memcpy(m.data() + 9, px, w);
            sendWs(dx, 0x2, m.data(), m.size());
        };
        wefax->onStart = [this]() {
            std::shared_ptr<net::Socket> dx;
            { std::lock_guard<std::mutex> lk2(clientMtx); dx = dxClient; }
            if (dx && dx->isOpen()) { uint8_t b = 0x02; sendWs(dx, 0x2, &b, 1); }
        };
        wefax->onStop = [this]() {
            std::shared_ptr<net::Socket> dx;
            { std::lock_guard<std::mutex> lk2(clientMtx); dx = dxClient; }
            if (dx && dx->isOpen()) { uint8_t b = 0x03; sendWs(dx, 0x2, &b, 1); }
        };
        LOGI("decoder attached: wefax lpm=%d width=%d carrier=%.0f", cfg.lpm, cfg.imageWidth, cfg.carrier);
    }
    // ── SSTV ───────────────────────────────────────────────────────────────
    void dxSend(const uint8_t* d, size_t n) {
        std::shared_ptr<net::Socket> dx;
        { std::lock_guard<std::mutex> lk2(clientMtx); dx = dxClient; }
        if (!dx || !dx->isOpen()) return;
        std::lock_guard<std::mutex> sl(dxSendMtx);
        sendWs(dx, 0x2, d, n);
    }
    static void put32(std::vector<uint8_t>& v, uint32_t x) {
        v.push_back((uint8_t)(x>>24)); v.push_back((uint8_t)(x>>16));
        v.push_back((uint8_t)(x>>8));  v.push_back((uint8_t)x);
    }
    void startSstv(const std::string& msg) {
        (void)msg;
        std::lock_guard<std::mutex> lk(decoderMtx);
        delete decoder; decoder = nullptr;
        delete wefax;   wefax = nullptr;
        delete sstv;
        sstv = new SstvDecoder(12000);
        sstvDecim = 0; sstvAcc = 0.0f;
        sstv->onImageStart = [this](int w, int h) {
            std::vector<uint8_t> m; m.push_back(0x07); put32(m,(uint32_t)w); put32(m,(uint32_t)h);
            dxSend(m.data(), m.size());
        };
        sstv->onLine = [this](int y, int w, const uint8_t* rgb) {
            std::vector<uint8_t> m; m.reserve(9 + (size_t)w*3);
            m.push_back(0x01); put32(m,(uint32_t)y); put32(m,(uint32_t)w);
            m.insert(m.end(), rgb, rgb + (size_t)w*3);
            dxSend(m.data(), m.size());
        };
        sstv->onMode = [this](uint8_t, const std::string& name) {
            std::vector<uint8_t> m; m.push_back(0x02);
            m.push_back((uint8_t)(name.size()>>8)); m.push_back((uint8_t)name.size());
            m.insert(m.end(), name.begin(), name.end());
            dxSend(m.data(), m.size());
        };
        sstv->onStatus = [this](const std::string& s) {
            std::vector<uint8_t> m; m.push_back(0x03); m.push_back(0x00);
            m.push_back((uint8_t)(s.size()>>8)); m.push_back((uint8_t)s.size());
            m.insert(m.end(), s.begin(), s.end());
            dxSend(m.data(), m.size());
        };
        sstv->onSync = [this]() { uint8_t b = 0x04; dxSend(&b, 1); };
        sstv->onComplete = [this]() { std::vector<uint8_t> m; m.push_back(0x05); put32(m,0); dxSend(m.data(), m.size()); };
        sstv->onRedrawStart = [this]() { uint8_t b = 0x08; dxSend(&b, 1); };
        LOGI("decoder attached: sstv");
    }
    void stopDecoder() {
        std::lock_guard<std::mutex> lk(decoderMtx);
        delete decoder; decoder = nullptr;
        delete wefax;   wefax = nullptr;
        delete sstv;    sstv = nullptr;
        { std::lock_guard<std::mutex> bl(decBufMtx); decTextBuf.clear(); }
    }

    void acceptDxcluster(std::shared_ptr<net::Socket> sock, const std::string& wsKey) {
        std::string acc = wsKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
        uint8_t digest[20]; Sha1().hash((const uint8_t*)acc.data(), acc.size(), digest);
        sock->sendstr("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      "Sec-WebSocket-Accept: " + base64(digest, 20) + "\r\n\r\n");
        { std::lock_guard<std::mutex> lk(clientMtx); dxClient = sock; }
        LOGI("dxcluster (decoder) WS connected");
        while (serverRunning.load() && sock->isOpen()) {
            std::string payload;
            int op = recvWs(sock, payload);
            if (op < 0 || op == 0x8) break;
            if (op == 0x9) { sendWs(sock, 0xA, (const uint8_t*)payload.data(), payload.size()); continue; }
            if (op != 0x1) continue;
            std::string type = jsonStr(payload, "type");
            if (type == "audio_extension_attach") {
                startDecoder(payload);
                sendText(sock, "{\"type\":\"audio_extension_attached\"}");
            } else if (type == "audio_extension_detach") {
                stopDecoder();
                sendText(sock, "{\"type\":\"audio_extension_detached\"}");
            } else if (type == "subscribe_digital_spots") {
                startSpots();    // local FT8/FT4 decoder feeds digital_spot frames
            } else if (type == "unsubscribe_digital_spots") {
                stopSpots();
            }
            // chat / cw-spot / subscribe_chat messages are ignored (no server here).
        }
        stopDecoder();
        stopSpots();
        { std::lock_guard<std::mutex> lk(clientMtx); if (dxClient == sock) dxClient = nullptr; }
        sock->close();
        LOGI("dxcluster WS disconnected");
    }

    // ── IQ producer (runs on the libusb/socket reader thread) ───────────────
    // Convert `sampCount` interleaved u8 I/Q samples to cf32 and ENQUEUE for the
    // dspThread. Must stay cheap (no DSP, no modeMtx) so the libusb callback
    // returns promptly. Drops the oldest buffer on overrun to bound latency.
    // `blockIfFull`: TCP reader may wait for space (surplus stays in the kernel's
    // receive buffer, where u8 IQ is 4x denser than cf32). The USB callback must
    // NEVER block — blocking libusb's handler stalls the whole device — so it
    // keeps the drop-oldest behaviour.
    void enqueueIq(const uint8_t* buf, int sampCount, bool blockIfFull = false) {
        if (sampCount <= 0) return;
        if (sampCount > STREAM_BUFFER_SIZE) sampCount = STREAM_BUFFER_SIZE;
        std::vector<cf32> v((size_t)sampCount);
        convU8ToF32(buf, reinterpret_cast<float*>(v.data()), sampCount * 2);  // NEON
        {
            std::unique_lock<std::mutex> lk(iqMtx);
            if (iqMaxSamples > 0) {
                if (blockIfFull) {
                    iqSpaceCv.wait(lk, [this]{
                        return iqQueuedSamples < iqMaxSamples || !dspRunning.load();
                    });
                    if (!dspRunning.load()) return;
                } else if (iqQueuedSamples >= iqMaxSamples) {
                    dropOldestLocked();
                }
            } else if (iqQueue.size() >= IQ_QUEUE_MAX) {
                dropOldestLocked();                       // USB: bounded by chunk count
            }
            iqQueuedSamples += v.size();
            iqQueue.push_back(std::move(v));
        }
        iqCv.notify_one();
    }

    // int16 IQ (16-bit devices: Airspy et al). Same queue, same backpressure; only
    // the sample conversion differs. Public SpyServers are not all 8-bit RTL-SDRs,
    // and feeding a 16-bit device's stream through the u8 path would be garbage.
    void enqueueIqInt16(const int16_t* buf, int sampCount, bool blockIfFull) {
        if (sampCount <= 0) return;
        if (sampCount > STREAM_BUFFER_SIZE) sampCount = STREAM_BUFFER_SIZE;
        std::vector<cf32> v((size_t)sampCount);
        constexpr float kInv = 1.0f / 32768.0f;
        for (int i = 0; i < sampCount; i++)
            v[i] = cf32(buf[2*i] * kInv, buf[2*i + 1] * kInv);
        {
            std::unique_lock<std::mutex> lk(iqMtx);
            if (iqMaxSamples > 0) {
                if (blockIfFull) {
                    iqSpaceCv.wait(lk, [this]{
                        return iqQueuedSamples < iqMaxSamples || !dspRunning.load();
                    });
                    if (!dspRunning.load()) return;
                } else if (iqQueuedSamples >= iqMaxSamples) {
                    dropOldestLocked();
                }
            }
            iqQueuedSamples += v.size();
            iqQueue.push_back(std::move(v));
        }
        iqCv.notify_one();
    }

    // Caller holds iqMtx. Counts what it discards — this used to be silent, which
    // is why the server could report a healthy link while the client broke up.
    void dropOldestLocked() {
        if (iqQueue.empty()) return;
        size_t n = iqQueue.front().size();
        iqQueuedSamples -= n;
        iqQueue.pop_front();
        iqDroppedSamples.fetch_add(n, std::memory_order_relaxed);
    }

    // ── DSP consumer (dedicated thread, OFF the libusb path) ────────────────
    // Drains the IQ queue and runs the engine. modeMtx serialises rx.feed against
    // setTune / buildAudio / setSampleRate (feed runs rebuildAudio inline).
    void dspLoop() {
        // This thread runs the whole demod chain (WFM stereo MPX + RDS + FIR
        // filters) and must keep up in real time or the audio it produces
        // underruns → thin/sibilant/"low-bandwidth" sound. It is spawned from the
        // React native-modules (v_native) JNI thread, so WITHOUT this it inherits
        // that thread's name + default scheduling — under the New Architecture
        // that leaves it losing CPU to the Fabric/worklets/JS threads on weak
        // (e.g. Moto G35 / Unisoc) cores. Pin it to real audio priority so the
        // scheduler treats it like the AudioTrack callback (v5/old-arch behaviour).
        vibeAudioThread("vibe-dsp");
        while (dspRunning.load()) {
            std::vector<cf32> buf;
            {
                std::unique_lock<std::mutex> lk(iqMtx);
                // One-shot prefill at stream start. The DSP is NOT paced by this
                // queue — it drains faster than real time and parks on iqCv, so an
                // empty queue here is normal, not starvation. What the prefill buys
                // is 250 ms of extra audio pushed downstream into the WebView's
                // audio buffer, which DOES run on a real-time clock; that buffer is
                // where the jitter actually gets absorbed.
                if (!iqPrefilled && iqPrefillSamples > 0) {
                    iqCv.wait(lk, [this]{
                        return iqQueuedSamples >= iqPrefillSamples || !dspRunning.load();
                    });
                    if (!dspRunning.load()) break;
                    iqPrefilled = true;
                }
                iqCv.wait(lk, [this]{ return !iqQueue.empty() || !dspRunning.load(); });
                if (!dspRunning.load()) break;
                buf = std::move(iqQueue.front());
                iqQueue.pop_front();
                iqQueuedSamples -= buf.size();
            }
            iqSpaceCv.notify_one();
            std::lock_guard<std::recursive_mutex> mlk(modeMtx);
            rx.feed(buf.data(), (int)buf.size());
        }
    }

    void startDspThread() {
        dspRunning.store(true);
        dspThread = std::thread([this]{ dspLoop(); });
    }
    void stopDspThread() {
        dspRunning.store(false);
        iqCv.notify_all();
        iqSpaceCv.notify_all();      // release a TCP reader parked on backpressure
        if (dspThread.joinable()) dspThread.join();
        std::lock_guard<std::mutex> lk(iqMtx);
        iqQueue.clear();
        iqQueuedSamples = 0;
        iqPrefilled = false;
    }

    static void asyncHandler(unsigned char* buf, uint32_t len, void* ctx) {
        ((Impl*)ctx)->enqueueIq(buf, (int)(len / 2));
    }

    // SpyServer read loop: the client owns framing; we just forward IQ into the
    // same queue the USB/rtl_tcp paths feed. Blocks with backpressure exactly like
    // tcpReadLoop, so the 250 ms jitter buffer applies here too.
    void spyReadLoop() {
        vibeThreadName("vibe-spy");
        auto lastData = std::chrono::steady_clock::now();
        spy->run(tcpRunning,
            [&](const uint8_t* data, size_t bytes, uint32_t fmt) {
                auto now = std::chrono::steady_clock::now();
                if (std::chrono::duration_cast<std::chrono::milliseconds>(now - lastData).count()
                        >= kStallMs)
                    netStalls.fetch_add(1, std::memory_order_relaxed);
                lastData = now;
                // Format is negotiated from the device's ADC resolution, so honour
                // whichever the server is actually sending.
                if (fmt == spyserver::FORMAT_UINT8)
                    enqueueIq(data, (int)(bytes / 2), /*blockIfFull=*/true);
                else if (fmt == spyserver::FORMAT_INT16)
                    enqueueIqInt16((const int16_t*)data, (int)(bytes / 4), /*blockIfFull=*/true);
            },
            [&](const uint8_t* bins, size_t count) { emitServerFft(bins, (int)count); });
    }

    // RTL-TCP read loop: pull u8 I/Q from the socket in ~32 KB chunks and enqueue.
    // Reads what's available (low latency) and carries a stray odd byte so I/Q
    // pairs never misalign across reads.
    void tcpReadLoop() {
        vibeThreadName("vibe-tcp");
        const int CHUNK = 32768;                 // bytes (16384 IQ samples)
        std::vector<uint8_t> buf(CHUNK + 1);
        int carry = 0;                            // 0/1 leftover byte from last read
        auto lastData = std::chrono::steady_clock::now();
        while (tcpRunning.load()) {
            auto s = tcpSock; if (!s) break;
            int got = s->recv(buf.data() + carry, CHUNK, false, 5000);
            if (got <= 0) { if (!tcpRunning.load()) break; continue; }
            auto now = std::chrono::steady_clock::now();
            auto gapMs = std::chrono::duration_cast<std::chrono::milliseconds>(
                             now - lastData).count();
            if (gapMs >= kStallMs) netStalls.fetch_add(1, std::memory_order_relaxed);
            lastData = now;
            int total = carry + got;
            enqueueIq(buf.data(), total / 2, /*blockIfFull=*/true);
            carry = total & 1;                    // keep the trailing half-sample byte
            if (carry) buf[0] = buf[total - 1];
        }
    }
};

// ── Public API ───────────────────────────────────────────────────────────────
// Serialises start()/stop() so concurrent app-teardown calls can't double-free.
static std::mutex g_lifecycle;

LocalSdrShim& LocalSdrShim::instance() { static LocalSdrShim inst; return inst; }

int LocalSdrShim::start(int fd, int vid, int pid,
                        double centerFreq, double sampleRate, int gainTenthDb,
                        int fftSize, double fftRate, const std::string& mode, std::string& err) {
    std::lock_guard<std::mutex> life(g_lifecycle);
    // Recover from a stale shim left by a dirty exit (app swiped away while the
    // foreground service kept the process — and the shim — alive). Without this
    // the new connect got "already running" and wedged on the next launch.
    if (p) { LOGI("stale shim found on start — tearing down"); stopLocked(); }
    auto* impl = new Impl();
    impl->sampleRate = sampleRate;
    impl->fftSize = fftSize;
    impl->fftRate = fftRate;
    impl->rtlCenter.store(centerFreq);
    impl->viewCenter.store(centerFreq);
    impl->audioFreq.store(centerFreq);
    impl->mode = mode.empty() ? "nfm" : mode;

    impl->usbFd = dup(fd);
    if (impl->usbFd < 0) { err = "dup(usb fd) failed"; delete impl; return -1; }
    int ret = rtlsdr_open_sys_dev(&impl->dev, (intptr_t)impl->usbFd);
    if (ret != 0 || !impl->dev) { err = "rtlsdr_open_sys_dev failed: " + std::to_string(ret); ::close(impl->usbFd); delete impl; return -1; }
    rtlsdr_set_sample_rate(impl->dev, (uint32_t)sampleRate);
    // Offset tuning: physically tune HW_OFFSET_HZ above the logical centre.
    impl->tuneHw(centerFreq);
    if (gainTenthDb < 0) rtlsdr_set_tuner_gain_mode(impl->dev, 0);
    else { rtlsdr_set_tuner_gain_mode(impl->dev, 1); rtlsdr_set_tuner_gain(impl->dev, gainTenthDb); }
    rtlsdr_reset_buffer(impl->dev);
    // Use the ACTUAL rate the RTL rounded to (keeps the waterfall calibrated).
    uint32_t actualSr = rtlsdr_get_sample_rate(impl->dev);
    if (actualSr > 0) impl->sampleRate = (double)actualSr;
    // FFT size auto-scales with the rate for uniform Hz/bin (matches UberSDR).
    impl->fftSize = fftSizeForRate(impl->sampleRate);

    impl->startEngine();
    impl->buildAudio();

    int chosen = -1;
    for (int port = 48000; port < 48050; port++) {
        try { impl->listener = net::listen("127.0.0.1", port); chosen = port; break; }
        catch (...) { impl->listener = nullptr; }
    }
    if (!impl->listener) {
        err = "could not bind localhost port";
        impl->teardownAudio(); impl->rx.stop(); rtlsdr_close(impl->dev); ::close(impl->usbFd); delete impl; return -1;
    }
    impl->port = chosen;
    impl->serverRunning.store(true);
    impl->acceptThread = std::thread([impl]{ impl->acceptLoop(); });

    impl->startDspThread();
    impl->rtlThread = std::thread([impl]{ vibeThreadName("vibe-rtl"); rtlsdr_read_async(impl->dev, &Impl::asyncHandler, impl, 0, 0); });

    p = impl;
    LOGI("local SDR started: center=%.0f rate=%.0f fft=%d mode=%s port=%d",
         centerFreq, sampleRate, fftSize, impl->mode.c_str(), chosen);
    return chosen;
}

// Standard R820T/R828D tuner gains (tenths of dB) — rtl_tcp's header gives only a
// gain COUNT, not the values, so we expose this well-known table for the slider.
static const int kR820tGains[] = {
    0, 9, 14, 27, 37, 77, 87, 125, 144, 157, 166, 197, 207, 229, 254, 280,
    297, 328, 338, 364, 372, 386, 402, 421, 434, 439, 445, 480, 496
};

int LocalSdrShim::startTcp(const std::string& host, int port,
                           double centerFreq, double sampleRate, int gainTenthDb,
                           int fftSize, double fftRate, const std::string& mode, std::string& err) {
    std::lock_guard<std::mutex> life(g_lifecycle);
    if (p) { LOGI("stale shim found on TCP start — tearing down"); stopLocked(); }
    auto* impl = new Impl();
    impl->sampleRate = sampleRate;
    impl->fftSize = fftSize;
    impl->fftRate = fftRate;
    impl->rtlCenter.store(centerFreq);
    impl->viewCenter.store(centerFreq);
    impl->audioFreq.store(centerFreq);
    impl->mode = mode.empty() ? "nfm" : mode;

    // Connect to the rtl_tcp server and read its 12-byte header.
    try { impl->tcpSock = net::connect(host, port); }
    catch (...) { impl->tcpSock = nullptr; }
    if (!impl->tcpSock) { err = "could not connect to rtl_tcp " + host + ":" + std::to_string(port); delete impl; return -1; }
    // 1 MB receive buffer: absorbs WiFi stalls on the receiving side so the IQ
    // stream doesn't gap when the radio naps. Kernel may clamp; not fatal.
    impl->tcpSock->setRecvBufferSize(1024 * 1024);

    // Network jitter buffer: 250 ms of standing backlog, capped at 500 ms. Enough
    // to ride out a WiFi power-save / retry stall; small enough that retuning still
    // feels responsive. Only the TCP path sets these (USB leaves them at 0).
    impl->iqPrefillSamples = (size_t)(sampleRate * 0.25);
    impl->iqMaxSamples     = impl->iqPrefillSamples * 2;
    uint8_t hdr[12];
    if (impl->tcpSock->recv(hdr, 12, true, 8000) != 12 || memcmp(hdr, "RTL0", 4) != 0) {
        err = "bad rtl_tcp header (not an rtl_tcp server?)"; impl->tcpSock->close(); impl->tcpSock = nullptr; delete impl; return -1;
    }
    impl->tcpTunerType = (hdr[4] << 24) | (hdr[5] << 16) | (hdr[6] << 8) | hdr[7];
    impl->tcpGains.assign(kR820tGains, kR820tGains + (sizeof(kR820tGains) / sizeof(int)));

    // Initial config via rtl_tcp commands (0x02 rate, 0x01 freq, 0x03/0x04 gain).
    impl->sendTcpCmd(0x02, (uint32_t)sampleRate);
    impl->tuneHw(impl->rtlCenter.load());   // offset tuning (HW_OFFSET_HZ above centre)
    if (gainTenthDb < 0) { impl->sendTcpCmd(0x03, 0); }                       // auto
    else { impl->sendTcpCmd(0x03, 1); impl->sendTcpCmd(0x04, (uint32_t)gainTenthDb); }

    impl->fftSize = fftSizeForRate(impl->sampleRate);

    impl->startEngine();
    impl->buildAudio();

    int chosen = -1;
    for (int p2 = 48000; p2 < 48050; p2++) {
        try { impl->listener = net::listen("127.0.0.1", p2); chosen = p2; break; }
        catch (...) { impl->listener = nullptr; }
    }
    if (!impl->listener) {
        err = "could not bind localhost port";
        impl->teardownAudio(); impl->rx.stop();
        impl->tcpSock->close(); impl->tcpSock = nullptr; delete impl; return -1;
    }
    impl->port = chosen;
    impl->serverRunning.store(true);
    impl->acceptThread = std::thread([impl]{ impl->acceptLoop(); });

    impl->startDspThread();
    impl->tcpRunning.store(true);
    impl->rtlThread = std::thread([impl]{ impl->tcpReadLoop(); });

    p = impl;
    LOGI("RTL-TCP started: %s:%d center=%.0f rate=%.0f tuner=%d port=%d",
         host.c_str(), port, centerFreq, sampleRate, impl->tcpTunerType, chosen);
    return chosen;
}

int LocalSdrShim::startSpyServer(const std::string& host, int port,
                                double centerFreq, double sampleRate, int gainTenthDb,
                                int fftSize, double fftRate, const std::string& mode,
                                std::string& err) {
    std::lock_guard<std::mutex> life(g_lifecycle);
    if (p) { LOGI("stale shim found on SpyServer start — tearing down"); stopLocked(); }
    auto* impl = new Impl();
    impl->fftSize = fftSize;
    impl->fftRate = fftRate;
    impl->rtlCenter.store(centerFreq);
    impl->viewCenter.store(centerFreq);
    impl->audioFreq.store(centerFreq);
    impl->mode = mode.empty() ? "nfm" : mode;

    impl->spy = std::make_unique<spyserver::SpyServerClient>();
    if (!impl->spy->connect(host, port, "VibeSDR", err)) { delete impl; return -1; }

    const auto& info = impl->spy->deviceInfo();
    if (info.maximumSampleRate == 0) {
        err = "SpyServer reported no sample rate"; impl->spy->close(); delete impl; return -1;
    }

    // Pick the DEEPEST decimation whose rate still comfortably carries the mode's
    // bandwidth. This is where the bandwidth win lives, and it must be derived from
    // the server's own DEVICE_INFO — public servers are not all RTL-SDRs. An Airspy
    // One runs at 10 MSPS, so a hardcoded "decimation 0" would pull 20 MB/s from a
    // stranger's uplink.
    // 1.6x the demod bandwidth covers the filter skirts and leaves the VFO room to
    // move before retune() has to recentre the IQ window. The 48 kHz floor keeps the
    // audio chain fed on narrow modes (SSB/CW would otherwise pick an absurd stage).
    const auto mp = paramsFor(impl->mode);
    const double needHz = std::max(mp.bandwidth * 1.6, 48000.0);
    // START at minimumIQDecimation, never 0. An Airspy One advertises min stage 5
    // (and 6 MSPS, 12-bit): starting at 0 and only raising the stage when a rate
    // satisfies the bandwidth leaves decim=0 whenever even the minimum stage is too
    // narrow — which for WFM it is. That would pull 24 MB/s off a stranger's server.
    // If no stage is wide enough, take the minimum: it's the widest we're allowed.
    const uint32_t maxStage = std::max(info.decimationStageCount, info.minimumIQDecimation);
    int decim = (int)info.minimumIQDecimation;
    for (uint32_t st = info.minimumIQDecimation; st <= maxStage; ++st) {
        const double r = (double)info.maximumSampleRate / (double)(1u << st);
        if (r < needHz) break;
        decim = (int)st;
    }
    impl->spyDecim   = decim;
    impl->sampleRate = (double)info.maximumSampleRate / (double)(1u << decim);
    impl->fftSize    = fftSizeForRate(impl->sampleRate);

    // Wide waterfall geometry, straight from the server.
    impl->spyFftSpan = info.maximumBandwidth > 0 ? (double)info.maximumBandwidth
                                                 : (double)info.maximumSampleRate;
    impl->spyFftCenter.store(centerFreq);
    impl->spyDbRange = 140;

    // SpyServer sends a bare gain INDEX and never the dB values, so the client must
    // supply a table. Public servers are NOT all RTL-SDRs: an Airspy HF advertises
    // maximumGainIndex = 8, so the 29-entry R820T table would have us sending
    // indices the server has to clamp or reject. Only use it when the device really
    // is an RTL-SDR AND the index count matches; otherwise synthesise a monotonic
    // table of the right length so the slider stays usable and in range.
    const size_t nGains = (size_t)info.maximumGainIndex + 1;
    const size_t rtlGains = sizeof(kR820tGains) / sizeof(int);
    if (info.deviceType == spyserver::DEVICE_RTLSDR && nGains >= rtlGains) {
        impl->spyGains.assign(kR820tGains, kR820tGains + rtlGains);
    } else {
        impl->spyGains.resize(nGains);
        for (size_t i = 0; i < nGains; ++i)                 // evenly spread 0..49.6 dB
            impl->spyGains[i] = (int)llround(496.0 * (double)i / (double)(nGains > 1 ? nGains - 1 : 1));
    }

    // Match the wire format to the device's ADC. uint8 is lossless on an 8-bit
    // RTL-SDR and half the bytes; on a 16-bit Airspy it would discard 8 bits of a
    // considerably better receiver. forcedIQFormat != 0 means the server dictates.
    uint32_t iqFormat = spyserver::FORMAT_UINT8;
    if (info.forcedIQFormat != 0)      iqFormat = info.forcedIQFormat;
    else if (info.resolution > 8)      iqFormat = spyserver::FORMAT_INT16;
    impl->spyIqFormat = iqFormat;
    impl->lastGainTenthDb = gainTenthDb;
    const uint32_t gainIdx = gainTenthDb < 0
        ? (uint32_t)(impl->spyGains.size() / 2)     // no AGC in the protocol: mid-scale
        : spyserver::SpyServerClient::gainIndexForTenthDb(impl->spyGains, gainTenthDb);

    // Same jitter buffer as the rtl_tcp path — decimation shrinks the stream but
    // does nothing about a WiFi stall.
    impl->iqPrefillSamples = (size_t)(impl->sampleRate * 0.25);
    impl->iqMaxSamples     = impl->iqPrefillSamples * 2;

    // IQ carries the offset-tuning shift the DSP expects; the FFT does not (its
    // bins are read straight against spyFftCenter).
    const uint32_t iqHz  = (uint32_t)llround(centerFreq + Impl::HW_OFFSET_HZ);
    const uint32_t fftHz = (uint32_t)llround(centerFreq);
    // 2048 bins over the span: ~977 Hz on a 2 MHz RTL server, ~30 KB/s at 15 fps.
    // Finer than this costs bandwidth for detail the waterfall can't show, and the
    // IQ FFT takes over anyway once you zoom in.
    constexpr uint32_t kFftPixels = 2048;
    if (!impl->spy->startStream(spyserver::STREAM_MODE_IQ | spyserver::STREAM_MODE_FFT,
                                iqFormat, (uint32_t)decim,
                                iqHz, gainIdx, kFftPixels, fftHz)) {
        err = "SpyServer refused the stream settings";
        impl->spy->close(); delete impl; return -1;
    }

    impl->startEngine();
    impl->buildAudio();

    int chosen = -1;
    for (int p2 = 48000; p2 < 48050; p2++) {
        try { impl->listener = net::listen("127.0.0.1", p2); chosen = p2; break; }
        catch (...) { impl->listener = nullptr; }
    }
    if (!impl->listener) {
        err = "could not bind localhost port";
        impl->teardownAudio(); impl->rx.stop();
        impl->spy->close(); delete impl; return -1;
    }
    impl->port = chosen;
    impl->serverRunning.store(true);
    impl->acceptThread = std::thread([impl]{ impl->acceptLoop(); });

    impl->startDspThread();
    impl->tcpRunning.store(true);                 // shared "network source alive" flag
    impl->rtlThread = std::thread([impl]{ impl->spyReadLoop(); });

    p = impl;
    LOGI("SpyServer started: %s:%d center=%.0f decim=%d iqRate=%.0f fftSpan=%.0f "
         "control=%d port=%d",
         host.c_str(), port, centerFreq, decim, impl->sampleRate, impl->spyFftSpan,
         (int)impl->spy->canControl(), chosen);
    return chosen;
}

void LocalSdrShim::stop() {
    // Serialise with start()/stop(): app teardown fires stopSpectrum from several
    // Kotlin paths (unmount + invalidate), possibly concurrently — without this
    // two stops grab the same Impl and double-free it (the ~Impl crash on close).
    std::lock_guard<std::mutex> life(g_lifecycle);
    stopLocked();
}

void LocalSdrShim::stopLocked() {
    if (!p) return;
    Impl* impl = p; p = nullptr;

    impl->serverRunning.store(false);
    // Close the client sockets FIRST. The FFT/audio worker threads write to them
    // via sendWs; if a client has stopped reading (e.g. the app is tearing the
    // spectrum/audio WS down while switching to a network instance), that send
    // blocks — and teardownAudio()/frontend->stop() below would then hang joining
    // a worker stuck mid-write. Closing the sockets makes the blocked send/recv
    // fail so every thread can exit. (This was the "shim gets stuck" on
    // local→network — long-standing, just never hit until that path was used.)
    { std::lock_guard<std::mutex> lk(impl->clientMtx);
      if (impl->specClient) impl->specClient->close();
      if (impl->audioClient) impl->audioClient->close();
      if (impl->dxClient) impl->dxClient->close(); }

    // Stop the IQ source. USB: cancel the async read. RTL-TCP: clear the run flag
    // and close the socket so the blocked recv() returns and the read thread exits.
    if (impl->dev) rtlsdr_cancel_async(impl->dev);
    if (impl->useSpy()) { impl->tcpRunning.store(false); impl->spy->close(); }
    if (impl->useTcp()) { impl->tcpRunning.store(false); if (impl->tcpSock) impl->tcpSock->close(); }
    if (impl->rtlThread.joinable()) impl->rtlThread.join();
    // IQ source stopped -> stop the DSP consumer (drains/clears the queue) before
    // tearing the engine down, so no rx.feed runs against a destroyed engine.
    impl->stopDspThread();
    impl->teardownAudio();
    impl->rx.stop();

    impl->stopDecoder();
    impl->stopSpots();
    { std::lock_guard<std::mutex> lk(impl->nrMtx); delete impl->nrEng; impl->nrEng = nullptr; }
    { std::lock_guard<std::mutex> lk(impl->notchMtx); delete impl->notchEng; impl->notchEng = nullptr; }
    // NOTE: do NOT call listener->stop() here. acceptLoop polls accept() with a
    // 500ms timeout and checks serverRunning, so clearing it (above) exits the
    // loop on its own. net::Listener::stop() isn't idempotent (it closeSocket()s
    // unconditionally) and ~Listener calls stop() again on `delete impl` — an
    // explicit stop() here made that a DOUBLE close of the same fd, which after
    // the number was reused tripped fdsan → SIGABRT on teardown. Let ~Listener
    // close it exactly once.
    if (impl->acceptThread.joinable()) impl->acceptThread.join();
    { std::lock_guard<std::mutex> lk(impl->connMtx);
      for (auto& t : impl->connThreads) if (t.joinable()) t.join();
      impl->connThreads.clear(); }

    if (impl->dev) rtlsdr_close(impl->dev);
    impl->tcpSock = nullptr;             // RTL-TCP socket already closed above
    // Close our own dup last (rtlsdr_close/libusb don't own it). Kotlin's
    // UsbDeviceConnection.close() races us harmlessly now — it's a different fd.
    if (impl->usbFd >= 0) { ::close(impl->usbFd); impl->usbFd = -1; }
    delete impl;
    LOGI("local SDR stopped");
}

// ── Decoder-only sidecar (network backends) ───────────────────────────────────
int LocalSdrShim::startDecoderService(std::string& err) {
    std::lock_guard<std::mutex> life(g_lifecycle);
    if (p) { LOGI("stale shim found on decoder-service start — tearing down"); stopLocked(); }
    Impl* impl = new Impl();
    impl->decoderOnly = true;
    impl->sampleRate = 48000.0;            // decoders run at 48 kHz
    int chosen = -1;
    for (int port = 48050; port < 48100; port++) {   // above the local-SDR range
        try { impl->listener = net::listen("127.0.0.1", port); chosen = port; break; }
        catch (...) { impl->listener = nullptr; }
    }
    if (!impl->listener) { err = "could not bind localhost port"; delete impl; return -1; }
    impl->port = chosen;
    impl->serverRunning.store(true);
    impl->acceptThread = std::thread([impl]{ impl->acceptLoop(); });
    p = impl;
    LOGI("decoder service started: port=%d", chosen);
    return chosen;
}

void LocalSdrShim::feedDecoderPcm(const int16_t* pcm, int n, int rate) {
    if (!p || !p->decoderOnly || n < 2 || rate <= 0) return;
    // Upsample to the decoders' 48 kHz (linear interp), build a mono stereo_t
    // buffer (l=r) and feed the decoder + digital-spots paths.
    double ratio = 48000.0 / (double)rate;
    double srcStep = 1.0 / ratio;
    std::vector<stereo_t> buf;
    buf.reserve((size_t)(n * ratio) + 2);
    for (double s = 0; s < n - 1; s += srcStep) {
        int i = (int)s; double f = s - i;
        float v = (float)(((1.0 - f) * pcm[i] + f * pcm[i + 1]) / 32768.0);
        buf.push_back({ v, v });
    }
    if (buf.empty()) return;
    p->feedDecoder(buf.data(), (int)buf.size());
    p->feedSpots(buf.data(), (int)buf.size());
}

void LocalSdrShim::setDecoderFreq(double hz) {
    if (!p || hz <= 0) return;
    // Dial frequency for the sidecar: FT8 spots are emitted at audioFreq + offset,
    // so without this they'd land at the 100 MHz default (empty band, wrong freq).
    p->audioFreq.store(hz);
}

// ── Hardware controls ─────────────────────────────────────────────────────────
void LocalSdrShim::setGain(int gainTenthDb) {
    if (!p) return;
    if (p->useSpy()) {
        // No AGC in the protocol — "auto" has no wire representation, so mid-scale.
        p->lastGainTenthDb = gainTenthDb;
        uint32_t idx = gainTenthDb < 0
            ? (uint32_t)(p->spyGains.size() / 2)
            : spyserver::SpyServerClient::gainIndexForTenthDb(p->spyGains, gainTenthDb);
        const uint32_t maxIdx = p->spy->deviceInfo().maximumGainIndex;
        if (idx > maxIdx) idx = maxIdx;
        p->spy->setGainIndex(idx);
        LOGI("gain: index %u", idx);
        return;
    }
    if (p->useTcp()) {
        if (gainTenthDb < 0) p->sendTcpCmd(0x03, 0);
        else { p->sendTcpCmd(0x03, 1); p->sendTcpCmd(0x04, (uint32_t)gainTenthDb); }
        return;
    }
    if (!p->dev) return;
    if (gainTenthDb < 0) { rtlsdr_set_tuner_gain_mode(p->dev, 0); LOGI("gain: auto"); }
    else { rtlsdr_set_tuner_gain_mode(p->dev, 1); rtlsdr_set_tuner_gain(p->dev, gainTenthDb);
           LOGI("gain: %.1f dB", gainTenthDb / 10.0); }
}
void LocalSdrShim::setPpm(int ppm) {
    if (!p) return;
    if (p->useSpy()) return;   // no ppm setting in the SpyServer protocol

    if (p->useTcp()) { p->sendTcpCmd(0x05, (uint32_t)ppm); return; }
    if (!p->dev) return;
    rtlsdr_set_freq_correction(p->dev, ppm); LOGI("ppm: %d", ppm);
}
void LocalSdrShim::setBiasTee(bool on) {
    if (!p) return;
    if (p->useTcp()) { p->sendTcpCmd(0x0e, on ? 1 : 0); return; }
    if (!p->dev) return;
    rtlsdr_set_bias_tee(p->dev, on ? 1 : 0); LOGI("bias-tee: %d", on);
}
void LocalSdrShim::setAgc(bool on) {
    if (!p) return;
    if (p->useTcp()) { p->sendTcpCmd(0x08, on ? 1 : 0); return; }
    if (!p->dev) return;
    rtlsdr_set_agc_mode(p->dev, on ? 1 : 0); LOGI("agc: %d", on);
}
void LocalSdrShim::setDirectSampling(int mode) {
    if (!p) return;
    if (p->useTcp()) { p->sendTcpCmd(0x09, (uint32_t)mode); return; }
    if (!p->dev) return;
    rtlsdr_set_direct_sampling(p->dev, mode); LOGI("direct sampling: %d", mode);
}
void LocalSdrShim::setSquelch(bool on, float db) {
    if (!p) return;
    p->squelchOn.store(on); p->squelchDb.store(db);
    LOGI("squelch: %d @ %.1f dB", on, db);
}
void LocalSdrShim::setNR(bool on) {
    if (!p) return;
    p->nrOn.store(on);
    if (!on) { std::lock_guard<std::mutex> lk(p->nrMtx); if (p->nrEng) p->nrEng->reset(); }
    LOGI("audio NR: %d", on);
}
void LocalSdrShim::setNrStrength(float s) {
    if (!p) return;
    std::lock_guard<std::mutex> lk(p->nrMtx);
    if (!p->nrEng) p->nrEng = new AudioNR();
    p->nrEng->setStrength(s);
}
float LocalSdrShim::getNrCpu() { return p ? p->nrCpuPct.load() : 0.0f; }
void LocalSdrShim::setNotch(bool on) {
    if (!p) return;
    p->notchOn.store(on);
    if (!on) { std::lock_guard<std::mutex> lk(p->notchMtx); if (p->notchEng) p->notchEng->reset(); }
    LOGI("auto notch: %d", on);
}
void LocalSdrShim::setStereoEnabled(bool on) {
    if (!p) return;
    p->rx.setStereoEnabled(on);           // engine blends L-R out when off (-> mono)
    LOGI("stereo: %s", on ? "on" : "forced mono");
}
void LocalSdrShim::setSampleRate(double rate) {
    if (!p || rate <= 0) return;
    Impl* impl = p;
    const bool tcp = impl->useTcp();
    if (!tcp && !impl->dev) return;
    // Stop the IQ source + drain the DSP consumer BEFORE taking modeMtx (the
    // dspThread locks modeMtx per buffer, so holding it across the join would
    // deadlock). With both quiesced, the rtlsdr control transfer below runs on an
    // idle libusb and the engine rebuild has no concurrent rx.feed.
    if (tcp) { impl->tcpRunning.store(false); }
    else     { rtlsdr_cancel_async(impl->dev); }
    if (impl->rtlThread.joinable()) impl->rtlThread.join();
    impl->stopDspThread();
    std::lock_guard<std::recursive_mutex> lk(impl->modeMtx);
    uint32_t actual;
    if (tcp) {
        impl->sendTcpCmd(0x02, (uint32_t)rate);   // rtl_tcp uses the rate as-is
        actual = (uint32_t)rate;
    } else {
        rtlsdr_set_sample_rate(impl->dev, (uint32_t)rate);
        rtlsdr_reset_buffer(impl->dev);
        // The RTL rounds to a supported rate — use the ACTUAL for FFT/config or the
        // waterfall calibration drifts (signals land off their true freq).
        actual = rtlsdr_get_sample_rate(impl->dev);
    }
    impl->sampleRate = actual > 0 ? (double)actual : rate;
    impl->fftSize = fftSizeForRate(impl->sampleRate);

    impl->teardownAudio();
    impl->rx.stop();
    impl->startEngine();
    impl->buildAudio();
    { std::lock_guard<std::mutex> lk(impl->clientMtx); if (impl->specClient) impl->sendConfig(impl->specClient); }
    impl->startDspThread();
    if (tcp) { impl->tcpRunning.store(true); impl->rtlThread = std::thread([impl]{ impl->tcpReadLoop(); }); }
    else     { impl->rtlThread = std::thread([impl]{ vibeThreadName("vibe-rtl"); rtlsdr_read_async(impl->dev, &Impl::asyncHandler, impl, 0, 0); }); }
    LOGI("sample rate: %.0f (actual %u) fft=%d tcp=%d", rate, actual, impl->fftSize, tcp);
}
void LocalSdrShim::setDeemphasis(double tau) {
    std::lock_guard<std::mutex> life(g_lifecycle);
    if (!p) return;
    if (p->deempTau == tau) return;
    p->deempTau = tau;
    p->rx.setDeemphasis(tau);   // engine applies 0/50us/75us on the next rebuild
    LOGI("deemphasis: %.0f us", tau * 1e6);
}
LocalSdrShim::NetStatus LocalSdrShim::getNetStatus() {
    NetStatus s;
    if (!p || !(p->useTcp() || p->useSpy())) return s;   // USB path: nothing to report
    s.tcp = true;
    s.stalls         = p->netStalls.load(std::memory_order_relaxed);
    s.droppedSamples = p->iqDroppedSamples.load(std::memory_order_relaxed);
    double rate = p->sampleRate > 0 ? p->sampleRate : 1.0;
    std::lock_guard<std::mutex> lk(p->iqMtx);
    s.bufferedMs = (uint32_t)(p->iqQueuedSamples * 1000.0 / rate);
    return s;
}

std::vector<int> LocalSdrShim::getTunerGains() {
    std::vector<int> out;
    if (!p) return out;
    // SpyServer transmits a bare gain INDEX and never the dB values, so the UI has
    // no table unless we supply one. Without this the gain slider has nothing to
    // offer and gain looks uncontrollable. (Stock clients just show a 0..29 dial.)
    if (p->useSpy()) return p->spyGains;
    if (p->useTcp()) return p->tcpGains;     // rtl_tcp header has no values → R820T table
    if (!p->dev) return out;
    int n = rtlsdr_get_tuner_gains(p->dev, nullptr);
    if (n <= 0) return out;
    out.resize(n);
    rtlsdr_get_tuner_gains(p->dev, out.data());
    return out;
}

bool LocalSdrShim::isRunning() const { return p != nullptr; }

} // namespace vibe
