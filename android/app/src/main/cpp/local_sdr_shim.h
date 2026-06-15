// VibeSDR V4 — local-SDR shim (Stage 3): RTL-SDR → FFT → localhost UberSDR
// spectrum WebSocket. Opens an RTL-SDR from a USB fd, runs SDR++ Brown's
// IQFrontEnd FFT, and emits UberSDR SPEC frames so the existing VibeSDR
// waterfall renders local hardware with zero client protocol change.
#pragma once
#include <string>

namespace vibe {

// Singleton-style control surface used by the JNI layer. Only one local SDR
// session runs at a time (the phone is the only client of its own session).
class LocalSdrShim {
public:
    static LocalSdrShim& instance();

    // Open the RTL-SDR on `fd`, start the FFT pipeline + spectrum server bound
    // to 127.0.0.1. Returns the chosen TCP port (>0) on success, or -1 on
    // failure with `err` populated. `fd` stays owned by the caller (Kotlin).
    int start(int fd, int vid, int pid,
              double centerFreq, double sampleRate, int gainTenthDb,
              int fftSize, double fftRate, std::string& err);

    void stop();
    bool isRunning() const;

private:
    LocalSdrShim() = default;
    struct Impl;
    Impl* p = nullptr;
};

} // namespace vibe
