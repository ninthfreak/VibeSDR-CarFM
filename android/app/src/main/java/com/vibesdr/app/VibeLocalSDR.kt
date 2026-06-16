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

    /**
     * Start the local-SDR spectrum pipeline (RTL-SDR → FFT → localhost UberSDR
     * spectrum WebSocket). Returns the bound TCP port, or -1 on failure. The fd
     * must stay open (caller keeps the UsbDeviceConnection alive) until [stopSpectrum].
     */
    fun startSpectrum(
        fd: Int, vid: Int, pid: Int,
        centerFreq: Double, sampleRate: Double, gainTenthDb: Int,
        fftSize: Int, fftRate: Double, mode: String
    ): Int {
        ensureLoaded()
        return nativeStartSpectrum(fd, vid, pid, centerFreq, sampleRate, gainTenthDb, fftSize, fftRate, mode)
    }

    fun stopSpectrum() {
        if (!loaded) return
        nativeStopSpectrum()
    }

    // Hardware controls (no-ops if no session running). gainTenthDb < 0 = auto.
    fun setGain(gainTenthDb: Int) { if (loaded) nativeSetGain(gainTenthDb) }
    fun setPpm(ppm: Int) { if (loaded) nativeSetPpm(ppm) }
    fun setBiasTee(on: Boolean) { if (loaded) nativeSetBiasTee(on) }
    fun setAgc(on: Boolean) { if (loaded) nativeSetAgc(on) }
    fun setDirectSampling(mode: Int) { if (loaded) nativeSetDirectSampling(mode) }
    fun setSampleRate(rate: Double) { if (loaded) nativeSetSampleRate(rate) }
    fun setDeemphasis(tau: Double) { if (loaded) nativeSetDeemphasis(tau) }
    fun setSquelch(on: Boolean, db: Float) { if (loaded) nativeSetSquelch(on, db) }
    fun getTunerGains(): IntArray { return if (loaded) nativeGetTunerGains() ?: IntArray(0) else IntArray(0) }

    private external fun nativeHello(): String
    private external fun nativeProbeRtl(fd: Int, vid: Int, pid: Int): String
    private external fun nativeStartSpectrum(
        fd: Int, vid: Int, pid: Int,
        centerFreq: Double, sampleRate: Double, gainTenthDb: Int,
        fftSize: Int, fftRate: Double, mode: String
    ): Int
    private external fun nativeStopSpectrum()
    private external fun nativeSetGain(gainTenthDb: Int)
    private external fun nativeSetPpm(ppm: Int)
    private external fun nativeSetBiasTee(on: Boolean)
    private external fun nativeSetAgc(on: Boolean)
    private external fun nativeSetDirectSampling(mode: Int)
    private external fun nativeSetSampleRate(rate: Double)
    private external fun nativeSetDeemphasis(tau: Double)
    private external fun nativeSetSquelch(on: Boolean, db: Float)
    private external fun nativeGetTunerGains(): IntArray?
}
