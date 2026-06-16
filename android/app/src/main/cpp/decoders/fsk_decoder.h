// VibeSDR V4 — FSK (RTTY / NAVTEX) decoder.
//
// C++ port of UberSDR's ka9q audio_extensions/fsk (decoder.go + fsk_demod.go +
// biquad.go + ita2.go). Takes mono int16 audio at a fixed sample rate and emits
// decoded characters (+ a coarse decoder state) via callbacks. The shim wraps
// this in the /ws/dxcluster audio-extension protocol so the existing VibeSDR
// decoder UI works unchanged. Encoding: ITA2 (RTTY) implemented; CCIR476
// (NAVTEX) is a later add.
#pragma once
#include <cstdint>
#include <functional>
#include <string>
#include <vector>
#include <map>

namespace vibe {

// ── Biquad (RBJ cookbook) — only the bandpass + lowpass we need ──────────────
class BiQuad {
public:
    enum Type { Bandpass, Lowpass };
    void configure(Type type, double freq, double sampleRate, double q);
    double filter(double in);
    void reset() { x1 = x2 = y1 = y2 = 0; }
private:
    double b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
    double x1 = 0, x2 = 0, y1 = 0, y2 = 0;
};

// ── ITA2 / Baudot (RTTY) with async framing ─────────────────────────────────
class Ita2 {
public:
    explicit Ita2(const std::string& framing);
    void reset() { shift = false; lastCode = 0; firstChar = true; }
    int nbits() const { return nbits_; }
    uint16_t msb() const { return (uint16_t)(1 << (nbits_ - 1)); }
    bool checkBits(uint16_t code) const;
    // Returns decoded char (0 = none).
    char32_t processChar(uint16_t code);
private:
    char32_t codeToChar(uint8_t code, bool fig) const;
    char32_t ltrs[32], figs[32];
    std::map<uint8_t, char32_t> codeLtrs, codeFigs;
    bool shift = false, firstChar = true;
    uint8_t lastCode = 0;
    const uint8_t letters = 0x1f, figures = 0x1b;
    int dataBits = 5, nbits_ = 5;
};

// ── FSK demodulator + decoder ───────────────────────────────────────────────
class FskDecoder {
public:
    enum State { NoSignal, Sync1, Sync2, ReadData };
    FskDecoder(int sampleRate, double centerFreq, double shiftHz, double baudRate,
               const std::string& framing, const std::string& encoding, bool inverted);
    void process(const int16_t* samples, int count);

    std::function<void(char32_t)> onChar;   // decoded character
    std::function<void(int)>      onState;  // State change (0..3)

private:
    void updateFilters();
    void setState(State s);
    void processBit(bool bit);
    bool processCharacter(uint16_t code);   // returns success

    double sampleRate, centerFrequency, shiftHz, deviationF, baudRate;
    bool inverted;
    std::string framing, encoding;

    double lowpassFilterF = 140.0, markSpaceFilterQ = 0, markF = 0, spaceF = 0;
    double audioAverageTC = 0, audioMinimum = 256.0;
    int bitSampleCount = 0, halfBitSampleCount = 0;

    BiQuad biquadMark, biquadSpace, biquadLowpass;

    State state = NoSignal;
    double audioAverage = 0.1;
    int signalAccumulator = 0, bitDuration = 0, sampleCount = 0, nextEventCount = 0;
    bool averagedMarkState = false, oldMarkState = false, pulseEdgeEvent = false;

    int zeroCrossingSamples = 16, zeroCrossingsDivisor = 4, zeroCrossingCount = 0;
    std::vector<int> zeroCrossings;
    double syncDelta = 0;

    int bitCount = 0; uint16_t codeBits = 0; int nbits = 0; uint16_t msb = 0;
    bool syncSetup = false; std::vector<uint16_t> syncChars; int validCount = 0, errorCount = 0;
    bool waiting = false, stopVariable = false;

    Ita2* ita2 = nullptr;
};

} // namespace vibe
