package com.vibesdr.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.media.app.NotificationCompat.MediaStyle

class MediaService : Service() {

    companion object {
        const val CHANNEL_ID     = "vibesdr_media"
        const val NOTIF_ID       = 1001
        const val EXTRA_TITLE    = "title"
        const val EXTRA_ARTIST   = "artist"
        const val EXTRA_PLAYING  = "playing"

        var controlListener: ControlListener? = null

        interface ControlListener {
            fun onPlay()
            fun onPause()
            fun onNext()
            fun onPrev()
        }
    }

    private var mediaSession: MediaSessionCompat? = null
    private var notificationManager: NotificationManager? = null
    private var audioManager: AudioManager? = null
    private var focusRequest: AudioFocusRequest? = null

    private var currentTitle  = "VibeSDR"
    private var currentArtist = "SDR Receiver"
    private var isPlaying     = true

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    override fun onCreate() {
        super.onCreate()
        notificationManager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        audioManager        = getSystemService(AUDIO_SERVICE) as AudioManager
        createChannel()
        setupMediaSession()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        intent?.let {
            currentTitle  = it.getStringExtra(EXTRA_TITLE)            ?: currentTitle
            currentArtist = it.getStringExtra(EXTRA_ARTIST)           ?: currentArtist
            isPlaying     = it.getBooleanExtra(EXTRA_PLAYING, isPlaying)
        }
        updateMetadata()
        updatePlaybackState()
        requestAudioFocus()

        val notif = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, notif,
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            startForeground(NOTIF_ID, notif)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        abandonAudioFocus()
        mediaSession?.apply { isActive = false; release() }
        mediaSession = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ── Public update (called by module without re-starting) ──────────────────

    fun update(title: String, artist: String, playing: Boolean) {
        val changed = title != currentTitle || artist != currentArtist || playing != isPlaying
        if (!changed) return
        currentTitle  = title
        currentArtist = artist
        isPlaying     = playing
        updateMetadata()
        updatePlaybackState()
        notificationManager?.notify(NOTIF_ID, buildNotification())
    }

    // ── MediaSession ──────────────────────────────────────────────────────────

    private fun setupMediaSession() {
        mediaSession = MediaSessionCompat(this, "VibeSDR").apply {
            setCallback(object : MediaSessionCompat.Callback() {
                override fun onPlay() {
                    isPlaying = true
                    updatePlaybackState()
                    notificationManager?.notify(NOTIF_ID, buildNotification())
                    controlListener?.onPlay()
                }
                override fun onPause() {
                    isPlaying = false
                    updatePlaybackState()
                    notificationManager?.notify(NOTIF_ID, buildNotification())
                    controlListener?.onPause()
                }
                override fun onSkipToNext()     { controlListener?.onNext() }
                override fun onSkipToPrevious() { controlListener?.onPrev() }
                override fun onStop()           { stopSelf() }
            })
            setFlags(
                MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS or
                MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS
            )
            isActive = true
        }
    }

    private fun updateMetadata() {
        mediaSession?.setMetadata(
            MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE,  currentTitle)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, currentArtist)
                .build()
        )
    }

    private fun updatePlaybackState() {
        val state = if (isPlaying) PlaybackStateCompat.STATE_PLAYING
                    else           PlaybackStateCompat.STATE_PAUSED
        mediaSession?.setPlaybackState(
            PlaybackStateCompat.Builder()
                .setState(state, PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1f)
                .setActions(
                    PlaybackStateCompat.ACTION_PLAY              or
                    PlaybackStateCompat.ACTION_PAUSE             or
                    PlaybackStateCompat.ACTION_SKIP_TO_NEXT      or
                    PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS  or
                    PlaybackStateCompat.ACTION_STOP
                )
                .build()
        )
    }

    // ── Notification ──────────────────────────────────────────────────────────

    private fun buildNotification(): Notification {
        val openIntent = PendingIntent.getActivity(
            this, 0,
            packageManager.getLaunchIntentForPackage(packageName),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val prevIntent = mediaActionIntent("prev", 10)
        val playIntent = mediaActionIntent(if (isPlaying) "pause" else "play", 11)
        val nextIntent = mediaActionIntent("next", 12)

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(currentTitle)
            .setContentText(currentArtist)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentIntent(openIntent)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .addAction(android.R.drawable.ic_media_previous, "Previous", prevIntent)
            .addAction(
                if (isPlaying) android.R.drawable.ic_media_pause
                else           android.R.drawable.ic_media_play,
                if (isPlaying) "Pause" else "Play",
                playIntent
            )
            .addAction(android.R.drawable.ic_media_next, "Next", nextIntent)
            .setStyle(
                MediaStyle()
                    .setMediaSession(mediaSession?.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2)
            )
            .build()
    }

    private fun mediaActionIntent(action: String, requestCode: Int): PendingIntent {
        val intent = Intent(this, MediaButtonReceiver::class.java).apply {
            this.action = action
        }
        return PendingIntent.getBroadcast(
            this, requestCode, intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
    }

    // ── Notification channel ──────────────────────────────────────────────────

    private fun createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val ch = NotificationChannel(
                CHANNEL_ID,
                "VibeSDR Media Controls",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "SDR audio stream controls"
                setShowBadge(false)
            }
            notificationManager?.createNotificationChannel(ch)
        }
    }

    // ── Audio focus ───────────────────────────────────────────────────────────

    private fun requestAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                        .build()
                )
                .build()
            audioManager?.requestAudioFocus(focusRequest!!)
        } else {
            @Suppress("DEPRECATION")
            audioManager?.requestAudioFocus(
                null, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN
            )
        }
    }

    private fun abandonAudioFocus() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest?.let { audioManager?.abandonAudioFocusRequest(it) }
        }
    }
}
