// VibeSDR V5 host test — ComplexFFT (IQ waterfall). Confirms positive AND
// negative frequency tones land in the correct fftshifted bins. No device.
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

// Peak bin of a complex tone at normalised frequency f (cycles/sample).
static int peakAt(double f, int N) {
    ComplexFFT fft(N);
    std::vector<cf32> x(N);
    std::vector<float> win(N), db(N);
    nuttallWindow(win.data(), N);
    for (int i = 0; i < N; ++i) {
        const double ph = 2.0 * M_PI * f * i;
        x[i] = cf32((float)std::cos(ph), (float)std::sin(ph));
    }
    fft.powerDbShifted(x.data(), win.data(), db.data(), 1.0f);
    int pk = 0;
    for (int i = 1; i < N; ++i) if (db[i] > db[pk]) pk = i;
    return pk;
}

int main() {
    std::printf("== vibedsp ComplexFFT (IQ waterfall) host test ==\n");
    const int N = 4096;
    const int center = N / 2;          // DC after fftshift

    // DC -> centre bin.
    check(peakAt(0.0, N) == center, "DC at centre bin");

    // +0.25 fs -> a quarter-band above centre (+N/4).
    int pkPos = peakAt(0.25, N);
    std::printf("  +0.25fs peak bin = %d (expected %d)\n", pkPos, center + N / 4);
    check(pkPos == center + N / 4, "positive freq above centre");

    // -0.25 fs -> a quarter-band below centre (-N/4). This is the test RealFFT
    // could never pass — it proves negative frequencies are placed correctly.
    int pkNeg = peakAt(-0.25, N);
    std::printf("  -0.25fs peak bin = %d (expected %d)\n", pkNeg, center - N / 4);
    check(pkNeg == center - N / 4, "negative freq below centre");

    std::printf(failures ? "\n%d FAILURE(S)\n" : "\nALL PASS\n", failures);
    return failures ? 1 : 0;
}
