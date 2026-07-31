package com.ninthfreak.carfm

import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.IntentFilter
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
import com.facebook.react.bridge.ReadableArray
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
                startPanelKeyWatch()
            }
        } catch (e: Throwable) {
            connectPromise = null
            promise.reject("bind", "bindService threw: ${e.message}", e)
        }
    }

    // ── Steering-wheel / panel keys (the REAL transport) ─────────────────────────
    // The wheel is NOT a media key on this unit. The MCU broadcasts
    // `com.nwd.action.ACTION_KEY_VALUE` with a byte `extra_key_value`, and the
    // vendor RadioService registers for it WITHOUT a permission, then routes it
    // through handlePanelKey() — gated on Settings.System `mcu_current_source == 4`
    // (FM). That is why MediaSession capture and Activity.dispatchKeyEvent both saw
    // nothing: the event never enters Android's input pipeline at all.
    //
    // Because the receiver is unprotected, CarFM can listen for the same broadcast.
    // Panel-key codes (from the service's own dispatch table):
    //   4 changeBand · 5/60 search up · 6/59 search down · 16/17 seek up/down
    //   46 AMS (auto-store) · 61 INTRO · 62 preset NEXT · 63 preset PREV
    //   72 changeFmBand · 73 changeAmBand
    // 62/63 call prefeb(), which steps the service's own mCurPrefNum and tunes
    // mPrefFrequency[band][n-1] — i.e. the HARDWARE preset banks. We can't cancel a
    // normal broadcast, so the service still acts; JS reasserts CarFM's own preset
    // immediately after, which is what makes the app's order win.
    private var panelReceiver: BroadcastReceiver? = null

    private fun startPanelKeyWatch() {
        if (panelReceiver != null) return
        val r = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, i: Intent?) {
                val a = i?.action ?: return
                val key = when (a) {
                    "com.nwd.action.ACTION_KEY_VALUE" -> i.getByteExtra("extra_key_value", (-1).toByte()).toInt()
                    "com.nwd.action.ACTION_TEST_KEY" -> i.getIntExtra("extra_key_value", -1)
                    else -> -1
                }
                if (key < 0) return
                Log.i(TAG, "panel key $key ($a)")
                val m = Arguments.createMap()
                m.putInt("key", key)
                m.putString("action", a)
                emit("NwdPanelKey", m)
            }
        }
        val f = IntentFilter().apply {
            addAction("com.nwd.action.ACTION_KEY_VALUE")
            addAction("com.nwd.action.ACTION_TEST_KEY")
        }
        try {
            if (android.os.Build.VERSION.SDK_INT >= 33) {
                reactContext.registerReceiver(r, f, Context.RECEIVER_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag") reactContext.registerReceiver(r, f)
            }
            panelReceiver = r
            Log.i(TAG, "panel-key watch registered")
        } catch (e: Throwable) { Log.w(TAG, "panel-key watch failed", e) }
    }

    private fun stopPanelKeyWatch() {
        panelReceiver?.let { try { reactContext.unregisterReceiver(it) } catch (_: Throwable) {} }
        panelReceiver = null
    }

    /** Send a panel key AS IF the wheel/panel had been pressed (same unprotected
     *  broadcast the MCU uses). Lets the probe exercise the service's own dispatch
     *  table — e.g. 46 = AMS auto-store — without physical buttons. */
    @ReactMethod
    fun sendPanelKey(key: Int) {
        reactContext.sendBroadcast(
            Intent("com.nwd.action.ACTION_KEY_VALUE").putExtra("extra_key_value", key.toByte()))
    }

    @ReactMethod
    fun disconnect() {
        stopPanelKeyWatch()
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
            // NO initial stereo read: isStreroOn() is stuck true on this firmware
            // (it reads true on dead air), so seeding from it put a false STEREO on
            // the face that nothing corrected. notifyStereo is the only trustworthy
            // source; until it fires, the face shows its "unknown" pill.
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

    /** Hardware seek up/down to the next receivable station. Uses search(), NOT
     *  seek(): the probe (2026-07-26) showed radio.seek() only nudges one 0.2 MHz
     *  step (landing on noise), while radio.search() scans and STOPS on the next
     *  real station both directions (88.7→91.1 / 91.1→88.7, clear audio) — the
     *  genuine on-demand seek, and it works outside the preset auto-search. */
    @ReactMethod
    fun seek(up: Boolean) {
        try { radio?.search(up) } catch (e: Throwable) { Log.w(TAG, "seek (search) failed", e) }
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
    // ── android.os.Hardware JSON channel — DISPROVEN on this ROM ────────────────
    // Kept because the decompile findings below are still correct about the
    // VENDOR's design; only our guess at the transport class was wrong. The
    // device result that settles it is directly beneath.
    //
    // The vendor service does NOT get signal or RDS over the AIDL we bind — it
    // goes around it. RadioService picks ArmRadioManager when
    // RadioJsonNative.getRadioIc() == "SI47925" (a Silicon Labs Si4792x), and
    // RadioJsonNative talks to the MCU as JSON through a VENDOR FRAMEWORK class:
    //
    //   ReflectUtil.invokeStatic(android.os.Hardware, "parseJson", String) with
    //     {"MODULE":"radio","ACTION":"get","IC":"query"}    -> "SI47925"
    //     {"MODULE":"radio","ACTION":"get","RSSI":"query"}  -> signal, as a string
    //     {"MODULE":"radio","ACTION":"get","RDS":"query"}   -> 16 hex chars =
    //       ONE raw RDS group (4 blocks x 2 bytes); "0000000000000000" = no data
    //
    // android.os.Hardware is a ROM addition, not AOSP — so it is very likely
    // ABSENT from the hidden-API blocklist (which is generated from AOSP), and
    // the framework is loaded into every app process. That makes this plausibly
    // reachable by reflection from an ordinary app, which would give us the two
    // things the AIDL genuinely cannot: TRUE signal strength and raw RDS (hence
    // RadioText, which ArmRadioManager.getRtMessage() hardcodes to "").
    //
    // SETTLED ON DEVICE, 2026-07-30 21:23 — the JSON channel is NOT on this class.
    //
    // Run 1: getMethod("parseJson") threw NoSuchMethodException. That was an
    // inconclusive result, because getMethod only sees PUBLIC methods and the
    // vendor's own ReflectUtil.invokeStatic uses getDeclaredMethod +
    // setAccessible. Run 2 added the getDeclaredMethod fallback AND a dump of
    // every method the class declares. Both came back negative:
    //
    //   * getDeclaredMethod("parseJson", String) → NoSuchMethodException. That
    //     call searches the class's own declarations at every visibility, so
    //     parseJson is not declared on android.os.Hardware, private or otherwise.
    //   * getMethod also failed, so it is not public anywhere up the hierarchy
    //     either.
    //   * The dump listed 180 methods, none named parseJson or anything
    //     JSON-shaped. There is no String-in/String-out entry point at all
    //     besides setDSP_ak7604_status(String), which is an AK7604 DSP setter.
    //
    // That decompile pass is now DONE (2026-07-31) and it found the answer:
    // ReflectUtil.invokeStatic returns null (it logs "Can't find …") instead of
    // throwing when a method is absent, so getRadioIc() yields "", the
    // getRadioIc()=="SI47925" test in RadioService.onCreate fails, and this unit
    // never selects ArmRadioManager at all — it runs the Allwinner path. The JSON
    // channel belongs to the Si4792x variant; it was never ours to reach.
    //
    // The transport THIS unit uses is the vendor framework class
    // com.nwd.app.NwdFmManager, via com.nwd.radio.arm.allwinner.AWNative:
    //   getRadioRDSDataArm() -> String, raw RDS      getRadioRDSFunArm() -> 1 if supported
    //   getFreAndStrength()  -> hi16 = strength      getStationStereoState() -> real stereo
    // See docs/BUILTIN-TUNER-FINDINGS.md, "The REAL transport found". Repointing
    // this probe at NwdFmManager is the next step; until that runs, RSSI and raw
    // RDS stay unavailable. Do NOT re-add speculative parseJson calls.
    //
    // What the dump DID give us is a set of real, read-only radio getters, which
    // is what this probe now reads. They are the honest replacement for the
    // representative strings in the settings diagnostics.
    private val hardwareGetters = listOf(
        "isArmFmSupported",      // is the FM front-end the ARM/Si module path?
        "getRadioModuleArm",     // which radio module the MCU reports
        "getMcuType",
        "getAudioICState",
        "getCameraICType",       // String; names the board's IC family
        "getTouchScreenVersion", // String; a firmware fingerprint for the unit
    )

    /** Call a no-arg static getter on android.os.Hardware and format the result.
     *  Read-only by construction: only names from `hardwareGetters` are invoked,
     *  and every one of them is a getter. Nothing here changes tuner state. */
    private fun hardwareGet(name: String): String {
        val cls = Class.forName("android.os.Hardware")
        val m = try {
            cls.getMethod(name)
        } catch (_: NoSuchMethodException) {
            cls.getDeclaredMethod(name).apply { isAccessible = true }
        }
        return m.invoke(null)?.toString() ?: "(null)"
    }

    /** Read the radio-related getters the firmware actually exposes and report
     *  exactly what happened for each, success or failure. */
    @ReactMethod
    fun probeJsonHardware(promise: Promise) {
        val sb = StringBuilder("HARDWARE PROBE (android.os.Hardware getters)\n")
        // Confirm the negative result stays true on any unit this runs on, in one
        // line rather than the four identical ERR lines the old probe emitted.
        sb.append("  parseJson(String) present? = ")
        sb.append(
            try { Class.forName("android.os.Hardware").getDeclaredMethod("parseJson", String::class.java); "YES" }
            catch (e: Throwable) { "no (${e.javaClass.simpleName})" },
        ).append('\n')
        for (name in hardwareGetters) {
            sb.append("  ").append(name).append("() = ")
            try {
                sb.append(hardwareGet(name))
            } catch (e: Throwable) {
                // The exception TYPE is the diagnosis: ClassNotFoundException =
                // this ROM has no such class; NoSuchMethodException = absent on
                // this firmware; SecurityException / InvocationTargetException =
                // reachable but refused.
                sb.append("ERR ").append(e.javaClass.name).append(": ").append(e.message)
            }
            sb.append('\n')
        }
        promise.resolve(sb.toString())
    }

    @ReactMethod
    fun probe(promise: Promise) {
        val r = radio ?: run { promise.reject("nc", "not connected"); return }
        val sb = StringBuilder()
        fun line(k: String, v: () -> Any?) {
            sb.append("  ").append(k).append('=')
            try { sb.append(v()) } catch (e: Throwable) { sb.append("ERR(").append(e.javaClass.simpleName).append(')') }
            sb.append('\n')
        }
        // Ask the tuner for its band rather than printing our tracked copy: the
        // header is how a log reader knows WHICH bank the `presets` line below is
        // showing, since getPrefabFrequency() always returns the current band's.
        // On 31 July the header claimed band=0 while the body read band=1.
        val liveBand = try { r.getCurrentFrequency()?.band?.toString() ?: "?" } catch (_: Throwable) { "?" }
        sb.append("NWD PROBE (freqMult=$freqMult band=$liveBand tracked=$fmBand)\n")
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
            else arr.joinToString("; ", "[${arr.size}] ") { "lo=${it.lo} hi=${it.hi} step=${it.step}" }
        }
        line("presets") {
            val arr = r.getPrefabFrequency()
            if (arr == null) "null"
            else arr.joinToString(",", "[${arr.size}] ") { "${it.freq}/${it.psName ?: ""}" }
        }
        promise.resolve(sb.toString())
    }

    /** Claim / release the FM audio source. The tuner's audio is analog + MCU-routed,
     *  so producing sound means BECOMING the active source, and stopping it means the
     *  MCU actually LETTING GO — `setRadioBackServiceOn` alone does neither.
     *
     *  ON  → announce we're the FM source the way the probe proved works
     *        (ACTION_APP_IN_OUT app_id=8, operation=1 IN) → service InitFM/powerUp →
     *        MCU routes tuner audio (mcu_current_source→4); keep the back-service
     *        alive + unmute.
     *  OFF → switch the MCU source AWAY from Radio (ACTION_REQUEST_CHANGE_SOURCE
     *        extra_source_id=0). This is the ONLY thing that sticks: the probe
     *        (2026-07-26) proved EXIT_ARM_FM and app-OUT (operation=0) both left
     *        mcu_current_source=4 and the MCU re-powered FM a second later (the
     *        "comes back on" bug), while source→0 made the audio STAY off
     *        (music=false, src=0). Pressing power ON again re-claims via app-IN. */
    @ReactMethod
    fun setAudioEnabled(on: Boolean) {
        val audio = reactContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        if (on) {
            sendAppInOut(operation = 1)      // claim the FM source (proven trigger) → src 4
            try { radio?.setRadioBackServiceOn(true) } catch (e: Throwable) { Log.w(TAG, "backservice on failed", e) }
            audio?.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_UNMUTE, 0)
        } else {
            try { radio?.setRadioBackServiceOn(false) } catch (e: Throwable) { Log.w(TAG, "backservice off failed", e) }
            // Device-proven stop: move the active source off Radio (→0). The MCU then
            // releases FM and it stays silent; nothing else (exit / app-out) held.
            reactContext.sendBroadcast(
                Intent("com.nwd.action.ACTION_REQUEST_CHANGE_SOURCE").putExtra("extra_source_id", 0.toByte())
            )
        }
    }

    /** ACTION_APP_IN_OUT app_id=8 — the source claim/release the stock app uses and
     *  the probe validated. operation: 1 = app IN (claim), 0 = app OUT (release). */
    private fun sendAppInOut(operation: Int) {
        reactContext.sendBroadcast(
            Intent("com.nwd.action.ACTION_APP_IN_OUT")
                .putExtra("extra_app_id", 8)
                .putExtra("extra_app_operation", operation)
                .putExtra("extra_app_event", 0)
        )
    }

    /** The heavier physical source-switch broadcasts (like pressing "Radio" on the
     *  unit). Kept as a separate, opt-in call — NOT fired automatically. */
    @ReactMethod
    fun requestAudioSource() {
        reactContext.sendBroadcast(Intent("com.nwd.action.ACTION_REQUEST_CHANGE_SOURCE").putExtra("extra_source_id", 4.toByte()))
        reactContext.sendBroadcast(Intent("com.nwd.action.ACTION_CHANGE_SOURCE").putExtra("extra_source_id", 4.toByte()))
    }



    // ── Callbacks → JS events ──────────────────────────────────────────────────
    private val callback = object : RadioCallback.Stub() {
        override fun notifyState(s: Byte) = emit("NwdRadioState", Arguments.createMap().apply { putInt("state", s.toInt()) })
        override fun notifyCurrentFrequency(band: Byte, freq: Int, ps: String?, arg: Int) =
            emit("NwdRadioFrequency", Arguments.createMap().apply {
                // TRACK the band. It was captured once at connect and never updated,
                // yet tune() passes it to setCurrentFrequency on every tune — so the
                // moment the head unit was switched FM1 -> FM2 we carried on tuning
                // against the old band. The 31 July log caught exactly that: at
                // 07:28 the tuner reported band=0 with the user's own six presets,
                // and by 07:55 band=1 with the factory list, while our connect-time
                // value stayed 0 for the whole session. Each band has its OWN preset
                // bank, which is also what `arg` indexes into.
                fmBand = band
                putInt("band", band.toInt()); putInt("freq", freq)
                putDouble("mhz", freq.toDouble() / freqMult); putString("ps", ps ?: "")
                // `arg` = the tuner's preset-slot index in the CURRENT bank (1-6), or
                // -1 if the tuned freq isn't a preset there. NOT a signal level
                // (confirmed on-device + decompile: GetisPrefabFrequency).
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
