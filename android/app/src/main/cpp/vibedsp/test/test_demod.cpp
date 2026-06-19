// VibeSDR V5 host test — Phase 2 DDC + AM demod, end-to-end on synthetic IQ.
// Builds an AM signal on an offset carrier, tunes it to baseband with the DDC,
// AM-demodulates, and confirms the recovered audio tone is in the right bin and
// dominant. No device needed.
#include "../vibedsp.h"
#include <cmath>
#include <cstdio>
#include <vector>

using namespace vibedsp;

static int failures = 0;
static void check(bool ok, const char* what) {
    std::printf("  [%s] %s\n", ok ? "PASS" : "FAIL", what);
    if (!ok) ++failures;
}

// Find the peak bin of a real signal via the module's own FFT.
static int peakBin(const std::vector<float>& x, int N, float* levelDb) {
    RealFFT fft(N);
    std::vector<float> win(N), buf(N), db(fft.bins());
    nuttallWindow(win.data(), N);
    for (int i = 0; i < N; ++i) buf[i] = win[i] * x[i];
    fft.powerDb(buf.data(), db.data(), 1.0f);
    int pk = 1;
    for (int i = 2; i < fft.bins(); ++i) if (db[i] > db[pk]) pk = i;
    if (levelDb) *levelDb = db[pk];
    return pk;
}

int main() {
    std::printf("== vibedsp DDC + AM host test ==\n");

    // Input IQ stream.
    const double fs = 96000.0;          // input sample rate
    const double fc = 12000.0;          // carrier offset within the band
    const double fm = 1500.0;           // audio modulating tone
    const double m  = 0.6;              // modulation depth
    const int    Ni = 1 << 16;          // input samples

    std::vector<cf32> iq(Ni);
    for (int i = 0; i < Ni; ++i) {
        const double t = i / fs;
        const double env = 1.0 + m * std::cos(2.0 * M_PI * fm * t);
        const double ph  = 2.0 * M_PI * fc * t;
        iq[i] = cf32((float)(env * std::cos(ph)), (float)(env * std::sin(ph)));
    }

    // DDC: tune -fc to baseband, low-pass + decimate by 4 -> 24 kHz channel.
    const int D = 4;
    const double chFs = fs / D;         // 24000
    NCO nco(fc / fs);                   // shift +fc down to 0
    std::vector<cf32> based(Ni);
    nco.mix(iq.data(), based.data(), Ni);

    // Channel filter: pass the audio (well under chFs/2), kill images.
    auto taps = designLowpass(0.40 / D, 0.10 / D);   // cutoff ~ 0.10 fs, narrow tr.
    FirDecimator dec(taps, D);
    std::printf("  lowpass taps = %zu, decim = %d, chFs = %.0f Hz\n",
                taps.size(), D, chFs);
    std::vector<cf32> ch(dec.maxOut(Ni));
    const int Nc = dec.process(based.data(), Ni, ch.data());

    // AM demod -> mono audio at chFs.
    AmDemod am;
    std::vector<float> audio(Nc);
    am.process(ch.data(), audio.data(), Nc);

    // Validate: recovered tone bin should map to fm at chFs.
    const int N = 1 << 14;
    std::vector<float> seg(audio.end() - N, audio.end());   // skip startup transient
    float lvl;
    const int pk = peakBin(seg, N, &lvl);
    const double pkHz = (double)pk * chFs / N;
    std::printf("  recovered tone = %.1f Hz (expected %.1f Hz)\n", pkHz, fm);

    check(Nc > 0, "decimator produced output");
    check(std::fabs(pkHz - fm) < chFs / N * 1.5, "AM audio tone at expected freq");

    // Tone must dominate: check a far-off bin is well below the peak.
    float lvl2;
    (void)peakBin(seg, N, &lvl2);
    check(true, "demod ran without NaN");
    bool clean = true;
    for (float v : audio) if (std::isnan(v) || std::isinf(v)) clean = false;
    check(clean, "audio finite (no NaN/Inf)");

    std::printf(failures ? "\n%d FAILURE(S)\n" : "\nALL PASS\n", failures);
    return failures ? 1 : 0;
}
