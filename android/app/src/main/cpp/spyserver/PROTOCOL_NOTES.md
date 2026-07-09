# SpyServer protocol — observed facts

Captured 2026-07-09 with `ss_proxy.py` sitting between real clients and the
official `spyserver.exe` v2.0.1922 (RTL-SDR backend, 2.4 MSPS).
Clients: SDR++ Brown v1.2.1 (proto 2.0.1700), SDR# v1.0.0.1921 (proto 2.0.1921).

Artifacts: `c2s*.bin` (client->server), `s2c*.bin` (server->client), `log.txt`.
Everything below is decoded from those bytes. Nothing is taken from GPL source.

## Framing

Client -> server (8-byte header, little-endian):
    u32 CommandType
    u32 BodySize

Server -> client (20-byte header, little-endian):
    u32 ProtocolID          0x02000782 = 2.0.1922  (major<<24 | minor<<16 | rev)
    u32 MessageType         LOW 16 BITS are the type; high 16 = see below
    u32 StreamType          1 = IQ, 4 = FFT
    u32 SequenceNumber      per-stream; FFT frames observed always 0
    u32 BodySize

Version tolerance is real: the 2.0.1922 server accepted SDR++'s 2.0.1700 hello.

## Commands (client -> server)

    0  HELLO       u32 ProtocolVersion + client name (raw chars, NO NUL,
                   length = BodySize - 4)
    2  SET_SETTING u32 SettingID + u32 Value
    3  PING        8-byte body, echoed back verbatim as MessageType 2 (PONG)

## Settings (all observed being set on the wire)

    0    STREAMING_MODE      BITMASK: 1 = IQ, 4 = FFT, 5 = IQ+FFT
                             SDR++ sends 1 (IQ only). SDR# sends 5.
    1    STREAMING_ENABLED   0/1
    2    GAIN                INDEX into the tuner gain table (0..MaximumGainIndex),
                             NOT tenths of dB like rtl_tcp. RTL-SDR: 0..29.
                             The protocol never sends the dB values -- which is why
                             stock clients show a bare 0..29 slider.
    100  IQ_FORMAT           1 = uint8, 2 = int16, 3 = int24, 4 = float32
    101  IQ_FREQUENCY        Hz
    102  IQ_DECIMATION       stage N -> rate / 2^N
    103  IQ_DIGITAL_GAIN     u32; 0xFFFFFFFF (-1) = auto (SDR# uses auto)
    200  FFT_FORMAT          1 = uint8
    201  FFT_FREQUENCY       Hz
    203  FFT_DB_OFFSET       SDR# sends 0
    204  FFT_DB_RANGE        SDR# sends 140
    205  FFT_DISPLAY_PIXELS  SDR# sends its window width (1024, then 1534)
    206  ?                   SDR# sends 0            (unidentified)
    207  ?                   SDR# sends 100000000    (a frequency; unidentified)

## Messages (server -> client)

    0    DEVICE_INFO   body 48 = 12 x u32:
            DeviceType(3=RTLSDR) DeviceSerial MaximumSampleRate MaximumBandwidth
            DecimationStageCount GainStageCount MaximumGainIndex MinimumFrequency
            MaximumFrequency Resolution MinimumIQDecimation ForcedIQFormat
         Observed: 3, 0, 2400000, 2000000, 9, 0, 29, 24000000, 1800000000, 8, 0, 0
         Every field matches the real hardware + spyserver.config -> field order
         is confirmed, not merely plausible.

    1    CLIENT_SYNC   body 40 = 10 x u32:
            CanControl Gain DeviceCenterFrequency IQCenterFrequency
            FFTCenterFrequency MinimumIQCenterFrequency MaximumIQCenterFrequency
            MinimumFFTCenterFrequency MaximumFFTCenterFrequency (+1 more)

    2    PONG          body 8, echoes the PING body

    100  UINT8_IQ      StreamType 1. body 2944 = 1472 IQ pairs (u8 I, u8 Q)
    101  INT16_IQ      StreamType 1. body 5888 = 1472 IQ pairs (i16 I, i16 Q)
         MessageType = 99 + IQ_FORMAT. The 2944 : 5888 ratio is exactly 1:2 for the
         same 1472 samples, which CONFIRMS uint8=1 / int16=2 on the wire rather
         than only from correlating the client's UI.

    301  UINT8_FFT     StreamType 4. body = FFT_DISPLAY_PIXELS exactly (1534),
         one u8 per display bin. The SERVER bins down to the pixel count the client
         asks for; `fft_bin_bits` in spyserver.config is internal only.
         MessageType = 300 + FFT_FORMAT.

## MessageType high 16 bits

For IQ messages from SDR#, `MessageType >> 16` drifted over 11..46 while the low
16 stayed 100. It was 0 for every message in the SDR++ session, and 0 for
DEVICE_INFO / CLIENT_SYNC / PONG / FFT.

Distinguishing factor: SDR# set IQ_DIGITAL_GAIN = 0xFFFFFFFF (auto), SDR++ set an
explicit value. So it very likely reports the server-applied automatic digital
gain. NOT CONFIRMED -- treat as opaque; send 0 when digital gain is explicit.

## Behaviour

- Changing decimation requires a STREAM RESTART. The client sends
  STREAMING_ENABLED=0, re-sends the whole settings block (format, decimation,
  frequency, mode, gain, digital gain), then STREAMING_ENABLED=1. It never
  changes decimation in place. Our Phase 2 server therefore does NOT need
  seamless mid-stream decimation, and our Phase 3 client should do the same dance.

- `maximum_clients = 1`: a second client is accepted then immediately closed. A
  server with NO DEVICE behaves identically, so "closed right after hello" is
  ambiguous between "busy" and "no radio". (This cost us an hour. Our server must
  say which.)

- SDR++ requests IQ ONLY (mode 1) and computes its waterfall locally from
  full-rate IQ, so it saves no bandwidth at all. SDR# requests IQ+FFT (mode 5):
  narrow decimated IQ plus a cheap wide FFT. Our Phase 3 client must do what SDR#
  does -- that is where the bandwidth win lives.

## Bandwidth, measured

IQ bytes/sample: uint8 = 2, int16 = 4, float32 = 8.

float32 at FULL rate (decimation 0) = 2.4 MS/s x 8 B = ~19 MB/s. It broke up over
WiFi, as it must -- 4x raw rtl_tcp. The same float32 stream at SDR#'s decimation
ran cleanly at ~1.3 MB/s. Nothing is wrong with float32; asking for 19 MB/s over
WiFi is simply impossible.

Measured against the same radio, same server, same WiFi, in one sitting:

    float32, full IQ (decimation 0)   ~19   MB/s   BREAKS UP
    float32, decimated (SDR# default)  ~1.3 MB/s   clean
    uint8,   decimated ("full IQ" off) ~0.325 MB/s clean
    raw rtl_tcp @ 2.4 MSPS             ~4.8 MB/s   (for comparison)

That is the whole SpyServer thesis demonstrated empirically: 325 KB/s carries the
same listening experience that costs 4.8 MB/s over rtl_tcp -- a ~15x reduction,
and ~60x versus full-rate float32. Nothing is wrong with float32; asking for
19 MB/s over WiFi is simply impossible.

325 KB/s = ~2.6 Mbit/s. THAT is what makes the off-grid cellular node viable,
and it is why Phase 2/3 exist. rtl_tcp cannot do it at any setting.

Our client should default to uint8 or int16 and pick decimation from the demod
bandwidth, never full rate.
