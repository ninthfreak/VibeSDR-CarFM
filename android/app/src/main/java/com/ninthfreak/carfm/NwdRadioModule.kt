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
    private var sourceObserver: android.database.ContentObserver? = null
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
            // RDS on. We don't know what each selector byte controls, and on-device
            // only selector 1 reads back enabled while our setRDSState(0,true) never
            // sticks — and no PS / RadioText ever arrives. So enable ALL of 0..3 as
            // an experiment: one of them may be the PS/RadioText gate. The probe
            // re-reads getRDSState(0..3) + rtMessage, so the next log shows whether
            // this changed anything. Harmless if not (they're just RDS toggles).
            for (sel in 0..3) { try { r.setRDSState(sel.toByte(), true) } catch (_: Throwable) {} }
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
        // Toggle all four selectors (see connect) — we don't know which gates PS/RT.
        for (sel in 0..3) {
            try { radio?.setRDSState(sel.toByte(), on) } catch (e: Throwable) { Log.w(TAG, "setRDSState($sel) failed", e) }
        }
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

    // ── Source-gate experiment (mcu_current_source in Settings.System) ───────────
    // Decompile finding: the service only decodes RDS (PS/RadioText) while
    // `mcu_current_source == 4` (FM) — it watches that Settings.System row with a
    // ContentObserver and opens the tuner + enables RDS when it flips. So the whole
    // RadioText wall may reduce to writing that one integer. These methods read /
    // observe / (guardedly) write it. All are opt-in from the diagnostics panel.

    private val SRC_KEY = "mcu_current_source"
    private val SRC_FM = 4

    /** Exhaustive read: dump every Settings.System row matching mcu/radio/source/
     *  antenna/fm/rds, plus WRITE_SETTINGS status and the total row count. */
    @ReactMethod
    fun sourceProbe(promise: Promise) {
        val cr = reactContext.contentResolver
        val sb = StringBuilder("SOURCE PROBE\n")
        val canWrite = try { android.provider.Settings.System.canWrite(reactContext) } catch (_: Throwable) { false }
        sb.append("  WRITE_SETTINGS granted: $canWrite\n")
        sb.append("  $SRC_KEY = ${readInt(SRC_KEY)}  (FM would be $SRC_FM)\n")
        try {
            val cur = cr.query(android.provider.Settings.System.CONTENT_URI, null, null, null, null)
            if (cur != null) {
                val ni = cur.getColumnIndex("name"); val vi = cur.getColumnIndex("value")
                var total = 0
                val rx = Regex("(?i)mcu|radio|source|antenna|\\bfm\\b|rds|tuner")
                val matched = StringBuilder()
                while (cur.moveToNext()) {
                    total++
                    val name = if (ni >= 0) cur.getString(ni) else null
                    val value = if (vi >= 0) cur.getString(vi) else null
                    if (name != null && rx.containsMatchIn(name)) matched.append("    $name = $value\n")
                }
                cur.close()
                sb.append("  Settings.System rows: $total; matching:\n").append(matched)
            } else sb.append("  Settings.System query returned null (not enumerable on this ROM)\n")
        } catch (e: Throwable) { sb.append("  enumerate failed: ${e.message}\n") }
        promise.resolve(sb.toString())
    }

    private fun readInt(key: String): Int =
        try { android.provider.Settings.System.getInt(reactContext.contentResolver, key, -1) } catch (_: Throwable) { -1 }

    @ReactMethod
    fun canWriteSettings(promise: Promise) {
        promise.resolve(try { android.provider.Settings.System.canWrite(reactContext) } catch (_: Throwable) { false })
    }

    /** Open the system "modify system settings" grant screen for this app. */
    @ReactMethod
    fun requestWriteSettings() {
        try {
            val i = Intent(android.provider.Settings.ACTION_MANAGE_WRITE_SETTINGS)
                .setData(android.net.Uri.parse("package:${reactContext.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            (currentActivity ?: reactContext).startActivity(i)
        } catch (e: Throwable) { Log.w(TAG, "requestWriteSettings failed", e) }
    }

    /** Watch mcu_current_source and emit NwdSourceChange on every change. */
    @ReactMethod
    fun startSourceObserver() {
        if (sourceObserver != null) return
        val cr = reactContext.contentResolver
        val obs = object : android.database.ContentObserver(android.os.Handler(android.os.Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                emit("NwdSourceChange", Arguments.createMap().apply { putInt("source", readInt(SRC_KEY)) })
            }
        }
        sourceObserver = obs
        try { cr.registerContentObserver(android.provider.Settings.System.getUriFor(SRC_KEY), false, obs) }
        catch (e: Throwable) { Log.w(TAG, "registerContentObserver failed", e); sourceObserver = null }
    }

    @ReactMethod
    fun stopSourceObserver() {
        sourceObserver?.let { try { reactContext.contentResolver.unregisterContentObserver(it) } catch (_: Throwable) {} }
        sourceObserver = null
    }

    /** Guarded write-and-restore: set mcu_current_source=4 (FM) so the service's
     *  observer opens the tuner + enables RDS, hold ~8s (watch the log for RT
     *  lines), then restore the original. Refuses without WRITE_SETTINGS. Returns a
     *  step-by-step log; the restore fires via a delayed handler + NwdSourceWriteRestored. */
    @ReactMethod
    fun sourceWriteTest(promise: Promise) {
        val cr = reactContext.contentResolver
        val sb = StringBuilder("SOURCE WRITE TEST\n")
        val canWrite = try { android.provider.Settings.System.canWrite(reactContext) } catch (_: Throwable) { false }
        if (!canWrite) { sb.append("  BLOCKED: WRITE_SETTINGS not granted — tap 'Grant write access' first.\n"); promise.resolve(sb.toString()); return }
        val orig = readInt(SRC_KEY)
        sb.append("  original $SRC_KEY = $orig\n")
        var wrote = false
        try { wrote = android.provider.Settings.System.putInt(cr, SRC_KEY, SRC_FM) }
        catch (e: Throwable) { sb.append("  putInt threw: ${e.message}\n") }
        val readback = readInt(SRC_KEY)
        sb.append("  putInt($SRC_FM) returned $wrote; readback = $readback (stuck=${readback == SRC_FM})\n")
        sb.append("  holding 8s — watch for RT '…' lines — then restoring to $orig\n")
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
            if (orig >= 0) try { android.provider.Settings.System.putInt(cr, SRC_KEY, orig) } catch (_: Throwable) {}
            emit("NwdSourceWriteRestored", Arguments.createMap().apply { putInt("restored", orig); putInt("stuck", if (readback == SRC_FM) 1 else 0) })
        }, 8000)
        promise.resolve(sb.toString())
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
        stopSourceObserver()
        disconnect()
        super.invalidate()
    }
}
