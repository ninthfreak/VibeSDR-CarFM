package com.ninthfreak.carfm

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.media.AudioManager
import android.os.IBinder
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.nwd.radio.service.RadioCallback
import com.nwd.radio.service.RadioFeature
import com.nwd.radio.service.data.Frequency

/**
 * CarFM built-in-tuner bridge for NOWADA (NWD) firmware head units.
 *
 * Drives the head unit's own FM tuner via the vendor service
 * `com.nwd.radio.service` (bound over its AIDL `RadioFeature`; push events come
 * back on `RadioCallback`). This is the productised form of the validated
 * `spike/nwd-tuner-probe` — same bind/tune/seek/RDS recipe, exposed to JS as a
 * React Native module + DeviceEventEmitter events.
 *
 * Nothing here runs unless JS asks: `isAvailable()` is a cheap PackageManager
 * probe (drives the settings tuner-source detection), and `connect()` is only
 * called when CarFM actually selects this backend.
 *
 * Audio is analog + MCU-routed (not streamed to the app); `setAudioEnabled` fires
 * the source-switch broadcasts the stock app uses. Frequency scale (kHz vs 10 kHz
 * vs MHz×100) and the FM band byte are self-calibrated from `getCurrentFrequency`
 * on connect — the units differ across units, so we never hard-code them.
 */
class NwdRadioModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val TAG = "NwdRadio"
    private val bindAction = "com.nwd.radio.service.ACTION_RADIO_SERVICE"
    private val servicePkg = "com.nwd.radio.service"

    private var radio: RadioFeature? = null
    private var bound = false
    private var registered = false
    private var initialStereo = false
    private var initialRt = ""
    private var initialPty = -1
    private var connectPromise: Promise? = null

    // Self-calibrated on connect from getCurrentFrequency() (see the spike). MHz →
    // raw multiplier and the FM band byte both vary by unit.
    private var freqMult = 1000
    private var fmBand: Byte = 0

    override fun getName() = "NwdRadio"

    // ── Detection ──────────────────────────────────────────────────────────────
    /** True if this unit exposes the NWD radio service. Cheap; safe to call any
     *  time (drives the settings picker's "Detected / Not detected" state). */
    @ReactMethod
    fun isAvailable(promise: Promise) {
        try {
            val intent = Intent(bindAction).setPackage(servicePkg)
            val resolved = reactContext.packageManager.resolveService(intent, 0) != null
            promise.resolve(resolved)
        } catch (e: Throwable) {
            promise.resolve(false)
        }
    }

    // ── Binding lifecycle ────────────────────────────────────────────────────────
    /** Bind the radio service. Resolves once connected (with the calibrated
     *  {mhz, band, freqMult}); rejects if the service can't be bound. */
    @ReactMethod
    fun connect(promise: Promise) {
        if (bound && radio != null) { promise.resolve(currentStateMap()); return }
        connectPromise = promise
        try {
            val intent = Intent(bindAction).setPackage(servicePkg)
            val ok = reactContext.bindService(intent, conn, Context.BIND_AUTO_CREATE)
            if (!ok) {
                connectPromise = null
                try { reactContext.unbindService(conn) } catch (_: Throwable) {}
                promise.reject("bind", "bindService returned false — NWD radio service not found/bindable")
            } else {
                bound = true
            }
        } catch (e: Throwable) {
            connectPromise = null
            promise.reject("bind", "bindService threw: ${e.message}", e)
        }
    }

    @ReactMethod
    fun disconnect() {
        try { radio?.unRegistCallback(callback) } catch (_: Throwable) {}
        if (bound) { try { reactContext.unbindService(conn) } catch (_: Throwable) {} }
        bound = false
        radio = null
    }

    private val conn = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            val r = RadioFeature.Stub.asInterface(binder)
            radio = r
            registered = try { r.registCallback(callback); true } catch (e: Throwable) { Log.w(TAG, "registCallback failed", e); false }
            // Self-calibrate units + band from the tuner's current reading.
            try {
                val f: Frequency? = r.getCurrentFrequency()
                if (f != null) {
                    fmBand = f.band
                    val fv = f.freq
                    freqMult = if (fv > 50000) 1000 else if (fv > 5000) 100 else if (fv > 500) 10 else 1
                }
            } catch (e: Throwable) { Log.w(TAG, "getCurrentFrequency failed", e) }
            // Read the CURRENT stereo state: a stable-stereo station never fires
            // notifyStereo (that only fires on change), so without this the face
            // is stuck at its mono default on a rock-solid stereo signal.
            initialStereo = try { r.isStreroOn() } catch (_: Throwable) { false }
            initialRt = try { r.getRtMessage() ?: "" } catch (_: Throwable) { "" }
            initialPty = try { r.getPTYType().toInt() } catch (_: Throwable) { -1 }
            // RDS on by default (selector byte 0 — same guess the spike confirmed works).
            try { r.setRDSState(0.toByte(), true) } catch (_: Throwable) {}
            connectPromise?.resolve(currentStateMap())
            connectPromise = null
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            radio = null
            emit("NwdRadioDisconnected", Arguments.createMap())
        }
    }

    // ── Control ──────────────────────────────────────────────────────────────────
    /** Tune to an FM frequency in MHz (e.g. 88.7). Converts to the unit's raw scale. */
    @ReactMethod
    fun tune(mhz: Double, promise: Promise) {
        val r = radio ?: run { promise.reject("nc", "not connected"); return }
        try {
            val raw = Math.round(mhz * freqMult).toInt()
            r.setCurrentFrequency(raw, fmBand, 0)
            promise.resolve(mhz)
        } catch (e: Throwable) { promise.reject("tune", e.message, e) }
    }

    /** Hardware seek up/down to the next receivable station. */
    @ReactMethod
    fun seek(up: Boolean) {
        try { radio?.seek(up) } catch (e: Throwable) { Log.w(TAG, "seek failed", e) }
    }

    /** Read the tuner's CURRENT state via the synchronous getters. On-device the
     *  push notify* callbacks don't reach us, but these getters do return live
     *  values (proven by the connect-time seed), so JS polls this to drive the
     *  face instead of waiting for callbacks that never come. */
    @ReactMethod
    fun poll(promise: Promise) {
        val r = radio
        if (r == null) { promise.resolve(null); return }
        try {
            val map = Arguments.createMap()
            try {
                r.getCurrentFrequency()?.let {
                    map.putDouble("mhz", it.freq.toDouble() / freqMult)
                    map.putString("ps", it.psName ?: "")
                }
            } catch (_: Throwable) {}
            map.putBoolean("stereo", try { r.isStreroOn() } catch (_: Throwable) { false })
            map.putString("rt", try { r.getRtMessage() ?: "" } catch (_: Throwable) { "" })
            map.putInt("pty", try { r.getPTYType().toInt() } catch (_: Throwable) { -1 })
            promise.resolve(map)
        } catch (e: Throwable) { promise.resolve(null) }
    }

    @ReactMethod
    fun setRdsEnabled(on: Boolean) {
        try { radio?.setRDSState(0.toByte(), on) } catch (e: Throwable) { Log.w(TAG, "setRDSState failed", e) }
    }

    /** One-shot diagnostic dump of EVERY readable getter the NWD RadioFeature
     *  exposes. On-device the station name (PS) and RadioText never populate
     *  through the usual paths (psName / getRtMessage / the callbacks), so this
     *  hunts for where — if anywhere — they actually live on this firmware, and
     *  captures the band plan (min/max/STEP — speaks to why seek moves 0.2 MHz),
     *  the RDS-enable selectors, presets and radio/scan state. Purely read-only;
     *  safe to call any time after connect. Returns a formatted multi-line string
     *  that JS writes to the tuner diagnostics log. */
    @ReactMethod
    fun probe(promise: Promise) {
        val r = radio ?: run { promise.reject("nc", "not connected"); return }
        val sb = StringBuilder()
        fun line(k: String, v: () -> Any?) {
            sb.append("  ").append(k).append('=')
            try { sb.append(v()) } catch (e: Throwable) { sb.append("ERR(").append(e.javaClass.simpleName).append(')') }
            sb.append('\n')
        }
        sb.append("NWD PROBE (freqMult=$freqMult band=$fmBand)\n")
        line("radioType") { r.getRadioType() }
        line("radioState") { r.getRadioState().toInt() }
        line("scanState") { r.getCurrentScanState() }
        line("freq") { r.getCurrentFrequency()?.let { "band=${it.band} freq=${it.freq} ps='${it.psName ?: ""}'" } }
        line("nearOn") { r.isNearOn() }
        line("hasStereo") { r.isHasStrero() }
        line("stereoOn") { r.isStreroOn() }
        line("backServiceOn") { r.isRadioBackServiceOn() }
        line("pty") { r.getPTYType().toInt() }
        line("prefabPty") { r.getPrefabPTYType().toInt() }
        line("rtMessage") { "'${r.getRtMessage() ?: ""}'" }
        for (sel in 0..3) line("rdsState[$sel]") { r.getRDSState(sel) }
        line("bandPlan") {
            val arr = r.getRadioPoint()
            if (arr == null) "null"
            else arr.joinToString("; ", "[${arr.size}] ") { "max=${it.max} min=${it.min} step=${it.step}" }
        }
        line("presets") {
            val arr = r.getPrefabFrequency()
            if (arr == null) "null"
            else arr.joinToString(",", "[${arr.size}] ") { "${it.freq}/${it.psName ?: ""}" }
        }
        promise.resolve(sb.toString())
    }

    /** Keep the tuner's (analog, MCU-routed) audio alive + unmute music. Does NOT
     *  fire the source-switch broadcasts: on-device those launched the STOCK radio
     *  app over CarFM. Kept as a separate, opt-in call for later experimentation. */
    @ReactMethod
    fun setAudioEnabled(on: Boolean) {
        try { radio?.setRadioBackServiceOn(on) } catch (e: Throwable) { Log.w(TAG, "setRadioBackServiceOn failed", e) }
        if (on) {
            (reactContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager)
                ?.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_UNMUTE, 0)
        }
    }

    /** The source-switch broadcasts, split out so they're NOT fired automatically
     *  (they launch the stock radio app). Exposed for deliberate testing only. */
    @ReactMethod
    fun requestAudioSource() {
        reactContext.sendBroadcast(Intent("com.nwd.action.ACTION_REQUEST_CHANGE_SOURCE"))
        reactContext.sendBroadcast(Intent("com.nwd.action.ACTION_CHANGE_SOURCE"))
        reactContext.sendBroadcast(Intent("com.nwd.action.ACTION_REQUEST_GOTO_CURRENT_SOURCE"))
    }

    // ── Callbacks → JS events ──────────────────────────────────────────────────
    private val callback = object : RadioCallback.Stub() {
        override fun notifyState(s: Byte) = emit("NwdRadioState", Arguments.createMap().apply { putInt("state", s.toInt()) })
        override fun notifyCurrentFrequency(band: Byte, freq: Int, ps: String?, arg: Int) =
            emit("NwdRadioFrequency", Arguments.createMap().apply {
                putInt("band", band.toInt()); putInt("freq", freq)
                putDouble("mhz", freq.toDouble() / freqMult); putString("ps", ps ?: "")
                // `arg` is the tuner's signal level (confirmed on-device: strong≈6, weak≈3).
                putInt("arg", arg)
            })
        override fun notifyNearOn(on: Boolean) {}
        override fun notifyStereo(on: Boolean) = emit("NwdRadioStereo", Arguments.createMap().apply { putBoolean("on", on) })
        override fun notifyStereoOn(on: Boolean) = emit("NwdRadioStereo", Arguments.createMap().apply { putBoolean("on", on) })
        override fun notifyRDSStateChange() {}
        override fun notifyCurrentPTYType(pty: Byte) = emit("NwdRadioPty", Arguments.createMap().apply { putInt("pty", pty.toInt()) })
        override fun notifyPrefabFrequency(arr: Array<Frequency>?) {}
        override fun notifyPrefabPTYType(pty: Byte) {}
        override fun notifyRadioPoint(arr: Array<com.nwd.radio.service.data.RadioPoint>?) {}
        override fun notifyCurrentIsTA(ta: Boolean) = emit("NwdRadioTa", Arguments.createMap().apply { putBoolean("ta", ta) })
        override fun notifyRdsShowState(on: Boolean) {}
        override fun notifyRtMessage(rt: String?) = emit("NwdRadioRt", Arguments.createMap().apply { putString("rt", rt ?: "") })
        override fun notifyRadioScanState(state: Int) = emit("NwdRadioScanState", Arguments.createMap().apply { putInt("state", state) })
    }

    private fun currentStateMap(): WritableMap = Arguments.createMap().apply {
        putInt("band", fmBand.toInt())
        putInt("freqMult", freqMult)
        putBoolean("registered", registered)
        putBoolean("stereo", initialStereo)
        putString("rt", initialRt)
        putInt("pty", initialPty)
        try { radio?.getCurrentFrequency()?.let {
            putDouble("mhz", it.freq.toDouble() / freqMult); putString("ps", it.psName ?: "")
        } } catch (_: Throwable) {}
    }

    private fun emit(name: String, params: WritableMap) {
        try {
            reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(name, params)
        } catch (_: Throwable) {}
    }

    // RN NativeEventEmitter contract (no-op; suppresses the "no listener" warning).
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}

    override fun invalidate() {
        disconnect()
        super.invalidate()
    }
}
