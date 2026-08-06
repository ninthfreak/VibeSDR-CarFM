package com.ninthfreak.carfm

import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.IntentFilter
import android.content.Intent
import android.content.ServiceConnection
import android.content.res.Configuration
import android.media.AudioManager
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
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
    @Volatile private var connectPromise: Promise? = null
    private val promiseLock = Any()
    /** Settle `connectPromise` exactly once, whoever gets there first — the bind
     *  callback arrives on the main thread while connect() runs on the bridge
     *  thread, and the watchdog below races both. */
    private fun settleConnect(block: (Promise) -> Unit) {
        val p = synchronized(promiseLock) { connectPromise.also { connectPromise = null } } ?: return
        block(p)
    }
    /** How long to wait for onServiceConnected before calling the bind dead. */
    private val connectTimeoutMs = 8000L
    private val mainHandler = Handler(Looper.getMainLooper())

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
        synchronized(promiseLock) { connectPromise = promise }
        try {
            val intent = Intent(bindAction).setPackage(servicePkg)
            val ok = reactContext.bindService(intent, conn, Context.BIND_AUTO_CREATE)
            if (!ok) {
                try { reactContext.unbindService(conn) } catch (_: Throwable) {}
                settleConnect { it.reject("bind", "bindService returned false — NWD radio service not found/bindable") }
            } else {
                bound = true
                startPanelKeyWatch()
                startIllWatch()
                // NOT startRdsPump() here: bindService is asynchronous, so at this
                // point `radio` is still null and setRDSState has not run. The pump
                // starts from onServiceConnected, once RDS has actually been enabled.
                //
                // WATCHDOG. A successful bindService only means the system accepted
                // the request; onServiceConnected is the event that matters, and if
                // the vendor service dies in onCreate or hands back a null binder it
                // never arrives. Nothing else settles this promise — disconnect()
                // does not touch it — so JS sat forever inside `await nwdConnect()`,
                // above every line that clears the tuner-error pill, leaving a dead
                // face with no way back short of killing the app. Reject instead, so
                // the caller's existing catch runs.
                mainHandler.postDelayed({
                    settleConnect {
                        Log.w(TAG, "connect timed out after ${connectTimeoutMs}ms — no onServiceConnected")
                        disconnect()
                        it.reject("bind", "NWD radio service bound but never connected (${connectTimeoutMs}ms)")
                    }
                }, connectTimeoutMs)
            }
        } catch (e: Throwable) {
            settleConnect { it.reject("bind", "bindService threw: ${e.message}", e) }
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

    // ── Illumination (headlights) → day/night ────────────────────────────────
    // Every other app on this unit switches to dark when the headlights go on,
    // CarFM does not. The face already follows useColorScheme(), so the question
    // is whether this ROM sets Android's uiMode night flag at all, or signals
    // day/night only through a vendor broadcast the way it does the wheel.
    //
    // Found in the vendor APKs: `com.nwd.ACTION_ILL_STATE_CHANGE` carrying
    // `extra_ill_state`. Same shape as the panel-key broadcast, so likely
    // unprotected and receivable.
    //
    // The extra's TYPE is unknown (byte / int / boolean), so this dumps the whole
    // bundle verbatim rather than guessing a getter and reading a silent default.
    // It also reports Android's uiMode night bits at the same instant, which is
    // the decisive comparison:
    //   ill fires AND uiMode flips  -> the ROM does set night mode; the bug is ours
    //   ill fires, uiMode unchanged -> vendor-only signal; CarFM must listen for it
    private var illReceiver: BroadcastReceiver? = null

    /** Android's night flag right now, as a readable string. */
    private fun uiModeNight(): String =
        when (reactContext.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) {
            Configuration.UI_MODE_NIGHT_YES -> "NIGHT"
            Configuration.UI_MODE_NIGHT_NO -> "DAY"
            else -> "UNDEFINED"
        }

    /** Register the illumination watch WITHOUT connecting the tuner.
     *
     *  Day/night is a property of the vehicle, not of which tuner is selected, but
     *  the only caller used to be connect() — which is gated on a tunerless launch
     *  — so an RTL-SDR session never registered the receiver at all and stayed
     *  light all night. JS calls this on mount for every backend. Idempotent. */
    @ReactMethod
    fun startIlluminationWatch() = startIllWatch()

    private fun startIllWatch() {
        if (illReceiver != null) return
        val r = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, i: Intent?) {
                val extras = i?.extras
                val dump = extras?.keySet()?.joinToString(", ") { k ->
                    "$k=${extras.get(k)} (${extras.get(k)?.javaClass?.simpleName ?: "null"})"
                } ?: "(no extras)"
                Log.i(TAG, "ILL ${i?.action} $dump uiMode=${uiModeNight()}")
                emit("NwdIllState", Arguments.createMap().apply {
                    putString("action", i?.action ?: "")
                    putString("extras", dump)
                    putString("uiMode", uiModeNight())
                })
            }
        }
        val f = IntentFilter().apply { addAction("com.nwd.ACTION_ILL_STATE_CHANGE") }
        try {
            if (android.os.Build.VERSION.SDK_INT >= 33) {
                reactContext.registerReceiver(r, f, Context.RECEIVER_EXPORTED)
            } else {
                @Suppress("UnspecifiedRegisterReceiverFlag") reactContext.registerReceiver(r, f)
            }
            illReceiver = r
            Log.i(TAG, "ill watch registered; uiMode=${uiModeNight()}")
        } catch (e: Throwable) { Log.w(TAG, "ill watch failed", e) }
    }

    private fun stopIllWatch() {
        illReceiver?.let { try { reactContext.unregisterReceiver(it) } catch (_: Throwable) {} }
        illReceiver = null
    }

    // ── Raw RDS pump ─────────────────────────────────────────────────────────
    // getRadioRDSDataArm() returns ONE already-synchronised RDS group as 16 hex
    // chars (4 blocks x 2 bytes). "Nothing this poll" comes back as all zeros OR
    // as a Java null — both observed on device, so both are skipped. This is the
    // data the bound AIDL never exposes — the reason RadioText is reachable on
    // this unit at all. Confirmed live 2026-08-01: real groups spelling a
    // station's PS and RadioText.
    //
    // RDS runs at ~11.4 groups/sec, so ~87ms per group. Polling at 90ms keeps up
    // without spinning. Consecutive identical reads are dropped: the same group
    // is returned repeatedly between refreshes, and the JS decoder is idempotent
    // for repeats anyway, so this is pure bridge-traffic saving.
    private val rdsPollMs = 90L
    private val zeroGroup = "0000000000000000"
    // Arming budget: 240 x 250ms = 60s. The gate below reads a hardware capability
    // flag, so this only has to outlast the vendor stack coming up — it is not
    // waiting on a station. Bounded so a unit without the transport at all doesn't
    // keep a thread alive forever.
    private val rdsArmAttempts = 240
    private val rdsArmRetryMs = 250L
    @Volatile private var rdsPumpRunning = false
    private var rdsThread: Thread? = null

    private fun startRdsPump() {
        if (rdsThread != null) return
        rdsPumpRunning = true
        val t = Thread {
            // The support check runs INSIDE the thread, with retries, and asks
            // only whether the HARDWARE has RDS — never whether a station is
            // sending it.
            //
            // It used to be a one-shot gate evaluated by the caller. connect()
            // called this straight after bindService(), which is asynchronous — so
            // the gate ran before `radio` existed, before setRDSState, and before
            // JS claimed the FM source. Launch CarFM while the head unit is on
            // Bluetooth and the gate read a cold front end, latched
            // supported=false, and nothing ever re-armed it: no RadioText for the
            // whole session, on the only path that can produce it.
            //
            // The gate also demanded a 16-char getRadioRDSDataArm() read, which is
            // a property of the STATION, not the tuner. Proved on 2026-08-03: the
            // probe taken on 102.1 — a channel that produced no group at all in
            // either visit — read (null) eight times out of eight while
            // getRadioRDSFunArm() still read 1, exactly as it did in the four
            // probes on stations that were sending. Sitting on a quiet channel
            // past the retry budget would therefore have killed RadioText for the
            // session. So the flag alone arms the pump; a null data read is just a
            // poll with nothing in it.
            var armed = false
            var attempts = 0
            var last = ""
            while (rdsPumpRunning) {
                if (!armed) {
                    val ok = try {
                        (nwdFmGet("getRadioRDSFunArm") as? Int) == 1
                    } catch (_: Throwable) { false }
                    if (ok) {
                        armed = true
                        Log.i(TAG, "RDS pump armed after $attempts attempt(s)")
                    } else if (++attempts >= rdsArmAttempts) {
                        Log.i(TAG, "RDS pump giving up: transport unavailable after $attempts attempts")
                        break
                    } else {
                        try { Thread.sleep(rdsArmRetryMs) } catch (_: InterruptedException) { break }
                        continue
                    }
                }
                val hex = try { nwdFmGet("getRadioRDSDataArm")?.toString() ?: "" } catch (_: Throwable) { "" }
                if (hex.length == 16 && hex != zeroGroup && hex != last) {
                    last = hex
                    emit("NwdRdsGroup", Arguments.createMap().apply { putString("hex", hex) })
                }
                try { Thread.sleep(rdsPollMs) } catch (_: InterruptedException) { break }
            }
        }
        t.isDaemon = true
        t.name = "nwd-rds-pump"
        t.start()
        rdsThread = t
        Log.i(TAG, "RDS pump thread started (${rdsPollMs}ms)")
    }

    private fun stopRdsPump() {
        rdsPumpRunning = false
        rdsThread?.interrupt()
        rdsThread = null
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
        mainHandler.removeCallbacksAndMessages(null)   // cancel the connect watchdog
        // A disconnect while a connect is still in flight must not leave the caller
        // awaiting a promise that now has nothing left to settle it.
        settleConnect { it.reject("bind", "disconnected before the NWD radio service connected") }
        stopPanelKeyWatch()
        stopIllWatch()
        stopRdsPump()
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
            // Only now is the raw-group transport worth polling: the service is
            // live and RDS has been switched on.
            startRdsPump()
            settleConnect { it.resolve(currentStateMap()) }
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            radio = null
            // The pump reads through NwdFmManager, not the binder, so it would keep
            // polling a dead front end. Stop it; a re-bind re-arms from scratch.
            stopRdsPump()
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
            // Whether FM audio is ACTUALLY playing. Android audio focus cannot
            // answer this on a head unit: the audio is analog and MCU-routed, and
            // after a permanent AUDIOFOCUS_LOSS the OS never sends a GAIN — so a
            // focus-driven state can go dark and never come back when the MCU
            // hands FM over to Android Auto and later takes it back. The MCU's own
            // source register is the truth and it self-heals. 4 = FM; -1 = unknown.
            map.putInt("source", try {
                Settings.System.getString(reactContext.contentResolver, "mcu_current_source")?.toIntOrNull() ?: -1
            } catch (_: Throwable) { -1 })
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
    // See docs/BUILTIN-TUNER-FINDINGS.md, "The REAL transport found".
    //
    // The probe that read that channel, and the getter list it walked, are GONE —
    // task #43 closed the question and the answer was "absent", so it could only
    // ever report "not there". Do NOT re-add speculative parseJson calls.
    /** One RDS read almost always returns the all-zero "no data this poll"
     *  sentinel, which reads like a failure. Burst it so a real group has a
     *  chance to land. */
    private val rdsBurstReads = 8
    private val rdsBurstGapMs = 120L

    /** Invoke a no-arg static getter on the vendor framework class. Read-only by
     *  construction: only names from `nwdFmGetters` reach this. */
    private fun nwdFmGet(name: String): Any? {
        val cls = Class.forName(nwdFmManagerClass)
        val m = try {
            cls.getMethod(name)
        } catch (_: NoSuchMethodException) {
            cls.getDeclaredMethod(name).apply { isAccessible = true }
        }
        return m.invoke(null)
    }

    // DELETED: nwdFmGetInt(name, arg).
    //
    // It existed for getRadioRDSStrengthArm(int) and carried the comment "Still a
    // getter: nothing here commands the tuner". That was wrong and it cost the
    // audio — sweeping arguments 0..3 cut the sound instantly and returned 63
    // (0x3F, all ones) for every one of them. The 2026-08-03 decompile then found
    // that method has NO callers anywhere in the vendor service, so there is no
    // usage model to copy and nothing to retry against.
    //
    // Left absent deliberately: an int-arg reflection helper on this class is an
    // invitation to call the next plausible-looking method the same way. The
    // strength path that IS evidenced is NwdFmManager.seek(rawFrequency), which
    // is a command and belongs behind a manual, stationary test — not behind a
    // helper named "get".

    // ── The signal-level experiment (task #58) ───────────────────────────────
    //
    // DELIBERATELY NOT PART OF probe(). probe() is fired automatically by
    // scheduleProbe() a few seconds after every retune while diagnostics are on,
    // and everything in it is a passive read. This is a COMMAND. Putting it there
    // would run it unattended on every tune, which is precisely how the audio was
    // cut on 2026-08-01.
    //
    // WHAT IT DOES, and why this argument and no other. From the service
    // decompile of 2026-08-03:
    //
    //   AWNative.seek(int frequency) {
    //       int packed   = NwdFmManager.seek(frequency);
    //       int strength = getFreAndStrength(packed, 1);   // high 4 hex digits
    //       int freq     = getFreAndStrength(packed, 0);   // low  4 hex digits
    //       return (freq == frequency) ? strength : 0;     // 0 = it moved, distrust
    //   }
    //
    // and NewRdsManager.getOtherGoodStation() — the alternative-frequency
    // follower — ends by calling AWNative.seek(mCurrentFrequency.getFrequency())
    // to return to where it started. So the vendor itself calls seek with the
    // frequency it is ALREADY ON, as a no-op restore, and the equality check
    // exists to confirm the tuner stayed put. That is the call this makes: one
    // invocation, at the current raw frequency, per press.
    //
    // It is still a command. It may mute briefly even when it works, and it could
    // behave like getRadioRDSStrengthArm did. Hence: manual, single-shot,
    // stationary, with someone listening.
    private val nwdFmSeek = "seek"

    /** One seek, serialized. The periodic watch and the manual test both come
     *  through here, so two of them can never command the tuner at once. */
    private val seekLock = Any()

    private data class SeekResult(val asked: Int, val strength: Int, val landed: Int, val err: String?)

    /** Ask the tuner for its level at the frequency it is ALREADY ON.
     *
     *  Reads the frequency live from the binder every time — never from cached
     *  state, because a stale number would turn this into a real retune, which is
     *  the one thing it must not be. */
    private fun seekHere(): SeekResult = synchronized(seekLock) {
        val r = radio ?: return SeekResult(0, 0, 0, "not connected")
        val asked = try {
            r.getCurrentFrequency()?.freq ?: return SeekResult(0, 0, 0, "getCurrentFrequency returned null")
        } catch (e: Throwable) {
            return SeekResult(0, 0, 0, "getCurrentFrequency threw ${e.javaClass.simpleName}")
        }
        if (asked <= 0) return SeekResult(asked, 0, 0, "current frequency reads $asked")
        val packed = try {
            val cls = Class.forName(nwdFmManagerClass)
            val m = try {
                cls.getMethod(nwdFmSeek, Int::class.javaPrimitiveType)
            } catch (_: NoSuchMethodException) {
                cls.getDeclaredMethod(nwdFmSeek, Int::class.javaPrimitiveType).apply { isAccessible = true }
            }
            m.invoke(null, asked)
        } catch (e: Throwable) {
            val cause = (e as? java.lang.reflect.InvocationTargetException)?.cause ?: e
            return SeekResult(asked, 0, 0, "seek threw ${cause.javaClass.name}: ${cause.message}")
        }
        if (packed !is Int) return SeekResult(asked, 0, 0, "seek returned ${packed?.javaClass?.name ?: "null"}, not Int")
        SeekResult(asked, (packed ushr 16) and 0xFFFF, packed and 0xFFFF, null)
    }

    // ── Periodic level watch ─────────────────────────────────────────────────
    // UNDER DEVELOPMENT (2026-08-04). Every tick COMMANDS the tuner, so:
    //   - its own thread, never the bridge, which the 1.5s poll already uses;
    //   - it stops the moment FM is not the MCU's current source, so it can
    //     never retune a front end that something else is using;
    //   - the interval comes from JS (LEVEL_POLL_MS) so there is one place to
    //     slow it down or turn it off.
    // The vendor rate-limits its own comparable read to 900ms
    // (ArmRadioManager.clearVaildFlag); this runs far below that.
    @Volatile private var levelRunning = false
    private var levelThread: Thread? = null
    /** Restart guard. Debug mode changes the cadence mid-drive, so start/stop is
     *  now routine — and a bare boolean flag races there: stopLevelWatch() sets it
     *  false, startLevelWatch() sets it true again, and if the outgoing thread has
     *  not re-checked in between it simply carries on, leaving two threads reading
     *  the tuner. Each thread captures a generation and exits when it is no longer
     *  the current one. */
    @Volatile private var levelGen = 0

    private fun emitLevel(s: SeekResult) {
        emit("NwdRadioLevel", Arguments.createMap().apply {
            putInt("level", s.strength)
            putInt("asked", s.asked)
            putInt("landed", s.landed)
            putBoolean("ok", s.err == null && s.asked > 0 && s.asked == s.landed)
            if (s.err != null) putString("err", s.err)
        })
    }

    @ReactMethod
    fun startLevelWatch(intervalMs: Double) {
        stopLevelWatch()          // idempotent, and the only way to change cadence
        val myGen = ++levelGen
        levelRunning = true
        val gap = intervalMs.toLong().coerceAtLeast(5_000L)   // floor: never hammer the chip
        val t = Thread {
            while (levelRunning && levelGen == myGen) {
                // Only when the MCU says FM owns the speakers. Commanding the
                // tuner while Bluetooth or Android Auto is playing would move a
                // front end nobody asked us to touch.
                val src = try {
                    Settings.System.getString(reactContext.contentResolver, "mcu_current_source")?.toIntOrNull() ?: -1
                } catch (_: Throwable) { -1 }
                if (src == 4) emitLevel(seekHere())
                try { Thread.sleep(gap) } catch (_: InterruptedException) { break }
            }
        }
        t.isDaemon = true
        t.name = "nwd-level-watch"
        t.start()
        levelThread = t
        Log.i(TAG, "level watch started (${gap}ms)")
    }

    @ReactMethod
    fun stopLevelWatch() {
        levelRunning = false
        levelGen++                // retires whatever thread is currently running
        levelThread?.interrupt()
        levelThread = null
    }

    /** One reading now, off the bridge thread — used on retune so the meter does
     *  not sit on the previous station's level until the next tick. */
    @ReactMethod
    fun readLevelNow() {
        Thread { emitLevel(seekHere()) }.apply { isDaemon = true }.start()
    }

    // seekStrengthTest lived here and is GONE. It existed to prove seek() was safe
    // to call after an earlier method cut the audio; twenty presses and two drives
    // answered that, and startLevelWatch now makes the same seekHere() call every
    // 30 seconds unattended. seekHere itself stays — it is the shipping read.
    /** Read an MCU settings key, trying each table in turn. Read-only. */
    private fun settingsRead(key: String): String {
        val cr = reactContext.contentResolver
        try { Settings.System.getString(cr, key)?.let { return "$it (system)" } } catch (_: Throwable) {}
        try { Settings.Global.getString(cr, key)?.let { return "$it (global)" } } catch (_: Throwable) {}
        try { Settings.Secure.getString(cr, key)?.let { return "$it (secure)" } } catch (_: Throwable) {}
        return "(not present in system/global/secure)"
    }

    /** Probe com.nwd.app.NwdFmManager for signal, raw RDS and a real stereo read,
     *  plus the two MCU settings that gate RDS. Reports the verbatim value or the
     *  exact exception type for every call. Read-only throughout. */
    @ReactMethod
    fun probeNwdFmManager(promise: Promise) {
        val sb = StringBuilder("NWDFMMANAGER PROBE ($nwdFmManagerClass)\n")
        // The decisive line. If the CLASS does not resolve, nothing below can and
        // this transport is out of reach for an unprivileged app — same shape of
        // answer the android.os.Hardware probe gave, one level earlier.
        var cls: Class<*>? = null
        sb.append("  class resolves? = ")
        try {
            cls = Class.forName(nwdFmManagerClass)
            sb.append("YES (").append(cls.declaredMethods.size).append(" declared methods)")
        } catch (e: Throwable) {
            sb.append("NO — ").append(e.javaClass.name).append(": ").append(e.message)
        }
        sb.append('\n')

        if (cls == null) {
            sb.append("  (class absent — skipping the getters; the transport is not reachable here)\n")
            promise.resolve(sb.toString())
            return
        }

        // Every method name on the class. We call nine; the class declares ~53, and
        // the ones we never tried are the only place a real signal level could
        // still be hiding — readRssi() is native-only and getCurrentFrequency()
        // returned 0, killing the strength-packed-in-the-high-16-bits route. Names
        // only: this lists the surface, it does not invoke anything.
        sb.append("  declared methods:\n")
        cls.declaredMethods
            .map { m -> "${m.name}(${m.parameterTypes.joinToString(",") { it.simpleName }}):${m.returnType.simpleName}" }
            .sorted()
            .forEach { sb.append("      ").append(it).append('\n') }

        for ((name, note) in nwdFmGetters) {
            sb.append("  ").append(name).append("() = ")
            try {
                sb.append(nwdFmGet(name)?.toString() ?: "(null)")
            } catch (e: Throwable) {
                // The exception TYPE is the diagnosis: NoSuchMethodException =
                // different signature on this firmware; SecurityException /
                // InvocationTargetException = reachable but refused.
                sb.append("ERR ").append(e.javaClass.name).append(": ").append(e.message)
            }
            sb.append("   // ").append(note).append('\n')
        }

        // AWNative.getFreAndStrength formats this as %08x and splits it: the low 4
        // hex digits are the frequency, the high 4 are signal strength. Show both
        // readings of whatever came back rather than guessing which it is.
        try {
            val raw = nwdFmGet("getCurrentFrequency")
            if (raw is Int) {
                sb.append("  getCurrentFrequency unpacked: freq=").append(raw and 0xFFFF)
                    .append(" strength=").append((raw ushr 16) and 0xFFFF)
                    .append("   // per AWNative.getFreAndStrength\n")
            }
        } catch (_: Throwable) {}

        // getRadioRDSStrengthArm(int) IS NOT CALLED HERE, DELIBERATELY.
        //
        // It was, once, swept over args 0..3 on the assumption that a method named
        // "get" reads rather than commands. On device (2026-08-01 16:13) that
        // sweep KILLED THE AUDIO instantly, and every getRadioRDSDataArm() call
        // after it returned null for the rest of the probe — the same call had
        // worked moments earlier in the same run. It returned 63 for all four
        // args, which now reads as an error sentinel rather than a level.
        //
        // The likely explanation matches AWNative.seek: on this chip a level is
        // MEASURED AT A FREQUENCY, so the argument is probably a raw frequency and
        // calling it with 0..3 tuned the front end to nonsense. If so it belongs
        // with seek() as a command, not a getter.
        //
        // LESSON, and it applies to every unexplored vendor method: "get" in this
        // API does not mean read-only. Nothing new gets called from this probe
        // without a reason to believe it is safe. See task #58 for the controlled
        // experiment — one call, current frequency, stationary, listening.

        sb.append("  getRadioRDSDataArm() x").append(rdsBurstReads).append(":\n")
        val seen = LinkedHashMap<String, Int>()
        repeat(rdsBurstReads) {
            val v = try {
                nwdFmGet("getRadioRDSDataArm")?.toString() ?: "(null)"
            } catch (e: Throwable) {
                "ERR ${e.javaClass.simpleName}"
            }
            seen[v] = (seen[v] ?: 0) + 1
            try { Thread.sleep(rdsBurstGapMs) } catch (_: InterruptedException) {}
        }
        for ((v, n) in seen) sb.append("      ").append(v).append("  x").append(n).append('\n')
        sb.append("      (all-zero = no group that poll; anything else = LIVE RAW RDS)\n")

        // NewRdsManager.updateRdsState enables RDS only when the area is 0 or 5.
        // That gate is in the service's Java layer, so reading the data directly
        // bypasses it — but if the area is wrong the MCU may not emit groups either,
        // which is exactly what the burst above settles.
        sb.append("  mcu_radio_area_current = ").append(settingsRead("mcu_radio_area_current"))
            .append("   // NewRdsManager needs 0 or 5\n")
        sb.append("  mcu_current_source     = ").append(settingsRead("mcu_current_source"))
            .append("   // 4 = FM\n")

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

    // requestAudioSource lived here and is GONE. It broadcast ACTION_CHANGE_SOURCE
    // with source id 4 (FM) to test whether becoming the MCU's radio source woke
    // audio and callbacks; task #14 answered that. Removed rather than left as a
    // dormant button because pressing it now works against the user: declaring FM
    // as the current source is exactly what the firmware's last-source restore
    // acts on when the ignition returns.



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
                // RE-DERIVE THE SCALE TOO. It was calibrated once at connect from
                // whatever the head unit happened to be tuned to, and never again —
                // while sitting two lines above the putDouble that consumes it. Last
                // on AM: freq=1000 -> the >500 arm gives freqMult=10, so FM then
                // reads "1059.0" MHz and tune(102.5) sends 1025, outside the
                // 8750..10790 plan. The dial spins and the radio does not move, for
                // the rest of the session. The band fix above already learned this
                // lesson; the scale was left behind.
                //
                // Only widen, never narrow: an AM reading must not undo an FM one.
                // 8750..10790 (FM, x100) and 87500..107900 (x1000) both exceed any
                // AM raw value, so taking the maximum settles on the FM scale and
                // stays there.
                val m = if (freq > 50000) 1000 else if (freq > 5000) 100 else if (freq > 500) 10 else 1
                if (m > freqMult) freqMult = m
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
