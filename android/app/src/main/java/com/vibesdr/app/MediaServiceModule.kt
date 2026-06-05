package com.vibesdr.app

import android.content.Intent
import android.os.Build
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

class MediaServiceModule(private val reactContext: ReactApplicationContext)
    : ReactContextBaseJavaModule(reactContext), MediaService.Companion.ControlListener {

    private var activeService: MediaService? = null

    override fun getName(): String = "VibeMediaService"

    init {
        MediaService.controlListener = this
    }

    // ── ControlListener callbacks (fired by service / notification buttons) ───

    override fun onPlay()  { emit("play") }
    override fun onPause() { emit("pause") }
    override fun onNext()  { emit("next") }
    override fun onPrev()  { emit("prev") }

    // ── JS-callable methods ───────────────────────────────────────────────────

    @ReactMethod
    fun start(title: String, artist: String, playing: Boolean) {
        val intent = buildIntent(title, artist, playing)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            reactContext.startForegroundService(intent)
        } else {
            reactContext.startService(intent)
        }
    }

    @ReactMethod
    fun update(title: String, artist: String, playing: Boolean) {
        // Re-issuing startForegroundService updates an already-running service
        // via onStartCommand; idempotent if values unchanged (service checks internally)
        start(title, artist, playing)
    }

    @ReactMethod
    fun stop() {
        reactContext.stopService(Intent(reactContext, MediaService::class.java))
    }

    // Required for NativeEventEmitter on the JS side
    @ReactMethod fun addListener(eventName: String) {}
    @ReactMethod fun removeListeners(count: Int) {}

    // ── Internals ─────────────────────────────────────────────────────────────

    private fun buildIntent(title: String, artist: String, playing: Boolean) =
        Intent(reactContext, MediaService::class.java).apply {
            putExtra(MediaService.EXTRA_TITLE,   title)
            putExtra(MediaService.EXTRA_ARTIST,  artist)
            putExtra(MediaService.EXTRA_PLAYING, playing)
        }

    private fun emit(action: String) {
        try {
            reactContext
                .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
                ?.emit("vibeMediaControl", action)
        } catch (_: Exception) {}
    }

    override fun invalidate() {
        super.invalidate()
        MediaService.controlListener = null
    }
}
