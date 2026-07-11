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
        val isBoot = a == Intent.ACTION_BOOT_COMPLETED ||
                     a == Intent.ACTION_LOCKED_BOOT_COMPLETED ||
                     a == Intent.ACTION_MY_PACKAGE_REPLACED
        val isAttach = a == android.hardware.usb.UsbManager.ACTION_USB_DEVICE_ATTACHED
        if (!isBoot && !isAttach) return

        if (!VibeServerBoot.isEnabled(ctx)) return

        // Do the work off the main thread: onReceive runs on it and is time-limited,
        // while opening USB and starting the DSP is not instant.
        Thread {
            if (isAttach) {
                // The dongle just appeared. Start immediately — no UI, no unlock. This
                // is also the RECOVERY path for the boot case below.
                val err = VibeServerBoot.start(ctx)
                if (err != null) Log.w(TAG, "autostart on attach skipped: $err")
                return@Thread
            }

            // BOOT. Android's OTG host stack frequently does NOT enumerate a device
            // that was already plugged in when the phone powered up — the port only
            // enters host mode on a sensed attach, and a dongle sitting there through
            // boot never generates one. There is no API to force re-enumeration.
            //
            // So don't check once and give up: some devices DO enumerate late. Retry
            // for a couple of minutes. If it never appears, the USB_DEVICE_ATTACHED
            // branch above means a single replug (or a power-cycle of the hub) starts
            // the server with nobody touching the phone.
            val deadline = System.currentTimeMillis() + 120_000
            var lastErr: String? = null
            while (System.currentTimeMillis() < deadline) {
                lastErr = VibeServerBoot.start(ctx)
                if (lastErr == null) return@Thread                    // up and running
                if (lastErr != "no RTL-SDR attached") break           // a real failure
                Thread.sleep(5_000)
            }
            Log.w(TAG, "VibeServer autostart after boot gave up: $lastErr " +
                       "(replug the dongle — attach will start it)")
        }.start()
    }

    private companion object { const val TAG = "BootReceiver" }
}
