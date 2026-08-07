package com.ninthfreak.carfm

import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * JS bridge — exposed as "VibePowerModule" to mirror the iOS module, so
 * AudioPlayer/SDRScreen drive ONE API on both platforms. The engine itself
 * lives in VibeStreamService (foreground service keeps audio alive in the
 * background); startAudioEngine goes via startForegroundService, everything
 * else through the running service instance.
 */
class VibeStreamModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    init {
        VibeStreamService.reactContext = reactContext
    }

    override fun getName() = "VibePowerModule"

    @ReactMethod
    fun startAudioEngine(baseUrl: String, frequency: Double, mode: String, uuid: String, password: String) {
        VibeStreamService.reactContext = reactContext
        val intent = Intent(reactContext, VibeStreamService::class.java).apply {
            action = VibeStreamService.ACTION_START
            putExtra(VibeStreamService.EXTRA_BASE_URL, baseUrl)
            putExtra(VibeStreamService.EXTRA_FREQUENCY, frequency.toLong())
            putExtra(VibeStreamService.EXTRA_MODE, mode)
            putExtra(VibeStreamService.EXTRA_UUID, uuid)
            putExtra(VibeStreamService.EXTRA_PASSWORD, password)
        }
        // If the service is already running (the reconnect case: AudioPlayer does
        // stopAudioEngine then startAudioEngine on a fresh session uuid), use
        // startService so this START stays FIFO-ordered with stopAudioEngine's
        // startService(ACTION_STOP). startForegroundService uses a different,
        // prioritised queue, so the START jumped ahead of the STOP and the STOP
        // then killed the just-started engine → frozen "go back to instances" state.
        if (VibeStreamService.instance != null) {
            reactContext.startService(intent)
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            reactContext.startForegroundService(intent)
        } else {
            reactContext.startService(intent)
        }
    }

    @ReactMethod
    fun stopAudioEngine() {
        reactContext.startService(
            Intent(reactContext, VibeStreamService::class.java).apply {
                action = VibeStreamService.ACTION_STOP
            }
        )
    }

    // External PCM audio (OWRX/Kiwi): start the foreground service in external
    // mode; pushExternalPcm/stopExternalAudio go straight to the live instance.
    @ReactMethod
    fun startExternalAudio(sampleRate: Double, pauseMode: String = "release") {
        VibeStreamService.reactContext = reactContext
        val intent = Intent(reactContext, VibeStreamService::class.java).apply {
            action = VibeStreamService.ACTION_START_EXTERNAL
            putExtra(VibeStreamService.EXTRA_RATE, sampleRate.toInt())
            putExtra(VibeStreamService.EXTRA_PAUSE_MODE, pauseMode)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) reactContext.startForegroundService(intent)
        else reactContext.startService(intent)
    }

    @ReactMethod
    fun pushExternalPcm(base64: String, sampleRate: Double, channels: Double) {
        VibeStreamService.instance?.pushExternalPcm(base64, sampleRate.toInt(), channels.toInt())
    }

    @ReactMethod
    fun stopExternalAudio() { VibeStreamService.instance?.stopExternalAudio() }

    // Exclude a full-width horizontal band (the VFO/zoom drums) from the system
    // back-edge swipe so a horizontal drag on a drum doesn't trigger the (useless,
    // in-app-handled) Android back gesture — which animated and blocked the drum
    // until it released. top/height are in dp; height<=0 clears the exclusion.
    @ReactMethod
    fun setSwipeExclusion(topDp: Double, heightDp: Double) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        val act = reactContext.currentActivity ?: return
        act.runOnUiThread {
            try {
                val dm = act.resources.displayMetrics
                val root = act.window.decorView
                if (heightDp <= 0) {
                    root.systemGestureExclusionRects = emptyList()
                } else {
                    val top = (topDp * dm.density).toInt()
                    val h = (heightDp * dm.density).toInt()
                    root.systemGestureExclusionRects =
                        listOf(android.graphics.Rect(0, top, dm.widthPixels, top + h))
                }
            } catch (_: Throwable) {}
        }
    }

    // Local hardware (V4): the foreground service reads the on-device shim's
    // /ws/audio natively (background-safe), so JS no longer pushes PCM. JS just
    // starts/stops it and forwards tune changes over the same WS.
    @ReactMethod
    fun startLocalAudio(host: String, port: Double, initialTune: String, authSuffix: String) {
        VibeStreamService.reactContext = reactContext
        val intent = Intent(reactContext, VibeStreamService::class.java).apply {
            action = VibeStreamService.ACTION_START_LOCAL
            putExtra(VibeStreamService.EXTRA_HOST, host)
            putExtra(VibeStreamService.EXTRA_PORT, port.toInt())
            putExtra(VibeStreamService.EXTRA_TUNE, initialTune)
            putExtra(VibeStreamService.EXTRA_AUTH, authSuffix)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) reactContext.startForegroundService(intent)
        else reactContext.startService(intent)
    }

    @ReactMethod
    fun sendLocalTune(json: String) { VibeStreamService.instance?.sendLocalTune(json) }

    @ReactMethod
    fun stopLocalAudio() { VibeStreamService.instance?.stopLocalAudio() }

    // FM-DX Webserver (v7): the shared tuner's MP3-over-WS audio, consumed +
    // decoded natively (background-safe). JS owns only the /text + /chat sockets.
    @ReactMethod
    fun startFmdxAudio(baseUrl: String) {
        VibeStreamService.reactContext = reactContext
        val intent = Intent(reactContext, VibeStreamService::class.java).apply {
            action = VibeStreamService.ACTION_START_FMDX
            putExtra(VibeStreamService.EXTRA_BASE_URL, baseUrl)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) reactContext.startForegroundService(intent)
        else reactContext.startService(intent)
    }

    @ReactMethod
    fun stopFmdxAudio() { VibeStreamService.instance?.stopFmdxAudio() }

    // Built-in NWD/NOWADA FM: hold a media-buttons-only MediaSession so the
    // steering-wheel ⏮⏭ keys drive CarFM's preset list (see the service). No
    // audio is produced here — the MCU routes the analog FM audio itself.
    @ReactMethod
    fun startNwdControl() {
        VibeStreamService.reactContext = reactContext
        val intent = Intent(reactContext, VibeStreamService::class.java).apply {
            action = VibeStreamService.ACTION_START_NWD_CONTROL
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) reactContext.startForegroundService(intent)
        else reactContext.startService(intent)
    }

    /** "ctl=on focus=yes session=active" — or "unavailable" when the service isn't
     *  running at all (which itself tells us the control session never started). */
    @ReactMethod
    fun getNwdControlState(promise: com.facebook.react.bridge.Promise) {
        promise.resolve(VibeStreamService.instance?.nwdControlState() ?: "unavailable (service not running)")
    }

    @ReactMethod
    fun stopNwdControl() {
        reactContext.startService(
            Intent(reactContext, VibeStreamService::class.java).apply {
                action = VibeStreamService.ACTION_STOP_NWD_CONTROL
            })
    }

    @ReactMethod
    fun revive() { VibeStreamService.instance?.revive() }

    @ReactMethod
    fun sendTuneCommand(frequency: Double, mode: String) {
        VibeStreamService.instance?.sendTuneCommand(frequency.toLong(), mode)
    }

    @ReactMethod
    fun sendBandwidth(low: Double, high: Double) {
        VibeStreamService.instance?.sendBandwidth(low.toLong(), high.toLong())
    }

    @ReactMethod
    fun setStep(hz: Double) { VibeStreamService.instance?.setStep(hz.toLong()) }

    @ReactMethod
    fun setInstanceName(name: String) {
        VibeStreamService.instance?.setInstanceNameNative(name)
    }

    @ReactMethod
    fun setMuted(muted: Boolean) { VibeStreamService.instance?.setMutedNative(muted) }

    @ReactMethod
    fun setVolume(volume: Double) {
        VibeStreamService.instance?.setVolumeNative(volume.toFloat())
    }

    /** Server-NR / squelch / gate commands ride the audio WS (iOS parity). */
    @ReactMethod
    fun sendAudioCommand(json: String) {
        VibeStreamService.instance?.sendRawCommand(json)
    }

    @ReactMethod
    fun setNowPlaying(title: String, artist: String) {
        VibeStreamService.instance?.setNowPlayingNative(title, artist)
    }

    @ReactMethod
    fun setArtwork(serverType: String) {
        VibeStreamService.instance?.setArtworkNative(serverType)
    }

    // CarFM: frequency -> MediaMetadata ALBUM (spec §5b). Empty = "VibeSDR".
    @ReactMethod
    fun setNowPlayingAlbum(album: String) {
        VibeStreamService.instance?.setNowPlayingAlbumNative(album)
    }

    @ReactMethod
    fun setMediaSkipMode(mode: String) {
        VibeStreamService.instance?.skipMode = mode
    }

    /** Car browse tree payload (bookmarks + band plan) for Android Auto. */
    @ReactMethod
    fun setBrowseItems(json: String) {
        VibeStreamService.instance?.setBrowseItemsNative(json)
    }

    /** Reconnect attempt failed (server full / rate-limited) — show "open app". */
    @ReactMethod
    fun setReconnectFailed(failed: Boolean) {
        VibeStreamService.instance?.setReconnectFailedNative(failed)
    }

    /**
     * A position good enough to correlate against radio reception.
     *
     * `getLocation()` below is not broken — the nearby-station search works on the
     * road — but it reads only getLastKnownLocation(), never requests a live fix,
     * and returns lat/lon alone. Debug mode needs accuracy, speed, bearing and
     * above all the AGE of the fix: a last-known position minutes old makes
     * distance and bearing to a transmitter into fiction while the car keeps
     * moving, and speed is what separates "bad spot" from "bad while moving".
     *
     * So: ask the providers for a LIVE update, wait up to `timeoutMs`, and fall
     * back to the freshest last-known if nothing arrives. Resolves null only when
     * there is genuinely nothing. Never rejects.
     */
    @ReactMethod
    fun getLocationDetailed(timeoutMs: Double, promise: Promise) {
        val lm = try {
            reactContext.getSystemService(android.content.Context.LOCATION_SERVICE)
                as android.location.LocationManager
        } catch (e: Throwable) { promise.resolve(null); return }

        fun toMap(l: android.location.Location, live: Boolean): com.facebook.react.bridge.WritableMap =
            com.facebook.react.bridge.Arguments.createMap().apply {
                putDouble("lat", l.latitude)
                putDouble("lon", l.longitude)
                if (l.hasAccuracy()) putDouble("accM", l.accuracy.toDouble())
                if (l.hasSpeed()) putDouble("speedMs", l.speed.toDouble())
                // Bearing is only meaningful while moving; a parked fix reports 0.
                if (l.hasBearing() && l.hasSpeed() && l.speed > 0.5f) putDouble("headingDeg", l.bearing.toDouble())
                if (l.hasAltitude()) putDouble("altM", l.altitude)
                putString("provider", l.provider ?: "?")
                putDouble("fixAgeS", ((System.currentTimeMillis() - l.time).coerceAtLeast(0L)) / 1000.0)
                putBoolean("live", live)
            }

        fun freshestLastKnown(): android.location.Location? {
            var best: android.location.Location? = null
            for (p in lm.getProviders(true)) {
                try {
                    val l = lm.getLastKnownLocation(p) ?: continue
                    if (best == null || l.time > best!!.time) best = l
                } catch (_: SecurityException) { }
            }
            return best
        }

        val settled = java.util.concurrent.atomic.AtomicBoolean(false)
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        var listener: android.location.LocationListener? = null

        val finish = { loc: android.location.Location?, live: Boolean ->
            if (settled.compareAndSet(false, true)) {
                listener?.let { try { lm.removeUpdates(it) } catch (_: Throwable) {} }
                promise.resolve(if (loc == null) null else toMap(loc, live))
            }
        }

        listener = object : android.location.LocationListener {
            override fun onLocationChanged(l: android.location.Location) { finish(l, true) }
            @Deprecated("required by the interface on older API levels")
            override fun onStatusChanged(p: String?, s: Int, e: android.os.Bundle?) {}
            override fun onProviderEnabled(p: String) {}
            override fun onProviderDisabled(p: String) {}
        }

        var requested = false
        for (p in lm.getProviders(true)) {
            try {
                lm.requestLocationUpdates(p, 0L, 0f, listener, android.os.Looper.getMainLooper())
                requested = true
            } catch (_: SecurityException) {
                // Permission not granted — last-known is all we will ever get.
            } catch (_: Throwable) { }
        }

        // Whatever happens, answer. A live fix wins; otherwise the freshest cached
        // one, tagged live=false and carrying its age so the caller can judge it.
        handler.postDelayed({ finish(freshestLastKnown(), false) },
            timeoutMs.toLong().coerceIn(1_000L, 30_000L))
        if (!requested) finish(freshestLastKnown(), false)
    }

    /** One-shot coarse location for nearest-first instance sorting. JS must
     *  request ACCESS_COARSE_LOCATION via PermissionsAndroid first. */
    @ReactMethod
    fun getLocation(promise: Promise) {
        try {
            val lm = reactContext.getSystemService(android.content.Context.LOCATION_SERVICE)
                as android.location.LocationManager
            var best: android.location.Location? = null
            for (p in lm.getProviders(true)) {
                try {
                    val l = lm.getLastKnownLocation(p) ?: continue
                    if (best == null || l.time > best!!.time) best = l
                } catch (_: SecurityException) { /* not granted */ }
            }
            val b = best
            if (b != null) {
                val map = com.facebook.react.bridge.Arguments.createMap()
                map.putDouble("lat", b.latitude)
                map.putDouble("lon", b.longitude)
                promise.resolve(map)
            } else {
                promise.resolve(null)
            }
        } catch (e: Exception) {
            promise.resolve(null)
        }
    }

    /** Whether this device actually has a vibrator/haptic motor. Some Android
     *  tablets have none, so JS hides the HAPTICS toggle when this is false. */
    @ReactMethod
    fun hasVibrator(promise: Promise) {
        try {
            val has = if (android.os.Build.VERSION.SDK_INT >= 31) {
                val vm = reactContext.getSystemService(android.content.Context.VIBRATOR_MANAGER_SERVICE)
                    as android.os.VibratorManager
                vm.defaultVibrator.hasVibrator()
            } else {
                @Suppress("DEPRECATION")
                val v = reactContext.getSystemService(android.content.Context.VIBRATOR_SERVICE)
                    as android.os.Vibrator
                v.hasVibrator()
            }
            promise.resolve(has)
        } catch (e: Exception) {
            promise.resolve(true) // assume present on error — safer than hiding a working toggle
        }
    }

    // Client NR/NR2/NB — VibeDSP.kt engines in the service decode path
    @ReactMethod
    fun setNrMode(mode: String) {
        VibeStreamService.instance?.let { it.nrMode = mode; it.requestDspReset() }
    }

    @ReactMethod
    fun setNoiseBlanker(on: Boolean) {
        VibeStreamService.instance?.let { it.nbOn = on; it.requestDspReset() }
    }

    // Auto notch (NLMS) — client-side, network backends (UberSDR/OWRX/Kiwi).
    @ReactMethod
    fun setNotch(on: Boolean) {
        VibeStreamService.instance?.setNotchOn(on)
    }

    // Client-side audio squelch gate (Kiwi etc.) — JS opens/closes from the meter.
    @ReactMethod
    fun setSquelchOpen(open: Boolean) {
        VibeStreamService.instance?.setSquelchOpen(open)
    }

    // Recorder — MediaCodec AAC + MediaMuxer on the service decode thread
    @ReactMethod
    fun startRecording(frequency: Double, mode: String, promise: Promise) {
        val svc = VibeStreamService.instance
        if (svc == null) promise.reject("not_running", "Audio engine is not running")
        else svc.startRecordingNative(frequency, mode, promise)
    }

    @ReactMethod
    fun stopRecording(promise: Promise) {
        val svc = VibeStreamService.instance
        if (svc == null) promise.resolve(null)
        else svc.stopRecordingNative(promise)
    }

    @ReactMethod
    fun shareRecording(path: String) {
        VibeStreamService.instance?.shareRecordingNative(path)
    }

    /**
     * Dump the head unit's own system settings, filtered by substring.
     *
     * WHY THIS EXISTS. The vendor firmware keeps its configuration in
     * `Settings.System` — the radio service reads `android.provider.Settings$System`
     * directly — and among the keys it knows about are `navigation_packagename`,
     * `AUTO_START_NAVI_WHEN_ACC_ON` and a five-valued exit mode
     * (`APP_EXIT_MODE_LASTAPP` / `LASTSOURCE` / `LAUNCHER` / `SENDKEY` / `NONE`).
     * Those decide what the unit brings up when the ignition comes back on, which
     * is why the vendor radio app appears in front of CarFM after every ACC cycle.
     * None of it is exposed in the visible settings.
     *
     * Reading these needs no permission, and doing it here rather than over ADB
     * means it can be done from the driver's seat with no laptop — which for a
     * device bolted into a dashboard is the difference between a check that
     * happens and one that does not.
     *
     * ENUMERATES rather than probing known names, because the interesting keys are
     * exactly the ones we cannot guess. Queries the settings provider directly; a
     * per-table failure is reported inline rather than aborting the dump, since
     * Secure is the one most likely to be restricted and the other two still
     * answer.
     *
     * READ-ONLY on purpose. Writing `Settings.System` needs WRITE_SETTINGS, and
     * whether the MCU would even honour a changed value is unknown — it may read
     * these once at boot and hold the real state itself. Find out what is there
     * first.
     */
    @ReactMethod
    fun dumpSystemSettings(filter: String, promise: Promise) {
        val needle = filter.trim().lowercase()
        val out = StringBuilder()
        val tables = listOf(
            "system" to android.provider.Settings.System.CONTENT_URI,
            "global" to android.provider.Settings.Global.CONTENT_URI,
            "secure" to android.provider.Settings.Secure.CONTENT_URI,
        )
        for ((label, uri) in tables) {
            var shown = 0
            var total = 0
            try {
                reactContext.contentResolver.query(uri, arrayOf("name", "value"), null, null, null)
                    .use { cur ->
                        if (cur == null) { out.append("$label: no cursor\n"); return@use }
                        while (cur.moveToNext()) {
                            total++
                            val name = cur.getString(0) ?: continue
                            if (needle.isNotEmpty() && !name.lowercase().contains(needle)) continue
                            val v = cur.getString(1) ?: ""
                            // Long values are almost always packed blobs of unrelated
                            // state; the head is enough to recognise a package name.
                            out.append("$label  $name = ${if (v.length > 120) v.take(120) + "…" else v}\n")
                            shown++
                        }
                    }
                out.append("$label: $shown of $total key(s) matched\n")
            } catch (e: Exception) {
                out.append("$label: unreadable (${e.message})\n")
            }
        }
        promise.resolve(out.toString())
    }

    // ── Trampoline feasibility recon ─────────────────────────────────────────
    //
    // WHAT THIS IS FOR. The vendor radio app (`com.nwd.radio`) is what the unit
    // brings to the front when the ignition comes back and FM was the source.
    // The plan under consideration is to move that APK off `/system` and install
    // a tiny same-named "trampoline" in its place whose only job is to launch
    // CarFM — so CarFM inherits the firmware's own restore decision instead of
    // reimplementing it.
    //
    // WHAT THIS PROBE IS AND IS NOT. It is a GATE, not an answer. It can say
    // "stop, this is impossible" cheaply and definitively — a squashfs `/system`,
    // no `su`, verity enforcing — and that is worth having before anything
    // irreversible happens. It CANNOT say the plan will work. The two questions
    // that decide that are whether the firmware's restore resolves the radio app
    // by package name or by explicit component (only an ignition cycle with the
    // app hidden answers that) and whether `/system` will actually remount rw
    // (only the attempt answers that). Neither is reachable by reading.
    //
    // STRICTLY READ-ONLY. Nothing here remounts, deletes, installs or writes a
    // setting. The one thing that reaches outside the process is `su -c id`,
    // which may raise a Superuser prompt — that prompt IS the answer to "is
    // there a root manager", so it is deliberate, and it is bounded by a timeout
    // so an unanswered dialog cannot wedge the call.

    /** `SystemProperties.get` by reflection — the same values `getprop` prints,
     *  without paying for a process. Absent/unreadable comes back empty. */
    private fun getprop(key: String): String = try {
        val m = Class.forName("android.os.SystemProperties")
            .getMethod("get", String::class.java, String::class.java)
        (m.invoke(null, key, "") as? String).orEmpty()
    } catch (e: Throwable) { "" }

    /** Run a command, merge stderr into stdout, and give up after [timeoutMs].
     *
     *  The timeout is the point: `su` on a unit with a Superuser manager blocks
     *  until someone taps the dialog, and this is called from a car. On timeout
     *  the process is destroyed, which unblocks the reader. */
    private fun execBounded(cmd: Array<String>, timeoutMs: Long): String {
        return try {
            val pb = ProcessBuilder(*cmd)
            pb.redirectErrorStream(true)
            val p = pb.start()
            val out = StringBuilder()
            val reader = Thread {
                try {
                    p.inputStream.bufferedReader().use { r -> r.forEachLine { out.append(it).append('\n') } }
                } catch (_: Throwable) { /* destroyed out from under us — expected on timeout */ }
            }
            reader.start()
            reader.join(timeoutMs)
            val timedOut = reader.isAlive
            try { p.destroy() } catch (_: Throwable) { }
            val text = out.toString().trim()
            if (timedOut) "${if (text.isEmpty()) "" else "$text\n"}(timed out after ${timeoutMs}ms)" else text
        } catch (e: Throwable) { "exec failed: ${e.message}" }
    }

    /** SHA-256 of each signing certificate, uppercase hex.
     *
     *  The question this answers is narrow: do the vendor app and CarFM share a
     *  signer? If they did, a same-package install would be an ordinary upgrade
     *  and the whole `/system` remount — the only step with a brick risk — would
     *  be unnecessary. Almost certainly they do not, but it is the one outcome
     *  that erases the risk, so it is worth measuring rather than assuming. */
    private fun certDigests(pm: android.content.pm.PackageManager, pkg: String): List<String> = try {
        val sigs: Array<android.content.pm.Signature> =
            if (Build.VERSION.SDK_INT >= 28) {
                val si = pm.getPackageInfo(
                    pkg, android.content.pm.PackageManager.GET_SIGNING_CERTIFICATES
                ).signingInfo
                when {
                    si == null -> emptyArray()
                    si.hasMultipleSigners() -> si.apkContentsSigners ?: emptyArray()
                    else -> si.signingCertificateHistory ?: emptyArray()
                }
            } else {
                @Suppress("DEPRECATION")
                pm.getPackageInfo(
                    pkg, android.content.pm.PackageManager.GET_SIGNATURES
                ).signatures ?: emptyArray()
            }
        if (sigs.isEmpty()) listOf("no signatures reported")
        else sigs.map { s ->
            java.security.MessageDigest.getInstance("SHA-256")
                .digest(s.toByteArray())
                .joinToString("") { b -> "%02X".format(b) }
        }
    } catch (e: Throwable) { listOf("unreadable (${e.message})") }

    /**
     * Gather everything an unprivileged app can learn about whether the vendor
     * radio app can be replaced. Returns a plain-text report; see the block
     * comment above for what it can and cannot establish.
     */
    @ReactMethod
    fun probeTrampolineFeasibility(promise: Promise) {
        val vendorPkg = "com.nwd.radio"
        val servicePkg = "com.nwd.radio.service"
        val out = StringBuilder()
        fun line(s: String) { out.append(s).append('\n') }
        fun section(s: String) { line(""); line("== $s ==") }

        val pm = reactContext.packageManager

        section("DEVICE")
        line("android          = ${Build.VERSION.RELEASE} (sdk ${Build.VERSION.SDK_INT})")
        line("model/device     = ${Build.MODEL} / ${Build.DEVICE}")
        line("fingerprint      = ${Build.FINGERPRINT}")
        for (k in listOf("ro.build.type", "ro.build.tags", "ro.secure", "ro.debuggable")) {
            line("$k".padEnd(16) + " = ${getprop(k).ifEmpty { "(unset)" }}")
        }

        // Verity is the single property most likely to make this plan impossible.
        // "enforcing" means writing /system breaks boot, and on a unit bolted into
        // a dashboard that means pulling it and flashing over USB.
        section("VERIFIED BOOT")
        for (k in listOf(
            "ro.boot.veritymode", "ro.boot.verifiedbootstate",
            "ro.boot.flash.locked", "ro.oem_unlock_supported", "ro.build.selinux",
        )) {
            line("$k".padEnd(26) + " = ${getprop(k).ifEmpty { "(unset)" }}")
        }
        line("NOTE: these are evidence, not proof — fstab flags on these ROMs often")
        line("      disagree with the properties. Only an actual remount settles it.")

        // A squashfs or erofs /system cannot be written at all, at any verity
        // setting, and that ends the plan outright — so it is worth reading the
        // filesystem type rather than only the ro/rw flag.
        section("SYSTEM PARTITION")
        try {
            val wanted = setOf("/", "/system", "/system_root", "/vendor")
            java.io.File("/proc/mounts").readLines().forEach { l ->
                val f = l.split(" ")
                if (f.size >= 4 && f[1] in wanted) line("mount  ${f[1]}  fs=${f[2]}  ${f[3]}  dev=${f[0]}")
            }
        } catch (e: Throwable) { line("/proc/mounts unreadable (${e.message})") }
        try {
            val st = android.os.StatFs("/system")
            val freeMb = (st.availableBlocksLong * st.blockSizeLong) / (1024 * 1024)
            val totalMb = (st.blockCountLong * st.blockSizeLong) / (1024 * 1024)
            line("/system space    = $freeMb MB free of $totalMb MB")
        } catch (e: Throwable) { line("/system statfs failed (${e.message})") }

        section("VENDOR RADIO APP ($vendorPkg)")
        try {
            val ai = pm.getApplicationInfo(vendorPkg, 0)
            val pi = pm.getPackageInfo(vendorPkg, 0)
            val sys = (ai.flags and android.content.pm.ApplicationInfo.FLAG_SYSTEM) != 0
            val upd = (ai.flags and android.content.pm.ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0
            line("sourceDir        = ${ai.sourceDir}")
            line("dataDir          = ${ai.dataDir}")
            line("uid              = ${ai.uid}")
            line("version          = ${pi.versionName}")
            line("FLAG_SYSTEM      = $sys")
            line("UPDATED_SYSTEM   = $upd")
            // An existing /data overlay changes the plan completely: `pm uninstall`
            // alone would drop back to the system copy, with no remount involved.
            if (upd) line("→ there is a /data overlay; `pm uninstall` reverts to the system copy")
            line("enabledSetting   = ${pm.getApplicationEnabledSetting(vendorPkg)} (0=default 1=enabled 2=disabled 3=disabled-user 4=disabled-until-used)")
            val launch = pm.getLaunchIntentForPackage(vendorPkg)
            line("launchIntent     = ${launch?.component?.flattenToShortString() ?: "(none)"}")
            val mainLauncher = android.content.Intent(android.content.Intent.ACTION_MAIN)
                .addCategory(android.content.Intent.CATEGORY_LAUNCHER)
                .setPackage(vendorPkg)
            pm.queryIntentActivities(mainLauncher, 0).forEach {
                line("launcher activity= ${it.activityInfo.packageName}/${it.activityInfo.name}")
            }
        } catch (e: Throwable) {
            line("NOT VISIBLE (${e.message})")
            line("→ on API 30+ this may be package-visibility filtering, not absence")
        }

        section("SIGNATURES")
        val ours = certDigests(pm, reactContext.packageName)
        val theirs = certDigests(pm, vendorPkg)
        ours.forEach { line("carfm            = $it") }
        theirs.forEach { line("$vendorPkg = $it") }
        val shareSigner = ours.isNotEmpty() && ours.any { it in theirs }
        line("same signer      = $shareSigner")
        line(
            if (shareSigner) "→ a same-package install would be an ordinary upgrade; NO remount needed"
            else "→ different signers: a same-name trampoline requires the /system copy to be GONE first"
        )

        section("NWD PACKAGES PRESENT")
        try {
            val all = pm.getInstalledPackages(0).map { it.packageName }.filter { it.startsWith("com.nwd") }.sorted()
            if (all.isEmpty()) line("(none visible)") else all.forEach { line(it) }
            // The service is the tuner. It is a separate package and must survive
            // the removal untouched — CarFM talks to it, not to the app.
            line("service present  = ${all.contains(servicePkg)}  ← must stay")
        } catch (e: Throwable) { line("package list unreadable (${e.message})") }

        // Whoever answers HOME is the most likely owner of the restore decision.
        // The probe cannot see that decision, but naming the package tells you
        // which APK to pull and decompile next.
        section("HOME / LAUNCHER APPS")
        try {
            val home = android.content.Intent(android.content.Intent.ACTION_MAIN)
                .addCategory(android.content.Intent.CATEGORY_HOME)
            val res = pm.queryIntentActivities(home, 0)
            if (res.isEmpty()) line("(none visible)")
            res.forEach { line("${it.activityInfo.packageName}/${it.activityInfo.name}") }
            line("→ decompile these to see HOW the radio app is launched on wake")
        } catch (e: Throwable) { line("home query failed (${e.message})") }

        section("ROOT")
        val suPaths = listOf(
            "/system/bin/su", "/system/xbin/su", "/sbin/su",
            "/su/bin/su", "/system/sbin/su", "/vendor/bin/su", "/debug_ramdisk/su",
        )
        var anySu = false
        for (p in suPaths) {
            val f = java.io.File(p)
            if (f.exists()) { anySu = true; line("present          = $p") }
        }
        if (!anySu) line("no su binary at any well-known path (it may still be on PATH)")
        line("id (unprivileged)= ${execBounded(arrayOf("id"), 2000)}")
        // This is the one call that may raise a Superuser dialog. That dialog is
        // itself the answer, so it is intentional — and bounded, because nobody
        // should have to sit in a car waiting on a prompt that never came.
        line("su -c id         = ${execBounded(arrayOf("su", "-c", "id"), 8000)}")

        section("WHAT THIS PROBE CANNOT ANSWER")
        line("1. by package or by component? — only `pm hide $vendorPkg` + one ACC cycle")
        line("2. will /system remount rw?    — only the attempt")
        line("3. what else breaks on removal — behavioural, ACC cycle only")
        line("4. is a same-name install accepted once /system is clear")
        line("5. is background activity start allowed for the trampoline")
        line("6. can this unit be recovered if the remount bricks it")

        promise.resolve(out.toString())
    }

    /** Write text to the PUBLIC Downloads folder and return a human path. No SAF /
     *  no picker Activity (so it can't crash on units without DocumentsUI), and
     *  Downloads is a standard location a file manager can see + copy to USB.
     *  API 29+ uses MediaStore; older uses the public Downloads dir directly. */
    @ReactMethod
    fun writeLog(text: String, promise: Promise) {
        try {
            val stamp = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.US).format(java.util.Date())
            val fileName = "carfm-tuner-log-$stamp.txt"
            if (android.os.Build.VERSION.SDK_INT >= 29) {
                val resolver = reactContext.contentResolver
                val values = android.content.ContentValues().apply {
                    put(android.provider.MediaStore.Downloads.DISPLAY_NAME, fileName)
                    put(android.provider.MediaStore.Downloads.MIME_TYPE, "text/plain")
                    put(android.provider.MediaStore.Downloads.RELATIVE_PATH, android.os.Environment.DIRECTORY_DOWNLOADS)
                }
                val uri = resolver.insert(android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                    ?: throw java.io.IOException("MediaStore insert returned null")
                resolver.openOutputStream(uri)?.use { it.write(text.toByteArray()) }
                    ?: throw java.io.IOException("openOutputStream returned null")
                promise.resolve("Downloads/$fileName")
            } else {
                @Suppress("DEPRECATION")
                val dir = android.os.Environment.getExternalStoragePublicDirectory(android.os.Environment.DIRECTORY_DOWNLOADS)
                dir.mkdirs()
                val f = java.io.File(dir, fileName)
                f.writeText(text)
                promise.resolve(f.absolutePath)
            }
        } catch (e: Exception) {
            promise.reject("write", e.message ?: "write failed", e)
        }
    }

    // ── Unified GPS engine (one stream → speed + lock) ───────────────────────
    // A SINGLE GPS session powers everything: one 1s location stream feeds the
    // speed events (VibeSpeed) and tracks provider on/off, and one GnssStatus
    // callback (~1Hz) drives lock detection (VibeGpsFix). JS acquires it through a
    // ref-counted session (services/gpsSession.ts); services/motion.ts derive
    // speed/is_moving and services/gps.ts derives the lock. One place controls the
    // GPS rate. FINE location must be granted first (JS requests it).
    private val GPS_INTERVAL_MS = 1_000L   // one deliberate rate for speed + engine
    private var locationListener: android.location.LocationListener? = null
    private var gnssCallback: android.location.GnssStatus.Callback? = null
    private var gpsHasFix = false
    private var gpsSatsUsed = 0
    private var gpsSatsVisible = 0

    private fun locationManager(): android.location.LocationManager? = try {
        reactContext.getSystemService(android.content.Context.LOCATION_SERVICE) as? android.location.LocationManager
    } catch (_: Throwable) { null }

    private fun gpsProviderEnabled(): Boolean =
        try { locationManager()?.isProviderEnabled(android.location.LocationManager.GPS_PROVIDER) ?: false } catch (_: Throwable) { false }

    private fun emitSpeed(mps: Float, hasSpeed: Boolean) {
        try {
            val map = com.facebook.react.bridge.Arguments.createMap()
            map.putDouble("mps", mps.toDouble())
            map.putBoolean("hasSpeed", hasSpeed)
            reactContext.getJSModule(
                com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter::class.java,
            ).emit("VibeSpeed", map)
        } catch (_: Throwable) {}
    }

    private fun emitGpsFix() {
        try {
            val map = com.facebook.react.bridge.Arguments.createMap()
            map.putBoolean("hasFix", gpsHasFix)
            map.putBoolean("providerEnabled", gpsProviderEnabled())
            map.putInt("satellitesUsed", gpsSatsUsed)
            map.putInt("satellitesVisible", gpsSatsVisible)
            reactContext.getJSModule(
                com.facebook.react.modules.core.DeviceEventManagerModule.RCTDeviceEventEmitter::class.java,
            ).emit("VibeGpsFix", map)
        } catch (_: Throwable) {}
    }

    @ReactMethod
    fun startGps() {
        if (locationListener != null) return
        val lm = locationManager() ?: return
        // Lock detection via GnssStatus (~1Hz), API 24+.
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N) {
            val cb = object : android.location.GnssStatus.Callback() {
                override fun onStopped() { gpsHasFix = false; gpsSatsUsed = 0; emitGpsFix() }
                override fun onFirstFix(ttffMillis: Int) { gpsHasFix = true; emitGpsFix() }
                override fun onSatelliteStatusChanged(status: android.location.GnssStatus) {
                    var used = 0
                    val n = status.satelliteCount
                    for (i in 0 until n) if (status.usedInFix(i)) used++
                    val fix = used >= 4   // solid 3D fix; JS also gets the raw counts
                    if (used != gpsSatsUsed || n != gpsSatsVisible || fix != gpsHasFix) {
                        gpsSatsUsed = used; gpsSatsVisible = n; gpsHasFix = fix
                        emitGpsFix()
                    }
                }
            }
            try { lm.registerGnssStatusCallback(cb, android.os.Handler(android.os.Looper.getMainLooper())); gnssCallback = cb }
            catch (_: SecurityException) {}
        }
        // One location stream: feeds speed + provider on/off, and keeps GNSS hot.
        val ll = object : android.location.LocationListener {
            override fun onLocationChanged(loc: android.location.Location) {
                emitSpeed(if (loc.hasSpeed()) loc.speed else -1f, loc.hasSpeed())
            }
            override fun onProviderEnabled(p: String) { emitGpsFix() }
            override fun onProviderDisabled(p: String) { gpsHasFix = false; gpsSatsUsed = 0; emitGpsFix() }
            @Deprecated("legacy callback") override fun onStatusChanged(p: String?, s: Int, e: android.os.Bundle?) {}
        }
        try {
            lm.requestLocationUpdates(
                android.location.LocationManager.GPS_PROVIDER, GPS_INTERVAL_MS, 0f, ll,
                android.os.Looper.getMainLooper(),
            )
            locationListener = ll
        } catch (_: SecurityException) { unregisterGnss(lm); return }
        // Seed speed immediately from the last known fix.
        try {
            lm.getLastKnownLocation(android.location.LocationManager.GPS_PROVIDER)?.let {
                emitSpeed(if (it.hasSpeed()) it.speed else -1f, it.hasSpeed())
            }
        } catch (_: SecurityException) {}
        emitGpsFix()   // initial lock state
    }

    @ReactMethod
    fun stopGps() {
        val lm = locationManager()
        locationListener?.let { try { lm?.removeUpdates(it) } catch (_: Throwable) {} }
        locationListener = null
        unregisterGnss(lm)
    }

    private fun unregisterGnss(lm: android.location.LocationManager?) {
        gnssCallback?.let {
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.N) {
                try { lm?.unregisterGnssStatusCallback(it) } catch (_: Throwable) {}
            }
        }
        gnssCallback = null
    }

    /** One-shot current fix state (same shape as the VibeGpsFix event). */
    @ReactMethod
    fun getGpsFix(promise: com.facebook.react.bridge.Promise) {
        try {
            val map = com.facebook.react.bridge.Arguments.createMap()
            map.putBoolean("hasFix", gpsHasFix)
            map.putBoolean("providerEnabled", gpsProviderEnabled())
            map.putInt("satellitesUsed", gpsSatsUsed)
            map.putInt("satellitesVisible", gpsSatsVisible)
            promise.resolve(map)
        } catch (e: Throwable) { promise.reject("gpsfix", e) }
    }

    // NativeEventEmitter housekeeping (events arrive via RCTDeviceEventEmitter)
    @ReactMethod
    fun addListener(eventName: String) { /* no-op */ }

    @ReactMethod
    fun removeListeners(count: Double) { /* no-op */ }
}
