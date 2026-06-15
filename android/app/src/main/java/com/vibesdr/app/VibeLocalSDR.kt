package com.vibesdr.app

/**
 * VibeSDR V4 — local-SDR shim (Stage 1).
 *
 * Thin Kotlin handle onto the bundled SDR++ Brown native core. Stage 1 only
 * proves the library loads (and transitively pulls in libsdrpp_core.so). The
 * real localhost UberSDR shim — USB enumeration, IQ → FFT/SPEC, Opus audio —
 * lands in later stages behind this same object.
 *
 * Not loaded at app startup yet; call [hello] from a debug action to verify the
 * native core links and loads on-device.
 */
object VibeLocalSDR {
    @Volatile private var loaded = false

    private fun ensureLoaded() {
        if (loaded) return
        synchronized(this) {
            if (!loaded) {
                System.loadLibrary("vibelocalsdr")
                loaded = true
            }
        }
    }

    fun hello(): String {
        ensureLoaded()
        return nativeHello()
    }

    /**
     * Open an RTL-SDR from a USB file descriptor (owned by a Kotlin
     * UsbDeviceConnection) and return a human-readable description. Returns a
     * string starting with "ERROR:" on failure. The fd stays owned by Kotlin.
     */
    fun probeRtl(fd: Int, vid: Int, pid: Int): String {
        ensureLoaded()
        return nativeProbeRtl(fd, vid, pid)
    }

    private external fun nativeHello(): String
    private external fun nativeProbeRtl(fd: Int, vid: Int, pid: Int): String
}
