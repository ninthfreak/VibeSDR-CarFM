package com.vibesdr.app

import android.content.Context
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log

/**
 * Restart VibeServer after a reboot — with NO JS, NO Activity and NO user present.
 *
 * This is the "leave it in the shed" path. An OS update reboots the phone at 3am;
 * without this the receiver is simply gone until someone walks over and opens the
 * app. So the whole flow has to work headless, which drives three design choices:
 *
 *  1. CONFIG LIVES IN DEVICE-PROTECTED SharedPreferences, mirrored from JS whenever
 *     the host starts the server. Two separate reasons, and the second is the one
 *     that decides whether this works at all:
 *       - We cannot read AsyncStorage here (RN's SQLite store) — that would mean
 *         starting the JS runtime just to learn a port number.
 *       - After a reboot Android does NOT send ACTION_BOOT_COMPLETED until a human
 *         unlocks the phone ONCE. Until then it's Direct Boot, and normal
 *         (credential-encrypted) storage cannot be read. A server that waits for
 *         someone to walk to the shed and type a PIN is not an unattended server.
 *         So: directBootAware receiver + LOCKED_BOOT_COMPLETED + device-protected
 *         prefs, which ARE readable before first unlock.
 *
 *  2. WE NEVER PROMPT. UsbManager.requestPermission() puts a dialog on screen and
 *     waits for a human; at boot there isn't one. If we don't already hold
 *     permission we log and give up, and the host re-opens the app once. Permission
 *     normally DOES persist, because the manifest's USB_DEVICE_ATTACHED filter +
 *     device_filter make Android grant it implicitly for a matching dongle.
 *
 *  3. mDNS IS REGISTERED HERE, standalone. VibeMdnsModule.advertise() is a
 *     @ReactMethod taking a Promise — useless without a JS bridge — so this keeps
 *     its own NsdManager registration rather than drag the React module into a
 *     context where it cannot exist.
 *
 * The foreground service (RtlTcpServerService, type connectedDevice) is what keeps
 * this alive afterwards; starting an FGS from BOOT_COMPLETED is explicitly exempt
 * from Android 12's background-FGS-start restriction.
 */
object VibeServerBoot {
    private const val TAG = "VibeServerBoot"
    private const val PREFS = "vibe_server_boot"

    // Mirrored from the JS server screen at start().
    private const val K_ENABLED   = "autostart"
    private const val K_NAME      = "name"
    private const val K_PIN       = "pin"
    private const val K_RATE      = "sampleRate"
    private const val K_LOCKED    = "lockedRate"
    private const val K_FFTRATE   = "maxFftRate"
    private const val K_COMPRESS  = "compressAudio"
    private const val K_WEB       = "webServer"
    private const val K_ADVERTISE = "advertise"

    private var nsd: NsdManager? = null
    private var registration: NsdManager.RegistrationListener? = null

    /**
     * DEVICE-protected storage, not the default credential-protected store.
     *
     * This is the difference between the shed working and not working. After a
     * reboot, Android does NOT deliver ACTION_BOOT_COMPLETED until a human unlocks
     * the phone for the first time; until then the device is in Direct Boot and
     * credential-encrypted storage — where ordinary SharedPreferences live — cannot
     * be read at all. A server that waits for someone to walk over and type a PIN is
     * not an unattended server.
     *
     * Device-protected storage is readable before first unlock, so the config we need
     * at LOCKED_BOOT_COMPLETED is here. Nothing sensitive goes in it beyond the PIN,
     * which is a LAN access code, not a credential.
     */
    private fun prefsCtx(ctx: Context): Context =
        ctx.createDeviceProtectedStorageContext() ?: ctx

    private fun prefs(ctx: Context) =
        prefsCtx(ctx).getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Persist the running config so a reboot can reproduce it. Called from JS. */
    fun saveConfig(
        ctx: Context, enabled: Boolean, name: String, pin: String,
        sampleRate: Double, lockedRate: Double, maxFftRate: Double,
        compressAudio: Boolean, webServer: Boolean, advertise: Boolean,
    ) {
        prefs(ctx).edit()
            .putBoolean(K_ENABLED, enabled)
            .putString(K_NAME, name)
            .putString(K_PIN, pin)
            .putFloat(K_RATE, sampleRate.toFloat())
            .putFloat(K_LOCKED, lockedRate.toFloat())
            .putFloat(K_FFTRATE, maxFftRate.toFloat())
            .putBoolean(K_COMPRESS, compressAudio)
            .putBoolean(K_WEB, webServer)
            .putBoolean(K_ADVERTISE, advertise)
            .apply()
    }

    fun setEnabled(ctx: Context, on: Boolean) {
        prefs(ctx).edit().putBoolean(K_ENABLED, on).apply()
    }

    fun isEnabled(ctx: Context): Boolean = prefs(ctx).getBoolean(K_ENABLED, false)

    /**
     * Bring the server back up. Returns a short reason on failure, null on success —
     * the caller only logs it (there is nobody to tell).
     */
    @Volatile private var running = false

    @Synchronized
    fun start(ctx: Context): String? {
        val p = prefs(ctx)
        if (!p.getBoolean(K_ENABLED, false)) return "autostart off"
        // The boot RETRY LOOP and a USB ATTACH can both fire — an attach during the
        // boot poll is in fact the expected sequence. Without this they would both
        // open the dongle and the second would tear the fd out from under the first.
        if (running) return null
        // ...and the APP may already be serving (started from the UI), in which case
        // our own flag says nothing. Ask the shim, which is the single source of truth.
        if (isShimServing()) return null

        val mgr = ctx.getSystemService(Context.USB_SERVICE) as? UsbManager
            ?: return "no USB service"
        val dev: UsbDevice = mgr.deviceList.values.firstOrNull { isRtlSdr(it) }
            ?: return "no RTL-SDR attached"

        // Cannot prompt: there is no user and no foreground activity. See (2) above.
        if (!mgr.hasPermission(dev)) return "no USB permission (open the app once)"

        val conn = mgr.openDevice(dev) ?: return "openDevice returned null"
        val fd = conn.fileDescriptor
        if (fd < 0) { conn.close(); return "bad fd" }

        val name     = p.getString(K_NAME, "VibeSDR") ?: "VibeSDR"
        val pin      = p.getString(K_PIN, "") ?: ""
        val rate     = p.getFloat(K_RATE, 2_400_000f).toDouble()
        val locked   = p.getFloat(K_LOCKED, 0f).toDouble()
        val fftRate  = p.getFloat(K_FFTRATE, 20f).toDouble()

        VibeLocalSDR.setVibeServerAuth(pin)
        VibeLocalSDR.setVibeServerLimits(0.0, fftRate)
        VibeLocalSDR.setVibeServerCompressAudio(p.getBoolean(K_COMPRESS, true))
        VibeLocalSDR.setVibeServerWebEnabled(p.getBoolean(K_WEB, true))
        VibeLocalSDR.setVibeServerLockedRate(locked)
        VibeLocalSDR.setServeOnLan(true)

        val port = VibeLocalSDR.startSpectrum(
            fd, dev.vendorId, dev.productId,
            100_000_000.0, rate, -1, 1024, fftRate, "nfm")
        if (port <= 0) {
            VibeLocalSDR.setServeOnLan(false)
            conn.close()
            return "native startSpectrum failed"
        }
        // The connection must outlive this call — the shim owns the fd until stop.
        heldConn = conn
        running = true

        val ip = getLocalIp() ?: "0.0.0.0"
        RtlTcpServerService.start(ctx, name, ip, port, "vibeserver")
        if (p.getBoolean(K_ADVERTISE, true)) advertise(ctx, name, port, pin.isNotEmpty())

        Log.i(TAG, "VibeServer restarted after boot: $ip:$port as \"$name\"")
        return null
    }

    /** Kotlin must keep the UsbDeviceConnection alive — the native shim holds the raw
     *  fd, and letting this be collected closes it out from under the DSP thread. */
    private var heldConn: android.hardware.usb.UsbDeviceConnection? = null

    /** Is the shim already serving? Covers the case where the APP started it. */
    private fun isShimServing(): Boolean = try {
        VibeLocalSDR.getVibeServerStatus().contains("\"running\":true")
    } catch (_: Throwable) { false }

    private fun isRtlSdr(dev: UsbDevice): Boolean {
        // Same VID/PID set the module matches on (Realtek 0x0bda + the usual clones).
        val key = (dev.vendorId shl 16) or dev.productId
        return VibeLocalSdrModule.RTL_SDR_VIDPIDS.contains(key)
    }

    private fun advertise(ctx: Context, name: String, port: Int, pinRequired: Boolean) {
        try {
            val m = ctx.getSystemService(Context.NSD_SERVICE) as? NsdManager ?: return
            nsd = m
            val info = NsdServiceInfo().apply {
                serviceName = name
                serviceType = "_vibesdr._tcp."
                this.port = port
                setAttribute("name", name)
                setAttribute("proto", "vibeserver")
                setAttribute("pin", if (pinRequired) "1" else "0")
            }
            val l = object : NsdManager.RegistrationListener {
                override fun onServiceRegistered(i: NsdServiceInfo) {}
                override fun onRegistrationFailed(i: NsdServiceInfo, e: Int) {
                    Log.w(TAG, "boot advertise failed: $e")
                }
                override fun onServiceUnregistered(i: NsdServiceInfo) {}
                override fun onUnregistrationFailed(i: NsdServiceInfo, e: Int) {}
            }
            registration = l
            m.registerService(info, NsdManager.PROTOCOL_DNS_SD, l)
        } catch (t: Throwable) {
            Log.w(TAG, "boot advertise threw: ${t.message}")
        }
    }

    private fun getLocalIp(): String? {
        return try {
            var fallback: String? = null
            for (nif in java.net.NetworkInterface.getNetworkInterfaces()) {
                if (!nif.isUp || nif.isLoopback) continue
                for (addr in nif.inetAddresses) {
                    if (addr.isLoopbackAddress || addr !is java.net.Inet4Address) continue
                    val ip = addr.hostAddress ?: continue
                    val n = nif.name.lowercase()
                    if (n.startsWith("wlan") || n.startsWith("ap") || n.startsWith("swlan")) return ip
                    if (fallback == null) fallback = ip
                }
            }
            fallback
        } catch (_: Throwable) { null }
    }
}
