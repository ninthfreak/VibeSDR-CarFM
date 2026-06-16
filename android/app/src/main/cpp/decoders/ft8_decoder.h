// VibeSDR V4 — FT8 / FT4 decoder (wraps kgoba's ft8_lib, MIT).
//
// Buffers mono audio, aligns to UTC FT8 (15 s) / FT4 (7.5 s) slots, runs the
// ft8_lib STFT monitor + candidate search + LDPC decode, and reports each
// decoded message via onSpot. The shim turns those into {type:'digital_spot'}
// JSON frames on /ws/dxcluster so the existing VibeSDR digital-spots list shows
// local decodes (same mechanism as the UberSDR server skimmer feed).
#pragma once
#include <cstdint>
#include <functional>
#include <string>
#include <vector>

// ft8_lib C core
extern "C" {
#include "common/monitor.h"
}

namespace vibe {

class Ft8Decoder {
public:
    Ft8Decoder(int sampleRate, bool ft4);
    ~Ft8Decoder();

    // Feed mono int16 audio at the construction sample rate.
    void process(const int16_t* mono, int count);

    bool isFt4() const { return ft4; }

    // call_to, call_de, grid (any may be empty), snr dB, audio offset Hz.
    std::function<void(const std::string& callTo, const std::string& callDe,
                       const std::string& grid, int snr, float audioHz)> onSpot;

private:
    void runDecode();

    bool   ft4;
    int    rate;
    float  slotPeriod;
    int    capSamples;     // allocated buffer length (full slot)
    int    numSamples;     // active samples decoded per slot
    std::vector<float> samples;
    int    inPos = 0, framePos = 0;
    bool   tsync = false;
    bool   ok = false;
    monitor_t mon;
};

} // namespace vibe
