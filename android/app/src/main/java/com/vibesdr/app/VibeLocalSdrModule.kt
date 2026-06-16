package com.vibesdr.app

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap

/**
 * VibeSDR V4 — local-SDR USB bridge (Android only).
 *
 * Owns the Android side of the V4 local-hardware path: enumerate attached
 * RTL-SDR dongles, run the USB permission dance, and on grant hand the
 * UsbDeviceConnection's file descriptor to the native shim
 * ([VibeLocalSDR.probeRtl]) which opens the device via librtlsdr.
 *
 * Stage 2 only enumerates + probes (logs device identity). Later stages start
 * the localhost UberSDR shim against the opened fd.
 */
class VibeLocalSdrModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val TAG = "VibeLocalSDR"
    private val ACTION_USB_PERMISSION = "com.vibesdr.app.USB_PERMISSION"

    private val usbManager: UsbManager?
        get() = reactContext.getSystemService(Context.USB_SERVICE) as? UsbManager

    override fun getName() = "VibeLocalSDR"

    private fun isRtlSdr(dev: UsbDevice): Boolean {
        val key = (dev.vendorId shl 16) or dev.productId
        return RTL_SDR_VIDPIDS.contains(key)
    }

    private fun describe(dev: UsbDevice, hasPermission: Boolean): WritableMap {
        val m = Arguments.createMap()
        m.putString("deviceName", dev.deviceName)
        m.putInt("vendorId", dev.vendorId)
        m.putInt("productId", dev.productId)
        m.putString("vendorIdHex", String.format("0x%04x", dev.vendorId))
        m.putString("productIdHex", String.format("0x%04x", dev.productId))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP_MR1) {
            m.putString("productName", dev.productName ?: "")
            m.putString("manufacturerName", dev.manufacturerName ?: "")
        }
        m.putBoolean("hasPermission", hasPermission)
        return m
    }

    /** List attached RTL-SDR dongles (filtered by the known VID/PID allowlist). */
    @ReactMethod
    fun listDevices(promise: Promise) {
        val mgr = usbManager ?: run { promise.reject("no_usb", "USB service unavailable"); return }
        val out: WritableArray = Arguments.createArray()
        for ((_, dev) in mgr.deviceList) {
            if (!isRtlSdr(dev)) continue
            out.pushMap(describe(dev, mgr.hasPermission(dev)))
        }
        promise.resolve(out)
    }

    private var pendingPromise: Promise? = null

    /**
     * Open the first attached RTL-SDR (requesting USB permission if needed) and
     * probe it via the native shim. Resolves with a description string, or
     * rejects on no-device / denied-permission / open failure.
     */
    @ReactMethod
    fun openAndProbe(promise: Promise) {
        val mgr = usbManager ?: run { promise.reject("no_usb", "USB service unavailable"); return }
        val dev = mgr.deviceList.values.firstOrNull { isRtlSdr(it) }
            ?: run { promise.reject("no_device", "No RTL-SDR found"); return }

        if (mgr.hasPermission(dev)) {
            openAndProbe(mgr, dev, promise)
            return
        }

        if (pendingPromise != null) {
            promise.reject("busy", "A USB permission request is already in progress")
            return
        }
        pendingPromise = promise
        registerUsbReceiver()
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
            PendingIntent.FLAG_MUTABLE else 0
        val intent = Intent(ACTION_USB_PERMISSION).setPackage(reactContext.packageName)
        val pi = PendingIntent.getBroadcast(reactContext, 0, intent, flags)
        Log.i(TAG, "requesting USB permission for $dev")
        mgr.requestPermission(dev, pi)
    }

    private fun openAndProbe(mgr: UsbManager, dev: UsbDevice, promise: Promise) {
        val conn = mgr.openDevice(dev)
            ?: run { promise.reject("open_failed", "openDevice returned null"); return }
        try {
            val fd = conn.fileDescriptor
            if (fd < 0) { promise.reject("bad_fd", "Invalid file descriptor"); return }
            val desc = VibeLocalSDR.probeRtl(fd, dev.vendorId, dev.productId)
            Log.i(TAG, "probe result: $desc")
            if (desc.startsWith("ERROR:")) promise.reject("probe_failed", desc)
            else promise.resolve(desc)
        } catch (e: Throwable) {
            promise.reject("probe_exception", e.message, e)
        } finally {
            conn.close()
        }
    }

    // ── Spectrum session (Stage 3) ────────────────────────────────────────
    // The UsbDeviceConnection must stay open for the whole session (the native
    // shim holds the fd), so we keep it here rather than close it after open.
    private var sessionConn: android.hardware.usb.UsbDeviceConnection? = null

    /**
     * Open the first attached RTL-SDR and start the local-SDR spectrum server.
     * Resolves with { port, wsBaseUrl } so JS can point UberSDRClient at
     * ws://127.0.0.1:<port>. Requests USB permission first if needed.
     */
    @ReactMethod
    fun startSpectrum(opts: com.facebook.react.bridge.ReadableMap, promise: Promise) {
        val mgr = usbManager ?: run { promise.reject("no_usb", "USB service unavailable"); return }
        val dev = mgr.deviceList.values.firstOrNull { isRtlSdr(it) }
            ?: run { promise.reject("no_device", "No RTL-SDR found"); return }
        if (!mgr.hasPermission(dev)) {
            // Reuse the permission flow, then retry once granted.
            openAndProbeThen(mgr, dev, promise) { startSpectrumNow(mgr, dev, opts, promise) }
            return
        }
        startSpectrumNow(mgr, dev, opts, promise)
    }

    private fun startSpectrumNow(
        mgr: UsbManager, dev: UsbDevice,
        opts: com.facebook.react.bridge.ReadableMap, promise: Promise
    ) {
        stopSpectrumInternal()
        val conn = mgr.openDevice(dev)
            ?: run { promise.reject("open_failed", "openDevice returned null"); return }
        val fd = conn.fileDescriptor
        if (fd < 0) { conn.close(); promise.reject("bad_fd", "Invalid file descriptor"); return }
        sessionConn = conn

        val centerFreq = if (opts.hasKey("centerFreq")) opts.getDouble("centerFreq") else 100_000_000.0
        val sampleRate = if (opts.hasKey("sampleRate")) opts.getDouble("sampleRate") else 2_400_000.0
        val gain       = if (opts.hasKey("gainTenthDb")) opts.getInt("gainTenthDb") else -1 // auto
        val fftSize    = if (opts.hasKey("fftSize")) opts.getInt("fftSize") else 1024
        val fftRate    = if (opts.hasKey("fftRate")) opts.getDouble("fftRate") else 20.0
        val mode       = if (opts.hasKey("mode")) opts.getString("mode") ?: "nfm" else "nfm"

        val port = VibeLocalSDR.startSpectrum(
            fd, dev.vendorId, dev.productId, centerFreq, sampleRate, gain, fftSize, fftRate, mode)
        if (port <= 0) {
            conn.close(); sessionConn = null
            promise.reject("start_failed", "native startSpectrum failed (see logcat)")
            return
        }
        Log.i(TAG, "spectrum started on port $port")
        val res = Arguments.createMap()
        res.putInt("port", port)
        res.putString("wsBaseUrl", "http://127.0.0.1:$port")
        promise.resolve(res)
    }

    @ReactMethod
    fun stopSpectrum(promise: Promise) {
        stopSpectrumInternal()
        promise.resolve(null)
    }

    // ── Hardware controls ──────────────────────────────────────────────────
    @ReactMethod fun setGain(gainTenthDb: Double) { VibeLocalSDR.setGain(gainTenthDb.toInt()) }
    @ReactMethod fun setPpm(ppm: Double) { VibeLocalSDR.setPpm(ppm.toInt()) }
    @ReactMethod fun setBiasTee(on: Boolean) { VibeLocalSDR.setBiasTee(on) }
    @ReactMethod fun setAgc(on: Boolean) { VibeLocalSDR.setAgc(on) }
    @ReactMethod fun setDirectSampling(mode: Double) { VibeLocalSDR.setDirectSampling(mode.toInt()) }
    @ReactMethod fun setSampleRate(rate: Double) { VibeLocalSDR.setSampleRate(rate) }
    @ReactMethod fun setDeemphasis(tau: Double) { VibeLocalSDR.setDeemphasis(tau) }
    @ReactMethod fun setSquelch(on: Boolean, db: Double) { VibeLocalSDR.setSquelch(on, db.toFloat()) }
    @ReactMethod fun setNR(on: Boolean) { VibeLocalSDR.setNR(on) }
    @ReactMethod fun setNrStrength(s: Double) { VibeLocalSDR.setNrStrength(s.toFloat()) }
    @ReactMethod fun startDecoderService(promise: Promise) { promise.resolve(VibeLocalSDR.startDecoderService()) }
    @ReactMethod fun feedDecoderPcm(b64: String, rate: Double) { VibeLocalSDR.feedDecoderPcm(b64, rate.toInt()) }
    @ReactMethod fun stopDecoderService() { VibeLocalSDR.stopSpectrum() }
    @ReactMethod fun getNrCpu(promise: Promise) { promise.resolve(VibeLocalSDR.getNrCpu().toDouble()) }

    /** Supported tuner gains in tenths of dB (e.g. 207 = 20.7 dB). */
    @ReactMethod
    fun getTunerGains(promise: Promise) {
        val gains = VibeLocalSDR.getTunerGains()
        val arr = Arguments.createArray()
        for (g in gains) arr.pushInt(g)
        promise.resolve(arr)
    }

    private fun stopSpectrumInternal() {
        try { VibeLocalSDR.stopSpectrum() } catch (_: Throwable) {}
        sessionConn?.let { try { it.close() } catch (_: Exception) {} }
        sessionConn = null
    }

    // Like openAndProbe's permission path, but runs [onGranted] instead of probing.
    private var grantedAction: (() -> Unit)? = null
    private fun openAndProbeThen(mgr: UsbManager, dev: UsbDevice, promise: Promise, onGranted: () -> Unit) {
        if (pendingPromise != null) { promise.reject("busy", "USB permission request in progress"); return }
        pendingPromise = promise
        grantedAction = onGranted
        registerUsbReceiver()
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        val intent = Intent(ACTION_USB_PERMISSION).setPackage(reactContext.packageName)
        mgr.requestPermission(dev, PendingIntent.getBroadcast(reactContext, 0, intent, flags))
    }

    private var receiver: BroadcastReceiver? = null

    private fun registerUsbReceiver() {
        if (receiver != null) return
        val r = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                if (intent.action != ACTION_USB_PERMISSION) return
                val promise = pendingPromise
                pendingPromise = null
                unregisterUsbReceiver()
                val mgr = usbManager
                @Suppress("DEPRECATION")
                val dev = intent.getParcelableExtra<UsbDevice>(UsbManager.EXTRA_DEVICE)
                val granted = intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)
                val action = grantedAction
                grantedAction = null
                if (promise == null) return
                if (!granted || dev == null || mgr == null) {
                    promise.reject("permission_denied", "USB permission denied")
                    return
                }
                if (action != null) action() else openAndProbe(mgr, dev, promise)
            }
        }
        receiver = r
        val filter = IntentFilter(ACTION_USB_PERMISSION)
        ContextCompat.registerReceiver(
            reactContext, r, filter, ContextCompat.RECEIVER_NOT_EXPORTED
        )
    }

    private fun unregisterUsbReceiver() {
        receiver?.let {
            try { reactContext.unregisterReceiver(it) } catch (_: Exception) {}
        }
        receiver = null
    }

    override fun invalidate() {
        unregisterUsbReceiver()
        pendingPromise = null
        stopSpectrumInternal()
        super.invalidate()
    }

    companion object {
        // RTL-SDR VID/PID allowlist (from SDR++ Brown), packed as (vid<<16)|pid.
        private val RTL_SDR_VIDPIDS: Set<Int> = listOf(
            0x0bda to 0x2832, 0x0bda to 0x2838, 0x0413 to 0x6680, 0x0413 to 0x6f0f,
            0x0458 to 0x707f, 0x0ccd to 0x00a9, 0x0ccd to 0x00b3, 0x0ccd to 0x00b4,
            0x0ccd to 0x00b5, 0x0ccd to 0x00b7, 0x0ccd to 0x00b8, 0x0ccd to 0x00b9,
            0x0ccd to 0x00c0, 0x0ccd to 0x00c6, 0x0ccd to 0x00d3, 0x0ccd to 0x00d7,
            0x0ccd to 0x00e0, 0x1554 to 0x5020, 0x15f4 to 0x0131, 0x15f4 to 0x0133,
            0x185b to 0x0620, 0x185b to 0x0650, 0x185b to 0x0680, 0x1b80 to 0xd393,
            0x1b80 to 0xd394, 0x1b80 to 0xd395, 0x1b80 to 0xd397, 0x1b80 to 0xd398,
            0x1b80 to 0xd39d, 0x1b80 to 0xd3a4, 0x1b80 to 0xd3a8, 0x1b80 to 0xd3af,
            0x1b80 to 0xd3b0, 0x1d19 to 0x1101, 0x1d19 to 0x1102, 0x1d19 to 0x1103,
            0x1d19 to 0x1104, 0x1f4d to 0xa803, 0x1f4d to 0xb803, 0x1f4d to 0xc803,
            0x1f4d to 0xd286, 0x1f4d to 0xd803
        ).map { (vid, pid) -> (vid shl 16) or pid }.toSet()
    }
}
