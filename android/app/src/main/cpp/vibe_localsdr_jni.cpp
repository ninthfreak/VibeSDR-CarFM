// VibeSDR V4 — local-SDR shim, Stage 1 JNI load-proof.
//
// Stage 1 only proves the SDR++ Brown core + RTL-SDR driver build and link into
// the VibeSDR APK for arm64. Later stages add the real localhost UberSDR shim
// (USB → IQ → FFT/SPEC → Opus audio) behind this same library.

#include <jni.h>
#include <android/log.h>

#define LOG_TAG "VibeLocalSDR"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)

extern "C" JNIEXPORT jstring JNICALL
Java_com_vibesdr_app_VibeLocalSDR_nativeHello(JNIEnv* env, jobject /*thiz*/) {
    LOGI("native shim loaded (SDR++ Brown core linked)");
    return env->NewStringUTF("VibeSDR local-SDR shim: SDR++ Brown core + rtl_sdr linked");
}
