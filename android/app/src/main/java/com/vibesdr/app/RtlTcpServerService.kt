package com.vibesdr.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import org.json.JSONObject

/**
 * Foreground service for the RTL-TCP SERVER (v6.1). Keeps the app alive + the
 * CPU awake while the phone serves its USB dongle over the network, and shows a
 * live notification (bandwidth + connected client). Uses the `connectedDevice`
 * FGS type (there's no audio — the mediaPlayback service is for on-device
 * listening), a PARTIAL_WAKE_LOCK so screen-off doze can't stall the USB/TCP
 * stream, and a WifiLock so the radio doesn't power-save mid-stream.
 *
 * The notification text is refreshed on a 2s timer from the native server
 * status, so it stays current even when the JS/UI is backgrounded.
 */
class RtlTcpServerService : Service() {

    companion object {
        const val EXTRA_NAME = "name"
        const val EXTRA_IP   = "ip"
        const val EXTRA_PORT = "port"
        private const val CHANNEL_ID = "vibesdr_rtltcp_server"
        private const val NOTIF_ID = 4711

        fun start(ctx: Context, name: String, ip: String, port: Int) {
            val i = Intent(ctx, RtlTcpServerService::class.java)
                .putExtra(EXTRA_NAME, name).putExtra(EXTRA_IP, ip).putExtra(EXTRA_PORT, port)
            ContextCompat_startForegroundService(ctx, i)
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, RtlTcpServerService::class.java))
        }

        private fun ContextCompat_startForegroundService(ctx: Context, i: Intent) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i)
            else ctx.startService(i)
        }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private val wifiLock by lazy { VibeWifiLock(this, "VibeSDR:RtlTcpServer") }
    private val handler = Handler(Looper.getMainLooper())
    private var name = "VibeSDR RTL-SDR"
    private var ip = ""
    private var port = 1234

    private val ticker = object : Runnable {
        override fun run() {
            updateNotification()
            handler.postDelayed(this, 2000)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        intent?.let {
            name = it.getStringExtra(EXTRA_NAME) ?: name
            ip   = it.getStringExtra(EXTRA_IP) ?: ip
            port = it.getIntExtra(EXTRA_PORT, port)
        }
        ensureChannel()
        startForegroundInternal()
        acquireWakeLock()
        wifiLock.acquire()
        handler.removeCallbacks(ticker)
        handler.post(ticker)
        return START_STICKY
    }

    private fun startForegroundInternal() {
        val notif = buildNotification("Starting…")
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceCompat.startForeground(
                this, NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun acquireWakeLock() {
        if (wakeLock != null) return
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "VibeSDR:RtlTcpServer").apply {
            setReferenceCounted(false)
            acquire()
        }
    }

    private fun releaseWakeLock() {
        try { wakeLock?.let { if (it.isHeld) it.release() } } catch (_: Throwable) {}
        wakeLock = null
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            val ch = NotificationChannel(
                CHANNEL_ID, "RTL-TCP server", NotificationManager.IMPORTANCE_LOW)
            ch.setShowBadge(false)
            nm.createNotificationChannel(ch)
        }
    }

    private fun bandwidthLabel(sampleRate: Long, overrideRate: Long): String {
        if (sampleRate <= 0) return "—"
        val mhz = sampleRate / 1_000_000.0
        val clean = String.format("%.3f", mhz).trimEnd('0').trimEnd('.') + " MHz"
        return if (overrideRate > 0) "$clean (capped)" else clean
    }

    private fun statusText(): String {
        return try {
            val j = JSONObject(VibeLocalSDR.getServerStatus())
            val sr = j.optLong("sampleRate", 0)
            val ov = j.optLong("overrideRate", 0)
            val client = j.optBoolean("client", false)
            val addr = j.optString("clientAddr", "")
            val bw = bandwidthLabel(sr, ov)
            val who = if (client) (if (addr.isNotEmpty()) "client $addr" else "client connected") else "waiting for client"
            "$ip:$port · $bw · $who"
        } catch (_: Throwable) {
            "$ip:$port"
        }
    }

    private fun buildNotification(text: String): Notification {
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        val pi = PendingIntent.getActivity(
            this, 0, launch,
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0)
                or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("VibeSDR — Sharing $name")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setContentIntent(pi)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
    }

    private fun updateNotification() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIF_ID, buildNotification(statusText()))
    }

    override fun onDestroy() {
        handler.removeCallbacks(ticker)
        releaseWakeLock()
        wifiLock.release()
        super.onDestroy()
    }
}
