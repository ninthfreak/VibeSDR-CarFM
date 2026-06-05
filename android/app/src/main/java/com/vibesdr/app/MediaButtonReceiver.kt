package com.vibesdr.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class MediaButtonReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            "play"  -> MediaService.controlListener?.onPlay()
            "pause" -> MediaService.controlListener?.onPause()
            "next"  -> MediaService.controlListener?.onNext()
            "prev"  -> MediaService.controlListener?.onPrev()
        }
    }
}
