// VibeSDR V5 — real-signal FM stereo/RDS probe.
//
// Connects to an rtl_tcp server (with a real RTL-SDR), runs the actual
// RxPipeline WFM engine on the live IQ, and reports the pilot-PLL lock over time
// plus RDS, writing the decoded stereo audio to a WAV for inspection. This is
// how we debug real-off-air stereo without rebuilding the phone app.
//
// Usage:  rtl_tcp -a 127.0.0.1 -s 2400000 -f 96600000      (on the Mac)
//         ./fm_probe [host] [port] [seconds]                (default 127.0.0.1 1234 12)
//
// Build (arm64 Mac, exercises the NEON path):
//   clang++ -std=c++17 -O3 -I.. fm_probe.cpp ../fft.cpp ../ddc.cpp \
//       ../resampler.cpp ../stereo.cpp ../rds.cpp ../pipeline.cpp \
//       ../third_party/kissfft/kiss_fft.c ../third_party/kissfft/kiss_fftr.c \
//       -Dkiss_fft_alloc=vibe_kiss_fft_alloc -Dkiss_fft=vibe_kiss_fft \
//       -Dkiss_fft_stride=vibe_kiss_fft_stride -Dkiss_fft_cleanup=vibe_kiss_fft_cleanup \
//       -Dkiss_fft_next_fast_size=vibe_kiss_fft_next_fast_size \
//       -Dkiss_fftr_alloc=vibe_kiss_fftr_alloc -Dkiss_fftr=vibe_kiss_fftr \
//       -Dkiss_fftri=vibe_kiss_fftri -o fm_probe

#include "../vibedsp.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

using namespace vibedsp;

struct Cap {
    std::vector<float> pcm;           // interleaved L/R @ 48k
    std::atomic<int> stereoEvents{0};
    bool lastStereo = false;
    std::string ps, rt;
    int pi = -1;
};

static void onAudio(void* c, const float* pcm, int frames, int ch, int) {
    Cap* cap = (Cap*)c;
    if (ch == 2) cap->pcm.insert(cap->pcm.end(), pcm, pcm + frames * 2);
    else for (int i = 0; i < frames; ++i) { cap->pcm.push_back(pcm[i]); cap->pcm.push_back(pcm[i]); }
}
static void onStereo(void* c, bool lk) {
    Cap* cap = (Cap*)c;
    cap->stereoEvents++;
    cap->lastStereo = lk;
    std::printf("  [stereo callback] locked=%d\n", (int)lk);
}
static void onPs(void* c, uint16_t pi, const char* ps) {
    Cap* cap = (Cap*)c; cap->pi = pi; cap->ps = ps ? ps : "";
    std::printf("  [RDS PS] PI=%04X  PS=\"%s\"\n", pi, ps ? ps : "");
}
static void onRt(void* c, const char* rt) {
    Cap* cap = (Cap*)c; cap->rt = rt ? rt : "";
    std::printf("  [RDS RT] \"%s\"\n", rt ? rt : "");
}

static void sendCmd(int fd, uint8_t code, uint32_t param) {
    uint8_t c[5] = { code, (uint8_t)(param>>24), (uint8_t)(param>>16),
                     (uint8_t)(param>>8), (uint8_t)param };
    (void)!write(fd, c, 5);
}

static void writeWav(const char* path, const std::vector<float>& pcm, int rate, int ch) {
    FILE* f = std::fopen(path, "wb");
    if (!f) { std::printf("cannot write %s\n", path); return; }
    const int n = (int)pcm.size();
    const int bytes = n * 2;
    auto w32 = [&](uint32_t v){ std::fwrite(&v, 4, 1, f); };
    auto w16 = [&](uint16_t v){ std::fwrite(&v, 2, 1, f); };
    std::fwrite("RIFF", 1, 4, f); w32(36 + bytes); std::fwrite("WAVE", 1, 4, f);
    std::fwrite("fmt ", 1, 4, f); w32(16); w16(1); w16((uint16_t)ch);
    w32(rate); w32(rate * ch * 2); w16((uint16_t)(ch * 2)); w16(16);
    std::fwrite("data", 1, 4, f); w32(bytes);
    for (float v : pcm) {
        int s = (int)lround(v * 32767.0f);
        if (s < -32768) s = -32768; else if (s > 32767) s = 32767;
        w16((int16_t)s);
    }
    std::fclose(f);
    std::printf("wrote %s (%d samples, %.1fs)\n", path, n / ch, (double)(n / ch) / rate);
}

int main(int argc, char** argv) {
    const char* host = argc > 1 ? argv[1] : "127.0.0.1";
    const int   port = argc > 2 ? atoi(argv[2]) : 1234;
    const int   secs = argc > 3 ? atoi(argv[3]) : 12;
    const double FREQ = argc > 4 ? atof(argv[4]) : 96600000.0;  // e.g. 104200000
    const int    gainT = argc > 5 ? atoi(argv[5]) : 496;        // tuner gain, tenths dB (496=49.6)
    const double FS = 2400000.0;

    int fd = socket(AF_INET, SOCK_STREAM, 0);
    sockaddr_in a{}; a.sin_family = AF_INET; a.sin_port = htons(port);
    inet_pton(AF_INET, host, &a.sin_addr);
    if (connect(fd, (sockaddr*)&a, sizeof(a)) < 0) { std::printf("connect failed to %s:%d\n", host, port); return 1; }
    uint8_t hdr[12];
    if (read(fd, hdr, 12) != 12 || memcmp(hdr, "RTL0", 4) != 0) { std::printf("bad rtl_tcp header\n"); return 1; }
    std::printf("connected; tuner type=%d\n", (hdr[4]<<24)|(hdr[5]<<16)|(hdr[6]<<8)|hdr[7]);

    sendCmd(fd, 0x02, (uint32_t)FS);       // sample rate
    sendCmd(fd, 0x01, (uint32_t)FREQ);     // center freq
    sendCmd(fd, 0x08, 0);                  // RTL2832 digital AGC OFF (poor on V4)
    sendCmd(fd, 0x03, 1);                  // tuner gain mode = manual
    sendCmd(fd, 0x04, (uint32_t)gainT);    // fixed tuner gain
    std::printf("fixed tuner gain = %.1f dB, AGC off\n", gainT / 10.0);

    Cap cap;
    RxPipeline pipe;
    RxPipeline::Callbacks cb; cb.ctx = &cap;
    cb.audio = onAudio; cb.stereo = onStereo; cb.rdsPs = onPs; cb.rdsText = onRt;
    pipe.start(FS, 4096, 20.0, 48000, cb);
    pipe.setTune(0.0, RxPipeline::Mode::WFM, 200000.0);

    std::vector<uint8_t> buf(65536);
    std::vector<cf32> iq(32768);
    auto t0 = std::chrono::steady_clock::now();
    auto tlog = t0;
    int carry = 0; uint8_t carryByte = 0;
    while (true) {
        int got = (int)read(fd, buf.data() + carry, (int)buf.size() - carry);
        if (got <= 0) break;
        if (carry) buf[0] = carryByte;
        int total = carry + got;
        int ns = total / 2;
        for (int i = 0; i < ns; ++i)
            iq[i] = cf32(((float)buf[i*2] - 127.4f)/128.0f, ((float)buf[i*2+1] - 127.4f)/128.0f);
        carry = total & 1; if (carry) carryByte = buf[total-1];
        pipe.feed(iq.data(), ns);

        auto now = std::chrono::steady_clock::now();
        if (now - tlog > std::chrono::milliseconds(500)) {
            tlog = now;
            std::printf("t=%4.1fs  pilotLock=%.4f  blend=%.2f  audio=%zu\n",
                std::chrono::duration<double>(now - t0).count(),
                pipe.pilotLockAmp(), pipe.stereoBlend(), cap.pcm.size()/2);
            std::fflush(stdout);
        }
        if (now - t0 > std::chrono::seconds(secs)) break;
    }
    close(fd);
    std::printf("\nstereo callbacks=%d lastStereo=%d  PI=%04X PS=\"%s\" RT=\"%s\"\n",
        cap.stereoEvents.load(), (int)cap.lastStereo, cap.pi, cap.ps.c_str(), cap.rt.c_str());
    writeWav("/tmp/fm_probe.wav", cap.pcm, 48000, 2);
    return 0;
}
