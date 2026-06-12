package com.vibesdr.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import androidx.core.app.NotificationCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.DeviceEventManagerModule
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.LinkedBlockingDeque
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.min

/**
 * Native audio engine + foreground service — Android mirror of the iOS
 * VibePowerModule pipeline (the old ExoPlayer /audio/stream HTTP path cannot
 * connect to v2 servers; audio rides the session WebSocket now).
 *
 * Packet layout (version=2, always 21-byte header):
 *   [0:8]   uint64 LE  timestamp
 *   [8:12]  uint32 LE  sample rate (encoder input rate — informational)
 *   [12]    uint8      channels
 *   [13:17] float32 LE baseband power
 *   [17:21] float32 LE noise density
 *   [21:]   Opus payload
 *
 * Design notes:
 *  - MediaCodec "audio/opus" decoder configured ONCE at 48 kHz. Opus payloads
 *    are rate-agnostic, so the server's per-mode sample-rate flips (linear
 *    12k / FM 24k) need no decoder or AudioTrack rebuilds — the half-speed
 *    race the iOS engine had cannot exist here by construction.
 *  - Single decode thread owns codec + AudioTrack; the WS callback only
 *    enqueues. Bounded deque drops OLDEST on overflow so playback hugs the
 *    live edge (iOS queuedSeconds parity).
 *  - Watchdog: packets flow ~50/s; >8s stale or dead socket → reopen with
 *    the SAME session uuid (a fresh one orphans decoders/spectrum WS
 *    server-side — "no active audio session").
 */
class VibeStreamService : Service() {

    companion object {
        const val CHANNEL_ID = "vibesdr_audio"
        const val NOTIF_ID = 1
        const val ACTION_PLAY = "com.vibesdr.app.PLAY"
        const val ACTION_PAUSE = "com.vibesdr.app.PAUSE"
        const val ACTION_STOP = "com.vibesdr.app.STOP"
        const val ACTION_NEXT = "com.vibesdr.app.NEXT"
        const val ACTION_PREV = "com.vibesdr.app.PREV"
        const val ACTION_START = "com.vibesdr.app.START"
        const val EXTRA_BASE_URL = "baseUrl"
        const val EXTRA_FREQUENCY = "frequency"
        const val EXTRA_MODE = "mode"
        const val EXTRA_UUID = "uuid"
        const val EXTRA_PASSWORD = "password"

        private const val TAG = "VibeStream"
        private const val HEADER_LEN = 21

        var reactContext: ReactApplicationContext? = null
        @Volatile var instance: VibeStreamService? = null
    }

    private var mediaSession: MediaSessionCompat? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    // ── Engine state ─────────────────────────────────────────────────────────
    @Volatile private var running = false
    @Volatile private var muted = false
    @Volatile private var volume = 1f
    @Volatile private var currentFreq = 14_074_000L
    @Volatile private var currentMode = "usb"
    @Volatile private var currentStep = 1_000L
    private var currentBase = ""
    private var currentUuid = ""
    // Bypass password (rate-limit/ban bypass) — appended to the audio WS URL
    private var bypassPassword = ""
    private var instanceName = ""
    @Volatile private var lastPacketAt = 0L
    @Volatile private var packetCount = 0

    private var httpClient: OkHttpClient? = null
    @Volatile private var ws: WebSocket? = null
    private val packetQueue = LinkedBlockingDeque<ByteArray>(32)
    private var decodeThread: Thread? = null

    // ── Client noise DSP (VibeDSP.kt — iOS/skin parity) ──────────────────────
    // Engines run at the STREAM rate (packet-header sr: linear 12k / FM 24k)
    // for exact tuning parity; the opus decoder always outputs 48k, so the
    // decode thread decimates by the integer factor, processes, interpolates
    // back. All DSP state is decode-thread-only.
    @Volatile var nrMode = "off"        // "off" | "nr" | "nr2"
    @Volatile var nbOn = false
    @Volatile var nrBandwidthHz = 2700.0
    @Volatile private var dspResetRequested = false
    private var dspRate = 0
    private var nbEngine: NoiseBlankerEngine? = null
    private var nr2Chunker: BlockChunker? = null
    private var websdrEngine: WebSDRNREngine? = null
    private var websdrChunker: BlockChunker? = null
    @Volatile private var streamSr = 12_000   // latest packet-header rate

    // ── Recorder (decode-thread state machine) ───────────────────────────────
    // Taps the post-DSP 48k PCM into MediaCodec AAC + MediaMuxer .m4a;
    // records through mutes. Start/stop arrive as requests and are handled
    // on the decode thread (MediaCodec is not thread-safe).
    @Volatile var recArmed = false
    @Volatile private var recStartReq: com.facebook.react.bridge.Promise? = null
    @Volatile private var recStopReq: com.facebook.react.bridge.Promise? = null
    private var recEncoder: android.media.MediaCodec? = null
    private var recMuxer: android.media.MediaMuxer? = null
    private var recTrackIndex = -1
    private var recMuxerStarted = false
    private var recChannels = 1
    private var recPtsUs = 0L
    private var recFile: java.io.File? = null
    private var recDisplayName = ""

    // Now-playing overrides — JS computes VTS-aware title/artist (station or
    // band name, user's frequency unit, tune step); native skips clear them
    // until the JS VibeTuned round-trip refreshes (sub-second).
    @Volatile private var npTitle: String? = null
    @Volatile private var npArtist: String? = null
    // Media skip routing: "step" = native tune±step; "bookmark" = emit
    // VibeSkip and let JS jump bookmarks (it owns the VTS station list)
    @Volatile var skipMode = "step"
    // Composited album art (app icon + server-type logo inset), cached
    private var npArtwork: android.graphics.Bitmap? = null
    private var npArtworkType = ""

    private var watchdog: Runnable? = null
    // Tune coalescing: the velocity drum can emit 20+ steps/s; one WS tune
    // per step thrashes radiod. Leading send + 80ms trailing timer.
    private var pendingTuneFreq = 0L
    private var pendingTuneMode = ""
    private var hasPendingTune = false
    private var lastTuneSentAt = 0L
    private var tuneFlush: Runnable? = null

    // ── Service lifecycle ────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        instance = this
        createNotificationChannel()
        setupMediaSession()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val base = intent.getStringExtra(EXTRA_BASE_URL) ?: return START_STICKY
                val freq = intent.getLongExtra(EXTRA_FREQUENCY, 14_074_000L)
                val mode = intent.getStringExtra(EXTRA_MODE) ?: "usb"
                val uuid = intent.getStringExtra(EXTRA_UUID) ?: return START_STICKY
                val pw = intent.getStringExtra(EXTRA_PASSWORD) ?: ""
                startAudioEngine(base, freq, mode, uuid, pw)
            }
            ACTION_PLAY -> setMutedNative(false)
            ACTION_PAUSE -> setMutedNative(true)
            ACTION_STOP -> { stopEngine(); stopSelf(); return START_NOT_STICKY }
            ACTION_NEXT -> tuneByStep(+1)
            ACTION_PREV -> tuneByStep(-1)
        }
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        stopEngine()
        mediaSession?.release()
        instance = null
        super.onDestroy()
    }

    // ── Engine control (called from VibeStreamModule / media controls) ───────

    fun startAudioEngine(baseUrl: String, frequency: Long, mode: String, uuid: String, password: String) {
        Log.i(TAG, "startAudioEngine $baseUrl $frequency $mode")
        stopEngine()
        currentBase = baseUrl
        currentFreq = frequency
        currentMode = mode
        currentUuid = uuid
        bypassPassword = password
        running = true
        muted = false
        packetCount = 0
        lastPacketAt = SystemClock.elapsedRealtime()
        packetQueue.clear()
        startDecodeThread()
        openWs()
        startWatchdog()
        mediaSession?.isActive = true
        updateMetadataSession()
        updatePlaybackState(PlaybackStateCompat.STATE_PLAYING)
        startForeground(NOTIF_ID, buildNotification())
    }

    fun stopEngine() {
        running = false
        watchdog?.let { mainHandler.removeCallbacks(it) }
        watchdog = null
        tuneFlush?.let { mainHandler.removeCallbacks(it) }
        tuneFlush = null
        ws?.close(1001, "going away")
        ws = null
        packetQueue.clear()
        decodeThread?.interrupt()
        decodeThread = null
        mediaSession?.isActive = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
    }

    fun sendTuneCommand(frequency: Long, mode: String) {
        currentFreq = frequency
        currentMode = mode
        mainHandler.post {
            pendingTuneFreq = frequency
            pendingTuneMode = mode
            hasPendingTune = true
            val since = SystemClock.elapsedRealtime() - lastTuneSentAt
            if (since >= 80) {
                flushPendingTune()
            } else if (tuneFlush == null) {
                val r = Runnable { tuneFlush = null; flushPendingTune() }
                tuneFlush = r
                mainHandler.postDelayed(r, 80 - since)
            }
            updateMetadataSession()
            updateNotification()
        }
    }

    private fun flushPendingTune() {
        if (!hasPendingTune) return
        hasPendingTune = false
        lastTuneSentAt = SystemClock.elapsedRealtime()
        sendWsJson(JSONObject().put("type", "tune")
            .put("frequency", pendingTuneFreq).put("mode", pendingTuneMode))
        // Drop queued (pre-tune) audio so what you HEAR snaps to the new
        // frequency — fine-tuning SSB through a stale backlog is impossible.
        packetQueue.clear()
    }

    fun sendBandwidth(low: Long, high: Long) {
        sendWsJson(JSONObject().put("type", "tune")
            .put("bandwidthLow", low).put("bandwidthHigh", high))
        // Audio occupies 0..max-edge Hz regardless of sideband (NR syncBins)
        nrBandwidthHz = maxOf(abs(low), abs(high)).toDouble()
    }

    fun setStep(hz: Long) { currentStep = hz }

    fun setInstanceNameNative(name: String) {
        instanceName = name
        mainHandler.post { updateMetadataSession(); updateNotification() }
    }

    fun setMutedNative(m: Boolean) {
        muted = m
        if (m) packetQueue.clear()
        emitEvent("VibeMuted") { it.putBoolean("muted", m) }
        mainHandler.post {
            updatePlaybackState(
                if (m) PlaybackStateCompat.STATE_PAUSED else PlaybackStateCompat.STATE_PLAYING
            )
            updateMetadataSession()
            updateNotification()
        }
    }

    fun setVolumeNative(v: Float) {
        volume = v.coerceIn(0f, 1f)
        track?.setVolume(volume)
    }

    fun sendRawCommand(json: String) {
        val sock = ws ?: return
        sock.send(json)
    }

    fun revive() {
        mainHandler.post { reviveIfDead(3_000) }
    }

    private fun tuneByStep(direction: Int) {
        if (skipMode == "bookmark") {
            emitEvent("VibeSkip") { it.putString("direction", if (direction > 0) "next" else "prev") }
            return
        }
        val newFreq = (currentFreq + direction * currentStep).coerceAtLeast(100_000L)
        currentFreq = newFreq
        // Stale VTS strings (old station name) — fall back until JS catches up
        npTitle = null
        npArtist = null
        sendWsJson(JSONObject().put("type", "tune").put("frequency", newFreq))
        emitEvent("VibeTuned") {
            it.putDouble("frequency", newFreq.toDouble())
            it.putString("mode", currentMode)
        }
        mainHandler.post { updateMetadataSession(); updateNotification() }
    }

    // ── WebSocket ────────────────────────────────────────────────────────────

    private fun wsUrl(): String {
        var s = currentBase.trim().trimEnd('/')
        s = when {
            s.startsWith("https://") -> "wss://" + s.removePrefix("https://")
            s.startsWith("http://") -> "ws://" + s.removePrefix("http://")
            else -> s
        }
        var url = "$s/ws?user_session_id=$currentUuid&frequency=$currentFreq" +
            "&mode=$currentMode&format=opus&version=2"
        if (bypassPassword.isNotEmpty()) {
            url += "&password=" + java.net.URLEncoder.encode(bypassPassword, "UTF-8")
        }
        return url
    }

    private fun openWs() {
        val client = httpClient ?: OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build().also { httpClient = it }
        val url = wsUrl()
        Log.i(TAG, "opening audio WS: $url")
        val socket = client.newWebSocket(Request.Builder().url(url).build(),
            object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    if (!running || ws !== webSocket) return
                    packetCount++
                    lastPacketAt = SystemClock.elapsedRealtime()
                    if (packetCount <= 3) Log.i(TAG, "ws pkt#$packetCount len=${bytes.size}")
                    // Recording keeps decoding through mutes (file taps the
                    // decoded feed); playback is gated at the AudioTrack write
                    if (!muted || recArmed) {
                        // Live-edge bound: drop OLDEST on overflow
                        val arr = bytes.toByteArray()
                        if (!packetQueue.offerLast(arr)) {
                            packetQueue.pollFirst()
                            packetQueue.offerLast(arr)
                        }
                    }
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (!running || ws !== webSocket) return
                    // dsp_filters / dsp_status / dsp_error etc. — JS owns the
                    // server-NR UI (same event name as iOS)
                    emitEvent("VibeWsText") { it.putString("text", text) }
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    if (!running || ws !== webSocket) return
                    Log.w(TAG, "ws failure: ${t.message} — reconnecting in 2s")
                    mainHandler.postDelayed({
                        // SAME uuid — decoders + spectrum WS are keyed to it
                        if (running && ws === webSocket) { ws = null; openWs() }
                    }, 2_000)
                }
            })
        ws = socket
    }

    private fun sendWsJson(obj: JSONObject) {
        ws?.send(obj.toString())
    }

    // ── Watchdog (zombie-socket revive, iOS parity) ──────────────────────────

    private fun startWatchdog() {
        watchdog?.let { mainHandler.removeCallbacks(it) }
        val r = object : Runnable {
            override fun run() {
                if (!running) return
                reviveIfDead(8_000)
                mainHandler.postDelayed(this, 4_000)
            }
        }
        watchdog = r
        mainHandler.postDelayed(r, 4_000)
    }

    private fun reviveIfDead(staleAfterMs: Long) {
        if (!running) return
        val stale = SystemClock.elapsedRealtime() - lastPacketAt
        if (stale <= staleAfterMs && ws != null) return
        Log.i(TAG, "watchdog: stale=${stale}ms — reviving audio WS")
        lastPacketAt = SystemClock.elapsedRealtime() // debounce one revive/window
        ws?.cancel()
        ws = null
        openWs()
    }

    // ── Decode thread: MediaCodec opus → AudioTrack ──────────────────────────

    private var codec: MediaCodec? = null
    private var codecChannels = 0
    @Volatile private var track: AudioTrack? = null
    private var trackRate = 0
    private var trackChannels = 0
    private var ptsUs = 0L

    private fun startDecodeThread() {
        val t = Thread({
            try {
                decodeLoop()
            } catch (e: InterruptedException) {
                // normal shutdown
            } catch (e: Exception) {
                Log.e(TAG, "decode loop died: ${e.message}", e)
            } finally {
                releaseCodec()
                recArmed = false
                releaseRecorder()  // finalises the .m4a if a recording was live
                recStartReq?.reject("stopped", "audio engine stopped"); recStartReq = null
                recStopReq?.resolve(null); recStopReq = null
                track?.release()
                track = null
                trackRate = 0
                trackChannels = 0
            }
        }, "vibesdr-decode")
        t.priority = Thread.MAX_PRIORITY
        decodeThread = t
        t.start()
    }

    private fun decodeLoop() {
        val info = MediaCodec.BufferInfo()
        while (running) {
            handleRecRequests()   // runs even when no packets flow
            val pkt = packetQueue.poll(250, TimeUnit.MILLISECONDS) ?: continue
            if (pkt.size <= HEADER_LEN) continue
            val ch = pkt[12].toInt() and 0xFF
            if (ch != 1 && ch != 2) continue
            val opusLen = pkt.size - HEADER_LEN
            if (opusLen < 3) continue
            // Stream sample rate from the header (encoder input rate) — the
            // DSP engines run at this rate for skin parity
            val sr = (pkt[8].toInt() and 0xFF) or ((pkt[9].toInt() and 0xFF) shl 8) or
                ((pkt[10].toInt() and 0xFF) shl 16) or ((pkt[11].toInt() and 0xFF) shl 24)
            if (sr in 8000..96000) streamSr = sr

            // Channel-count flip → rebuild codec synchronously (no race:
            // this thread owns codec + track exclusively)
            if (codec == null || codecChannels != ch) ensureCodec(ch)
            val c = codec ?: continue

            // Feed input (drain between attempts so the decoder never stalls)
            var fed = false
            var attempts = 0
            while (!fed && attempts < 50 && running) {
                val inIdx = c.dequeueInputBuffer(10_000)
                if (inIdx >= 0) {
                    val ib = c.getInputBuffer(inIdx) ?: break
                    ib.clear()
                    ib.put(pkt, HEADER_LEN, opusLen)
                    c.queueInputBuffer(inIdx, 0, opusLen, ptsUs, 0)
                    ptsUs += 20_000
                    fed = true
                }
                drainOutput(c, info)
                attempts++
            }
            drainOutput(c, info)
        }
    }

    private fun drainOutput(c: MediaCodec, info: MediaCodec.BufferInfo) {
        while (true) {
            val outIdx = c.dequeueOutputBuffer(info, 0)
            when {
                outIdx >= 0 -> {
                    val ob = c.getOutputBuffer(outIdx)
                    if (ob != null && info.size > 0) {
                        var pcm = ByteArray(info.size)
                        ob.position(info.offset)
                        ob.get(pcm, 0, info.size)
                        ensureTrackFor(c.outputFormat)
                        if (trackChannels == 1 && (nbOn || nrMode != "off")) {
                            pcm = dspProcess(pcm)
                        }
                        if (recArmed) encodePcm(pcm)
                        if (!muted) track?.write(pcm, 0, pcm.size)  // blocking = backpressure
                    }
                    c.releaseOutputBuffer(outIdx, false)
                }
                outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    ensureTrackFor(c.outputFormat)
                }
                else -> return
            }
        }
    }

    // ── Client noise DSP (decode-thread only) ────────────────────────────────

    /** 16-bit mono 48k PCM → decimate to streamSr → NB → NR/NR2 → back to 48k. */
    private fun dspProcess(pcm: ByteArray): ByteArray {
        val sr = streamSr
        val factor = if (sr > 0) 48_000 / sr else 1
        if (factor < 1 || 48_000 % sr != 0) return pcm

        if (dspResetRequested || dspRate != sr) {
            dspRate = sr
            dspResetRequested = false
            nbEngine = null
            nr2Chunker = null
            websdrEngine = null
            websdrChunker = null
        }

        val n48 = pcm.size / 2
        val n = n48 / factor
        if (n == 0) return pcm

        // Decimate: boxcar average per factor group (content is band-limited
        // to the stream rate already — opus encoded at sr)
        var mono = FloatArray(n)
        var bi = 0
        for (i in 0 until n) {
            var acc = 0.0f
            for (k in 0 until factor) {
                val lo = pcm[bi].toInt() and 0xFF
                val hi = pcm[bi + 1].toInt()
                acc += ((hi shl 8) or lo) / 32768.0f
                bi += 2
            }
            mono[i] = acc / factor
        }

        if (nbOn) {
            if (nbEngine == null) nbEngine = NoiseBlankerEngine(sr.toDouble())
            nbEngine!!.process(mono)
        }
        when (nrMode) {
            "nr2" -> {
                if (nr2Chunker == null) {
                    val eng = NR2Engine()
                    nr2Chunker = BlockChunker(512) { blk -> eng.processHop(blk) }
                }
                mono = nr2Chunker!!.run(mono)
            }
            "nr" -> {
                if (websdrChunker == null) {
                    val eng = WebSDRNREngine()
                    eng.syncBins(nrBandwidthHz, sr.toDouble())
                    websdrEngine = eng
                    websdrChunker = BlockChunker(WebSDRNREngine.BLOCK) { blk -> eng.processWithDelay(blk) }
                }
                websdrEngine?.syncBins(nrBandwidthHz, sr.toDouble())
                mono = websdrChunker!!.run(mono)
            }
        }

        // Interpolate back to 48k (linear)
        val out = ByteArray(n * factor * 2)
        var oi = 0
        for (i in 0 until n) {
            val cur = mono[i]
            val next = if (i + 1 < n) mono[i + 1] else cur
            for (k in 0 until factor) {
                val v = cur + (next - cur) * k / factor
                val s = (v * 32767.0f).toInt().coerceIn(-32768, 32767)
                out[oi] = (s and 0xFF).toByte()
                out[oi + 1] = ((s shr 8) and 0xFF).toByte()
                oi += 2
            }
        }
        return out
    }

    fun requestDspReset() { dspResetRequested = true }

    // ── Recorder (decode-thread state machine) ───────────────────────────────

    private fun handleRecRequests() {
        recStartReq?.let { promise ->
            recStartReq = null
            try {
                val ts = java.text.SimpleDateFormat("yyyy-MM-dd'T'HH-mm-ss", java.util.Locale.US)
                    .format(java.util.Date())
                val mhz = String.format(java.util.Locale.US, "%.4fMHz", currentFreq / 1e6)
                recDisplayName = "VibeSDR_${ts}_${mhz}_${currentMode.uppercase()}.m4a"
                val f = java.io.File(cacheDir, recDisplayName)
                recChannels = if (trackChannels == 2) 2 else 1
                val fmt = MediaFormat.createAudioFormat(
                    MediaFormat.MIMETYPE_AUDIO_AAC, 48_000, recChannels)
                fmt.setInteger(MediaFormat.KEY_AAC_PROFILE,
                    android.media.MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                fmt.setInteger(MediaFormat.KEY_BIT_RATE, 128_000)
                fmt.setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 65_536)
                val enc = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
                enc.configure(fmt, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                enc.start()
                recEncoder = enc
                recMuxer = android.media.MediaMuxer(
                    f.absolutePath, android.media.MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
                recTrackIndex = -1
                recMuxerStarted = false
                recPtsUs = 0
                recFile = f
                recArmed = true
                Log.i(TAG, "recording → $recDisplayName")
                promise.resolve(f.absolutePath)
            } catch (e: Exception) {
                Log.e(TAG, "rec start failed: ${e.message}")
                promise.reject("rec_open", e.message)
                releaseRecorder()
            }
        }
        recStopReq?.let { promise ->
            recStopReq = null
            recArmed = false
            try {
                val enc = recEncoder
                if (enc != null) {
                    val idx = enc.dequeueInputBuffer(50_000)
                    if (idx >= 0) {
                        enc.queueInputBuffer(idx, 0, 0, recPtsUs,
                            MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                    }
                    drainEncoder(true)
                }
                val src = recFile
                releaseRecorder()
                promise.resolve(if (src != null) publishRecording(src) else null)
            } catch (e: Exception) {
                Log.e(TAG, "rec stop failed: ${e.message}")
                releaseRecorder()
                promise.reject("rec_stop", e.message)
            }
        }
    }

    private fun encodePcm(pcm: ByteArray) {
        val enc = recEncoder ?: return
        // Track channels can flip mid-recording — adapt to the encoder's count
        val data = matchChannels(pcm, trackChannels, recChannels)
        var off = 0
        try {
            while (off < data.size) {
                val idx = enc.dequeueInputBuffer(10_000)
                if (idx < 0) { drainEncoder(false); continue }
                val ib = enc.getInputBuffer(idx) ?: break
                ib.clear()
                val chunk = min(ib.capacity(), data.size - off)
                ib.put(data, off, chunk)
                enc.queueInputBuffer(idx, 0, chunk, recPtsUs, 0)
                recPtsUs += (chunk / (2L * recChannels)) * 1_000_000L / 48_000L
                off += chunk
            }
            drainEncoder(false)
        } catch (e: Exception) {
            Log.e(TAG, "rec encode failed: ${e.message}")
            recArmed = false
            releaseRecorder()
        }
    }

    private fun drainEncoder(eos: Boolean) {
        val enc = recEncoder ?: return
        val muxer = recMuxer ?: return
        val info = MediaCodec.BufferInfo()
        while (true) {
            val outIdx = enc.dequeueOutputBuffer(info, if (eos) 50_000 else 0)
            when {
                outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    recTrackIndex = muxer.addTrack(enc.outputFormat)
                    muxer.start()
                    recMuxerStarted = true
                }
                outIdx >= 0 -> {
                    val ob = enc.getOutputBuffer(outIdx)
                    if (ob != null && info.size > 0 && recMuxerStarted &&
                        (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
                        muxer.writeSampleData(recTrackIndex, ob, info)
                    }
                    enc.releaseOutputBuffer(outIdx, false)
                    if ((info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) return
                }
                else -> return
            }
        }
    }

    private fun matchChannels(pcm: ByteArray, from: Int, to: Int): ByteArray {
        if (from == to) return pcm
        val frames = pcm.size / (2 * from)
        val out = ByteArray(frames * 2 * to)
        var ii = 0; var oi = 0
        for (f in 0 until frames) {
            if (from == 1) { // mono → stereo: duplicate
                out[oi] = pcm[ii]; out[oi + 1] = pcm[ii + 1]
                out[oi + 2] = pcm[ii]; out[oi + 3] = pcm[ii + 1]
                ii += 2; oi += 4
            } else {         // stereo → mono: average
                val l = ((pcm[ii + 1].toInt() shl 8) or (pcm[ii].toInt() and 0xFF))
                val r = ((pcm[ii + 3].toInt() shl 8) or (pcm[ii + 2].toInt() and 0xFF))
                val m = (l + r) / 2
                out[oi] = (m and 0xFF).toByte(); out[oi + 1] = ((m shr 8) and 0xFF).toByte()
                ii += 4; oi += 2
            }
        }
        return out
    }

    private fun releaseRecorder() {
        try { recEncoder?.stop() } catch (_: Exception) {}
        try { recEncoder?.release() } catch (_: Exception) {}
        recEncoder = null
        try { if (recMuxerStarted) recMuxer?.stop() } catch (_: Exception) {}
        try { recMuxer?.release() } catch (_: Exception) {}
        recMuxer = null
        recMuxerStarted = false
        recTrackIndex = -1
    }

    /** Copy the finished .m4a into MediaStore (Music/VibeSDR) so it's visible
     *  in music/file apps; returns a shareable content:// URI (or the raw
     *  file path below API 29). */
    private fun publishRecording(src: java.io.File): String {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return src.absolutePath
        return try {
            val values = android.content.ContentValues().apply {
                put(android.provider.MediaStore.Audio.Media.DISPLAY_NAME, recDisplayName)
                put(android.provider.MediaStore.Audio.Media.MIME_TYPE, "audio/mp4")
                put(android.provider.MediaStore.Audio.Media.RELATIVE_PATH, "Music/VibeSDR")
                put(android.provider.MediaStore.Audio.Media.IS_PENDING, 1)
            }
            val uri = contentResolver.insert(
                android.provider.MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, values)
                ?: return src.absolutePath
            contentResolver.openOutputStream(uri)?.use { out ->
                java.io.FileInputStream(src).use { it.copyTo(out) }
            }
            values.clear()
            values.put(android.provider.MediaStore.Audio.Media.IS_PENDING, 0)
            contentResolver.update(uri, values, null, null)
            src.delete()
            uri.toString()
        } catch (e: Exception) {
            Log.w(TAG, "MediaStore publish failed: ${e.message}")
            src.absolutePath
        }
    }

    fun startRecordingNative(promise: com.facebook.react.bridge.Promise) {
        if (!running) { promise.reject("not_running", "Audio engine is not running"); return }
        recStartReq = promise
    }

    fun stopRecordingNative(promise: com.facebook.react.bridge.Promise) {
        recStopReq = promise
    }

    /** System share sheet for the finished recording (content:// URI). */
    fun shareRecordingNative(uriOrPath: String) {
        try {
            val uri = if (uriOrPath.startsWith("content:")) android.net.Uri.parse(uriOrPath)
                      else return  // bare paths (pre-Q fallback) aren't shareable without a provider
            val send = Intent(Intent.ACTION_SEND).apply {
                type = "audio/mp4"
                putExtra(Intent.EXTRA_STREAM, uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            val chooser = Intent.createChooser(send, "Share recording").apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            startActivity(chooser)
        } catch (e: Exception) {
            Log.w(TAG, "share failed: ${e.message}")
        }
    }

    private fun ensureCodec(ch: Int) {
        releaseCodec()
        val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_OPUS, 48_000, ch)
        format.setByteBuffer("csd-0", ByteBuffer.wrap(opusHead(ch)))
        format.setByteBuffer("csd-1", ByteBuffer.wrap(le64(0)))           // pre-skip ns
        format.setByteBuffer("csd-2", ByteBuffer.wrap(le64(80_000_000)))  // seek pre-roll ns
        val c = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_OPUS)
        c.configure(format, null, null, 0)
        c.start()
        codec = c
        codecChannels = ch
        ptsUs = 0
        Log.i(TAG, "opus decoder created ch=$ch")
    }

    private fun releaseCodec() {
        try { codec?.stop() } catch (_: Exception) {}
        try { codec?.release() } catch (_: Exception) {}
        codec = null
        codecChannels = 0
    }

    /** OpusHead identification header (RFC 7845 §5.1) for MediaCodec csd-0. */
    private fun opusHead(ch: Int): ByteArray {
        val b = ByteBuffer.allocate(19).order(ByteOrder.LITTLE_ENDIAN)
        b.put("OpusHead".toByteArray(Charsets.US_ASCII))
        b.put(1)                 // version
        b.put(ch.toByte())       // channel count
        b.putShort(0)            // pre-skip
        b.putInt(48_000)         // input sample rate (informational)
        b.putShort(0)            // output gain
        b.put(0)                 // mapping family
        return b.array()
    }

    private fun le64(v: Long): ByteArray =
        ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN).putLong(v).array()

    private fun ensureTrackFor(format: MediaFormat) {
        val rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE)
        val ch = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
        if (track != null && trackRate == rate && trackChannels == ch) return
        track?.release()
        val mask = if (ch == 2) AudioFormat.CHANNEL_OUT_STEREO else AudioFormat.CHANNEL_OUT_MONO
        val minBuf = AudioTrack.getMinBufferSize(rate, mask, AudioFormat.ENCODING_PCM_16BIT)
        val t = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build()
            )
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(rate)
                    .setChannelMask(mask)
                    .build()
            )
            .setBufferSizeInBytes(maxOf(minBuf * 2, 9_600 * ch)) // ≥100ms
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        t.setVolume(volume)
        t.play()
        track = t
        trackRate = rate
        trackChannels = ch
        Log.i(TAG, "AudioTrack ${rate}Hz ${ch}ch")
    }

    // ── Events to JS ─────────────────────────────────────────────────────────

    private fun emitEvent(name: String, fill: (com.facebook.react.bridge.WritableMap) -> Unit) {
        val ctx = reactContext ?: return
        try {
            val map = Arguments.createMap()
            fill(map)
            ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                .emit(name, map)
        } catch (e: Exception) {
            Log.w(TAG, "emit $name failed: ${e.message}")
        }
    }

    // ── Notification / MediaSession ──────────────────────────────────────────

    private fun nowPlayingTitle(): String {
        val base = npTitle ?: run {
            val mhz = String.format("%.3f MHz", currentFreq / 1_000_000.0)
            "$mhz ${currentMode.uppercase()}"
        }
        return base + (if (muted) " ·muted·" else "")
    }

    private fun nowPlayingArtist(): String =
        npArtist ?: instanceName.ifEmpty { currentBase }

    /** VTS-aware now-playing strings from JS (empty string clears). */
    fun setNowPlayingNative(title: String, artist: String) {
        npTitle = title.ifEmpty { null }
        npArtist = artist.ifEmpty { null }
        mainHandler.post { updateMetadataSession(); updateNotification() }
    }

    /** Album art: VibeSDR icon with the server-type logo inset bottom-right
     *  (multi-server prep — type picks the overlay, "ubersdr" for now). */
    fun setArtworkNative(serverType: String) {
        if (serverType == npArtworkType) return
        npArtworkType = serverType
        mainHandler.post {
            try {
                val base = android.graphics.BitmapFactory.decodeResource(
                    resources, R.drawable.artwork_base) ?: return@post
                val overlayId = resources.getIdentifier(
                    "logo_$serverType", "drawable", packageName)
                var composed = base
                if (overlayId != 0) {
                    val overlay = android.graphics.BitmapFactory.decodeResource(resources, overlayId)
                    if (overlay != null) {
                        composed = base.copy(android.graphics.Bitmap.Config.ARGB_8888, true)
                        val canvas = android.graphics.Canvas(composed)
                        val inset = composed.width * 0.30f
                        val pad = composed.width * 0.045f
                        val dst = android.graphics.RectF(
                            composed.width - inset - pad, composed.height - inset - pad,
                            composed.width - pad, composed.height - pad)
                        canvas.drawBitmap(overlay, null, dst, null)
                    }
                }
                npArtwork = composed
                updateMetadataSession()
                updateNotification()
            } catch (e: Exception) {
                Log.w(TAG, "artwork composite failed: ${e.message}")
            }
        }
    }

    private fun updateMetadataSession() {
        val b = MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, nowPlayingTitle())
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, nowPlayingArtist())
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, "VibeSDR")
        npArtwork?.let { b.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it) }
        mediaSession?.setMetadata(b.build())
    }

    private fun updatePlaybackState(state: Int) {
        mediaSession?.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setState(state, -1L, 1f)
                .setActions(
                    PlaybackStateCompat.ACTION_PLAY or
                        PlaybackStateCompat.ACTION_PAUSE or
                        PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                        PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or
                        PlaybackStateCompat.ACTION_STOP
                )
                .build()
        )
    }

    private fun updateNotification() {
        if (!running) return
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        manager.notify(NOTIF_ID, buildNotification())
    }

    private fun setupMediaSession() {
        mediaSession = MediaSessionCompat(this, "VibeSDR").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                // Play/pause = unmute/mute, skips = tune ± step (iOS parity)
                override fun onPlay() { setMutedNative(false) }
                override fun onPause() { setMutedNative(true) }
                override fun onStop() { stopEngine(); stopSelf() }
                override fun onSkipToNext() { tuneByStep(+1) }
                override fun onSkipToPrevious() { tuneByStep(-1) }
            })
        }
        updatePlaybackState(PlaybackStateCompat.STATE_NONE)
    }

    private fun pi(requestCode: Int, action: String) = PendingIntent.getService(
        this, requestCode,
        Intent(this, VibeStreamService::class.java).apply { this.action = action },
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    private fun buildNotification(): Notification {
        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val contentPi = PendingIntent.getActivity(
            this, 0, launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val playPauseIcon = if (!muted) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play
        val playPauseLabel = if (!muted) "Mute" else "Unmute"
        val playPauseAction = if (!muted) ACTION_PAUSE else ACTION_PLAY

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setLargeIcon(npArtwork)
            .setContentTitle(nowPlayingTitle())
            .setContentText(nowPlayingArtist())
            .setContentIntent(contentPi)
            .addAction(android.R.drawable.ic_media_previous, "Prev", pi(1, ACTION_PREV))
            .addAction(playPauseIcon, playPauseLabel, pi(2, playPauseAction))
            .addAction(android.R.drawable.ic_media_next, "Next", pi(3, ACTION_NEXT))
            .addAction(android.R.drawable.ic_delete, "Stop", pi(4, ACTION_STOP))
            .setStyle(
                androidx.media.app.NotificationCompat.MediaStyle()
                    .setMediaSession(mediaSession?.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2)
            )
            .setOngoing(true)
            .setSilent(true)
            .build()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID, "VibeSDR Audio",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "SDR audio stream"
                setSound(null, null)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(channel)
        }
    }
}
