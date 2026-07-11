package com.vibesdr.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Restart VibeServer after a reboot.
 *
 * The case this exists for: an OS update reboots the phone at 3am and a receiver
 * that was meant to be left running is simply gone until someone walks over to it.
 *
 * NB we start a foreground SERVICE, never an Activity. Android has blocked
 * background activity starts since Android 10, so launching the UI from here is not
 * possible — and not wanted: the phone boots to its normal lock screen, screen off,
 * with the server already running behind it. No app on screen means no unlocked app
 * on screen, so the headless case is secure by default rather than by kiosk-mode
 * gymnastics.
 *
 * Starting a foreground service from BOOT_COMPLETED is explicitly exempt from
 * Android 12's "no background FGS starts" rule, which is what makes this legal.
 *
 * ACTION_MY_PACKAGE_REPLACED is handled too — an app UPDATE also stops the service,
 * and a self-hosted receiver shouldn't need a human after every Play update either.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val a = intent.action
        if (a != Intent.ACTION_BOOT_COMPLETED &&
            a != Intent.ACTION_LOCKED_BOOT_COMPLETED &&
            a != Intent.ACTION_MY_PACKAGE_REPLACED) return

        if (!VibeServerBoot.isEnabled(ctx)) return

        // Do the work off the main thread: onReceive runs on it and is time-limited,
        // and opening USB + starting the DSP is not instant.
        Thread {
            val err = VibeServerBoot.start(ctx)
            if (err != null) Log.w("BootReceiver", "VibeServer autostart skipped: $err")
        }.start()
    }
}
