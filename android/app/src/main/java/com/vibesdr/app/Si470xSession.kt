package com.vibesdr.app

import android.content.Context
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.util.Log

/** JNI surface into the shared vibedsp RdsDecoder (vibe_si470x_rds_jni.cpp). */
object Si470xRdsBridge {
    init { System.loadLibrary("vibelocalsdr") }
    external fun reset()
    /** Returns the decoder's state as a {"type":"rds",...} JSON when it changed. */
    external fun pushGroup(a: Int, b: Int, c: Int, d: Int, okMask: Int): String?
}

/**
 * Backend C session (tuner-backends addendum §4): owns the Si470x driver, an
 * RDS poll thread feeding the shared decoder, a status poll, and the audio
 * bridge (USB capture -> default output). Fully additive — nothing else in the
 * app changes; the RTL-SDR path is untouched. VERIFY on hardware (§8: any
 * OTG phone + dongle is the dev rig).
 */
class Si470xSession(
    private val context: Context,
    private val device: UsbDevice,
    /** Emits {"type":"rds"...} JSON / status JSON up to the RN module. */
    private val onMeta: (String) -> Unit,
    private val onStatus: (rssi: Int, stereo: Boolean, freqKHz: Int) -> Unit,
) {
    companion object { private const val TAG = "Si470xSession" }

    private var tuner: Si470xTuner? = null
    @Volatile private var running = false
    private var rdsThread: Thread? = null
    private var audioThread: Thread? = null
    private var record: AudioRecord? = null
    private var track: AudioTrack? = null

    fun start(initialFreqKHz: Int): Boolean {
        val mgr = context.getSystemService(Context.USB_SERVICE) as UsbManager
        val conn = mgr.openDevice(device) ?: return false
        val t = Si470xTuner(conn, device)
        if (!t.open()) { conn.close(); return false }
        tuner = t
        return try {
            t.powerUp()
            t.tune(initialFreqKHz)
            Si470xRdsBridge.reset()
            running = true
            startRdsLoop(t)
            startAudio()
            true
        } catch (e: Throwable) {
            Log.w(TAG, "start failed: ${e.message}")
            stop(); false
        }
    }

    fun stop() {
        running = false
        rdsThread?.join(500); rdsThread = null
        audioThread?.join(500); audioThread = null
        try { record?.stop() } catch (_: Throwable) {}
        record?.release(); record = null
        try { track?.stop() } catch (_: Throwable) {}
        track?.release(); track = null
        tuner?.close(); tuner = null
    }

    fun tune(freqKHz: Int): Int {
        Si470xRdsBridge.reset()               // new station -> fresh RDS state
        return tuner?.tune(freqKHz) ?: -1
    }

    fun seek(up: Boolean): Int? {
        val f = tuner?.seek(up)
        if (f != null) Si470xRdsBridge.reset()
        return f
    }

    /** RDS + status poll: ~30 ms RDS cadence (group every ~87 ms on-air). */
    private fun startRdsLoop(t: Si470xTuner) {
        rdsThread = Thread {
            var lastStatus = 0L
            while (running) {
                try {
                    t.pollRdsGroup()?.let { g ->
                        val mask = (if (g.okA) 1 else 0) or (if (g.okB) 2 else 0) or
                                   (if (g.okC) 4 else 0) or (if (g.okD) 8 else 0)
                        Si470xRdsBridge.pushGroup(g.a, g.b, g.c, g.d, mask)?.let(onMeta)
                    }
                    val now = System.currentTimeMillis()
                    if (now - lastStatus > 1000) {
                        lastStatus = now
                        val s = t.status()
                        onStatus(s.rssi, s.stereo, s.freqKHz)
                    }
                } catch (e: Throwable) {
                    Log.w(TAG, "rds loop: ${e.message}"); if (running) Thread.sleep(250)
                }
                Thread.sleep(30)
            }
        }.apply { name = "si470x-rds"; start() }
    }

    /** USB capture -> default output. The dongle is a UAC capture device; find
     *  its input by USB type and prefer it explicitly (addendum §4 audio path). */
    private fun startAudio() {
        val am = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val usbIn = am.getDevices(AudioManager.GET_DEVICES_INPUTS)
            .firstOrNull { it.type == AudioDeviceInfo.TYPE_USB_DEVICE }
        val rate = usbIn?.sampleRates?.firstOrNull { it == 48000 }
            ?: usbIn?.sampleRates?.maxOrNull() ?: 48000
        val chIn = AudioFormat.CHANNEL_IN_STEREO
        val chOut = AudioFormat.CHANNEL_OUT_STEREO
        val enc = AudioFormat.ENCODING_PCM_16BIT
        val bufIn = AudioRecord.getMinBufferSize(rate, chIn, enc).coerceAtLeast(4096)
        val rec = AudioRecord(MediaRecorder.AudioSource.UNPROCESSED, rate, chIn, enc, bufIn * 2)
        if (usbIn != null) rec.preferredDevice = usbIn
        val bufOut = AudioTrack.getMinBufferSize(rate, chOut, enc).coerceAtLeast(4096)
        val trk = AudioTrack.Builder()
            .setAudioAttributes(AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            .setAudioFormat(AudioFormat.Builder().setSampleRate(rate)
                .setChannelMask(chOut).setEncoding(enc).build())
            .setBufferSizeInBytes(bufOut * 2)     // < 100 ms target at 48 k stereo
            .build()
        record = rec; track = trk
        audioThread = Thread {
            val buf = ShortArray(2048)
            try {
                rec.startRecording(); trk.play()
                while (running) {
                    val n = rec.read(buf, 0, buf.size)
                    if (n > 0) trk.write(buf, 0, n)
                }
            } catch (e: Throwable) { Log.w(TAG, "audio loop: ${e.message}") }
        }.apply { name = "si470x-audio"; start() }
    }
}
