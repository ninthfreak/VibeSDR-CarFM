// VibeSDR — SpyServer wire protocol (clean-room).
//
// LICENSING: this file is original VibeSDR code, written from the protocol's
// OBSERVED behaviour — a proxy capture between the official spyserver.exe
// v2.0.1922 and two real clients (SDR++ Brown, SDR#), recorded 2026-07-09. See
// Reference/pcap/FINDINGS.md for the byte-level evidence behind every constant
// here. No code, header, or struct was copied from SDR++ (GPLv3) or from any
// Airspy binary. VibeSDR is GPL-3.0 WITH APPSTORE-EXCEPTION.md, which Stuart can
// only grant over code he holds copyright to.
//
// TRADEMARK: "SpyServer" and "Airspy" are marks of their owner. VibeSDR is
// unaffiliated. Speak of this feature nominatively — "SpyServer-compatible",
// "speaks the SpyServer protocol" — never as being SpyServer.
//
// Everything is LITTLE-ENDIAN on the wire.
#pragma once
#include <cstdint>

namespace vibe::spyserver {

// Version encoding: (major << 24) | (minor << 16) | revision.
// Observed: server announced 0x02000782 (2.0.1922); SDR++ said 2.0.1700 and was
// accepted, so minor/revision differences are tolerated. We announce the version
// the current stock clients speak.
constexpr uint32_t kProtocolVersion = 0x02000782;   // 2.0.1922

constexpr uint32_t versionMajor(uint32_t v) { return v >> 24; }
constexpr uint32_t versionMinor(uint32_t v) { return (v >> 16) & 0xFF; }
constexpr uint32_t versionRev  (uint32_t v) { return v & 0xFFFF; }

// ── Client → server ─────────────────────────────────────────────────────────
// Header is just {CommandType, BodySize}; the body follows.
enum Command : uint32_t {
    CMD_HELLO       = 0,   // body: u32 version + client name (raw chars, NO NUL)
    CMD_SET_SETTING = 2,   // body: u32 setting id + u32 value
    CMD_PING        = 3,   // body: 8 opaque bytes, echoed back as MSG_PONG
};

struct CommandHeader {
    uint32_t commandType;
    uint32_t bodySize;
};
static_assert(sizeof(CommandHeader) == 8, "wire layout");

// ── Settings (CMD_SET_SETTING ids) ──────────────────────────────────────────
enum Setting : uint32_t {
    // Bitmask, NOT an enum: 1 = IQ, 4 = FFT, 5 = both. SDR++ asks for 1 and draws
    // its own waterfall from full-rate IQ (saving nothing); SDR# asks for 5 —
    // narrow IQ plus a cheap wide FFT. 5 is where the bandwidth win lives.
    SETTING_STREAMING_MODE    = 0,
    SETTING_STREAMING_ENABLED = 1,

    // An INDEX into the tuner's gain table (0..DeviceInfo::maximumGainIndex), not
    // tenths of a dB as rtl_tcp uses. The protocol never transmits the dB values,
    // which is why stock clients show a bare unitless slider.
    SETTING_GAIN              = 2,

    SETTING_IQ_FORMAT         = 100,   // StreamFormat
    SETTING_IQ_FREQUENCY      = 101,   // Hz
    SETTING_IQ_DECIMATION     = 102,   // stage N → rate / 2^N
    SETTING_IQ_DIGITAL_GAIN   = 103,   // 0xFFFFFFFF = auto (SDR# uses auto)

    SETTING_FFT_FORMAT        = 200,   // StreamFormat (only uint8 observed)
    SETTING_FFT_FREQUENCY     = 201,   // Hz
    SETTING_FFT_DB_OFFSET     = 203,   // SDR# sends 0
    SETTING_FFT_DB_RANGE      = 204,   // SDR# sends 140
    // The client asks for its WINDOW WIDTH in pixels and the server bins down to
    // exactly that many u8 values per frame. The server's own fft_bin_bits is
    // internal and never appears on the wire.
    //
    // Frame geometry, verified against a known 96.6 MHz WFM carrier: the bins
    // span DeviceInfo::maximumBandwidth (NOT maximumSampleRate), centred on
    // SETTING_FFT_FREQUENCY, ascending in frequency with bin 0 at
    // centre - span/2. No fftshift. Reading the span as maximumSampleRate puts
    // the carrier 47 bins wrong.
    SETTING_FFT_DISPLAY_PIXELS = 205,

    // Seen from SDR# but not identified. 206 was sent as 0; 207 as a frequency
    // equal to the tuned centre. Accept and ignore rather than erroring — an
    // unknown setting must never drop the client.
    SETTING_UNKNOWN_206       = 206,
    SETTING_UNKNOWN_207       = 207,
};

constexpr uint32_t STREAM_MODE_IQ  = 1;
constexpr uint32_t STREAM_MODE_FFT = 4;
constexpr uint32_t kDigitalGainAuto = 0xFFFFFFFFu;

// ── Stream formats ──────────────────────────────────────────────────────────
// Confirmed on the wire: for the same 1472 IQ samples, a uint8 body was 2944
// bytes and an int16 body 5888 — exactly 1:2.
enum StreamFormat : uint32_t {
    FORMAT_UINT8   = 1,   // 2 bytes/sample
    FORMAT_INT16   = 2,   // 4 bytes/sample
    FORMAT_INT24   = 3,   // 6 bytes/sample (not observed)
    FORMAT_FLOAT32 = 4,   // 8 bytes/sample
};

constexpr uint32_t bytesPerIqSample(uint32_t fmt) {
    return fmt == FORMAT_UINT8 ? 2 : fmt == FORMAT_INT16 ? 4
         : fmt == FORMAT_INT24 ? 6 : fmt == FORMAT_FLOAT32 ? 8 : 0;
}

// ── Server → client ─────────────────────────────────────────────────────────
enum StreamType : uint32_t {
    STREAM_TYPE_STATUS = 0,   // device info / client sync / pong
    STREAM_TYPE_IQ     = 1,
    STREAM_TYPE_FFT    = 4,
};

// Only the LOW 16 BITS of the header's messageType field carry the type.
enum MessageType : uint32_t {
    MSG_DEVICE_INFO = 0,
    MSG_CLIENT_SYNC = 1,
    MSG_PONG        = 2,

    // Data messages are derived from the negotiated format, not fixed:
    //   IQ  message type = 99  + IQ_FORMAT   → 100 = uint8, 101 = int16, …
    //   FFT message type = 300 + FFT_FORMAT  → 301 = uint8
    MSG_IQ_BASE  = 99,
    MSG_FFT_BASE = 300,
};

constexpr uint32_t iqMessageType (uint32_t fmt) { return MSG_IQ_BASE  + fmt; }
constexpr uint32_t fftMessageType(uint32_t fmt) { return MSG_FFT_BASE + fmt; }

// The high 16 bits of messageType were non-zero (drifting 11..46) ONLY for IQ
// messages to a client that requested automatic digital gain, and zero
// everywhere else — most likely the server reporting the gain it applied. Not
// confirmed. Treat as opaque: mask it off when reading, send 0 when writing.
constexpr uint32_t messageTypeOf(uint32_t raw) { return raw & 0xFFFF; }
constexpr uint32_t messageAuxOf (uint32_t raw) { return raw >> 16; }

struct MessageHeader {
    uint32_t protocolId;       // kProtocolVersion
    uint32_t messageType;      // low 16 = MessageType; high 16 = aux (see above)
    uint32_t streamType;       // StreamType
    uint32_t sequenceNumber;   // per stream; FFT frames observed always 0
    uint32_t bodySize;
};
static_assert(sizeof(MessageHeader) == 20, "wire layout");

// ── Bodies ──────────────────────────────────────────────────────────────────
// Field order verified against real hardware: every value the RTL-SDR reported
// matched the dongle and spyserver.config.
struct DeviceInfo {
    uint32_t deviceType;            // 3 = RTL-SDR
    uint32_t deviceSerial;
    uint32_t maximumSampleRate;     // 2400000
    uint32_t maximumBandwidth;      // 2000000
    uint32_t decimationStageCount;  // 9
    uint32_t gainStageCount;        // 0 for RTL-SDR
    uint32_t maximumGainIndex;      // 29 for RTL-SDR
    uint32_t minimumFrequency;      // 24000000
    uint32_t maximumFrequency;      // 1800000000
    uint32_t resolution;            // 8 (ADC bits)
    uint32_t minimumIQDecimation;   // 0
    uint32_t forcedIQFormat;        // 0 = client chooses
};
static_assert(sizeof(DeviceInfo) == 48, "wire layout");

constexpr uint32_t DEVICE_INVALID  = 0;
constexpr uint32_t DEVICE_AIRSPY_ONE = 1;
constexpr uint32_t DEVICE_AIRSPY_HF  = 2;
constexpr uint32_t DEVICE_RTLSDR     = 3;

struct ClientSync {
    uint32_t canControl;               // 0 = another client owns the tuner
    uint32_t gain;                     // gain-table index
    uint32_t deviceCenterFrequency;
    uint32_t iqCenterFrequency;
    uint32_t fftCenterFrequency;
    uint32_t minimumIQCenterFrequency;
    uint32_t maximumIQCenterFrequency;
    uint32_t minimumFFTCenterFrequency;
    uint32_t maximumFFTCenterFrequency;
    uint32_t reserved;                 // 10th u32; purpose unobserved
};
static_assert(sizeof(ClientSync) == 40, "wire layout");

// FFT bin -> dB. PROVISIONAL: consistent with a captured spectrum (carrier at
// -32 dB, noise floor at -78 dB) but never checked against a calibrated source.
constexpr float fftBinToDb(uint8_t raw, uint32_t dbRange, int32_t dbOffset) {
    return raw * ((float)dbRange / 255.0f) - (float)dbRange + (float)dbOffset;
}

// Hz of the first FFT bin, and the width of each. Span is maximumBandwidth.
constexpr double fftBinWidthHz(uint32_t maximumBandwidth, uint32_t displayPixels) {
    return displayPixels ? (double)maximumBandwidth / displayPixels : 0.0;
}
constexpr double fftFirstBinHz(uint32_t fftCenterHz, uint32_t maximumBandwidth) {
    return (double)fftCenterHz - (double)maximumBandwidth / 2.0;
}

}  // namespace vibe::spyserver
