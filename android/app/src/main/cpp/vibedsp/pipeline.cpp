// VibeSDR V5 — RxPipeline: IQ -> {spectrum, audio}. Original VibeSDR code.
#include "vibedsp.h"
#include <cmath>
#include <algorithm>

namespace vibedsp {

void RxPipeline::start(double sampleRate, int fftSize, double fftRate,
                       int outRate, const Callbacks& cb) {
    sampleRate_ = sampleRate;
    fftSize_    = fftSize;
    fftRate_    = fftRate;
    outRate_    = outRate;
    cb_         = cb;

    // Spectrum: window + FFT, one frame every (sampleRate/fftRate) input samples.
    cfft_ = std::make_unique<ComplexFFT>(fftSize_);
    win_.resize(fftSize_);
    nuttallWindow(win_.data(), fftSize_);
    specBuf_.assign(fftSize_ * 2, 0.0f);   // interleaved? no — store cf32 below
    specDb_.assign(fftSize_, 0.0f);
    specStride_ = std::max(1, (int)std::llround(sampleRate_ / fftRate_));
    specFill_   = 0;
    sinceFrame_ = 0;

    dirty_ = true;
    rebuildAudio();
}

void RxPipeline::setTune(double offsetHz, Mode mode, double bwHz) {
    offsetHz_ = offsetHz;
    mode_     = mode;
    bwHz_     = bwHz;
    dirty_    = true;
}

void RxPipeline::rebuildAudio() {
    // Channel decimation: bring the IQ down to a manageable channel rate that
    // comfortably holds the demod bandwidth, then resample to exactly outRate.
    // 1.5x covers the RF channel + (for WFM) the 60 kHz MPX while keeping the
    // per-sample MPX/PLL/RDS work as cheap as possible — WFM at bwHz*3 (=600 kHz)
    // was ~2x more CPU than needed and made audio choppy on budget phones. Narrow
    // modes are unaffected (floored by outRate).
    const double targetCh = std::max((double)outRate_, bwHz_ * 3.0);
    chDecim_ = std::max(1, (int)std::floor(sampleRate_ / targetCh));
    chFs_    = sampleRate_ / chDecim_;

    // Channel low-pass. The decimator filters at the INPUT rate, so cutoff is
    // normalised to sampleRate: pass the demod bandwidth, but never exceed the
    // post-decimation Nyquist (0.5/chDecim) or we alias.
    const double cutoff = std::min(0.45 / chDecim_, (bwHz_ * 0.5) / sampleRate_);
    const double trans  = std::max(cutoff * 0.5, 0.25 / chDecim_ - cutoff);
    dec_  = std::make_unique<FirDecimator>(designLowpass(cutoff, std::max(trans, 1e-3)), chDecim_);

    nco_.setFreq(offsetHz_ / sampleRate_);   // tune the channel to baseband

    // Construct the demod for the active mode. FM gain maps radians/sample to a
    // unit-ish audio level at the channel rate.
    am_.reset(); fm_.reset(); ssb_.reset(); audioLpf_.reset(); lmrLpf_.reset();
    useDeemph_ = false; stereo_ = false; useAgc_ = false;
    switch (mode_) {
        case Mode::AM:                          am_ = std::make_unique<AmDemod>();
                                                useAgc_ = true; agc_.configure(chFs_); agc_.reset(); break;
        case Mode::SSB_USB: case Mode::SSB_LSB:
        case Mode::CW:
            ssb_ = std::make_unique<SsbDemod>();
            ssb_->configure(mode_ == Mode::SSB_LSB ? SsbDemod::Side::LSB : SsbDemod::Side::USB,
                            bwHz_, chFs_);
            useAgc_ = true; agc_.configure(chFs_); agc_.reset(); break;
        case Mode::NFM:
            fm_ = std::make_unique<FmDemod>((float)(chFs_ / (2.0 * M_PI * std::max(1.0, bwHz_ * 0.5))));
            if (deempTau_.load() > 0.0) { deemph_.configure(deempTau_.load(), chFs_); deemph_.reset(); useDeemph_ = true; }
            break;
        case Mode::WFM: {
            // Wideband FM. Discriminator -> MPX. Mono path = 15 kHz L+R LPF +
            // de-emphasis. Stereo path adds a 19 kHz pilot PLL, 38 kHz coherent
            // L-R recovery, a second 15 kHz LPF, and per-channel de-emphasis.
            fm_ = std::make_unique<FmDemod>((float)(chFs_ / (2.0 * M_PI * 75000.0)));
            const double tau = deempTau_.load();   // 0=off / 50us EU/UK / 75us US
            useDeemph_ = (tau > 0.0);
            if (useDeemph_) { deemph_.configure(tau, chFs_); deemph_.reset();
                              deemphR_.configure(tau, chFs_); deemphR_.reset(); }
            const double cut = 15000.0 / chFs_;
            audioLpf_ = std::make_unique<RealFir>(designLowpass(cut, cut * 0.4));
            lmrLpf_   = std::make_unique<RealFir>(designLowpass(cut, cut * 0.4));
            pll_.configure(19000.0, chFs_); pll_.reset();
            stereoBlend_ = 0.0f;               // new tune starts mono, blends up
            const int rch = (int)std::llround(chFs_);
            resampR_ = std::make_unique<RationalResampler>(rch, outRate_);
            stereo_ = true; lastStereo_ = false;

            // RDS: coherent 57 kHz demod -> parallel-phase data-link decoders.
            RdsDecoder::Callbacks rcb; rcb.ctx = this;
            rcb.ps = [](void* c, uint16_t pi, const char* ps) {
                auto* self = (RxPipeline*)c;
                if (self->cb_.rdsPs) self->cb_.rdsPs(self->cb_.ctx, pi, ps);
            };
            rcb.radiotext = [](void* c, const char* rt) {
                auto* self = (RxPipeline*)c;
                if (self->cb_.rdsText) self->cb_.rdsText(self->cb_.ctx, rt);
            };
            rcb.ecc = [](void* c, uint16_t, uint8_t ecc) {
                auto* self = (RxPipeline*)c;
                if (self->cb_.rdsEcc) self->cb_.rdsEcc(self->cb_.ctx, ecc);
            };
            rdsDemod_.configure(chFs_, rcb);
            break;
        }
    }
    resamp_ = std::make_unique<RationalResampler>((int)std::llround(chFs_), outRate_);

    baseBuf_.clear(); chBuf_.clear(); demodBuf_.clear(); audioBuf_.clear();
    dirty_ = false;
}

void RxPipeline::feed(const cf32* iq, int n) {
    if (dirty_) rebuildAudio();

    // ── Spectrum ───────────────────────────────────────────────────────────
    // Gather fftSize contiguous samples for a frame, then skip to the next slot.
    if (cb_.spectrum) {
        // Gather fftSize contiguous samples into a frame, FFT + emit, then DROP the
        // remaining (specStride - fftSize) samples to honour the frame rate. This is
        // O(n) — never the per-sample buffer shift (O(n*fftSize)) that can't keep up
        // at MS/s. `sinceFrame_` doubles as the inter-frame drop countdown.
        cf32* sb = reinterpret_cast<cf32*>(specBuf_.data());
        for (int i = 0; i < n; ++i) {
            if (sinceFrame_ > 0) { --sinceFrame_; continue; }
            sb[specFill_++] = iq[i];
            if (specFill_ >= fftSize_) {
                const float scale = 1.0f / (float)(fftSize_ * fftSize_);
                cfft_->powerDbShifted(sb, win_.data(), specDb_.data(), scale);
                cb_.spectrum(cb_.ctx, specDb_.data(), fftSize_);
                specFill_   = 0;
                sinceFrame_ = std::max(0LL, (long long)specStride_ - fftSize_);
            }
        }
    }

    // ── Audio (DDC -> demod -> resample) ─────────────────────────────────────
    if (cb_.audio) {
        baseBuf_.resize(n);
        nco_.mix(iq, baseBuf_.data(), n);

        chBuf_.resize(dec_->maxOut(n));
        const int nc = dec_->process(baseBuf_.data(), n, chBuf_.data());

        demodBuf_.resize(nc);
        if (am_)       am_->process(chBuf_.data(), demodBuf_.data(), nc);
        else if (fm_)  fm_->process(chBuf_.data(), demodBuf_.data(), nc);
        else if (ssb_) ssb_->process(chBuf_.data(), demodBuf_.data(), nc);

        if (stereo_) {
            // ── WFM stereo MPX decode ────────────────────────────────────────
            // demodBuf_ is the MPX. L+R = LPF(mpx); L-R = LPF(mpx * 38kHz_ref).
            lprBuf_.resize(nc); lmrBuf_.resize(nc);
            ref57Buf_.resize(nc); bitClkBuf_.resize(nc);
            for (int i = 0; i < nc; ++i) {
                float r38 = 0.0f, r57 = 0.0f, bclk = 0.0f;
                pll_.step(demodBuf_[i], &r38, &r57, &bclk);
                lprBuf_[i] = demodBuf_[i];
                lmrBuf_[i] = demodBuf_[i] * r38 * 2.0f;   // coherent gain comp
                ref57Buf_[i] = r57; bitClkBuf_[i] = bclk;
            }
            // RDS (only meaningful once the pilot is locked).
            if ((cb_.rdsPs || cb_.rdsText) && pll_.locked())
                rdsDemod_.process(demodBuf_.data(), ref57Buf_.data(), bitClkBuf_.data(), nc);
            leftBuf_.resize(audioLpf_->maxOut(nc));
            rightBuf_.resize(lmrLpf_->maxOut(nc));
            const int n1 = audioLpf_->process(lprBuf_.data(), nc, leftBuf_.data()); // L+R
            const int n2 = lmrLpf_->process(lmrBuf_.data(),  nc, rightBuf_.data()); // L-R
            const int nm = std::min(n1, n2);
            // Stereo BLEND (anti-screech): fade the L-R in/out by a smoothed
            // pilot-lock confidence rather than hard-switching. forceMono or no
            // lock -> target 0 (clean mono); solid lock -> 1. The per-sample ramp
            // (~ a few ms) stops the harsh on/off when an edge signal flickers.
            const bool wantStereo = stereoEnabled_.load();
            // Target full stereo when the pilot is locked (locked() has hysteresis
            // so it won't chatter on an edge signal), else mono. The ramp does the
            // smoothing so the transition fades instead of screeching.
            const float target = (wantStereo && pll_.locked()) ? 1.0f : 0.0f;
            const float ramp = (float)(1.0 / (chFs_ * 0.04));   // ~40 ms blend time constant
            for (int i = 0; i < nm; ++i) {
                stereoBlend_ += ramp * (target - stereoBlend_);
                const float lpr = leftBuf_[i];
                const float lmr = rightBuf_[i] * stereoBlend_;   // blended L-R
                lprBuf_[i] = 0.5f * (lpr + lmr);                 // L
                lmrBuf_[i] = 0.5f * (lpr - lmr);                 // R
            }
            const bool lk = stereoBlend_ > 0.5f;   // indicator follows audible state
            if (useDeemph_) {                  // off -> skip (tau=0)
                deemph_.process(lprBuf_.data(), nm);
                deemphR_.process(lmrBuf_.data(), nm);
            }
            audioBuf_.resize(resamp_->maxOut(nm));
            rOutBuf_.resize(resampR_->maxOut(nm));
            const int na = resamp_->process(lprBuf_.data(), nm, audioBuf_.data());
            const int nb = resampR_->process(lmrBuf_.data(), nm, rOutBuf_.data());
            const int no = std::min(na, nb);
            if (no > 0) {
                ilvBuf_.resize(no * 2);
                for (int i = 0; i < no; ++i) { ilvBuf_[2*i] = audioBuf_[i]; ilvBuf_[2*i+1] = rOutBuf_[i]; }
                cb_.audio(cb_.ctx, ilvBuf_.data(), no, 2, outRate_);
            }
            if (cb_.stereo && lk != lastStereo_) { lastStereo_ = lk; cb_.stereo(cb_.ctx, lk); }
        } else {
            // ── Mono post-chain (AM/SSB/CW/NFM + WFM-mono fallback) ───────────
            int nd = nc;
            float* audioIn = demodBuf_.data();
            if (useDeemph_) deemph_.process(demodBuf_.data(), nc);
            if (audioLpf_) {
                lpfBuf_.resize(audioLpf_->maxOut(nc));
                nd = audioLpf_->process(demodBuf_.data(), nc, lpfBuf_.data());
                audioIn = lpfBuf_.data();
            }
            if (useAgc_) agc_.process(audioIn, nd);   // AM/SSB/CW level + anti-clip
            audioBuf_.resize(resamp_->maxOut(nd));
            const int na = resamp_->process(audioIn, nd, audioBuf_.data());
            if (na > 0) cb_.audio(cb_.ctx, audioBuf_.data(), na, 1, outRate_);
        }
    }
}

void RxPipeline::stop() {
    cfft_.reset(); dec_.reset(); am_.reset(); resamp_.reset();
}

} // namespace vibedsp
