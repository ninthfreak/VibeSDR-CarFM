package com.vibesdr.app

import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbInterface
import android.util.Log

/**
 * Backend C (tuner-backends addendum §4): Si470x USB FM dongle driver.
 *
 * Hardware demod + hardware RDS: the app's DSP does nothing here — the chip
 * tunes/seeks itself and delivers RDS block groups, which we forward RAW into
 * the shared vibedsp RdsDecoder (pushGroup) per the addendum's architecture
 * rule. Audio arrives separately as a USB Audio Class capture device.
 *
 * CLEAN-ROOM NOTE (addendum license caution): register semantics below are
 * implemented from the public Silicon Labs Si4702/03-C19 datasheet and AN230
 * programming guide. The mainline GPL driver was NOT ported. The USB HID
 * framing (report layout) is the one part the datasheet does not cover —
 * it is implemented to the common Si470x-USB convention and marked VERIFY:
 * confirm on real hardware, and adjust REPORT_SIZE/ids if a dongle disagrees.
 */
class Si470xTuner(private val conn: UsbDeviceConnection, private val device: UsbDevice) {

    companion object {
        private const val TAG = "Si470xTuner"
        /** Known Si470x composite dongles (VID shl 16 or PID), addendum §4. */
        val VIDPIDS = setOf(
            0x10C4_818A.toInt(), 0x06E1_A155.toInt(), 0x1B80_D700.toInt(),
            0x10C5_819A.toInt(), 0x12CF_7111.toInt(),
        )
        fun matches(dev: UsbDevice) = ((dev.vendorId shl 16) or dev.productId) in VIDPIDS

        // ── Si4702/03 register file (datasheet Table 8) ──
        private const val REG_POWERCFG = 0x02
        private const val REG_CHANNEL = 0x03
        private const val REG_SYSCONFIG1 = 0x04
        private const val REG_SYSCONFIG2 = 0x05
        private const val REG_SYSCONFIG3 = 0x06
        private const val REG_TEST1 = 0x07
        private const val REG_STATUSRSSI = 0x0A
        private const val REG_READCHAN = 0x0B
        private const val REG_RDSA = 0x0C   // ..RDSD = 0x0F

        // POWERCFG bits
        private const val PWR_DSMUTE = 1 shl 15
        private const val PWR_DMUTE = 1 shl 14
        private const val PWR_SEEKUP = 1 shl 9
        private const val PWR_SEEK = 1 shl 8
        private const val PWR_ENABLE = 1 shl 0
        // CHANNEL / STATUSRSSI bits
        private const val CHAN_TUNE = 1 shl 15
        private const val STAT_RDSR = 1 shl 15
        private const val STAT_STC = 1 shl 14
        private const val STAT_SFBL = 1 shl 13
        private const val STAT_ST = 1 shl 8
        // SYSCONFIG1: RDS enable, DE (0 = 75us US)
        private const val SC1_RDS = 1 shl 12
        // TEST1: crystal oscillator enable
        private const val TEST1_XOSCEN = 1 shl 15

        // US band profile: 87.5–108, 200 kHz spacing (SYSCONFIG2 BAND=00 SPACE=00).
        private const val BAND_BOTTOM_KHZ = 87_500
        private const val SPACING_KHZ = 200

        // ── USB HID framing — VERIFY on hardware ──
        // Convention for these dongles: HID report id N carries register (N-1)
        // as one big-endian 16-bit value; GET_REPORT reads, SET_REPORT writes.
        // The interrupt-IN endpoint delivers a periodic status report carrying
        // STATUSRSSI..RDSD. If a unit deviates, fix reportIdFor()/parseIntr().
        private fun reportIdFor(reg: Int) = reg + 1
        private const val HID_GET_REPORT = 0x01
        private const val HID_SET_REPORT = 0x09
        private const val HID_REPORT_TYPE_INPUT = 0x0100
        private const val HID_REPORT_TYPE_OUTPUT = 0x0200
    }

    private var hidIface: UsbInterface? = null
    private var intrIn: UsbEndpoint? = null
    /** One RDS block group, exactly as the shared decoder wants it. */
    data class RdsGroup(val a: Int, val b: Int, val c: Int, val d: Int,
                        val okA: Boolean, val okB: Boolean, val okC: Boolean, val okD: Boolean)
    data class Status(val rssi: Int, val stereo: Boolean, val freqKHz: Int)

    /** Claim the HID control interface (force = detach any system claim). */
    fun open(): Boolean {
        for (i in 0 until device.interfaceCount) {
            val itf = device.getInterface(i)
            if (itf.interfaceClass == UsbConstants.USB_CLASS_HID) {
                if (!conn.claimInterface(itf, /*force=*/true)) return false
                hidIface = itf
                for (e in 0 until itf.endpointCount) {
                    val ep = itf.getEndpoint(e)
                    if (ep.type == UsbConstants.USB_ENDPOINT_XFER_INT
                        && ep.direction == UsbConstants.USB_DIR_IN) intrIn = ep
                }
                return true
            }
        }
        Log.w(TAG, "no HID interface on ${device.deviceName}")
        return false
    }

    fun close() {
        try { writeReg(REG_POWERCFG, 0) } catch (_: Throwable) {}   // power down
        hidIface?.let { conn.releaseInterface(it) }
    }

    private fun readReg(reg: Int): Int {
        val buf = ByteArray(3)
        val n = conn.controlTransfer(
            UsbConstants.USB_DIR_IN or UsbConstants.USB_TYPE_CLASS or 0x01 /*iface recipient*/,
            HID_GET_REPORT, HID_REPORT_TYPE_INPUT or reportIdFor(reg),
            hidIface?.id ?: 0, buf, buf.size, 500)
        if (n < 3) throw IllegalStateException("GET_REPORT reg=$reg -> $n")
        return ((buf[1].toInt() and 0xFF) shl 8) or (buf[2].toInt() and 0xFF)
    }

    private fun writeReg(reg: Int, value: Int) {
        val buf = byteArrayOf(reportIdFor(reg).toByte(), (value ushr 8).toByte(), value.toByte())
        val n = conn.controlTransfer(
            UsbConstants.USB_DIR_OUT or UsbConstants.USB_TYPE_CLASS or 0x01,
            HID_SET_REPORT, HID_REPORT_TYPE_OUTPUT or reportIdFor(reg),
            hidIface?.id ?: 0, buf, buf.size, 500)
        if (n < buf.size) throw IllegalStateException("SET_REPORT reg=$reg -> $n")
    }

    /** Init per AN230 US profile (addendum §4 sequence). */
    fun powerUp() {
        writeReg(REG_TEST1, TEST1_XOSCEN)          // 1. internal oscillator
        Thread.sleep(500)                           //    datasheet oscillator settle
        writeReg(REG_POWERCFG, PWR_DMUTE or PWR_DSMUTE or PWR_ENABLE)
        Thread.sleep(110)                           //    powerup time
        // 2/3. US band + spacing, volume max in-chip; RDS on, 75 us de-emphasis.
        writeReg(REG_SYSCONFIG1, SC1_RDS)           // DE bit 0 = 75 us
        writeReg(REG_SYSCONFIG2, 0x0F)              // BAND=00 SPACE=00 VOLUME=max
        writeReg(REG_SYSCONFIG3, 0x0048)            // moderate seek SNR/impulse (AN230)
    }

    /** 5. Tune: CHANNEL+TUNE, await STC, clear. Returns the landed frequency. */
    fun tune(freqKHz: Int): Int {
        val chan = ((freqKHz - BAND_BOTTOM_KHZ) / SPACING_KHZ).coerceIn(0, 0x3FF)
        writeReg(REG_CHANNEL, CHAN_TUNE or chan)
        awaitStcAndClear { writeReg(REG_CHANNEL, chan) }
        return readFreqKHz()
    }

    /** 6. Hardware seek. Returns landed frequency, or null on band-limit fail. */
    fun seek(up: Boolean): Int? {
        val base = PWR_DMUTE or PWR_DSMUTE or PWR_ENABLE
        writeReg(REG_POWERCFG, base or PWR_SEEK or (if (up) PWR_SEEKUP else 0))
        var failed = false
        awaitStcAndClear(onStatus = { failed = (it and STAT_SFBL) != 0 }) {
            writeReg(REG_POWERCFG, base)
        }
        return if (failed) null else readFreqKHz()
    }

    private inline fun awaitStcAndClear(onStatus: (Int) -> Unit = {}, clear: () -> Unit) {
        var status = 0
        for (i in 0 until 60) {                     // <= 3 s (60 ms tune typical)
            status = readReg(REG_STATUSRSSI)
            if (status and STAT_STC != 0) break
            Thread.sleep(50)
        }
        onStatus(status)
        clear()                                     // datasheet: clear to re-arm STC
        for (i in 0 until 20) {
            if (readReg(REG_STATUSRSSI) and STAT_STC == 0) break
            Thread.sleep(10)
        }
    }

    private fun readFreqKHz(): Int =
        BAND_BOTTOM_KHZ + (readReg(REG_READCHAN) and 0x3FF) * SPACING_KHZ

    fun status(): Status {
        val s = readReg(REG_STATUSRSSI)
        return Status(rssi = s and 0xFF, stereo = (s and STAT_ST) != 0, freqKHz = readFreqKHz())
    }

    /** Poll one RDS group if ready (RDSR). Interrupt-endpoint delivery can
     *  replace this once verified on hardware; polling is the safe baseline. */
    fun pollRdsGroup(): RdsGroup? {
        val s = readReg(REG_STATUSRSSI)
        if (s and STAT_RDSR == 0) return null
        // BLERA in STATUSRSSI bits 10:9; BLERB/C/D in READCHAN 15:10 (Si4703).
        val rc = readReg(REG_READCHAN)
        val blerA = (s ushr 9) and 0x3
        val blerB = (rc ushr 14) and 0x3
        val blerC = (rc ushr 12) and 0x3
        val blerD = (rc ushr 10) and 0x3
        return RdsGroup(
            readReg(REG_RDSA), readReg(REG_RDSA + 1), readReg(REG_RDSA + 2), readReg(REG_RDSA + 3),
            okA = blerA < 3, okB = blerB < 3, okC = blerC < 3, okD = blerD < 3,
        )
    }
}
