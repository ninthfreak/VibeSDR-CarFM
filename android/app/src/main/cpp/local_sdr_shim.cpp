// VibeSDR V4 — local-SDR shim implementation (Stages 3 + 4).
//
// Pipeline:
//   RTL-SDR (USB fd) → librtlsdr async IQ → dsp::stream → IQFrontEnd
//     ├─ FFT dB row → SPEC full-uint8 frames → /ws/user-spectrum (Stage 3)
//     └─ RxVFO → demod (AM/SSB/CW/NFM/WFM) → resample 48k → int16 PCM
//                → /ws/audio (Stage 4; WFM stereo, others mono)
//
// A minimal localhost HTTP/WebSocket server (one thread per connection) speaks
// the UberSDR contract so the VibeSDR client connects unchanged. Control
// (zoom/tune/mode/bandwidth/set_rate/ping/reset) arrives as JSON text frames.

#include "local_sdr_shim.h"

#include <android/log.h>
#include <rtl-sdr.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "signal_path/iq_frontend.h"
#include "dsp/channel/rx_vfo.h"
#include "dsp/demod/am.h"
#include "dsp/demod/ssb.h"
#include "dsp/demod/fm.h"
#include "dsp/demod/cw.h"
#include "dsp/demod/broadcast_fm.h"
#include "dsp/multirate/rational_resampler.h"
#include "dsp/sink/handler_sink.h"
#include "dsp/types.h"
#include "utils/net.h"

#define LOG_TAG "VibeLocalSDR"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace vibe {
namespace {

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
    if (mode == "cwu" || mode == "cwl" || mode == "cw") return {ModeParams::CW, 8000, 500, 1};
    if (mode == "wfm")            return {ModeParams::WFM, 250000, 200000, 2};
    /* nfm / fm */                return {ModeParams::NFM, 50000, 12500, 1};
}

} // namespace

// ── Impl ────────────────────────────────────────────────────────────────────
struct LocalSdrShim::Impl {
    // device / params
    rtlsdr_dev_t* dev = nullptr;
    double sampleRate = 2400000.0;
    int    fftSize    = 1024;
    double fftRate    = 20.0;
    std::atomic<double> rtlCenter{100000000.0}; // RTL tuned centre = spectrum centre
    std::atomic<double> audioFreq{100000000.0}; // demod dial frequency
    std::atomic<int>    rateDivisor{1};
    std::atomic<double> zoomFactor{1.0}; // spectrum zoom: FFT-crop factor (>=1)
    std::string mode = "nfm";
    double demodOffset = 0.0;             // VFO offset for the mode (SSB = ±bw/2)
    std::mutex modeMtx;

    // IQ + FFT. frontend is heap-allocated so a detail (FFT-size) change can
    // recreate it with fresh dsp blocks (re-init aborts; setFFTSize touches the
    // GUI waterfall which doesn't exist headless).
    dsp::stream<dsp::complex_t> iqStream;
    IQFrontEnd* frontend = nullptr;
    std::vector<float> fftBuf;
    std::vector<float> fftAccum;   // running sum for FFT averaging
    int accumCount = 0;
    std::thread rtlThread;

    // VFO offset for the current dial freq + mode (SSB sideband correction).
    double vfoOffsetNow() { return audioFreq.load() - rtlCenter.load() + demodOffset; }

    // audio chain (rebuilt on mode change)
    dsp::channel::RxVFO* vfo = nullptr;
    dsp::Processor<dsp::complex_t, dsp::stereo_t>* demod = nullptr;
    void (*demodDeleter)(void*) = nullptr;
    // Heap-allocated + recreated on every rebuild: dsp::block::init() aborts() if
    // called twice on the same block (registerInput guard), so member objects
    // can't be re-init'd — each buildAudio() needs fresh ones.
    dsp::multirate::RationalResampler<dsp::stereo_t>* resamp = nullptr;
    dsp::sink::Handler<dsp::stereo_t>* audioSink = nullptr;
    std::atomic<int> audioChannels{1};

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

    // ── FFT callback (Stage 3) ─────────────────────────────────────────────
    static float* acquire(void* ctx) { return ((Impl*)ctx)->fftBuf.data(); }
    static void release(void* ctx) { ((Impl*)ctx)->onFFT(); }
    void onFFT() {
        const int bins = fftSize;
        // Block-average FFT_AVG independent FFTs (dB domain) to kill shimmer.
        if ((int)fftAccum.size() != bins) { fftAccum.assign(bins, 0.0f); accumCount = 0; }
        for (int i = 0; i < bins; i++) fftAccum[i] += fftBuf[i];
        if (++accumCount < FFT_AVG) return;
        float inv = 1.0f / (float)accumCount;

        uint64_t n = frameCounter.fetch_add(1);
        int div = rateDivisor.load();
        bool emit = !(div > 1 && (n % (uint64_t)div) != 0);
        std::shared_ptr<net::Socket> sock;
        { std::lock_guard<std::mutex> lk(clientMtx); sock = specClient; }

        if (emit && sock && sock->isOpen()) {
            // Emit a FIXED OUT_BINS bins (GPU-safe waterfall texture width — a
            // 32768-wide texture exceeds mobile GPU limits and the waterfall
            // silently fails). Map the fine internal FFT (fftSize bins) to the
            // output, applying zoom: each output bin covers `step` source bins;
            // peak-hold when downsampling (don't drop narrow carriers), nearest
            // when zoomed in (step<1) so deep zoom stays sharp off the fine FFT.
            double zoom = zoomFactor.load();
            const int outBins = OUT_BINS;
            const double step = (double)bins / (zoom * (double)outBins); // src bins / out bin
            std::vector<uint8_t> frame(22 + outBins);
            frame[0]='S';frame[1]='P';frame[2]='E';frame[3]='C';frame[4]=0x01;frame[5]=0x03;
            uint64_t ts = (uint64_t)std::chrono::duration_cast<std::chrono::nanoseconds>(
                std::chrono::system_clock::now().time_since_epoch()).count();
            std::memcpy(&frame[6], &ts, 8);
            uint64_t f = (uint64_t)llround(rtlCenter.load());
            std::memcpy(&frame[14], &f, 8);
            for (int i = 0; i < outBins; i++) {
                int signedOut = (i <= outBins / 2) ? i : i - outBins;
                double center = signedOut * step;          // fractional src index (signed)
                int lo = (int)std::floor(center - step / 2.0);
                int hi = (int)std::ceil(center + step / 2.0);
                if (hi <= lo) hi = lo + 1;
                float best = -1e9f;
                for (int s = lo; s < hi; s++) {
                    int idx = ((s % bins) + bins) % bins;
                    float val = fftAccum[idx] * inv;        // averaged dB
                    if (val > best) best = val;             // peak-hold
                }
                int v = (int)lround(best + 256.0);
                frame[22+i] = (uint8_t)(v < 0 ? 0 : (v > 255 ? 255 : v));
            }
            sendWs(sock, 0x2, frame.data(), frame.size());
        }
        std::fill(fftAccum.begin(), fftAccum.end(), 0.0f);
        accumCount = 0;
    }

    // ── Audio callback (Stage 4) ───────────────────────────────────────────
    static void audioHandler(dsp::stereo_t* data, int count, void* ctx) {
        ((Impl*)ctx)->onAudio(data, count);
    }
    void onAudio(dsp::stereo_t* data, int count) {
        std::shared_ptr<net::Socket> sock;
        { std::lock_guard<std::mutex> lk(clientMtx); sock = audioClient; }
        if (!sock || !sock->isOpen() || count <= 0) return;
        int ch = audioChannels.load();
        // header: [0]=channels, [1]=0, [2..5]=sampleRate u32 LE, then int16 PCM
        std::vector<uint8_t> frame(6 + (size_t)count * ch * 2);
        frame[0] = (uint8_t)ch; frame[1] = 0;
        uint32_t sr = (uint32_t)AUDIO_SR; std::memcpy(&frame[2], &sr, 4);
        int16_t* pcm = (int16_t*)(frame.data() + 6);
        auto cvt = [](float v) -> int16_t {
            int s = (int)lround(v * 32767.0f);
            return (int16_t)(s < -32768 ? -32768 : (s > 32767 ? 32767 : s));
        };
        if (ch == 2) {
            for (int i = 0; i < count; i++) { pcm[i*2] = cvt(data[i].l); pcm[i*2+1] = cvt(data[i].r); }
        } else {
            for (int i = 0; i < count; i++) pcm[i] = cvt(data[i].l);
        }
        sendWs(sock, 0x2, frame.data(), frame.size());
    }

    // ── Demod chain (re)build ──────────────────────────────────────────────
    void teardownAudio() {
        if (audioSink) { audioSink->stop(); delete audioSink; audioSink = nullptr; }
        if (resamp) { resamp->stop(); delete resamp; resamp = nullptr; }
        if (demod) { demod->stop(); if (demodDeleter) demodDeleter(demod); demod = nullptr; demodDeleter = nullptr; }
        if (vfo) { frontend->removeVFO("audio"); vfo = nullptr; }
    }

    void buildAudio() {
        std::lock_guard<std::mutex> lk(modeMtx);
        teardownAudio();
        ModeParams mp = paramsFor(mode);
        audioChannels.store(mp.channels);
        // SSB sideband correction: USB passband sits above the carrier (tune at
        // lower edge → VFO +bw/2), LSB below (−bw/2). Without this the audio is
        // shifted ±bw/2 → the SSB "beat"/high-pitch.
        demodOffset = (mp.kind == ModeParams::SSB_USB) ?  mp.bandwidth / 2.0
                    : (mp.kind == ModeParams::SSB_LSB) ? -mp.bandwidth / 2.0 : 0.0;

        double offset = vfoOffsetNow();
        vfo = frontend->addVFO("audio", mp.ifRate, mp.bandwidth, offset);

        switch (mp.kind) {
            case ModeParams::AM: {
                auto* d = new dsp::demod::AM<dsp::stereo_t>();
                d->init(&vfo->out, dsp::demod::AM<dsp::stereo_t>::AGCMode::CARRIER,
                        mp.bandwidth, 50.0/mp.ifRate, 5.0/mp.ifRate, 100.0/mp.ifRate, mp.ifRate);
                demod = d; demodDeleter = [](void* x){ delete (dsp::demod::AM<dsp::stereo_t>*)x; };
                break;
            }
            case ModeParams::SSB_USB:
            case ModeParams::SSB_LSB: {
                auto* d = new dsp::demod::SSB<dsp::stereo_t>();
                d->init(&vfo->out,
                        mp.kind == ModeParams::SSB_USB ? dsp::demod::SSB<dsp::stereo_t>::Mode::USB
                                                       : dsp::demod::SSB<dsp::stereo_t>::Mode::LSB,
                        mp.bandwidth, mp.ifRate, 50.0/mp.ifRate, 5.0/mp.ifRate);
                demod = d; demodDeleter = [](void* x){ delete (dsp::demod::SSB<dsp::stereo_t>*)x; };
                break;
            }
            case ModeParams::CW: {
                auto* d = new dsp::demod::CW<dsp::stereo_t>();
                d->init(&vfo->out, 800.0, 100.0/mp.ifRate, 5.0/mp.ifRate, mp.ifRate);
                demod = d; demodDeleter = [](void* x){ delete (dsp::demod::CW<dsp::stereo_t>*)x; };
                break;
            }
            case ModeParams::NFM: {
                auto* d = new dsp::demod::FM<dsp::stereo_t>();
                d->init(&vfo->out, mp.ifRate, mp.bandwidth, true, false);
                demod = d; demodDeleter = [](void* x){ delete (dsp::demod::FM<dsp::stereo_t>*)x; };
                break;
            }
            case ModeParams::WFM: {
                auto* d = new dsp::demod::BroadcastFM();
                d->init(&vfo->out, 75000.0, mp.ifRate, /*stereo*/true, /*lowPass*/true, /*rds*/false);
                demod = d; demodDeleter = [](void* x){ delete (dsp::demod::BroadcastFM*)x; };
                break;
            }
        }

        resamp = new dsp::multirate::RationalResampler<dsp::stereo_t>();
        resamp->init(&demod->out, mp.ifRate, AUDIO_SR);
        audioSink = new dsp::sink::Handler<dsp::stereo_t>();
        audioSink->init(&resamp->out, &Impl::audioHandler, this);
        demod->start();
        resamp->start();
        audioSink->start();
        LOGI("audio chain: mode=%s ifRate=%.0f bw=%.0f ch=%d", mode.c_str(), mp.ifRate, mp.bandwidth, mp.channels);
    }

    // retune the demod (and RTL centre if the offset would fall outside span)
    void retune(double freq) {
        audioFreq.store(freq);
        double limit = sampleRate / 2.0 - 50000.0;
        if (std::fabs(freq - rtlCenter.load()) > limit) {
            rtlCenter.store(freq);
            if (dev) rtlsdr_set_center_freq(dev, (uint32_t)llround(freq));
        }
        std::lock_guard<std::mutex> lk(modeMtx);
        if (vfo) vfo->setOffset(vfoOffsetNow());
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
        double effective = sampleRate / zoomFactor.load();           // zoom-aware span
        double binBw = effective / (double)OUT_BINS;                  // we emit OUT_BINS bins
        char buf[256];
        snprintf(buf, sizeof buf,
            "{\"type\":\"config\",\"centerFreq\":%lld,\"binCount\":%d,"
            "\"binBandwidth\":%.6f,\"totalBandwidth\":%.1f}",
            (long long)llround(rtlCenter.load()), OUT_BINS, binBw, effective);
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
        if (type == "zoom") { // spectrum centre move (+ span via binBandwidth)
            if (jsonNum(msg,"frequency",v) && v > 0) {
                // Only retune the RTL when the centre actually moves (a pinch
                // keeps the centre, so this avoids per-gesture retune clicks).
                if (std::fabs(v - rtlCenter.load()) > 1.0) {
                    rtlCenter.store(v);
                    if (dev) rtlsdr_set_center_freq(dev, (uint32_t)llround(v));
                    std::lock_guard<std::mutex> lk(modeMtx);
                    if (vfo) vfo->setOffset(vfoOffsetNow());
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
            if (!m.empty() && m != mode) { mode = m; buildAudio(); }
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
        std::lock_guard<std::mutex> lk(modeMtx);
        if (vfo) vfo->setBandwidth(std::min(bw, sampleRate));
        // (demod-internal bandwidth left at construction default for Stage 4)
    }

    // ── HTTP/WS server ─────────────────────────────────────────────────────
    void acceptLoop() {
        while (serverRunning.load()) {
            std::shared_ptr<net::Socket> sock;
            try { sock = listener->accept(nullptr, 500); } catch (...) { sock = nullptr; }
            if (!sock) continue;
            std::lock_guard<std::mutex> lk(connMtx);
            connThreads.emplace_back([this, sock]{ handleConnection(sock); });
        }
    }

    void handleConnection(std::shared_ptr<net::Socket> sock) {
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
        if ((wsSpec || wsAudio) && !wsKey.empty()) {
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

    // ── RTL IQ worker ──────────────────────────────────────────────────────
    static void asyncHandler(unsigned char* buf, uint32_t len, void* ctx) {
        Impl* _this = (Impl*)ctx;
        int sampCount = (int)(len / 2);
        if (sampCount > STREAM_BUFFER_SIZE) sampCount = STREAM_BUFFER_SIZE;
        for (int i = 0; i < sampCount; i++) {
            _this->iqStream.writeBuf[i].re = ((float)buf[i*2]     - 127.4f) / 128.0f;
            _this->iqStream.writeBuf[i].im = ((float)buf[i*2 + 1] - 127.4f) / 128.0f;
        }
        _this->iqStream.swap(sampCount);
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
    if (p) { err = "already running"; return -1; }
    auto* impl = new Impl();
    impl->sampleRate = sampleRate;
    impl->fftSize = fftSize;
    impl->fftRate = fftRate;
    impl->rtlCenter.store(centerFreq);
    impl->audioFreq.store(centerFreq);
    impl->mode = mode.empty() ? "nfm" : mode;
    impl->fftBuf.assign(fftSize, -256.0f);

    int ret = rtlsdr_open_sys_dev(&impl->dev, (intptr_t)fd);
    if (ret != 0 || !impl->dev) { err = "rtlsdr_open_sys_dev failed: " + std::to_string(ret); delete impl; return -1; }
    rtlsdr_set_sample_rate(impl->dev, (uint32_t)sampleRate);
    rtlsdr_set_center_freq(impl->dev, (uint32_t)llround(centerFreq));
    if (gainTenthDb < 0) rtlsdr_set_tuner_gain_mode(impl->dev, 0);
    else { rtlsdr_set_tuner_gain_mode(impl->dev, 1); rtlsdr_set_tuner_gain(impl->dev, gainTenthDb); }
    rtlsdr_reset_buffer(impl->dev);
    // Use the ACTUAL rate the RTL rounded to (keeps the waterfall calibrated).
    uint32_t actualSr = rtlsdr_get_sample_rate(impl->dev);
    if (actualSr > 0) impl->sampleRate = (double)actualSr;
    // FFT size auto-scales with the rate for uniform Hz/bin (matches UberSDR).
    impl->fftSize = fftSizeForRate(impl->sampleRate);
    impl->fftBuf.assign(impl->fftSize, -256.0f);

    impl->frontend = new IQFrontEnd();
    impl->frontend->init(&impl->iqStream, impl->sampleRate, true, 1, true, impl->fftSize, fftRate * FFT_AVG,
                         IQFrontEnd::FFTWindow::NUTTALL, &Impl::acquire, &Impl::release, impl);
    impl->frontend->start();
    impl->buildAudio();

    int chosen = -1;
    for (int port = 48000; port < 48050; port++) {
        try { impl->listener = net::listen("127.0.0.1", port); chosen = port; break; }
        catch (...) { impl->listener = nullptr; }
    }
    if (!impl->listener) {
        err = "could not bind localhost port";
        impl->teardownAudio(); impl->frontend->stop(); delete impl->frontend; rtlsdr_close(impl->dev); delete impl; return -1;
    }
    impl->port = chosen;
    impl->serverRunning.store(true);
    impl->acceptThread = std::thread([impl]{ impl->acceptLoop(); });

    impl->rtlThread = std::thread([impl]{ rtlsdr_read_async(impl->dev, &Impl::asyncHandler, impl, 0, 0); });

    p = impl;
    LOGI("local SDR started: center=%.0f rate=%.0f fft=%d mode=%s port=%d",
         centerFreq, sampleRate, fftSize, impl->mode.c_str(), chosen);
    return chosen;
}

void LocalSdrShim::stop() {
    // Serialise with start()/stop(): app teardown fires stopSpectrum from several
    // Kotlin paths (unmount + invalidate), possibly concurrently — without this
    // two stops grab the same Impl and double-free it (the ~Impl crash on close).
    std::lock_guard<std::mutex> life(g_lifecycle);
    if (!p) return;
    Impl* impl = p; p = nullptr;

    // Stop data producers/consumers FIRST (they touch impl + the sockets).
    impl->serverRunning.store(false);
    if (impl->dev) rtlsdr_cancel_async(impl->dev);
    if (impl->rtlThread.joinable()) impl->rtlThread.join();
    impl->teardownAudio();
    if (impl->frontend) { impl->frontend->stop(); delete impl->frontend; impl->frontend = nullptr; }

    // Then the server: close client sockets to unblock reader recv, stop the
    // listener, join the accept + connection threads.
    { std::lock_guard<std::mutex> lk(impl->clientMtx);
      if (impl->specClient) impl->specClient->close();
      if (impl->audioClient) impl->audioClient->close(); }
    if (impl->listener) impl->listener->stop();
    if (impl->acceptThread.joinable()) impl->acceptThread.join();
    { std::lock_guard<std::mutex> lk(impl->connMtx);
      for (auto& t : impl->connThreads) if (t.joinable()) t.join();
      impl->connThreads.clear(); }

    if (impl->dev) rtlsdr_close(impl->dev);
    delete impl;
    LOGI("local SDR stopped");
}

// ── Hardware controls ─────────────────────────────────────────────────────────
void LocalSdrShim::setGain(int gainTenthDb) {
    if (!p || !p->dev) return;
    if (gainTenthDb < 0) { rtlsdr_set_tuner_gain_mode(p->dev, 0); LOGI("gain: auto"); }
    else { rtlsdr_set_tuner_gain_mode(p->dev, 1); rtlsdr_set_tuner_gain(p->dev, gainTenthDb);
           LOGI("gain: %.1f dB", gainTenthDb / 10.0); }
}
void LocalSdrShim::setPpm(int ppm) {
    if (!p || !p->dev) return;
    rtlsdr_set_freq_correction(p->dev, ppm); LOGI("ppm: %d", ppm);
}
void LocalSdrShim::setBiasTee(bool on) {
    if (!p || !p->dev) return;
    rtlsdr_set_bias_tee(p->dev, on ? 1 : 0); LOGI("bias-tee: %d", on);
}
void LocalSdrShim::setAgc(bool on) {
    if (!p || !p->dev) return;
    rtlsdr_set_agc_mode(p->dev, on ? 1 : 0); LOGI("agc: %d", on);
}
void LocalSdrShim::setDirectSampling(int mode) {
    if (!p || !p->dev) return;
    rtlsdr_set_direct_sampling(p->dev, mode); LOGI("direct sampling: %d", mode);
}
void LocalSdrShim::setSampleRate(double rate) {
    if (!p || !p->dev || rate <= 0) return;
    Impl* impl = p;
    // Stop the IQ stream and recreate the front end at the new rate + auto FFT
    // size (FFT scales with rate for uniform Hz/bin). setFFTSize/setSampleRate on
    // the live IQFrontEnd touch the headless GUI / abort, so rebuild the object.
    rtlsdr_cancel_async(impl->dev);
    if (impl->rtlThread.joinable()) impl->rtlThread.join();
    rtlsdr_set_sample_rate(impl->dev, (uint32_t)rate);
    rtlsdr_reset_buffer(impl->dev);
    // The RTL rounds to a supported rate — use the ACTUAL rate for the FFT/config
    // or the waterfall calibration drifts (signals land off their true freq).
    uint32_t actual = rtlsdr_get_sample_rate(impl->dev);
    impl->sampleRate = actual > 0 ? (double)actual : rate;
    impl->fftSize = fftSizeForRate(impl->sampleRate);

    impl->teardownAudio();
    impl->frontend->stop();
    delete impl->frontend;
    impl->fftBuf.assign(impl->fftSize, -256.0f);
    impl->frontend = new IQFrontEnd();
    impl->frontend->init(&impl->iqStream, impl->sampleRate, true, 1, true, impl->fftSize, impl->fftRate * FFT_AVG,
                         IQFrontEnd::FFTWindow::NUTTALL, &Impl::acquire, &Impl::release, impl);
    impl->frontend->start();
    impl->buildAudio();
    { std::lock_guard<std::mutex> lk(impl->clientMtx); if (impl->specClient) impl->sendConfig(impl->specClient); }
    impl->rtlThread = std::thread([impl]{ rtlsdr_read_async(impl->dev, &Impl::asyncHandler, impl, 0, 0); });
    LOGI("sample rate: %.0f (actual %u) fft=%d", rate, actual, impl->fftSize);
}
std::vector<int> LocalSdrShim::getTunerGains() {
    std::vector<int> out;
    if (!p || !p->dev) return out;
    int n = rtlsdr_get_tuner_gains(p->dev, nullptr);
    if (n <= 0) return out;
    out.resize(n);
    rtlsdr_get_tuner_gains(p->dev, out.data());
    return out;
}

bool LocalSdrShim::isRunning() const { return p != nullptr; }

} // namespace vibe
