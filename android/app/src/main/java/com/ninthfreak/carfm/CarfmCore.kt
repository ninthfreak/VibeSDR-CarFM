package com.ninthfreak.carfm

import android.util.Log

/**
 * The portable Rust core, reached over JNI (`core/jni`).
 *
 * FIRST CALLER. `core/rds` and `core/stations` have been proven equal to the
 * TypeScript over a generated corpus, but nothing had ever run them on this
 * hardware and no TypeScript has been retired because of them. This object is
 * the seam that changes that.
 *
 * NOT WIRED INTO THE TUNER YET, deliberately. The intended first use is shadow
 * mode: feed the RDS pump's groups to both decoders, keep letting JavaScript
 * drive the face, and record where they disagree. `rdsPush` returns the same
 * one-line string `carfm_rds::format_state` gives the differential harness, so a
 * device capture diffs against the TypeScript decoder's output for the same
 * groups with no conversion.
 *
 * LOADING IS OPTIONAL AND MUST STAY THAT WAY. `libcarfm_jni.so` is built by
 * `tools/build-core-android.sh`, which is not part of the Gradle build — so a
 * clean checkout, a CI build, or anyone who has not run that script produces an
 * APK without it. [available] is false there and every call below is refused,
 * rather than taking the radio down with an UnsatisfiedLinkError in a car.
 */
object CarfmCore {
    private const val TAG = "CarfmCore"

    /** True only if the native library actually loaded. Check before calling. */
    @JvmStatic
    val available: Boolean = try {
        System.loadLibrary("carfm_jni")
        Log.i(TAG, "portable core loaded")
        true
    } catch (t: Throwable) {
        // Expected whenever the .so was not built. Info, not warn: this is the
        // normal state of the tree today, not a fault.
        Log.i(TAG, "portable core not present (${t.javaClass.simpleName}) — JS decoder only")
        false
    }

    /** Allocate a decoder. Returns an opaque handle, or 0 if unavailable. */
    fun newRds(): Long = if (available) rdsNew() else 0L

    /** Release a decoder. Safe to call with 0. */
    fun freeRds(handle: Long) { if (available && handle != 0L) rdsFree(handle) }

    /**
     * Feed one 16-hex-char group. Returns the state line when a user-visible
     * field changed and null when nothing did — the same contract as the
     * TypeScript decoder's push, so the caller can log changes and nothing else.
     *
     * The handle is NOT thread-safe. The RDS pump is one thread and owns it.
     */
    fun pushRds(handle: Long, hex: String): String? =
        if (available && handle != 0L) rdsPush(handle, hex) else null

    fun stateRds(handle: Long): String? =
        if (available && handle != 0L) rdsState(handle) else null

    fun resetRds(handle: Long) { if (available && handle != 0L) rdsReset(handle) }
    fun resetRdsForRetune(handle: Long) { if (available && handle != 0L) rdsResetForRetune(handle) }
    fun clearRdsTa(handle: Long) { if (available && handle != 0L) rdsClearTa(handle) }

    // The raw JNI surface. Private so nothing can reach it without the
    // [available] guard above — calling one of these without the library loaded
    // is an UnsatisfiedLinkError, and the wrappers exist to make that
    // unreachable.
    private external fun rdsNew(): Long
    private external fun rdsFree(handle: Long)
    private external fun rdsPush(handle: Long, hex: String): String?
    private external fun rdsState(handle: Long): String?
    private external fun rdsReset(handle: Long)
    private external fun rdsResetForRetune(handle: Long)
    private external fun rdsClearTa(handle: Long)
}
