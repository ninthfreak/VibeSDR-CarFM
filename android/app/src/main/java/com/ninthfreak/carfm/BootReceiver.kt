package com.ninthfreak.carfm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Bring CarFM up when the head unit comes back.
 *
 * TWO DIFFERENT EVENTS, and on this hardware only one of them ever happens.
 *
 * `BOOT_COMPLETED` is the classic case: a genuine cold start. That is what this
 * receiver was originally written for, and on a permanent install it fires
 * roughly never — because the unit does not cold-boot on an ignition cycle.
 *
 * `com.nwd.ACTION_OS_WAKE_UP` is what actually happens. The MCU puts the SoC to
 * sleep on ACC-off (the vendor service handles `ACTION_ACCOFF_UPDATE` going
 * down) and wakes it on ACC-on. CarFM is not running when it comes back, so the
 * system kills the process while it sleeps — the vendor service has a
 * `com.nwd.ACTION_KILL_OTHER_APP` broadcast, which is the likely instrument.
 *
 * A dead process is exactly why this must be a MANIFEST-declared receiver: only
 * a manifest registration causes Android to start the process to deliver the
 * broadcast. A runtime-registered receiver dies with the app and would never see
 * the wake.
 *
 * That vendor broadcasts reach an ordinary app at all is not an assumption —
 * CarFM already receives `com.nwd.action.ACTION_KEY_VALUE` for the steering
 * wheel, and that works.
 *
 * ── Why the wake path is CONDITIONAL and the boot path is not ─────────────────
 *
 * On boot there is nothing else the driver could have been doing, so coming up
 * is right. On a wake there is: if they were on maps or a music app when the
 * ignition went off, taking the foreground back would be obnoxious. The flag
 * MainActivity keeps answers that question, and it is the last thing the process
 * recorded before it was killed.
 *
 * ── The known risk ───────────────────────────────────────────────────────────
 *
 * Android 10+ restricts starting an activity from the background, which is what
 * this does. Head-unit ROMs are usually permissive and this one is old, but if
 * the launch is refused there will be no crash and no visible effect — so the
 * failure is logged rather than swallowed, and the tuner log is where to look.
 */
class BootReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "CarFmLaunch"
        /** The MCU's wake broadcast, from com.nwd.radio.service v214. */
        const val ACTION_OS_WAKE_UP = "com.nwd.ACTION_OS_WAKE_UP"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val conditional = when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_LOCKED_BOOT_COMPLETED,
            "android.intent.action.QUICKBOOT_POWERON" -> false
            ACTION_OS_WAKE_UP -> true
            else -> return
        }

        if (conditional && !wasForeground(context)) {
            Log.i(TAG, "${intent.action}: CarFM was not in front — leaving it alone")
            return
        }

        try {
            val launch = context.packageManager
                .getLaunchIntentForPackage(context.packageName)
            if (launch == null) {
                Log.w(TAG, "no launch intent for ${context.packageName}")
                return
            }
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            launch.putExtra("carBootAutostart", true)
            context.startActivity(launch)
            Log.i(TAG, "${intent.action}: brought CarFM forward")
        } catch (e: Exception) {
            // The likely one is a background-activity-start refusal on a newer
            // Android. Nothing to recover — say so plainly so it is diagnosable
            // rather than looking like the broadcast never arrived.
            Log.w(TAG, "${intent.action}: launch refused: ${e.message}")
        }
    }

    private fun wasForeground(context: Context): Boolean = try {
        context.getSharedPreferences(MainActivity.WAKE_PREFS, Context.MODE_PRIVATE)
            .getBoolean(MainActivity.WAKE_KEY_WAS_FOREGROUND, false)
    } catch (e: Exception) {
        Log.w(TAG, "could not read the foreground flag: ${e.message}")
        false
    }
}
