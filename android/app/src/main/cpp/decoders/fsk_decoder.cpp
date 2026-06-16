// VibeSDR V4 — FSK (RTTY) decoder, C++ port of UberSDR's ka9q fsk extension.
#include "fsk_decoder.h"
#include <cmath>

namespace vibe {

// ── BiQuad ──────────────────────────────────────────────────────────────────
void BiQuad::configure(Type type, double freq, double sampleRate, double q) {
    double omega = 2.0 * M_PI * freq / sampleRate;
    double sinO = std::sin(omega), cosO = std::cos(omega);
    double alpha = sinO / (2.0 * q);
    double A0, A1, A2, B0, B1, B2;
    if (type == Bandpass) {
        B0 = alpha; B1 = 0.0; B2 = -alpha;
        A0 = 1.0 + alpha; A1 = -2.0 * cosO; A2 = 1.0 - alpha;
    } else { // Lowpass
        B0 = (1.0 - cosO) / 2.0; B1 = 1.0 - cosO; B2 = (1.0 - cosO) / 2.0;
        A0 = 1.0 + alpha; A1 = -2.0 * cosO; A2 = 1.0 - alpha;
    }
    b0 = B0 / A0; b1 = B1 / A0; b2 = B2 / A0; a1 = A1 / A0; a2 = A2 / A0;
}
double BiQuad::filter(double in) {
    double out = b0 * in + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = in; y2 = y1; y1 = out;
    return out;
}

// ── ITA2 ─────────────────────────────────────────────────────────────────────
Ita2::Ita2(const std::string& framing) {
    // Parse framing <data>N<stop> (e.g. 5N1.5).
    if (framing.size() >= 3 && framing[1] == 'N') {
        dataBits = framing[0] - '0';
        double stop = 1.0;
        std::string s = framing.substr(2);
        if (s == "1.5") stop = 1.5; else if (s == "2") stop = 2.0; else stop = 1.0;
        double total = 1.0 + dataBits + stop;       // start + data + stop
        nbits_ = (stop == 1.5) ? (int)(total * 2) : (int)total;
    } else {
        nbits_ = dataBits;
    }
    const char32_t NUL = 0, QUO = U'\'', LF = U'\n', CR = U'\r', BEL = 7, GAP = U'_';
    const char32_t L[32] = {
        NUL,U'E',LF,U'A',U' ',U'S',U'I',U'U',CR,U'D',U'R',U'J',U'N',U'F',U'C',U'K',
        U'T',U'Z',U'L',U'W',U'H',U'Y',U'P',U'Q',U'O',U'B',U'G',GAP,U'M',U'X',U'V',GAP };
    const char32_t F[32] = {
        NUL,U'3',LF,U'-',U' ',BEL,U'8',U'7',CR,U'$',U'4',QUO,U',',U'!',U':',U'(',
        U'5',U'"',U')',U'2',U'#',U'6',U'0',U'1',U'9',U'?',U'&',GAP,U'.',U'/',U';',GAP };
    for (int c = 0; c < 32; c++) { ltrs[c] = L[c]; figs[c] = F[c];
        if (L[c] != U'_') codeLtrs[(uint8_t)c] = L[c];
        if (F[c] != U'_') codeFigs[(uint8_t)c] = F[c]; }
}
bool Ita2::checkBits(uint16_t code) const {
    uint16_t v = code;
    if (nbits_ == 15) { // 5N1.5 doubled
        if ((v & 3) != 0) return false; v >>= 2;
        for (int b = 0; b < dataBits; b++) { uint16_t d = v & 3; if (d != 0 && d != 3) return false; v >>= 2; }
        if ((v & 7) != 7) return false; v >>= 3;
        return v == 0;
    }
    if ((v & 1) != 0) return false; v >>= 1;
    v >>= (unsigned)dataBits;
    int stopBits = nbits_ - 1 - dataBits;
    uint16_t mask = (uint16_t)((1 << (unsigned)stopBits) - 1);
    return (v & mask) == mask;
}
char32_t Ita2::codeToChar(uint8_t code, bool fig) const {
    auto& m = fig ? codeFigs : codeLtrs;
    auto it = m.find(code);
    return it == m.end() ? 0 : it->second;
}
char32_t Ita2::processChar(uint16_t code) {
    uint8_t dataB;
    if (nbits_ == 15) {
        uint16_t v = code; v >>= 2;
        dataB = 0; uint8_t dMSB = (uint8_t)(1 << (dataBits - 1));
        for (int b = 0; b < dataBits; b++) { uint16_t d = v & 3; dataB = (uint8_t)((dataB >> 1) | (d != 0 ? dMSB : 0)); v >>= 2; }
    } else {
        dataB = (uint8_t)(code & ((1 << (unsigned)dataBits) - 1));
    }
    if (firstChar) { lastCode = dataB; firstChar = false; return 0; }
    char32_t out = 0;
    if (lastCode == letters)      shift = false;
    else if (lastCode == figures) shift = true;
    else                          out = codeToChar(lastCode, shift);
    lastCode = dataB;
    return out;
}

// ── FskDecoder ───────────────────────────────────────────────────────────────
FskDecoder::FskDecoder(int sr, double cf, double sh, double baud,
                       const std::string& fr, const std::string& enc, bool inv)
    : sampleRate((double)sr), centerFrequency(cf), shiftHz(sh), baudRate(baud),
      inverted(inv), framing(fr), encoding(enc) {
    deviationF = shiftHz / 2.0;
    audioAverageTC = 1000.0 / sampleRate;
    if (baudRate < 10) baudRate = 10;
    // ITA2 (RTTY). CCIR476/NAVTEX = future.
    ita2 = new Ita2(framing.empty() ? "5N1.5" : framing);
    nbits = ita2->nbits(); msb = ita2->msb();
    if (framing == "5N1.5") { baudRate *= 2; stopVariable = true; }
    double bitDur = 1.0 / baudRate;
    bitSampleCount = (int)(sampleRate * bitDur + 0.5);
    halfBitSampleCount = bitSampleCount / 2;
    zeroCrossings.assign(bitSampleCount / zeroCrossingsDivisor, 0);
    updateFilters();
}
void FskDecoder::updateFilters() {
    markSpaceFilterQ = 6.0 * centerFrequency / 1000.0;
    double qv = centerFrequency + (4.0 * 1000.0 / centerFrequency);
    markF = qv + deviationF; spaceF = qv - deviationF;
    biquadMark.configure(BiQuad::Bandpass, markF, sampleRate, markSpaceFilterQ);
    biquadSpace.configure(BiQuad::Bandpass, spaceF, sampleRate, markSpaceFilterQ);
    biquadLowpass.configure(BiQuad::Lowpass, lowpassFilterF, sampleRate, 1.0 / std::sqrt(2.0));
}
void FskDecoder::setState(State s) {
    if (s != state) { state = s; if (onState) onState((int)s); }
}
void FskDecoder::process(const int16_t* samples, int count) {
    for (int n = 0; n < count; n++) {
        double dv = (double)samples[n];
        double markAbs = std::fabs(biquadMark.filter(dv));
        double spaceAbs = std::fabs(biquadSpace.filter(dv));
        double maxAbs = std::max(markAbs, spaceAbs);
        audioAverage += (maxAbs - audioAverage) * audioAverageTC;
        audioAverage = std::max(0.1, audioAverage);
        double diffAbs = (markAbs - spaceAbs) / audioAverage;
        double logic = biquadLowpass.filter(diffAbs);
        bool markState = logic > 0;
        signalAccumulator += markState ? 1 : -1;
        bitDuration++;
        if (markState != oldMarkState) {
            if ((bitDuration % bitSampleCount) > halfBitSampleCount) {
                int index = (sampleCount - nextEventCount + bitSampleCount * 8) % bitSampleCount;
                zeroCrossings[index / zeroCrossingsDivisor]++;
            }
            bitDuration = 0;
        }
        oldMarkState = markState;
        if (sampleCount % bitSampleCount == 0) {
            zeroCrossingCount++;
            if (zeroCrossingCount >= zeroCrossingSamples) {
                int best = 0, bestIndex = 0;
                for (int j = 0; j < (int)zeroCrossings.size(); j++) {
                    if (zeroCrossings[j] > best) { best = zeroCrossings[j]; bestIndex = j; }
                    zeroCrossings[j] = 0;
                }
                if (best > 0) {
                    bestIndex *= zeroCrossingsDivisor;
                    bestIndex = ((bestIndex + halfBitSampleCount) % bitSampleCount) - halfBitSampleCount;
                    bestIndex /= 8;
                    syncDelta = (double)bestIndex;
                }
                zeroCrossingCount = 0;
            }
        }
        pulseEdgeEvent = (sampleCount >= nextEventCount);
        if (pulseEdgeEvent) {
            averagedMarkState = (signalAccumulator > 0) != inverted;
            signalAccumulator = 0;
            nextEventCount = sampleCount + bitSampleCount + (int)(syncDelta + 0.5);
            syncDelta = 0;
        }
        if (audioAverage < audioMinimum && state != NoSignal) setState(NoSignal);
        else if (state == NoSignal) syncSetup = true;
        if (!pulseEdgeEvent) { sampleCount++; continue; }
        processBit(averagedMarkState);
        sampleCount++;
    }
}
void FskDecoder::processBit(bool bit) {
    uint16_t bitVal = bit ? 1 : 0;
    if (syncSetup) {
        bitCount = 0; codeBits = 0; errorCount = 0; validCount = 0;
        if (ita2) ita2->reset();
        syncChars.clear(); setState(Sync1); syncSetup = false;
    }
    switch (state) {
        case NoSignal: break;
        case Sync1: {
            codeBits = (uint16_t)((codeBits >> 1) | (bitVal * msb));
            if (ita2 && ita2->checkBits(codeBits)) {
                syncChars.push_back(codeBits); validCount++;
                bitCount = 0; codeBits = 0; setState(Sync2); waiting = true;
            }
            break;
        }
        case Sync2: {
            if (stopVariable && waiting && bit) return;
            waiting = false;
            codeBits = (uint16_t)((codeBits >> 1) | (bitVal * msb)); bitCount++;
            if (bitCount == nbits) {
                if (ita2 && ita2->checkBits(codeBits)) {
                    syncChars.push_back(codeBits); codeBits = 0; bitCount = 0; validCount++;
                    int required = ita2 ? 1 : 4;
                    if (validCount >= required) {
                        for (uint16_t c : syncChars) processCharacter(c);
                        setState(ReadData);
                    }
                } else { codeBits = 0; bitCount = 0; syncSetup = true; }
                waiting = true;
            }
            break;
        }
        case ReadData: {
            if (stopVariable && waiting && bit) return;
            waiting = false;
            codeBits = (uint16_t)((codeBits >> 1) | (bitVal * msb)); bitCount++;
            if (bitCount == nbits) {
                bool ok = processCharacter(codeBits);
                if (ok) { if (errorCount > 0) errorCount--; }
                else { errorCount++; if (errorCount > 2) syncSetup = true; }
                codeBits = 0; bitCount = 0; waiting = true;
            }
            break;
        }
    }
}
bool FskDecoder::processCharacter(uint16_t code) {
    if (ita2) {
        char32_t ch = ita2->processChar(code);
        if (ch != 0 && onChar) onChar(ch);
        return true;   // ITA2 has no error correction
    }
    return false;
}

} // namespace vibe
