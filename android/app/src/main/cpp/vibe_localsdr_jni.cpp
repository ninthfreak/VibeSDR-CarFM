// VibeSDR V4 — local-SDR shim JNI.
//
// Stage 1 proved the SDR++ Brown core + RTL-SDR driver build/link into the APK.
// Stage 2 opens an RTL-SDR over a USB file descriptor handed down from Kotlin
// (which owns the Android USB permission flow) and probes it via librtlsdr's
// rtlsdr_open_sys_dev(fd). Later stages add the real localhost UberSDR shim
// (IQ → FFT/SPEC → Opus audio).

#include <jni.h>
#include <android/log.h>
#include <string>
#include <thread>
#include <vector>
#include <rtl-sdr.h>
#include "local_sdr_shim.h"
#include "rtl_tcp_server.h"

#define LOG_TAG "VibeLocalSDR"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO,  LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

static const char* tunerName(enum rtlsdr_tuner t) {
    switch (t) {
        case RTLSDR_TUNER_E4000:  return "E4000";
        case RTLSDR_TUNER_FC0012: return "FC0012";
        case RTLSDR_TUNER_FC0013: return "FC0013";
        case RTLSDR_TUNER_FC2580: return "FC2580";
        case RTLSDR_TUNER_R820T:  return "R820T";
        case RTLSDR_TUNER_R828D:  return "R828D";
        default:                  return "unknown";
    }
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeHello(JNIEnv* env, jobject /*thiz*/) {
    LOGI("native shim loaded (SDR++ Brown core + librtlsdr linked)");
    return env->NewStringUTF("VibeSDR local-SDR shim: SDR++ Brown core + rtl_sdr linked");
}

// Open an RTL-SDR from a USB fd (owned by the Kotlin UsbDeviceConnection) and
// return a human-readable description. Returns a string starting with "ERROR:"
// on failure. The fd stays owned by Kotlin; we close only the rtlsdr handle.
extern "C" JNIEXPORT jstring JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeProbeRtl(JNIEnv* env, jobject /*thiz*/,
                                                 jint fd, jint vid, jint pid) {
    LOGI("probing RTL-SDR: fd=%d vid=0x%04x pid=0x%04x", fd, vid, pid);

    rtlsdr_dev_t* dev = nullptr;
    int ret = rtlsdr_open_sys_dev(&dev, (intptr_t)fd);
    if (ret != 0 || dev == nullptr) {
        LOGE("rtlsdr_open_sys_dev failed: %d", ret);
        std::string err = "ERROR: rtlsdr_open_sys_dev failed (" + std::to_string(ret) + ")";
        return env->NewStringUTF(err.c_str());
    }

    enum rtlsdr_tuner tuner = rtlsdr_get_tuner_type(dev);

    char manufact[256] = {0}, product[256] = {0}, serial[256] = {0};
    rtlsdr_get_usb_strings(dev, manufact, product, serial);

    std::string desc = std::string("RTL-SDR opened: ")
        + (manufact[0] ? manufact : "?") + " "
        + (product[0]  ? product  : "?")
        + " [sn:" + (serial[0] ? serial : "?") + "]"
        + " tuner=" + tunerName(tuner);
    LOGI("%s", desc.c_str());

    rtlsdr_close(dev);
    return env->NewStringUTF(desc.c_str());
}

// Start the local-SDR spectrum pipeline + localhost UberSDR server.
// Returns the bound TCP port (>0), or -1 on failure (check logcat).
extern "C" JNIEXPORT jint JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeStartSpectrum(
        JNIEnv* env, jobject /*thiz*/, jint fd, jint vid, jint pid,
        jdouble centerFreq, jdouble sampleRate, jint gainTenthDb,
        jint fftSize, jdouble fftRate, jstring mode) {
    const char* modeC = mode ? env->GetStringUTFChars(mode, nullptr) : "";
    std::string modeS = modeC ? modeC : "";
    if (mode && modeC) env->ReleaseStringUTFChars(mode, modeC);
    std::string err;
    int port = vibe::LocalSdrShim::instance().start(
        fd, vid, pid, centerFreq, sampleRate, gainTenthDb, fftSize, fftRate, modeS, err);
    if (port < 0) LOGE("startSpectrum failed: %s", err.c_str());
    return port;
}

// RTL-TCP: IQ from an rtl_tcp server (host:port) instead of a USB fd. Same return
// contract as nativeStartSpectrum (bound localhost port, or -1).
extern "C" JNIEXPORT jint JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeStartTcp(
        JNIEnv* env, jobject /*thiz*/, jstring host, jint port,
        jdouble centerFreq, jdouble sampleRate, jint gainTenthDb,
        jint fftSize, jdouble fftRate, jstring mode) {
    const char* hostC = host ? env->GetStringUTFChars(host, nullptr) : "";
    std::string hostS = hostC ? hostC : "";
    if (host && hostC) env->ReleaseStringUTFChars(host, hostC);
    const char* modeC = mode ? env->GetStringUTFChars(mode, nullptr) : "";
    std::string modeS = modeC ? modeC : "";
    if (mode && modeC) env->ReleaseStringUTFChars(mode, modeC);
    std::string err;
    int bound = vibe::LocalSdrShim::instance().startTcp(
        hostS, port, centerFreq, sampleRate, gainTenthDb, fftSize, fftRate, modeS, err);
    if (bound < 0) LOGE("startTcp failed: %s", err.c_str());
    return bound;
}

// SpyServer: IQ from a SpyServer-compatible server. Same return contract as
// nativeStartTcp (bound localhost port, or -1).
extern "C" JNIEXPORT jint JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeStartSpyServer(
        JNIEnv* env, jobject /*thiz*/, jstring host, jint port,
        jdouble centerFreq, jdouble sampleRate, jint gainTenthDb,
        jint fftSize, jdouble fftRate, jstring mode) {
    const char* hostC = host ? env->GetStringUTFChars(host, nullptr) : "";
    std::string hostS = hostC ? hostC : "";
    if (host && hostC) env->ReleaseStringUTFChars(host, hostC);
    const char* modeC = mode ? env->GetStringUTFChars(mode, nullptr) : "";
    std::string modeS = modeC ? modeC : "";
    if (mode && modeC) env->ReleaseStringUTFChars(mode, modeC);
    std::string err;
    int bound = vibe::LocalSdrShim::instance().startSpyServer(
        hostS, port, centerFreq, sampleRate, gainTenthDb, fftSize, fftRate, modeS, err);
    if (bound < 0) LOGE("startSpyServer failed: %s", err.c_str());
    return bound;
}

extern "C" JNIEXPORT void JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeStopSpectrum(JNIEnv* /*env*/, jobject /*thiz*/) {
    // Tear down on a detached thread so the JS/bridge caller never blocks if the
    // teardown is slow (RTL cancel + thread joins) — the app must not lock up
    // when leaving a local session. stop() is serialised internally (g_lifecycle).
    std::thread([]{ vibe::LocalSdrShim::instance().stop(); }).detach();
}

extern "C" JNIEXPORT void JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeSetGain(JNIEnv*, jobject, jint g) {
    vibe::LocalSdrShim::instance().setGain(g);
}
extern "C" JNIEXPORT void JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeSetPpm(JNIEnv*, jobject, jint ppm) {
    vibe::LocalSdrShim::instance().setPpm(ppm);
}
extern "C" JNIEXPORT void JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeSetBiasTee(JNIEnv*, jobject, jboolean on) {
    vibe::LocalSdrShim::instance().setBiasTee(on);
}
extern "C" JNIEXPORT void JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeSetAgc(JNIEnv*, jobject, jboolean on) {
    vibe::LocalSdrShim::instance().setAgc(on);
}
extern "C" JNIEXPORT void JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeSetDirectSampling(JNIEnv*, jobject, jint mode) {
    vibe::LocalSdrShim::instance().setDirectSampling(mode);
}
extern "C" JNIEXPORT void JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeSetSampleRate(JNIEnv*, jobject, jdouble rate) {
    vibe::LocalSdrShim::instance().setSampleRate(rate);
}
extern "C" JNIEXPORT void JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeSetDeemphasis(JNIEnv*, jobject, jdouble tau) {
    vibe::LocalSdrShim::instance().setDeemphasis(tau);
}
extern "C" JNIEXPORT void JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeSetSquelch(JNIEnv*, jobject, jboolean on, jfloat db) {
    vibe::LocalSdrShim::instance().setSquelch(on, db);
}
extern "C" JNIEXPORT void JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeSetNR(JNIEnv*, jobject, jboolean on) {
    vibe::LocalSdrShim::instance().setNR(on);
}
extern "C" JNIEXPORT void JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeSetNrStrength(JNIEnv*, jobject, jfloat s) {
    vibe::LocalSdrShim::instance().setNrStrength(s);
}
extern "C" JNIEXPORT void JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeSetNotch(JNIEnv*, jobject, jboolean on) {
    vibe::LocalSdrShim::instance().setNotch(on);
}
extern "C" JNIEXPORT void JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeSetStereoEnabled(JNIEnv*, jobject, jboolean on) {
    vibe::LocalSdrShim::instance().setStereoEnabled(on);
}
extern "C" JNIEXPORT jfloat JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeGetNrCpu(JNIEnv*, jobject) {
    return vibe::LocalSdrShim::instance().getNrCpu();
}
// ── Decoder-only sidecar (Kiwi/OWRX): decode the backend's audio natively ────
extern "C" JNIEXPORT jint JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeStartDecoderService(JNIEnv* env, jobject) {
    std::string err;
    int port = vibe::LocalSdrShim::instance().startDecoderService(err);
    if (port < 0) LOGE("startDecoderService: %s", err.c_str());
    return port;
}
// PCM is base64-encoded int16 LE (same form JS already builds for pushExternalPcm).
extern "C" JNIEXPORT void JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeFeedDecoderPcm(JNIEnv* env, jobject, jstring b64, jint rate) {
    if (!b64) return;
    const char* s = env->GetStringUTFChars(b64, nullptr);
    if (!s) return;
    // Inline base64 decode (RFC 4648).
    auto dval = [](char c) -> int {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '+') return 62;
        if (c == '/') return 63;
        return -1;
    };
    std::vector<uint8_t> bytes;
    int val = 0, bits = 0;
    for (const char* q = s; *q; q++) {
        int d = dval(*q);
        if (d < 0) continue;
        val = (val << 6) | d; bits += 6;
        if (bits >= 8) { bits -= 8; bytes.push_back((uint8_t)((val >> bits) & 0xFF)); }
    }
    (void)val;
    env->ReleaseStringUTFChars(b64, s);
    int n = (int)(bytes.size() / 2);
    if (n < 2) return;
    vibe::LocalSdrShim::instance().feedDecoderPcm((const int16_t*)bytes.data(), n, (int)rate);
}

extern "C" JNIEXPORT void JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeSetDecoderFreq(JNIEnv*, jobject, jdouble hz) {
    vibe::LocalSdrShim::instance().setDecoderFreq((double)hz);
}

// ── RTL-TCP SERVER (share this device's USB dongle over the network) ─────────
extern "C" JNIEXPORT jint JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeStartServer(
        JNIEnv* /*env*/, jobject, jint fd, jint vid, jint pid,
        jdouble sampleRate, jdouble centerFreq, jint gainTenthDb,
        jint port, jdouble overrideRate) {
    std::string err;
    int bound = vibe::RtlTcpServer::instance().start(
        fd, vid, pid, (uint32_t)sampleRate, (uint32_t)centerFreq, gainTenthDb,
        port, (uint32_t)overrideRate, err);
    if (bound < 0) LOGE("startServer failed: %s", err.c_str());
    return bound;
}

extern "C" JNIEXPORT void JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeStopServer(JNIEnv*, jobject) {
    // Detached like nativeStopSpectrum so the JS/bridge caller never blocks on the
    // teardown (socket closes + thread joins).
    std::thread([]{ vibe::RtlTcpServer::instance().stop(); }).detach();
}

extern "C" JNIEXPORT void JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeSetServerSampleRate(JNIEnv*, jobject, jdouble rate) {
    vibe::RtlTcpServer::instance().setSampleRateOverride((uint32_t)rate);
}

// Returns a small JSON status string for the UI + notification.
extern "C" JNIEXPORT jstring JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeGetServerStatus(JNIEnv* env, jobject) {
    auto s = vibe::RtlTcpServer::instance().getStatus();
    std::string j = "{";
    j += "\"running\":"       + std::string(s.running ? "true" : "false");
    j += ",\"client\":"       + std::string(s.clientConnected ? "true" : "false");
    j += ",\"clientAddr\":\"" + s.clientAddr + "\"";
    j += ",\"sampleRate\":"   + std::to_string(s.sampleRate);
    j += ",\"overrideRate\":" + std::to_string(s.overrideRate);
    j += ",\"droppedBytes\":" + std::to_string(s.droppedBytes);
    j += ",\"port\":"         + std::to_string(s.port);
    j += "}";
    return env->NewStringUTF(j.c_str());
}

// rtl_tcp CLIENT link health (jitter buffer). JSON, like the server status above.
extern "C" JNIEXPORT jstring JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeGetNetStatus(JNIEnv* env, jobject) {
    auto s = vibe::LocalSdrShim::instance().getNetStatus();
    std::string j = "{";
    j += "\"tcp\":"             + std::string(s.tcp ? "true" : "false");
    j += ",\"stalls\":"         + std::to_string(s.stalls);
    j += ",\"droppedSamples\":" + std::to_string(s.droppedSamples);
    j += ",\"bufferedMs\":"     + std::to_string(s.bufferedMs);
    j += ",\"spy\":"            + std::string(s.spy ? "true" : "false");
    j += ",\"canControl\":"     + std::string(s.canControl ? "true" : "false");
    j += ",\"closed\":"         + std::string(s.closed ? "true" : "false");
    j += "}";
    return env->NewStringUTF(j.c_str());
}

extern "C" JNIEXPORT jintArray JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeGetTunerGains(JNIEnv* env, jobject) {
    auto gains = vibe::LocalSdrShim::instance().getTunerGains();
    jintArray arr = env->NewIntArray((jsize)gains.size());
    if (arr && !gains.empty()) env->SetIntArrayRegion(arr, 0, (jsize)gains.size(), gains.data());
    return arr;
}
