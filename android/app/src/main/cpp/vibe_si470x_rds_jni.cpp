// Si470x hardware-RDS bridge (tuner-backends addendum §4): a standalone JNI
// surface feeding block groups from the Kotlin driver into the SHARED vibedsp
// RdsDecoder — RDS is decoded once, downstream, never in the backend. Fully
// additive: plain JNI-named exports, no JNI_OnLoad, touches nothing else.
//
// Kotlin side: com.vibesdr.app.Si470xRdsBridge { external fun reset();
//   external fun pushGroup(a,b,c,d, okMask): String?  // JSON when state changed
// }
#include <jni.h>
#include <mutex>
#include <string>
#include <vector>
#include <cstdio>
#include "vibedsp/vibedsp.h"

namespace {

struct State {
    std::string ps, rt, artist, title;
    bool tp = false, ta = false, af = false;
    int pty = 0, pi = -1;
    std::vector<float> afMhz;
    bool dirty = false;
};

std::mutex g_mtx;
State g_st;
vibedsp::RdsDecoder g_dec;
bool g_wired = false;

void wire() {
    vibedsp::RdsDecoder::Callbacks cb;
    cb.ctx = nullptr;
    cb.ps = [](void*, uint16_t pi, const char* ps) {
        g_st.pi = pi; g_st.ps = ps ? ps : ""; g_st.dirty = true;
    };
    cb.radiotext = [](void*, const char* rt) { g_st.rt = rt ? rt : ""; g_st.dirty = true; };
    cb.rtPlus = [](void*, const char* a, const char* t) {
        g_st.artist = a ? a : ""; g_st.title = t ? t : ""; g_st.dirty = true;
    };
    cb.flags = [](void*, bool tp, bool ta, uint8_t pty, bool af) {
        g_st.tp = tp; g_st.ta = ta; g_st.pty = pty; g_st.af = af; g_st.dirty = true;
    };
    cb.afList = [](void*, const float* mhz, int n) {
        g_st.afMhz.assign(mhz, mhz + n); g_st.dirty = true;
    };
    g_dec.setCallbacks(cb);
    g_wired = true;
}

std::string esc(const std::string& s) {
    std::string o;
    for (char c : s) {
        if (c == '"' || c == '\\') { o.push_back('\\'); o.push_back(c); }
        else if ((unsigned char)c >= 0x20) o.push_back(c);
    }
    return o;
}

// Same field names as the shim's {"type":"rds"} frame so JS mapping is shared.
std::string toJson(const State& s) {
    auto t = [](const std::string& v) {
        size_t e = v.find_last_not_of(" \t\r\n");
        return e == std::string::npos ? std::string() : v.substr(0, e + 1);
    };
    std::string af = "[";
    char tmp[16];
    for (size_t i = 0; i < s.afMhz.size(); ++i) {
        snprintf(tmp, sizeof tmp, "%s%.1f", i ? "," : "", s.afMhz[i]);
        af += tmp;
    }
    af += "]";
    std::string o = "{\"type\":\"rds\",\"ps\":\"" + esc(t(s.ps))
        + "\",\"radiotext\":\"" + esc(t(s.rt))
        + "\",\"rt_artist\":\"" + esc(s.artist) + "\",\"rt_title\":\"" + esc(s.title) + "\"";
    snprintf(tmp, sizeof tmp, ",\"pi\":%d", s.pi); o += tmp;
    o += std::string(",\"tp\":") + (s.tp ? "true" : "false")
       + ",\"ta\":" + (s.ta ? "true" : "false");
    snprintf(tmp, sizeof tmp, ",\"pty\":%d", s.pty); o += tmp;
    o += std::string(",\"af\":") + (s.af ? "true" : "false") + ",\"af_list\":" + af + "}";
    return o;
}

} // namespace

extern "C" JNIEXPORT void JNICALL
Java_com_vibesdr_app_Si470xRdsBridge_reset(JNIEnv*, jobject) {
    std::lock_guard<std::mutex> lk(g_mtx);
    if (!g_wired) wire();
    g_dec.reset();
    g_st = State{};
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_vibesdr_app_Si470xRdsBridge_pushGroup(
    JNIEnv* env, jobject, jint a, jint b, jint c, jint d, jint okMask) {
    std::lock_guard<std::mutex> lk(g_mtx);
    if (!g_wired) wire();
    const uint16_t blocks[4] = { (uint16_t)a, (uint16_t)b, (uint16_t)c, (uint16_t)d };
    const bool ok[4] = { (okMask & 1) != 0, (okMask & 2) != 0, (okMask & 4) != 0, (okMask & 8) != 0 };
    g_st.dirty = false;
    g_dec.pushGroup(blocks, ok);
    if (!g_st.dirty) return nullptr;
    return env->NewStringUTF(toJson(g_st).c_str());
}
