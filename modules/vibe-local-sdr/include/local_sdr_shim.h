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

    // RTL-TCP source (rtl_tcp protocol over the network — no USB/librtlsdr, so it
    // works on iOS too). Same pipeline as start(), IQ from a TCP socket.
    int startTcp(const std::string& host, int port,
                 double centerFreq, double sampleRate, int gainTenthDb,
                 int fftSize, double fftRate, const std::string& mode, std::string& err);

    void stop();
    bool isRunning() const;

    // Decoder-only "sidecar" mode for network backends (Kiwi/OWRX): starts just
    // the localhost /ws/dxcluster server + the decoder modules, NO RTL/FFT/demod.
    // The app feeds it the backend's decoded audio via feedDecoderPcm(); the
    // existing DecoderClient connects to the returned port and the decoder UI
    // works unchanged. Returns the TCP port (>0) or -1 with `err` set.
    int startDecoderService(std::string& err);
    // Feed mono int16 PCM at `rate` Hz (upsampled to the decoders' 48 kHz).
    void feedDecoderPcm(const int16_t* pcm, int n, int rate);
    // Tell the sidecar the backend's dial frequency (Hz) so FT8 spot RF freq +
    // band are correct (otherwise they're computed against a 100 MHz default →
    // empty band / wrong tune freq). Network backends (Kiwi) call this on tune.
    void setDecoderFreq(double hz);

    // Hardware controls (no-ops if not running). gainTenthDb < 0 = auto gain.
    void setGain(int gainTenthDb);
    void setPpm(int ppm);
    void setBiasTee(bool on);
    void setAgc(bool on);                 // RTL2832 digital AGC
    void setDirectSampling(int mode);     // 0=off, 1=I, 2=Q (not needed on Blog V4)
    void setSampleRate(double rate);      // cancels + restarts the IQ stream (auto FFT size)
    void setDeemphasis(double tau);       // FM de-emphasis time constant (0=off, 50e-6, 75e-6)
    void setSquelch(bool on, float db);   // power-based audio squelch (dBFS)
    void setNR(bool on);                  // audio noise reduction on/off
    void setNrStrength(float s);          // NR aggressiveness 0..1
    float getNrCpu();                     // NR CPU% (rolling) for the UI readout
    // Returns supported tuner gains (tenths of dB); empty if not running.
    std::vector<int> getTunerGains();

private:
    LocalSdrShim() = default;
    void stopLocked();      // teardown; caller must hold g_lifecycle
    struct Impl;
    Impl* p = nullptr;
};

} // namespace vibe
