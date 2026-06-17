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
#include <rtl-sdr.h>
#include "local_sdr_shim.h"

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

extern "C" JNIEXPORT void JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeStopSpectrum(JNIEnv* /*env*/, jobject /*thiz*/) {
    vibe::LocalSdrShim::instance().stop();
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

extern "C" JNIEXPORT jintArray JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeGetTunerGains(JNIEnv* env, jobject) {
    auto gains = vibe::LocalSdrShim::instance().getTunerGains();
    jintArray arr = env->NewIntArray((jsize)gains.size());
    if (arr && !gains.empty()) env->SetIntArrayRegion(arr, 0, (jsize)gains.size(), gains.data());
    return arr;
}
