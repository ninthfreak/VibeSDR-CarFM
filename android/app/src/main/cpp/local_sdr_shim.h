// VibeSDR V4 — local-SDR shim: RTL-SDR → FFT + demod → localhost UberSDR.
// Stage 3 added the spectrum WebSocket; Stage 4 adds the demodulated-audio
// WebSocket (int16 PCM, mono or stereo for WFM) plus tune/mode/bandwidth
// control, so the existing VibeSDR audio engine plays local hardware.
#pragma once
#include <string>
#include <vector>

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

    // Hardware controls (no-ops if not running). gainTenthDb < 0 = auto gain.
    void setGain(int gainTenthDb);
    void setPpm(int ppm);
    void setBiasTee(bool on);
    void setAgc(bool on);                 // RTL2832 digital AGC
    void setDirectSampling(int mode);     // 0=off, 1=I, 2=Q (not needed on Blog V4)
    void setSampleRate(double rate);      // cancels + restarts the IQ stream (auto FFT size)
    void setDeemphasis(double tau);       // FM de-emphasis time constant (0=off, 50e-6, 75e-6)
    void setSquelch(bool on, float db);   // power-based audio squelch (dBFS)
    // Returns supported tuner gains (tenths of dB); empty if not running.
    std::vector<int> getTunerGains();

private:
    LocalSdrShim() = default;
    struct Impl;
    Impl* p = nullptr;
};

} // namespace vibe
