// VibeSDR V5 host test — RationalResampler + RxPipeline end-to-end.
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

static int peakBinReal(const std::vector<float>& x, int N, int off, float* lvl) {
    RealFFT fft(N);
    std::vector<float> win(N), buf(N), db(fft.bins());
    nuttallWindow(win.data(), N);
    for (int i = 0; i < N; ++i) buf[i] = win[i] * x[off + i];
    fft.powerDb(buf.data(), db.data(), 1.0f);
    int pk = 1; for (int i = 2; i < fft.bins(); ++i) if (db[i] > db[pk]) pk = i;
    if (lvl) *lvl = db[pk];
    return pk;
}

static void testResampler() {
    std::printf("-- RationalResampler --\n");
    // 44100 -> 48000: a 1 kHz tone must stay 1 kHz, length scales by 48/44.1.
    const int inFs = 44100, outFs = 48000, fTone = 1000, Ni = 44100;
    RationalResampler rs(inFs, outFs);
    std::vector<float> in(Ni), out(rs.maxOut(Ni));
    for (int i = 0; i < Ni; ++i) in[i] = std::sin(2.0 * M_PI * fTone * i / inFs);
    const int no = rs.process(in.data(), Ni, out.data());
    std::printf("  L/M = %d/%d, in %d -> out %d (expected ~%d)\n",
                rs.L(), rs.M(), Ni, no, Ni * outFs / inFs);
    check(std::abs(no - Ni * outFs / inFs) < 50, "output length matches ratio");

    const int N = 1 << 14;
    float lvl;
    int pk = peakBinReal(out, N, no - N - 100, &lvl);
    const double hz = (double)pk * outFs / N;
    std::printf("  tone after resample = %.1f Hz (expected %d)\n", hz, fTone);
    check(std::abs(hz - fTone) < (double)outFs / N * 1.5, "tone frequency preserved");
}

// RxPipeline callback capture.
struct Cap { std::vector<float> audio; int specFrames = 0; int bins = 0; };
static void onSpec(void* c, const float*, int b) { auto* p = (Cap*)c; p->specFrames++; p->bins = b; }
static void onAud(void* c, const float* a, int n, int) { auto* p = (Cap*)c; p->audio.insert(p->audio.end(), a, a + n); }

static void testPipeline() {
    std::printf("-- RxPipeline (AM) --\n");
    const double fs = 1200000.0;     // 1.2 Msps input
    const double fc = 200000.0;      // channel offset within band
    const double fm = 1200.0;        // audio tone
    const double m  = 0.6;
    const int    Ni = 1 << 20;

    std::vector<cf32> iq(Ni);
    for (int i = 0; i < Ni; ++i) {
        const double t = i / fs;
        const double env = 1.0 + m * std::cos(2.0 * M_PI * fm * t);
        const double ph  = 2.0 * M_PI * fc * t;
        iq[i] = cf32((float)(env * std::cos(ph)), (float)(env * std::sin(ph)));
    }

    Cap cap;
    RxPipeline pipe;
    RxPipeline::Callbacks cb; cb.ctx = &cap; cb.spectrum = onSpec; cb.audio = onAud;
    pipe.start(fs, 1024, 20.0, 48000, cb);
    pipe.setTune(fc, RxPipeline::Mode::AM, 10000.0);
    // Feed in blocks to exercise streaming state.
    for (int o = 0; o < Ni; o += 65536)
        pipe.feed(iq.data() + o, std::min(65536, Ni - o));

    std::printf("  spectrum frames = %d (bins %d), audio samples = %zu\n",
                cap.specFrames, cap.bins, cap.audio.size());
    check(cap.specFrames > 0 && cap.bins == 1024, "spectrum frames emitted");
    check(cap.audio.size() > 40000, "audio produced near 48 kHz rate");

    const int N = 1 << 14;
    if ((int)cap.audio.size() > N + 2000) {
        float lvl;
        int pk = peakBinReal(cap.audio, N, (int)cap.audio.size() - N - 1000, &lvl);
        const double hz = (double)pk * 48000.0 / N;
        std::printf("  recovered AM tone = %.1f Hz (expected %.1f)\n", hz, fm);
        check(std::abs(hz - fm) < 48000.0 / N * 2.0, "pipeline recovers AM tone at 48 kHz");
    } else check(false, "enough audio for analysis");
}

int main() {
    std::printf("== vibedsp resampler + pipeline host test ==\n");
    testResampler();
    testPipeline();
    std::printf(failures ? "\n%d FAILURE(S)\n" : "\nALL PASS\n", failures);
    return failures ? 1 : 0;
}
