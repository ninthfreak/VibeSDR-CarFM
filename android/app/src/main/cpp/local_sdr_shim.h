// VibeSDR V4 — local-SDR shim: RTL-SDR → FFT + demod → localhost UberSDR.
// Stage 3 added the spectrum WebSocket; Stage 4 adds the demodulated-audio
// WebSocket (int16 PCM, mono or stereo for WFM) plus tune/mode/bandwidth
// control, so the existing VibeSDR audio engine plays local hardware.
#pragma once
#include <string>

namespace vibe {

class LocalSdrShim {
public:
    static LocalSdrShim& instance();

    // Open the RTL-SDR on `fd`, start FFT + demod pipelines and the localhost
    // server (spectrum + audio WebSockets). Returns the chosen TCP port (>0) on
    // success, or -1 with `err` set. `fd` stays owned by the caller (Kotlin).
    int start(int fd, int vid, int pid,
              double centerFreq, double sampleRate, int gainTenthDb,
              int fftSize, double fftRate, const std::string& mode, std::string& err);

    void stop();
    bool isRunning() const;

private:
    LocalSdrShim() = default;
    struct Impl;
    Impl* p = nullptr;
};

} // namespace vibe
