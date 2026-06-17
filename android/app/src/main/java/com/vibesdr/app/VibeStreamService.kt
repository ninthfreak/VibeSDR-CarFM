package com.vibesdr.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.support.v4.media.MediaBrowserCompat
import android.support.v4.media.MediaDescriptionCompat
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import android.util.Log
import androidx.car.app.connection.CarConnection
import androidx.core.app.NotificationCompat
import androidx.lifecycle.Observer
import androidx.media.MediaBrowserServiceCompat
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
class VibeStreamService : MediaBrowserServiceCompat() {

    companion object {
        const val CHANNEL_ID = "vibesdr_audio"
        const val NOTIF_ID = 1
        // Media-browser node ids (Android Auto / CarPlay-style browse tree)
        const val MEDIA_ROOT_ID = "vibesdr_root"
        const val BOOKMARKS_ID = "bookmarks"
        const val BANDS_ID = "bands"
        const val ACTION_PLAY = "com.vibesdr.app.PLAY"
        const val ACTION_PAUSE = "com.vibesdr.app.PAUSE"
        const val ACTION_STOP = "com.vibesdr.app.STOP"
        const val ACTION_NEXT = "com.vibesdr.app.NEXT"
        const val ACTION_PREV = "com.vibesdr.app.PREV"
        const val ACTION_START = "com.vibesdr.app.START"
        const val ACTION_START_EXTERNAL = "com.vibesdr.app.START_EXTERNAL"
        const val EXTRA_RATE = "rate"
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
    @Volatile private var externalAudio = false   // OWRX/Kiwi/local: raw PCM pushed from JS
    @Volatile var localExternal = false           // external audio is LOCAL hardware (pause = mute, not stop)
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

    // SERVER BUG WORKAROUND (FM half-speed): ubersdr creates its opus encoder
    // ONCE per WS at the then-current sample rate; a mode change flips radiod
    // to a new rate but keeps the old encoder → audio time-stretched INSIDE
    // the opus stream. A header-rate flip cycles the WS so the server builds
    // a fresh encoder (3-packet confirm + 4s cooldown for flip stragglers).
    @Volatile private var wsBaseSr = 0
    @Volatile private var srFlipCount = 0
    @Volatile private var lastSrCycleAt = 0L

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
    private var recRate = 48_000     // encoder rate: 48k (UberSDR) or the external stream rate
    private var recReqFreq = 0.0     // freq/mode from the UI for the recording filename
    private var recReqMode = ""
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
    // Pause disconnects the SDR (server drops it on suspend anyway) and Play
    // reconnects; these track the two non-playing notification states: cleanly
    // disconnected vs a reconnect that failed (server full / rate-limited).
    @Volatile private var dataSaverDisconnected = false
    @Volatile private var reconnectFailed = false
    @Volatile private var lastSignalEmit = 0L   // throttle the SNR (VibeSignal) event
    // Audio focus — when another app takes it (parity with iOS interruption) we
    // register a mute so the UI + data saver reflect it; user presses Play to
    // return (no auto-resume on regain).
    private val audioManager by lazy { getSystemService(AUDIO_SERVICE) as AudioManager }
    private var audioFocusRequest: AudioFocusRequest? = null
    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT,
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK ->
                mainHandler.post { if (running && !muted && !dataSaverDisconnected) setMutedNative(true) }
        }
    }
    // Composited album art (app icon + server-type logo inset), cached
    private var npArtwork: android.graphics.Bitmap? = null
    private var npArtworkType = ""

    // ── Car browse tree (Android Auto) ───────────────────────────────────────
    // Bookmarks + Band Plan lists pushed from JS (setBrowseItems) and served via
    // MediaBrowserServiceCompat. Cached to prefs so a cold service start (Android
    // Auto connecting before the app has run) still shows the last known list.
    private data class BrowseItem(
        val name: String, val freq: Long, val mode: String, val step: Long, val isBand: Boolean,
    )
    @Volatile private var browseBookmarks: List<BrowseItem> = emptyList()
    @Volatile private var browseBands: List<BrowseItem> = emptyList()
    private var carConnection: CarConnection? = null
    private var carObserver: Observer<Int>? = null

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
        // Required so MediaBrowserServiceCompat can serve Android Auto / Wear.
        sessionToken = mediaSession?.sessionToken
        loadCachedBrowse()
        startCarConnectionWatch()
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
            ACTION_START_EXTERNAL -> startExternalAudio(intent.getIntExtra(EXTRA_RATE, 48000))
            ACTION_PLAY -> setMutedNative(false)
            ACTION_PAUSE -> setMutedNative(true)
            ACTION_STOP -> { stopEngine(); stopSelf(); return START_NOT_STICKY }
            ACTION_NEXT -> tuneByStep(+1)
            ACTION_PREV -> tuneByStep(-1)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        stopEngine()
        stopCarConnectionWatch()
        mediaSession?.release()
        instance = null
        super.onDestroy()
    }

    // App swiped from recents: release the local SDR (USB device + localhost
    // port) and stop audio + the service immediately. Without this the
    // foreground service lingered for several seconds holding the shim, so an
    // immediate relaunch collided with the still-alive instance → spinning
    // wheel. (Background audio still works on screen-lock — that's not a task
    // removal.)
    override fun onTaskRemoved(rootIntent: Intent?) {
        Log.i(TAG, "onTaskRemoved — releasing local SDR + stopping service")
        try { VibeLocalSDR.stopSpectrum() } catch (_: Throwable) {}
        stopExternalAudio()
        stopEngine()
        stopSelf()
        super.onTaskRemoved(rootIntent)
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
        // Fresh session — clear the disconnected / reconnect-failed card state.
        dataSaverDisconnected = false
        reconnectFailed = false
        lastArtworkKey = ""
        packetCount = 0
        lastPacketAt = SystemClock.elapsedRealtime()
        packetQueue.clear()
        requestAudioFocus()
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
        // Reset external state too, so switching OWRX→UberSDR doesn't leave the
        // engine in external mode (which made UberSDR pause take the external path
        // → media-control "pause springs back to play").
        externalAudio = false
        extThread?.interrupt(); extThread = null
        extQueue.clear()
        extTrack?.release(); extTrack = null; extRate = 0
        abandonAudioFocus()
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
        // OWRX/Kiwi (external): an OWRX reconnect resets the server to its default
        // profile, so we don't offer play-to-reconnect. PAUSE fully releases the
        // media controls (stopExternalAudio clears the notification); JS closes its
        // WS on the VibeMuted event and shows an in-app reconnect prompt, so a
        // (profile-resetting) reconnect is always a deliberate user action.
        if (externalAudio) {
            if (localExternal) {
                // Local hardware: no server profile to reset, so pause just
                // mutes/resumes the engine (keep it + the media controls alive).
                // The ext writer silences while muted and PCM resumes on play.
                mainHandler.post {
                    if (m) {
                        extQueue.clear()
                        updatePlaybackState(PlaybackStateCompat.STATE_PAUSED)
                    } else {
                        requestAudioFocus()
                        updatePlaybackState(PlaybackStateCompat.STATE_PLAYING)
                    }
                    updateNotification()
                }
                return
            }
            if (m) mainHandler.post { stopExternalAudio() }
            return
        }
        // UberSDR — Pause = disconnect, Play = reconnect (disconnect card + ▶).
        mainHandler.post {
            if (m) {
                disconnectForPause()
            } else if (dataSaverDisconnected) {
                resumeFromDataSaver()
            } else {
                updatePlaybackState(PlaybackStateCompat.STATE_PLAYING)
                updateNotification()
            }
        }
    }

    // ── Pause = disconnect / Play = reconnect ────────────────────────────────

    private fun disconnectForPause() {
        if (dataSaverDisconnected) return
        dataSaverDisconnected = true
        abandonAudioFocus()                       // release the audio route
        ws?.close(1001, "paused"); ws = null
        packetQueue.clear()
        // Keep the foreground notification + session so ▶ reconnects; show it as
        // a clearly "Disconnected" card (see nowPlaying* / refreshArtwork).
        mainHandler.post {
            updatePlaybackState(PlaybackStateCompat.STATE_PAUSED)
            updateMetadataSession(); updateNotification()
        }
        emitEvent("VibeDataSaverDisconnect") { }
    }

    private fun resumeFromDataSaver() {
        if (!dataSaverDisconnected) return
        // Don't reopen the old session — a partial reopen lands in a broken
        // half-state. Hand off to JS for a full from-scratch reconnect (new uuid
        // → fresh startAudioEngine, which clears the disconnected state). The flag
        // stays set until then so the watchdog won't revive the stale socket.
        emitEvent("VibeDataSaverResume") { }
    }

    /** JS calls this when a reconnect attempt fails (server full / rate-limited)
     *  so the notification tells the user to open the app. */
    fun setReconnectFailedNative(failed: Boolean) {
        reconnectFailed = failed
        if (failed) dataSaverDisconnected = false
        mainHandler.post {
            // COMPUTE the state (matching iOS updateNowPlaying) — don't hardcode
            // PAUSED. JS calls setReconnectFailed(false) on every successful
            // connect, which used to flip a freshly-PLAYING session to PAUSED
            // (the media card stuck on a play button / pause-play spring). Only
            // pause when actually failed / disconnected / muted.
            val playing = !reconnectFailed && !dataSaverDisconnected && !muted
            updatePlaybackState(if (playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED)
            updateMetadataSession(); updateNotification()
        }
    }

    private fun requestAudioFocus() {
        val attrs = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(attrs)
                .setOnAudioFocusChangeListener(focusListener, mainHandler)
                .build()
            audioFocusRequest = req
            audioManager.requestAudioFocus(req)
        } else {
            @Suppress("DEPRECATION")
            audioManager.requestAudioFocus(
                focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
        }
    }

    private fun abandonAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioFocusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
            audioFocusRequest = null
        } else {
            @Suppress("DEPRECATION")
            audioManager.abandonAudioFocus(focusListener)
        }
    }

    // ── External PCM audio (OWRX/Kiwi) ───────────────────────────────────────
    // The WS + decode live in JS; JS pushes raw 16-bit mono PCM and we just play
    // it. A dedicated AudioTrack (recreated when the rate changes) plays at the
    // pushed rate — Android resamples to the device rate, so the DAB speed
    // correction (JS under-states the rate) works the same as on iOS. Background
    // audio survives because the foreground service keeps the app + JS alive.
    @Volatile private var extTrack: AudioTrack? = null
    private var extRate = 0
    private var extChannels = 1
    private var extThread: Thread? = null
    // (rate, channels, interleaved int16 samples)
    private val extQueue = LinkedBlockingDeque<Triple<Int, Int, ShortArray>>(64)

    fun startExternalAudio(rate: Int) {
        Log.i(TAG, "startExternalAudio $rate")
        stopEngine()                       // tear down any opus path
        externalAudio = true
        running = true
        muted = false
        dataSaverDisconnected = false
        reconnectFailed = false
        lastArtworkKey = ""
        packetCount = 0
        lastPacketAt = SystemClock.elapsedRealtime()
        extQueue.clear()
        requestAudioFocus()
        startExtWriter()
        mediaSession?.isActive = true
        updateMetadataSession()
        updatePlaybackState(PlaybackStateCompat.STATE_PLAYING)
        startForeground(NOTIF_ID, buildNotification())
    }

    // channels: 1=mono (OWRX/Kiwi, local narrow modes), 2=interleaved stereo
    // (local WFM). Samples are interleaved L,R for stereo.
    fun pushExternalPcm(base64: String, rate: Int, channels: Int = 1) {
        if (!externalAudio || muted) return
        val bytes = try { Base64.decode(base64, Base64.DEFAULT) } catch (e: Exception) { return }
        val n = bytes.size / 2
        if (n == 0) return
        val shorts = ShortArray(n)
        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(shorts)
        lastPacketAt = SystemClock.elapsedRealtime()
        packetCount++
        extQueue.offer(Triple(rate, if (channels == 2) 2 else 1, shorts))   // drop when full (backpressure)
    }

    fun stopExternalAudio() {
        Log.i(TAG, "stopExternalAudio")
        externalAudio = false
        running = false
        extThread?.interrupt(); extThread = null
        extQueue.clear()
        abandonAudioFocus()
        mediaSession?.isActive = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE)
        else { @Suppress("DEPRECATION") stopForeground(true) }
    }

    private fun startExtWriter() {
        val t = Thread({
            try {
                while (running && externalAudio) {
                    val item = extQueue.poll(250, TimeUnit.MILLISECONDS)
                    handleRecRequests()   // arm/stop the recorder on this thread too
                    if (item == null) continue
                    ensureExtTrack(item.first, item.second)
                    if (!muted) extTrack?.write(item.third, 0, item.third.size)  // blocking = backpressure
                    // Feed the recorder encoder (the UberSDR decode loop isn't
                    // running on this path, so recording is driven from here).
                    if (recArmed) {
                        val sh = item.third
                        val bytes = ByteArray(sh.size * 2)
                        ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().put(sh)
                        encodePcm(bytes, item.second)
                    }
                }
            } catch (e: InterruptedException) {
                // normal shutdown
            } finally {
                extTrack?.release(); extTrack = null; extRate = 0
            }
        }, "vibesdr-ext")
        t.priority = Thread.MAX_PRIORITY
        extThread = t
        t.start()
    }

    private fun ensureExtTrack(rate: Int, channels: Int = 1) {
        if (extTrack != null && extRate == rate && extChannels == channels) return
        extTrack?.release()
        val mask = if (channels == 2) AudioFormat.CHANNEL_OUT_STEREO else AudioFormat.CHANNEL_OUT_MONO
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
            .setBufferSizeInBytes(maxOf(minBuf * 2, rate / 5 * 2 * channels))  // ≥200ms
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        t.setVolume(volume)
        t.play()
        extTrack = t
        extRate = rate
        extChannels = channels
        Log.i(TAG, "ext AudioTrack ${rate}Hz ch=$channels")
    }

    fun setVolumeNative(v: Float) {
        volume = v.coerceIn(0f, 1f)
        track?.setVolume(volume)
        extTrack?.setVolume(volume)
    }

    fun sendRawCommand(json: String) {
        val sock = ws ?: return
        sock.send(json)
    }

    fun revive() {
        mainHandler.post { reviveIfDead(3_000) }
    }

    private fun tuneByStep(direction: Int) {
        // External (OWRX/Kiwi): tuning lives in JS — delegate so we don't tune the
        // native UberSDR WS (resurrecting a session). JS handles step vs bookmark
        // vs DAB-programme cycling from its own state.
        if (externalAudio || skipMode == "bookmark") {
            emitEvent("VibeSkip") { it.putString("direction", if (direction > 0) "next" else "prev") }
            return
        }
        val newFreq = snapStep(direction)
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

    /** Snap a media-control skip to the step grid, matching the VFO drum: an
     *  off-grid frequency lands on the next/previous multiple of the step; an
     *  on-grid one moves exactly one step. direction +1 = up, -1 = down. */
    private fun snapStep(direction: Int): Long {
        val s = currentStep
        if (s <= 0) return currentFreq.coerceAtLeast(100_000L)
        val snapped = if (direction > 0) (currentFreq / s + 1) * s
                      else ((currentFreq + s - 1) / s - 1) * s
        return snapped.coerceAtLeast(100_000L)
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
        wsBaseSr = 0
        srFlipCount = 0
        val socket = client.newWebSocket(Request.Builder().url(url).build(),
            object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                    if (!running || ws !== webSocket) return
                    packetCount++
                    lastPacketAt = SystemClock.elapsedRealtime()
                    if (packetCount <= 3) Log.i(TAG, "ws pkt#$packetCount len=${bytes.size}")
                    // Header rate flip → server encoder mismatched, cycle WS
                    if (bytes.size > HEADER_LEN) {
                        val sr = (bytes[8].toInt() and 0xFF) or ((bytes[9].toInt() and 0xFF) shl 8) or
                            ((bytes[10].toInt() and 0xFF) shl 16) or ((bytes[11].toInt() and 0xFF) shl 24)
                        if (sr in 8000..96000) {
                            if (wsBaseSr == 0) {
                                wsBaseSr = sr
                            } else if (sr != wsBaseSr) {
                                srFlipCount++
                                if (srFlipCount >= 3 &&
                                    SystemClock.elapsedRealtime() - lastSrCycleAt > 4_000) {
                                    Log.i(TAG, "sample rate $wsBaseSr→$sr — cycling WS for fresh server encoder")
                                    lastSrCycleAt = SystemClock.elapsedRealtime()
                                    webSocket.cancel()
                                    ws = null
                                    mainHandler.post { if (running) openWs() }
                                    return
                                }
                            } else {
                                srFlipCount = 0
                            }
                        }
                    }
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
        // External (OWRX/Kiwi) has no native WS to revive — JS owns it.
        if (!running || externalAudio || dataSaverDisconnected) return  // data saver owns the closed WS
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

            // SNR meter = radiod channel SNR = basebandPower − noiseDensity (both
            // dBFS, per-packet header) — the demodulator's own channel measure, so
            // independent of the spectrum/zoom (matches UberSDR).
            val bb = Float.fromBits((pkt[13].toInt() and 0xFF) or ((pkt[14].toInt() and 0xFF) shl 8) or
                ((pkt[15].toInt() and 0xFF) shl 16) or ((pkt[16].toInt() and 0xFF) shl 24))
            val nd = Float.fromBits((pkt[17].toInt() and 0xFF) or ((pkt[18].toInt() and 0xFF) shl 8) or
                ((pkt[19].toInt() and 0xFF) shl 16) or ((pkt[20].toInt() and 0xFF) shl 24))
            if (bb > -900f && nd > -900f) {
                val now = SystemClock.elapsedRealtime()
                if (now - lastSignalEmit > 200) {
                    lastSignalEmit = now
                    emitEvent("VibeSignal") { it.putDouble("snr", (bb - nd).toDouble()); it.putDouble("dbfs", bb.toDouble()) }
                }
            }

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
                val rf = if (recReqFreq > 0) recReqFreq else currentFreq.toDouble()
                val rm = if (recReqMode.isNotEmpty()) recReqMode else currentMode
                val mhz = String.format(java.util.Locale.US, "%.4fMHz", rf / 1e6)
                recDisplayName = "VibeSDR_${ts}_${mhz}_${rm.uppercase()}.m4a"
                val f = java.io.File(cacheDir, recDisplayName)
                // External audio (local/Kiwi/OWRX) has its own rate/channels;
                // the UberSDR path is always 48k. Match the encoder to the source
                // so recordings play at the right speed.
                recRate = if (externalAudio && extRate > 0) extRate else 48_000
                recChannels = if (externalAudio) extChannels.coerceIn(1, 2)
                              else if (trackChannels == 2) 2 else 1
                val fmt = MediaFormat.createAudioFormat(
                    MediaFormat.MIMETYPE_AUDIO_AAC, recRate, recChannels)
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

    private fun encodePcm(pcm: ByteArray, srcChannels: Int = trackChannels) {
        val enc = recEncoder ?: return
        // Source channels can flip mid-recording — adapt to the encoder's count
        val data = matchChannels(pcm, srcChannels, recChannels)
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
                recPtsUs += (chunk / (2L * recChannels)) * 1_000_000L / recRate
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

    fun startRecordingNative(frequency: Double, mode: String, promise: com.facebook.react.bridge.Promise) {
        if (!running) { promise.reject("not_running", "Audio engine is not running"); return }
        // Use the frequency/mode the UI passes (accurate for every backend,
        // including local/Kiwi where the service's currentFreq isn't synced).
        if (frequency > 0) recReqFreq = frequency
        if (mode.isNotEmpty()) recReqMode = mode
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

    // ── Car browse tree (MediaBrowserServiceCompat) ──────────────────────────

    override fun onGetRoot(
        clientPackageName: String, clientUid: Int, rootHints: Bundle?,
    ): BrowserRoot? {
        // Opt OUT of Android 11+ media resumption (the system "resume" query sets
        // EXTRA_RECENT). On some skins (HyperOS/MIUI) the resume card hijacks the
        // LIVE MediaSession when the app is backgrounded — showing a paused card
        // while audio plays, failing to resume ("Cannot resume"), so the lock-screen
        // play/pause springs and never reaches our onPause/onPlay. Returning null
        // here keeps the live session controls in charge. Live SDR isn't a
        // resumable on-demand stream anyway.
        if (rootHints?.getBoolean(BrowserRoot.EXTRA_RECENT) == true) return null
        // Any other caller may browse — the tree is just public bookmarks + the
        // band plan (no user data). Android Auto / Wear connect here.
        return BrowserRoot(MEDIA_ROOT_ID, null)
    }

    override fun onLoadChildren(
        parentId: String, result: Result<MutableList<MediaBrowserCompat.MediaItem>>,
    ) {
        val items = ArrayList<MediaBrowserCompat.MediaItem>()
        when (parentId) {
            MEDIA_ROOT_ID -> {
                items.add(browsableFolder(BOOKMARKS_ID, "Bookmarks"))
                items.add(browsableFolder(BANDS_ID, "Band Plan"))
            }
            BOOKMARKS_ID -> browseBookmarks.forEach { items.add(playableItem(it)) }
            BANDS_ID -> browseBands.forEach { items.add(playableItem(it)) }
        }
        result.sendResult(items)
    }

    private fun browsableFolder(id: String, title: String): MediaBrowserCompat.MediaItem {
        val desc = MediaDescriptionCompat.Builder().setMediaId(id).setTitle(title).build()
        return MediaBrowserCompat.MediaItem(desc, MediaBrowserCompat.MediaItem.FLAG_BROWSABLE)
    }

    private fun playableItem(it: BrowseItem): MediaBrowserCompat.MediaItem {
        val mhz = String.format(java.util.Locale.US, "%.3f MHz", it.freq / 1_000_000.0)
        val sub = if (it.mode.isNotEmpty()) "$mhz · ${it.mode.uppercase()}" else mhz
        val desc = MediaDescriptionCompat.Builder()
            // id = freq|mode|step|isBand — parsed back in playFromBrowseId
            .setMediaId("${it.freq}|${it.mode}|${it.step}|${if (it.isBand) 1 else 0}")
            .setTitle(it.name)
            .setSubtitle(sub)
            .build()
        return MediaBrowserCompat.MediaItem(desc, MediaBrowserCompat.MediaItem.FLAG_PLAYABLE)
    }

    private fun playFromBrowseId(mediaId: String?) {
        val parts = mediaId?.split("|") ?: return
        if (parts.size < 4) return
        val freq = parts[0].toLongOrNull() ?: return
        val mode = parts[1]
        val isBand = parts[3] == "1"
        emitEvent("VibeCarTune") {
            it.putDouble("frequency", freq.toDouble())
            it.putString("mode", mode.ifEmpty { null })
            it.putBoolean("isBand", isBand)
        }
    }

    /** JS pushes the browse payload ({bookmarks:[{name,frequency,mode}],
     *  bands:[{name,frequency,mode,step}]}). Cached to prefs + Auto refreshed. */
    fun setBrowseItemsNative(json: String) {
        try {
            val obj = JSONObject(json)
            browseBookmarks = parseBrowseArr(obj.optJSONArray("bookmarks"), isBand = false)
            browseBands = parseBrowseArr(obj.optJSONArray("bands"), isBand = true)
            getSharedPreferences("vibesdr_browse", MODE_PRIVATE)
                .edit().putString("payload", json).apply()
            mainHandler.post {
                notifyChildrenChanged(BOOKMARKS_ID)
                notifyChildrenChanged(BANDS_ID)
            }
        } catch (e: Exception) {
            Log.w(TAG, "setBrowseItems parse failed: ${e.message}")
        }
    }

    private fun parseBrowseArr(arr: org.json.JSONArray?, isBand: Boolean): List<BrowseItem> {
        if (arr == null) return emptyList()
        val out = ArrayList<BrowseItem>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val name = o.optString("name")
            val freq = o.optDouble("frequency", 0.0).toLong()
            if (name.isEmpty() || freq <= 0) continue
            out.add(BrowseItem(name, freq, o.optString("mode", ""), o.optLong("step", 0), isBand))
        }
        return out
    }

    private fun loadCachedBrowse() {
        val json = getSharedPreferences("vibesdr_browse", MODE_PRIVATE)
            .getString("payload", null) ?: return
        try {
            val obj = JSONObject(json)
            browseBookmarks = parseBrowseArr(obj.optJSONArray("bookmarks"), isBand = false)
            browseBands = parseBrowseArr(obj.optJSONArray("bands"), isBand = true)
        } catch (_: Exception) {}
    }

    // ── Car-connected signal (Android Auto projection/native) ────────────────

    private fun startCarConnectionWatch() {
        try {
            val cc = CarConnection(this)
            val obs = Observer<Int> { type ->
                val connected = type == CarConnection.CONNECTION_TYPE_PROJECTION ||
                    type == CarConnection.CONNECTION_TYPE_NATIVE
                emitEvent("VibeCarConnected") { it.putBoolean("connected", connected) }
            }
            cc.type.observeForever(obs)
            carConnection = cc
            carObserver = obs
        } catch (e: Exception) {
            Log.w(TAG, "CarConnection watch failed: ${e.message}")
        }
    }

    private fun stopCarConnectionWatch() {
        carObserver?.let { carConnection?.type?.removeObserver(it) }
        carObserver = null
        carConnection = null
    }

    // ── Notification / MediaSession ──────────────────────────────────────────

    private fun nowPlayingTitle(): String {
        if (reconnectFailed) return "Failed to reconnect"
        if (dataSaverDisconnected) return "Disconnected"
        return npTitle ?: run {
            val mhz = String.format("%.3f MHz", currentFreq / 1_000_000.0)
            "$mhz ${currentMode.uppercase()}"
        }
    }

    private fun nowPlayingArtist(): String {
        if (reconnectFailed) return "Open VibeSDR to reconnect"
        if (dataSaverDisconnected) return "VibeSDR — press ▶ to reconnect"
        return npArtist ?: instanceName.ifEmpty { currentBase }
    }

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
        mainHandler.post { refreshArtwork(); updateMetadataSession(); updateNotification() }
    }

    // State-aware album art: server logo inset while playing, a muted-speaker
    // glyph + minutes-to-disconnect while muted, a disconnected glyph once the
    // data saver drops the stream. Keyed so it only recomposites on change.
    private var lastArtworkKey = ""
    private fun refreshArtwork() {
        val key = when {
            reconnectFailed -> "fail"
            dataSaverDisconnected -> "disc"
            else -> "play-$npArtworkType"
        }
        if (key == lastArtworkKey) return
        lastArtworkKey = key
        try {
            val base = android.graphics.BitmapFactory.decodeResource(
                resources, R.drawable.artwork_base) ?: return
            val composed = base.copy(android.graphics.Bitmap.Config.ARGB_8888, true)
            val canvas = android.graphics.Canvas(composed)
            val inset = composed.width * 0.30f
            val pad = composed.width * 0.045f
            val dst = android.graphics.RectF(
                composed.width - inset - pad, composed.height - inset - pad,
                composed.width - pad, composed.height - pad)
            when {
                reconnectFailed -> { drawInsetGlyph(canvas, dst, "⛔", null); drawBadge(canvas, dst, "❗") }
                dataSaverDisconnected -> drawInsetGlyph(canvas, dst, "⛔", null)
                else -> {
                    val overlayId = resources.getIdentifier("logo_$npArtworkType", "drawable", packageName)
                    if (overlayId != 0) {
                        android.graphics.BitmapFactory.decodeResource(resources, overlayId)?.let {
                            canvas.drawBitmap(it, null, dst, null)
                        }
                    }
                }
            }
            npArtwork = composed
        } catch (e: Exception) {
            Log.w(TAG, "artwork composite failed: ${e.message}")
        }
    }

    private fun drawInsetGlyph(canvas: android.graphics.Canvas, dst: android.graphics.RectF, glyph: String, sub: String?) {
        val bg = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply { color = 0xCC101418.toInt() }
        val r = dst.width() * 0.18f
        canvas.drawRoundRect(dst, r, r, bg)
        val tp = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
            color = android.graphics.Color.WHITE
            textAlign = android.graphics.Paint.Align.CENTER
        }
        if (sub != null) {
            tp.textSize = dst.height() * 0.40f
            canvas.drawText(glyph, dst.centerX(), dst.top + dst.height() * 0.46f, tp)
            tp.textSize = dst.height() * 0.30f
            tp.isFakeBoldText = true
            canvas.drawText(sub, dst.centerX(), dst.bottom - dst.height() * 0.12f, tp)
        } else {
            tp.textSize = dst.height() * 0.52f
            canvas.drawText(glyph, dst.centerX(), dst.centerY() + dst.height() * 0.20f, tp)
        }
    }

    /** Small exclamation badge in the bottom-right of the inset (reconnect failed). */
    private fun drawBadge(canvas: android.graphics.Canvas, dst: android.graphics.RectF, glyph: String) {
        val tp = android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG).apply {
            textAlign = android.graphics.Paint.Align.CENTER
            textSize = dst.height() * 0.34f
        }
        canvas.drawText(glyph, dst.right - dst.width() * 0.16f, dst.bottom - dst.height() * 0.04f, tp)
    }

    private fun updateMetadataSession() {
        refreshArtwork()  // keep the inset glyph/countdown in step with the state
        val b = MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, nowPlayingTitle())
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, nowPlayingArtist())
            .putString(MediaMetadataCompat.METADATA_KEY_ALBUM, "VibeSDR")
        npArtwork?.let { b.putBitmap(MediaMetadataCompat.METADATA_KEY_ALBUM_ART, it) }
        mediaSession?.setMetadata(b.build())
    }

    private fun updatePlaybackState(state: Int) {
        // Use a concrete position (0) + current update time, not -1/UNKNOWN: some
        // system media panels treat "PLAYING with unknown position" as not really
        // playing and render a play button (→ taps send ACTION_PLAY, the spring).
        mediaSession?.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setState(state, 0L, 1f, SystemClock.elapsedRealtime())
                .setActions(
                    PlaybackStateCompat.ACTION_PLAY or
                        PlaybackStateCompat.ACTION_PAUSE or
                        PlaybackStateCompat.ACTION_PLAY_PAUSE or
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
                // Car browse-list pick → hand the tune to JS (owns region logic)
                override fun onPlayFromMediaId(mediaId: String?, extras: Bundle?) {
                    playFromBrowseId(mediaId)
                }
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
