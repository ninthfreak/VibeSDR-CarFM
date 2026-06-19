// VibeSDR V5 host test — Phase 1 RealFFT.
// Runs on the dev machine (clang++), NO device needed. Validates the FFT finds
// a known tone in the right bin at the right level. This is the fast inner loop:
// edit DSP -> `cmake --build` -> instant pass/fail, before anything touches Android.
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

int main() {
    std::printf("== vibedsp RealFFT host test ==\n");

    const int N = 4096;
    RealFFT fft(N);
    check(fft.bins() == N / 2 + 1, "bin count = N/2+1");

    // Known real tone at bin K -> peak must land in bin K.
    std::vector<float> win(N), buf(N), db(fft.bins());
    nuttallWindow(win.data(), N);
    const double cg = windowCoherentGain(win.data(), N);

    const int K = 512;                       // target bin
    for (int i = 0; i < N; ++i)
        buf[i] = win[i] * std::cos(2.0 * M_PI * K * i / N);

    // Normalise so a full-scale tone reads ~0 dB: 1/(N*cg/2).
    const float scale = 1.0f / (float)((N * cg / 2.0) * (N * cg / 2.0));
    fft.powerDb(buf.data(), db.data(), scale);

    int peak = 0;
    for (int i = 1; i < fft.bins(); ++i) if (db[i] > db[peak]) peak = i;
    std::printf("  peak bin = %d (expected %d), level = %.2f dB\n", peak, K, db[peak]);
    check(peak == K, "tone lands in expected bin");
    check(db[peak] > -3.0f && db[peak] < 3.0f, "tone level near 0 dBFS");

    // Off-tone bin far from K must be well below the peak (window sidelobes low).
    check(db[K + 100] < db[peak] - 60.0f, "sidelobe >60 dB down at +100 bins");

    std::printf(failures ? "\n%d FAILURE(S)\n" : "\nALL PASS\n", failures);
    return failures ? 1 : 0;
}
