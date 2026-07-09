// VibeSDR — SpyServer-compatible CLIENT transport. Clean-room; see
// spyserver_protocol.h for provenance and licensing.
//
// Owns the socket, the handshake and the framing. Callers pump run() on their own
// thread and receive decoded stream payloads through callbacks. No DSP here, and
// nothing Android-specific — this builds into the iOS static lib too, so the
// SpyServer backend works on iPhone exactly like the rtl_tcp one.
#pragma once
#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "net_shim.h"
#include "spyserver_protocol.h"

namespace vibe::spyserver {

class SpyServerClient {
public:
    ~SpyServerClient();

    // Connect + hello + wait for DEVICE_INFO and CLIENT_SYNC. Returns false with
    // `err` set. A server with no radio, or a server already serving its one
    // permitted client, both simply close the socket after the hello — so we
    // cannot tell those apart, and neither can any other client. Say so plainly
    // rather than guessing (this exact ambiguity cost us an afternoon).
    bool connect(const std::string& host, int port, const std::string& clientName,
                 std::string& err);

    const DeviceInfo& deviceInfo() const { return info_; }
    const ClientSync& clientSync() const { return sync_; }
    bool canControl() const { return sync_.canControl != 0; }

    // Send one setting. Safe from any thread (serialised internally).
    bool setSetting(uint32_t settingId, uint32_t value);

    // Bring a stream up. Mirrors what SDR# does, which is also the only sequence
    // the server is known to accept: disable, push every setting, enable.
    // Changing decimation later requires calling this again — the protocol has no
    // in-place transition (observed: stock clients always restart the stream).
    bool startStream(uint32_t streamMode, uint32_t iqFormat, uint32_t decimation,
                     uint32_t iqFrequencyHz, uint32_t gainIndex,
                     uint32_t fftDisplayPixels, uint32_t fftFrequencyHz);

    // Retune without restarting the stream. Cheap; the server keeps streaming.
    bool setIqFrequency(uint32_t hz);
    bool setFftFrequency(uint32_t hz);
    bool setGainIndex(uint32_t index);

    // Blocking read loop. Returns when `running` goes false or the link dies.
    //   onIq  — payload in the negotiated iqFormat, `bytes` long
    //   onFft — one uint8 magnitude per display bin
    // Both are called on this thread; keep them cheap.
    using IqCallback  = std::function<void(const uint8_t* data, size_t bytes, uint32_t format)>;
    using FftCallback = std::function<void(const uint8_t* bins, size_t count)>;
    void run(std::atomic<bool>& running, const IqCallback& onIq, const FftCallback& onFft);

    void close();
    bool isOpen() const { return sock_ && sock_->isOpen(); }

    // Nearest gain-table index for a gain in tenths of a dB. SpyServer transmits a
    // bare index and never the dB values, so a client that wants to show real
    // units has to know the table itself. `gains` is the device's table.
    static uint32_t gainIndexForTenthDb(const std::vector<int>& gains, int tenthDb);

private:
    bool sendCommand(const std::vector<uint8_t>& bytes);
    bool readMessage(std::vector<uint8_t>& buf, size_t& msgLen, int timeoutMs);

    std::shared_ptr<net::Socket> sock_;
    DeviceInfo info_{};
    ClientSync sync_{};
    std::vector<uint8_t> rx_;     // accumulates partial messages across recv()s
};

}  // namespace vibe::spyserver
