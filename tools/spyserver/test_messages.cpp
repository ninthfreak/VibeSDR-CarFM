// Phase 1 acceptance test for the SpyServer protocol module.
//
//   1. Round-trip: every message type serialises -> deserialises to identity.
//   2. Ground truth: the deserialiser parses REAL captured bytes from the
//      official spyserver.exe and real clients, and the decoded values match the
//      hardware. A loopback-only test would happily pass on a wrong spec.
//
// Build + run:
//   c++ -std=c++17 -I android/app/src/main/cpp/spyserver \
//       tools/spyserver/test_messages.cpp \
//       android/app/src/main/cpp/spyserver/spyserver_messages.cpp -o /tmp/ss_test
//   /tmp/ss_test [c2s.bin s2c.bin]
#include "spyserver_messages.h"

#include <cstdio>
#include <cstring>
#include <fstream>
#include <vector>

using namespace vibe::spyserver;

static int failures = 0;
#define CHECK(cond)                                                            \
    do {                                                                       \
        if (!(cond)) { std::printf("  FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); ++failures; } \
    } while (0)

static std::vector<uint8_t> readFile(const char* path) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return {};
    return std::vector<uint8_t>((std::istreambuf_iterator<char>(f)),
                                std::istreambuf_iterator<char>());
}

static void testRoundTrip() {
    std::printf("round-trip:\n");

    // HELLO — the name has no NUL on the wire, so it must survive exactly.
    {
        auto buf = encodeHello(kProtocolVersion, "VibeSDR");
        Command_t c; size_t used = 0;
        CHECK(parseCommand(buf.data(), buf.size(), &c, &used));
        CHECK(used == buf.size());
        CHECK(c.type == CMD_HELLO);
        uint32_t ver = 0; std::string name;
        CHECK(parseHelloBody(c.body, c.bodySize, &ver, &name));
        CHECK(ver == kProtocolVersion);
        CHECK(name == "VibeSDR");
    }
    // An empty client name is legal: bodySize 4, no chars.
    {
        auto buf = encodeHello(kProtocolVersion, "");
        Command_t c; size_t used = 0;
        CHECK(parseCommand(buf.data(), buf.size(), &c, &used));
        uint32_t ver = 0; std::string name{"dirty"};
        CHECK(parseHelloBody(c.body, c.bodySize, &ver, &name));
        CHECK(name.empty());
    }
    // SET_SETTING, including the 0xFFFFFFFF "auto" digital gain.
    {
        auto buf = encodeSetSetting(SETTING_IQ_DIGITAL_GAIN, kDigitalGainAuto);
        Command_t c; size_t used = 0;
        CHECK(parseCommand(buf.data(), buf.size(), &c, &used));
        uint32_t id = 0, val = 0;
        CHECK(parseSetSettingBody(c.body, c.bodySize, &id, &val));
        CHECK(id == SETTING_IQ_DIGITAL_GAIN);
        CHECK(val == 0xFFFFFFFFu);
    }
    // DEVICE_INFO / CLIENT_SYNC bodies.
    {
        DeviceInfo in{3, 12345, 2400000, 2000000, 9, 0, 29, 24000000, 1800000000, 8, 0, 0};
        auto body = encodeDeviceInfo(in);
        auto msg = encodeMessage(MSG_DEVICE_INFO, STREAM_TYPE_STATUS, 0, body.data(),
                                 (uint32_t)body.size());
        Message_t m; size_t used = 0;
        CHECK(parseMessage(msg.data(), msg.size(), &m, &used));
        CHECK(used == msg.size());
        CHECK(m.type == MSG_DEVICE_INFO && m.aux == 0);
        DeviceInfo out{};
        CHECK(parseDeviceInfo(m.body, m.bodySize, &out));
        CHECK(std::memcmp(&in, &out, sizeof(in)) == 0);
    }
    {
        ClientSync in{1, 17, 100000000, 96600000, 100000000, 25000000, 1799000000,
                      25000000, 1799000000, 0};
        auto body = encodeClientSync(in);
        auto msg = encodeMessage(MSG_CLIENT_SYNC, STREAM_TYPE_STATUS, 7, body.data(),
                                 (uint32_t)body.size());
        Message_t m; size_t used = 0;
        CHECK(parseMessage(msg.data(), msg.size(), &m, &used));
        CHECK(m.sequenceNumber == 7);
        ClientSync out{};
        CHECK(parseClientSync(m.body, m.bodySize, &out));
        CHECK(std::memcmp(&in, &out, sizeof(in)) == 0);
    }
    // The aux field must survive the high-16 packing without corrupting the type.
    {
        auto msg = encodeMessage(iqMessageType(FORMAT_UINT8), STREAM_TYPE_IQ, 42,
                                 nullptr, 0, /*aux=*/12);
        Message_t m; size_t used = 0;
        CHECK(parseMessage(msg.data(), msg.size(), &m, &used));
        CHECK(m.type == 100);
        CHECK(m.aux == 12);
        CHECK(m.streamType == STREAM_TYPE_IQ);
    }
    // Short buffers must be reported as incomplete, never over-read.
    {
        auto buf = encodeHello(kProtocolVersion, "VibeSDR");
        Command_t c; size_t used = 0;
        for (size_t n = 0; n < buf.size(); ++n)
            CHECK(!parseCommand(buf.data(), n, &c, &used));
        CHECK(parseCommand(buf.data(), buf.size(), &c, &used));
    }
    std::printf("  %s\n", failures ? "FAILURES ABOVE" : "ok");
}

// The real bytes. This is what a loopback test cannot give us.
static void testCapture(const char* c2sPath, const char* s2cPath) {
    std::printf("captured c2s (%s):\n", c2sPath);
    auto c2s = readFile(c2sPath);
    if (c2s.empty()) { std::printf("  (missing, skipped)\n"); return; }

    size_t off = 0, n = 0;
    bool sawHello = false;
    while (off < c2s.size()) {
        Command_t c; size_t used = 0;
        if (!parseCommand(c2s.data() + off, c2s.size() - off, &c, &used)) break;
        if (n == 0) {
            uint32_t ver = 0; std::string name;
            CHECK(c.type == CMD_HELLO);
            CHECK(parseHelloBody(c.body, c.bodySize, &ver, &name));
            std::printf("  HELLO v%u.%u.%u from \"%s\"\n", versionMajor(ver),
                        versionMinor(ver), versionRev(ver), name.c_str());
            CHECK(versionMajor(ver) == 2);
            sawHello = true;
        }
        off += used; ++n;
    }
    CHECK(sawHello);
    CHECK(off == c2s.size());   // every byte accounted for: no framing drift
    std::printf("  parsed %zu commands, %zu/%zu bytes\n", n, off, c2s.size());

    std::printf("captured s2c (%s):\n", s2cPath);
    auto s2c = readFile(s2cPath);
    if (s2c.empty()) { std::printf("  (missing, skipped)\n"); return; }

    off = 0; n = 0;
    size_t iq = 0, fft = 0, pong = 0;
    bool sawInfo = false, sawSync = false;
    while (off < s2c.size()) {
        Message_t m; size_t used = 0;
        if (!parseMessage(s2c.data() + off, s2c.size() - off, &m, &used)) break;
        CHECK(versionMajor(m.protocolId) == 2);
        if (m.type == MSG_DEVICE_INFO && !sawInfo) {
            DeviceInfo d{};
            CHECK(parseDeviceInfo(m.body, m.bodySize, &d));
            std::printf("  DEVICE_INFO type=%u maxRate=%u res=%u maxGainIdx=%u "
                        "fmin=%u fmax=%u decStages=%u\n",
                        d.deviceType, d.maximumSampleRate, d.resolution,
                        d.maximumGainIndex, d.minimumFrequency, d.maximumFrequency,
                        d.decimationStageCount);
            // Cross-check against the actual dongle + spyserver.config.
            CHECK(d.deviceType == DEVICE_RTLSDR);
            CHECK(d.maximumSampleRate == 2400000);
            CHECK(d.resolution == 8);
            CHECK(d.maximumGainIndex == 29);
            CHECK(d.minimumFrequency == 24000000);
            CHECK(d.maximumFrequency == 1800000000);
            sawInfo = true;
        } else if (m.type == MSG_CLIENT_SYNC && !sawSync) {
            ClientSync s{};
            CHECK(parseClientSync(m.body, m.bodySize, &s));
            std::printf("  CLIENT_SYNC canControl=%u gain=%u devFc=%u iqFc=%u\n",
                        s.canControl, s.gain, s.deviceCenterFrequency, s.iqCenterFrequency);
            sawSync = true;
        } else if (m.type == MSG_PONG) {
            ++pong;
        } else if (m.streamType == STREAM_TYPE_IQ) {
            ++iq;
            // IQ bodies must be a whole number of samples in the negotiated format.
            CHECK(m.type == 100 || m.type == 101 || m.type == 103);
            CHECK(m.bodySize % bytesPerIqSample(m.type - MSG_IQ_BASE) == 0);
        } else if (m.streamType == STREAM_TYPE_FFT) {
            ++fft;
            CHECK(m.type == fftMessageType(FORMAT_UINT8));   // 301
        }
        off += used; ++n;
    }
    CHECK(sawInfo);
    CHECK(sawSync);
    std::printf("  parsed %zu messages (%zu IQ, %zu FFT, %zu pong), %zu/%zu bytes\n",
                n, iq, fft, pong, off, s2c.size());
    // The tail is a partially-captured final message; everything before must frame.
    CHECK(s2c.size() - off < 100000);
}

int main(int argc, char** argv) {
    testRoundTrip();
    if (argc >= 3) testCapture(argv[1], argv[2]);
    else std::printf("captured: (no paths given, skipped)\n");
    std::printf("\n%s\n", failures ? "TESTS FAILED" : "ALL TESTS PASSED");
    return failures ? 1 : 0;
}
