package com.vibesdr.app

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build

/**
 * WifiLock holder for the network-SDR paths (rtl_tcp server and client).
 *
 * Without this the WiFi radio enters power-save between beacons, which stalls a
 * sustained multi-Mbit IQ stream long enough to overflow the server's bounded
 * client queue — the user hears audio breakup. WIFI_MODE_FULL_LOW_LATENCY tells
 * the framework to disable power-save outright while the lock is held.
 *
 * Each owner constructs its own instance; the underlying lock is not reference
 * counted, so acquire/release must be paired per instance. Requires WAKE_LOCK,
 * which the manifest already declares.
 */
class VibeWifiLock(private val context: Context, private val tag: String) {

    private var lock: WifiManager.WifiLock? = null

    fun acquire() {
        if (lock != null) return
        try {
            val wm = context.applicationContext
                .getSystemService(Context.WIFI_SERVICE) as? WifiManager ?: return
            val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            else
                @Suppress("DEPRECATION") WifiManager.WIFI_MODE_FULL_HIGH_PERF
            lock = wm.createWifiLock(mode, tag).apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (_: Throwable) {
            lock = null
        }
    }

    fun release() {
        try { lock?.let { if (it.isHeld) it.release() } } catch (_: Throwable) {}
        lock = null
    }
}
