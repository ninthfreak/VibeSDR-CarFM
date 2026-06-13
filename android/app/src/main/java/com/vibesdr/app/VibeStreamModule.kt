package com.vibesdr.app

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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
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

    // Client NR/NR2/NB — VibeDSP.kt engines in the service decode path
    @ReactMethod
    fun setNrMode(mode: String) {
        VibeStreamService.instance?.let { it.nrMode = mode; it.requestDspReset() }
    }

    @ReactMethod
    fun setNoiseBlanker(on: Boolean) {
        VibeStreamService.instance?.let { it.nbOn = on; it.requestDspReset() }
    }

    // Recorder — MediaCodec AAC + MediaMuxer on the service decode thread
    @ReactMethod
    fun startRecording(promise: Promise) {
        val svc = VibeStreamService.instance
        if (svc == null) promise.reject("not_running", "Audio engine is not running")
        else svc.startRecordingNative(promise)
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

    // NativeEventEmitter housekeeping (events arrive via RCTDeviceEventEmitter)
    @ReactMethod
    fun addListener(eventName: String) { /* no-op */ }

    @ReactMethod
    fun removeListeners(count: Double) { /* no-op */ }
}
