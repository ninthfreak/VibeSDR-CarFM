package com.vibesdr.app

import android.content.Intent
import android.hardware.usb.UsbManager
import android.net.Uri
import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

import expo.modules.ReactActivityDelegateWrapper

class MainActivity : ReactActivity() {
  companion object {
    // Set when the app is launched (or resumed) by plugging in a matching RTL-SDR
    // dongle — the USB_DEVICE_ATTACHED intent declared for this activity. JS reads
    // and clears it via VibeLocalSDR.consumeUsbLaunch() on the instance picker, to
    // route straight into Local Hardware instead of the default instance / picker.
    @Volatile @JvmField var usbLaunchPending = false

    // Set when an image is shared INTO the app (Android share sheet) — the CarFM
    // manual-logo flow: the user searches the web for a station logo in a browser,
    // long-presses it, and shares it here. JS reads+clears it via
    // VibeLocalSDR.consumeSharedLogo() and assigns it to the pending station.
    @Volatile @JvmField var sharedImagePending: Uri? = null
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // Set the theme to AppTheme BEFORE onCreate to support
    // coloring the background, status bar, and navigation bar.
    // This is required for expo-splash-screen.
    setTheme(R.style.AppTheme);
    noteIntent(intent)   // cold start: JS reads the flags when the UI mounts
    super.onCreate(null)
  }

  override fun onNewIntent(intent: Intent?) {
    super.onNewIntent(intent)
    setIntent(intent)
    noteIntent(intent)   // warm start (singleTask): consumed on next focus
  }

  private fun noteIntent(intent: Intent?) {
    if (intent?.action == UsbManager.ACTION_USB_DEVICE_ATTACHED) usbLaunchPending = true
    if (intent?.action == Intent.ACTION_SEND && intent.type?.startsWith("image/") == true) {
      sharedImagePending =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU)
          intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
        else @Suppress("DEPRECATION") intent.getParcelableExtra(Intent.EXTRA_STREAM)
    }
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "main"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate {
    return ReactActivityDelegateWrapper(
          this,
          BuildConfig.IS_NEW_ARCHITECTURE_ENABLED,
          object : DefaultReactActivityDelegate(
              this,
              mainComponentName,
              fabricEnabled
          ){})
  }

  /**
    * Align the back button behavior with Android S
    * where moving root activities to background instead of finishing activities.
    * @see <a href="https://developer.android.com/reference/android/app/Activity#onBackPressed()">onBackPressed</a>
    */
  override fun invokeDefaultOnBackPressed() {
      if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.R) {
          if (!moveTaskToBack(false)) {
              // For non-root activities, use the default implementation to finish them.
              super.invokeDefaultOnBackPressed()
          }
          return
      }

      // Use the default back button implementation on Android S
      // because it's doing more than [Activity.moveTaskToBack] in fact.
      super.invokeDefaultOnBackPressed()
  }
}
