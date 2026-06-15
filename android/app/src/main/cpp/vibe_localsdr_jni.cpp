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
