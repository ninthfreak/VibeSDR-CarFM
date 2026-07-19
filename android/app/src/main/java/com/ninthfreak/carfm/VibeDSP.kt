package com.ninthfreak.carfm

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sqrt

/**
 * Client-side noise DSP — Kotlin port of ios/VibeSDR/VibeDSP.swift (itself a
 * verbatim port of the reference skin's engines):
 *   NR  — websdr-nr.js   entropy-VAD STFT masker (512-pt, 4096 blocks)
 *   NR2 — nr2.js         spectral subtraction    (2048-pt, hop 512)
 *   NB  — noise-blanker.js amplitude+flatness impulse blanker
 *
 * The engines are tuned for the STREAM sample rate (linear 12k / FM 24k).
 * Android's opus decoder always outputs 48 kHz, so VibeStreamService
 * decimates 48k→sr (integer factor) before these, and interpolates back —
 * exact iOS/skin parity for all tuning constants. All math in Double.
 */

// ── Radix-2 FFT (port of fft512 / fft.js — same conventions) ────────────────

class RadixFFT(val n: Int) {
    private val bitrev: IntArray
    private val twRe: DoubleArray
    private val twIm: DoubleArray

    init {
        var b = 0
        while ((1 shl b) < n) b++
        bitrev = IntArray(n) { i ->
            var j = 0
            for (k in 0 until b) j = (j shl 1) or ((i shr k) and 1)
            j
        }
        val half = n / 2
        twRe = DoubleArray(half)
        twIm = DoubleArray(half)
        for (i in 0 until half) {
            val a = -2.0 * Math.PI * i / n
            twRe[i] = cos(a)
            twIm[i] = kotlin.math.sin(a)
        }
    }

    fun forward(re: DoubleArray, im: DoubleArray) {
        for (i in 0 until n) {
            val j = bitrev[i]
            if (i < j) {
                var t = re[i]; re[i] = re[j]; re[j] = t
                t = im[i]; im[i] = im[j]; im[j] = t
            }
        }
        var s = 1
        var len = 2
        while (len <= n) {
            val half = len shr 1
            val step = n shr s
            var i = 0
            while (i < n) {
                for (j in 0 until half) {
                    val twIdx = j * step
                    val tRe = twRe[twIdx]; val tIm = twIm[twIdx]
                    val idx1 = i + j; val idx2 = idx1 + half
                    val uRe = re[idx1]; val uIm = im[idx1]
                    val vRe = re[idx2] * tRe - im[idx2] * tIm
                    val vIm = re[idx2] * tIm + im[idx2] * tRe
                    re[idx1] = uRe + vRe; im[idx1] = uIm + vIm
                    re[idx2] = uRe - vRe; im[idx2] = uIm - vIm
                }
                i += len
            }
            s++; len = len shl 1
        }
    }

    fun inverse(re: DoubleArray, im: DoubleArray) {
        for (i in 0 until n) im[i] = -im[i]
        forward(re, im)
        val inv = 1.0 / n
        for (i in 0 until n) { re[i] *= inv; im[i] = -im[i] * inv }
    }

    companion object {
        fun hannWindow(size: Int) = DoubleArray(size) { i ->
            0.5 * (1 - cos(2 * Math.PI * i / (size - 1)))
        }
    }
}

// ── NR2 spectral subtraction (port of NR2Processor, hop-exact feed) ─────────

class NR2Engine {
    private val fftSize = 2048
    private val hopSize = 512
    private val fft = RadixFFT(2048)
    private val window = RadixFFT.hannWindow(2048)

    private var inputBuffer = DoubleArray(fftSize)
    private var outputBuffer = DoubleArray(fftSize)
    private val real = DoubleArray(fftSize)
    private val imag = DoubleArray(fftSize)
    private val magnitude = DoubleArray(fftSize / 2 + 1)

    private var noiseProfile = DoubleArray(fftSize / 2 + 1)
    private var noiseProfileCount = 0
    private val learningFrames = 30
    private var isLearning = true

    private val noiseAdaptRate = 0.01
    private val signalThreshold = 2.0
    private val alpha = 2.0   // over-subtraction factor
    private val beta = 0.01   // spectral floor

    fun reset() {
        noiseProfile = DoubleArray(fftSize / 2 + 1)
        noiseProfileCount = 0
        isLearning = true
        inputBuffer = DoubleArray(fftSize)
        outputBuffer = DoubleArray(fftSize)
    }

    /** Input MUST be exactly hopSize (512) samples. */
    fun processHop(input: FloatArray): FloatArray {
        for (i in 0 until fftSize - hopSize) inputBuffer[i] = inputBuffer[i + hopSize]
        for (i in 0 until hopSize) inputBuffer[fftSize - hopSize + i] = input[i].toDouble()

        processFrame()

        val out = FloatArray(hopSize)
        for (i in 0 until hopSize) out[i] = outputBuffer[i].toFloat()
        for (i in 0 until fftSize - hopSize) outputBuffer[i] = outputBuffer[i + hopSize]
        for (i in fftSize - hopSize until fftSize) outputBuffer[i] = 0.0
        return out
    }

    private fun processFrame() {
        val half = fftSize / 2
        for (i in 0 until fftSize) {
            real[i] = inputBuffer[i] * window[i]
            imag[i] = 0.0
        }
        fft.forward(real, imag)
        for (i in 0..half) magnitude[i] = sqrt(real[i] * real[i] + imag[i] * imag[i])

        if (isLearning && noiseProfileCount < learningFrames) {
            for (i in 0..half) noiseProfile[i] += magnitude[i]
            noiseProfileCount++
            if (noiseProfileCount >= learningFrames) {
                for (i in 0..half) noiseProfile[i] /= learningFrames.toDouble()
                isLearning = false
            }
            for (i in 0 until fftSize) outputBuffer[i] += inputBuffer[i] * window[i]
            return
        }

        if (!isLearning) {
            for (i in 0..half) {
                if (magnitude[i] < signalThreshold * noiseProfile[i]) {
                    noiseProfile[i] = (1 - noiseAdaptRate) * noiseProfile[i] + noiseAdaptRate * magnitude[i]
                }
                var cleanMag = magnitude[i] - alpha * noiseProfile[i]
                cleanMag = max(cleanMag, beta * magnitude[i])
                if (magnitude[i] > 0) {
                    val scale = cleanMag / magnitude[i]
                    real[i] *= scale; imag[i] *= scale
                } else {
                    real[i] = 0.0; imag[i] = 0.0
                }
            }
            for (i in half + 1 until fftSize) {
                val m = fftSize - i
                real[i] = real[m]; imag[i] = -imag[m]
            }
        }

        fft.inverse(real, imag)
        for (i in 0 until fftSize) outputBuffer[i] += real[i] * window[i]
    }
}

// ── WebSDR NR (entropy-VAD STFT masker — verbatim NREngine port) ────────────

class WebSDRNREngine {
    companion object {
        private const val N_FFT = 512
        private const val HALF = 256
        private const val N_BINS = 257
        private const val HOP = 128
        private const val N_FRAMES = 192
        private const val OUTPUT_FRAMES = 32
        private const val OUTPUT_START = 96
        private const val TIME_PAD = 13
        private const val FREQ_PAD = 3
        private const val AUDIO_BUF = 24576
        const val BLOCK = 4096

        private val sawKernel = doubleArrayOf(
            0.0, 0.14285714, 0.28571429, 0.42857143, 0.57142857,
            0.71428571, 0.85714286, 1.0, 0.85714286, 0.71428571,
            0.57142857, 0.42857143, 0.28571429, 0.14285714, 0.0,
        )
        private const val sawKernelSum = 6.916666666666667

        private fun pearson(x: DoubleArray, xOff: Int, y: DoubleArray, yOff: Int, n: Int): Double {
            var sx = 0.0; var sy = 0.0; var sxy = 0.0; var sx2 = 0.0; var sy2 = 0.0
            for (i in 0 until n) {
                val xi = x[xOff + i]; val yi = y[yOff + i]
                sx += xi; sy += yi; sxy += xi * yi; sx2 += xi * xi; sy2 += yi * yi
            }
            val nn = n.toDouble()
            val d = sqrt((nn * sx2 - sx * sx) * (nn * sy2 - sy * sy))
            return if (d == 0.0) 0.0 else (nn * sxy - sx * sy) / d
        }

        private fun generateLogistic(out: DoubleArray, n: Int) {
            if (n < 4) return
            for (i in 0 until n) out[i] = i.toDouble() / (n - 1)
            for (i in 1 until n - 1) out[i] = ln(out[i] / (1 - out[i]))
            out[n - 1] = 2 * out[n - 2] - out[n - 3]
            out[0] = -out[n - 1]
            val mn = out[0]; val rng = out[n - 1] - mn
            if (rng == 0.0) return
            for (i in 0 until n) out[i] = (out[i] - mn) / rng
        }

        private fun entropyMaximum(logistic: DoubleArray, n: Int): Double {
            val tmp = DoubleArray(n)
            tmp[n - 1] = 1.0
            return 1 - pearson(tmp, 0, logistic, 0, n)
        }

        private fun man1d(data: DoubleArray, nb: Int): Double {
            val vals = ArrayList<Double>(nb)
            for (i in 0 until nb) {
                val v = data[i]
                if (v != 0.0 && !v.isNaN()) vals.add(v)
            }
            if (vals.isEmpty()) return 0.0
            vals.sort()
            val n = vals.size
            val med = if (n % 2 == 0) (vals[n / 2] + vals[n / 2 - 1]) / 2 else vals[(n - 1) / 2]
            val diffs = DoubleArray(n) { abs(vals[it] - med) }
            diffs.sort()
            return if (n % 2 == 0) (diffs[n / 2] + diffs[n / 2 - 1]) / 2 else diffs[(n - 1) / 2]
        }

        private fun atd1d(data: DoubleArray, manVal: Double, nb: Int): Double {
            var sum = 0.0
            for (i in 0 until nb) {
                val d = data[i] - manVal
                sum += d * d
            }
            return if (nb == 0) 0.0 else sqrt(sum / nb)
        }

        private fun atd2d(mag: Array<DoubleArray>, manVal: Double, frames: Int, nb: Int): Double {
            var sum = 0.0
            val cnt = frames * nb
            for (j in 0 until frames) for (i in 0 until nb) {
                val d = abs(mag[j][i] - manVal)
                sum += d * d
            }
            return if (cnt == 0) 0.0 else sqrt(sum / cnt) - manVal
        }

        private fun findMax2d(data: Array<DoubleArray>, frames: Int, nb: Int): Double {
            var mx = Double.NEGATIVE_INFINITY
            for (j in 0 until frames) for (i in 0 until nb) if (data[j][i] > mx) mx = data[j][i]
            return mx
        }

        private fun longestConsecutive(arr: ByteArray): Int {
            var cur = 0; var best = 0
            for (v in arr) {
                if (v.toInt() == 1) cur++
                else { if (cur > best) best = cur; cur = 0 }
            }
            return max(best, cur)
        }

        private fun removeOutliers(a: ByteArray, value: Byte, threshold: Int, replace: Byte) {
            var first = 0
            while (first < a.size) {
                if (a[first] == value) {
                    var idx = first
                    while (idx < a.size && a[idx] == value) idx++
                    val end = idx
                    if (end - first + 1 < threshold) {
                        for (i in first until end) a[i] = replace
                    }
                    first = end
                } else {
                    var idx = first
                    while (idx < a.size && a[idx] != value) idx++
                    first = idx
                }
            }
        }
    }

    var nbins = 37
    private val threshold = 0.057
    private val mult = 0.1
    private val squelchMode = true

    private val fft = RadixFFT(N_FFT)
    private val hannWin = RadixFFT.hannWindow(N_FFT)
    private val synthWin: DoubleArray

    private var audio = DoubleArray(AUDIO_BUF)
    private val fRe = Array(N_FRAMES) { DoubleArray(N_BINS) }
    private val fIm = Array(N_FRAMES) { DoubleArray(N_BINS) }
    private val fMag = Array(N_FRAMES) { DoubleArray(N_BINS) }
    private val mask = Array(N_FRAMES) { DoubleArray(N_BINS) }
    private val smoothed = Array(N_FRAMES) { DoubleArray(N_BINS) }
    private val entropyRaw = DoubleArray(N_FRAMES)
    private val entropySmoothed = DoubleArray(N_FRAMES)
    private val entropyThresh = ByteArray(N_FRAMES)
    private val logistic1 = DoubleArray(N_BINS)
    private val logistic3 = DoubleArray(N_BINS * 3)
    private var max3 = 1.0
    private var olaBuf = DoubleArray(N_FFT - HOP)
    private var flag = 0
    private var prevNbins = -1

    private val t512 = DoubleArray(N_FFT)
    private val tBins = DoubleArray(N_BINS)
    private val t3Bins = DoubleArray(N_BINS * 3)
    private val tSort = DoubleArray(N_BINS * N_FRAMES)
    private val tDiff = DoubleArray(N_BINS * N_FRAMES)
    private val t192 = DoubleArray(N_FRAMES)
    private val work = Array(N_FRAMES) { DoubleArray(N_BINS) }
    private val mask2 = Array(N_FRAMES) { DoubleArray(N_BINS) }
    private val pH = N_FRAMES + 2 * TIME_PAD
    private val pW = N_BINS + 2 * FREQ_PAD
    private val c2dVert = Array(pH) { DoubleArray(pW) }
    private val c2dHoriz = Array(pH) { DoubleArray(pW) }
    private val c2dTmpRow = DoubleArray(pW)
    private val c2dCol = DoubleArray(pH)
    private val c2dColOut = DoubleArray(pH)
    private val sawPad = DoubleArray(N_FRAMES + 14)
    private val sawOut = DoubleArray(N_FRAMES)
    private val padBuf = DoubleArray(AUDIO_BUF + 512)
    private val wkRe = DoubleArray(N_FFT)
    private val wkIm = DoubleArray(N_FFT)

    private var delayBuf = FloatArray(BLOCK)
    private var delayReady = false

    init {
        synthWin = DoubleArray(N_FFT) { k ->
            var sumSq = 0.0
            var m = k % HOP
            while (m < N_FFT) { sumSq += hannWin[m] * hannWin[m]; m += HOP }
            if (sumSq > 0) hannWin[k] / sumSq else 0.0
        }
        updateBins()
    }

    fun syncBins(bandwidthHz: Double, sampleRate: Double) {
        if (bandwidthHz <= 0 || sampleRate <= 0) return
        val binWidth = sampleRate / N_FFT
        nbins = ceil(bandwidthHz / binWidth).toInt().plus(1).coerceIn(4, 257)
    }

    fun reset() {
        audio = DoubleArray(AUDIO_BUF)
        olaBuf = DoubleArray(N_FFT - HOP)
        delayReady = false
        delayBuf = FloatArray(BLOCK)
        for (i in 0 until N_FRAMES) {
            java.util.Arrays.fill(fRe[i], 0.0); java.util.Arrays.fill(fIm[i], 0.0)
            java.util.Arrays.fill(fMag[i], 0.0); java.util.Arrays.fill(mask[i], 0.0)
            java.util.Arrays.fill(smoothed[i], 0.0)
        }
        java.util.Arrays.fill(entropyRaw, 0.0)
        java.util.Arrays.fill(entropySmoothed, 0.0)
        java.util.Arrays.fill(entropyThresh, 0)
    }

    private fun updateBins() {
        if (nbins == prevNbins) return
        nbins = nbins.coerceIn(4, 257)
        prevNbins = nbins
        generateLogistic(logistic1, nbins)
        generateLogistic(logistic3, nbins * 3)
        max3 = entropyMaximum(logistic3, nbins * 3)
        for (i in 0 until N_FRAMES) java.util.Arrays.fill(smoothed[i], 0.0)
    }

    private fun rfft(inp: DoubleArray, outRe: DoubleArray, outIm: DoubleArray) {
        for (i in 0 until N_FFT) { wkRe[i] = inp[i]; wkIm[i] = 0.0 }
        fft.forward(wkRe, wkIm)
        for (i in 0 until N_BINS) { outRe[i] = wkRe[i]; outIm[i] = wkIm[i] }
    }

    private fun irfft(inRe: DoubleArray, inIm: DoubleArray, out: DoubleArray) {
        for (i in 0 until N_BINS) { wkRe[i] = inRe[i]; wkIm[i] = inIm[i] }
        for (i in 1 until HALF) {
            wkRe[N_FFT - i] = inRe[i]
            wkIm[N_FFT - i] = -inIm[i]
        }
        fft.inverse(wkRe, wkIm)
        for (i in 0 until N_FFT) out[i] = wkRe[i]
    }

    private fun stftFull() {
        for (i in 0 until AUDIO_BUF) padBuf[256 + i] = audio[i]
        for (i in 1..256) padBuf[256 - i] = audio[i]
        for (i in 1..255) padBuf[256 + AUDIO_BUF - 1 + i] = audio[AUDIO_BUF - 1 - i]
        for (seg in 0 until N_FRAMES) {
            val start = seg * HOP
            for (i in 0 until N_FFT) t512[i] = padBuf[start + i] * hannWin[i]
            rfft(t512, fRe[seg], fIm[seg])
        }
    }

    private fun updateMagnitudes() {
        for (j in 0 until N_FRAMES) for (i in 0 until nbins) {
            val re = fRe[j][i]; val im = fIm[j][i]
            fMag[j][i] = sqrt(re * re + im * im)
        }
    }

    private fun istftBlock(outBuf: FloatArray) {
        var outIdx = 0
        for (f in 0 until OUTPUT_FRAMES) {
            val fi = OUTPUT_START + f
            irfft(fRe[fi], fIm[fi], t512)
            for (i in 0 until N_FFT) t512[i] *= synthWin[i]
            for (i in 0 until HOP) outBuf[outIdx + i] = (olaBuf[i] + t512[i]).toFloat()
            outIdx += HOP
            for (i in 0 until HALF) olaBuf[i] = olaBuf[i + HOP]
            for (i in 0 until HOP) olaBuf[HALF + i] = 0.0
            for (i in 0 until N_FFT - HOP) olaBuf[i] += t512[HOP + i]
        }
    }

    private fun fastEntropy() {
        val nb = nbins
        val n3 = nb * 3
        for (i in 1 until N_FRAMES - 1) {
            for (j in 0 until nb) {
                t3Bins[j] = fMag[i - 1][j]
                t3Bins[j + nb] = fMag[i][j]
                t3Bins[j + 2 * nb] = fMag[i + 1][j]
            }
            java.util.Arrays.sort(t3Bins, 0, n3)
            val dx = t3Bins[n3 - 1] - t3Bins[0]
            if (dx == 0.0) { entropyRaw[i] = 0.0; continue }
            val base = t3Bins[0]
            for (j in 0 until n3) t3Bins[j] = (t3Bins[j] - base) / dx
            val v = pearson(t3Bins, 0, logistic3, 0, n3)
            entropyRaw[i] = if (v.isNaN()) 0.0 else 1 - v
        }
        for (frame in intArrayOf(0, N_FRAMES - 1)) {
            for (j in 0 until nb) tBins[j] = fMag[frame][j]
            java.util.Arrays.sort(tBins, 0, nb)
            val dx = tBins[nb - 1] - tBins[0]
            if (dx == 0.0) { entropyRaw[frame] = 0.0; continue }
            val base = tBins[0]
            for (j in 0 until nb) tBins[j] = (tBins[j] - base) / dx
            val v = pearson(tBins, 0, logistic1, 0, nb)
            entropyRaw[frame] = if (v.isNaN()) 0.0 else 1 - v
        }
    }

    private fun smoothEntropy() {
        entropySmoothed[0] = (entropyRaw[0] + entropyRaw[1]) / 2
        for (i in 1 until N_FRAMES - 1) {
            entropySmoothed[i] = (entropyRaw[i - 1] + entropyRaw[i] + entropyRaw[i + 1]) / 3
        }
        entropySmoothed[N_FRAMES - 1] = (entropyRaw[N_FRAMES - 2] + entropyRaw[N_FRAMES - 1]) / 2
    }

    private fun processEntropy() {
        fastEntropy()
        smoothEntropy()
        var count = 0
        java.util.Arrays.fill(entropyThresh, 0)
        for (i in 0 until N_FRAMES) {
            if (entropySmoothed[i] > threshold) {
                entropyThresh[i] = 1
                if (i in 32..160) count++
            }
        }
        if (count > 22 || longestConsecutive(entropyThresh) > 16) {
            flag = 2
            removeOutliers(entropyThresh, 0, 6, 1)
            removeOutliers(entropyThresh, 1, 2, 0)
        }
    }

    private fun sawtoothSmooth1d(arr: DoubleArray, n: Int) {
        java.util.Arrays.fill(sawPad, 0.0)
        for (i in 0 until n) sawPad[i + 7] = arr[i]
        for (i in 0 until n) {
            var s = 0.0
            for (k in 0 until 15) s += sawPad[i + k] * sawKernel[k]
            sawOut[i] = s / sawKernelSum
        }
        for (i in 0 until n) arr[i] = sawOut[i]
    }

    private fun sawtoothConvolve(src: Array<DoubleArray>, dst: Array<DoubleArray>) {
        for (i in 0 until nbins) {
            for (j in 0 until N_FRAMES) t192[j] = src[j][i]
            sawtoothSmoo1dWrap(t192)
            for (j in 0 until N_FRAMES) dst[j][i] = t192[j]
        }
    }

    private fun sawtoothSmoo1dWrap(arr: DoubleArray) = sawtoothSmooth1d(arr, N_FRAMES)

    private fun convolve2d(data: Array<DoubleArray>) {
        val nb = nbins
        val pWl = nb + 2 * FREQ_PAD
        repeat(3) {
            for (i in 0 until pH) {
                java.util.Arrays.fill(c2dVert[i], 0.0)
                java.util.Arrays.fill(c2dHoriz[i], 0.0)
            }
            for (i in 0 until N_FRAMES) for (j in 0 until nb) {
                c2dVert[i + TIME_PAD][j + FREQ_PAD] = data[i][j]
                c2dHoriz[i + TIME_PAD][j + FREQ_PAD] = data[i][j]
            }
            for (i in 0 until N_FRAMES) {
                val row = i + TIME_PAD
                val leftVal = data[i][0]; val rightVal = data[i][nb - 1]
                for (j in 0 until FREQ_PAD) {
                    c2dVert[row][j] = leftVal
                    c2dVert[row][nb + FREQ_PAD + j] = rightVal
                    c2dHoriz[row][j] = leftVal
                    c2dHoriz[row][nb + FREQ_PAD + j] = rightVal
                }
            }
            for (i in 0 until pH) {
                java.util.Arrays.fill(c2dTmpRow, 0.0)
                for (j in 1 until pWl - 1) {
                    c2dTmpRow[j] = (c2dVert[i][j - 1] + c2dVert[i][j] + c2dVert[i][j + 1]) / 3
                }
                c2dTmpRow[0] = (c2dVert[i][0] + c2dVert[i][1]) / 2
                c2dTmpRow[pWl - 1] = (c2dVert[i][pWl - 2] + c2dVert[i][pWl - 1]) / 2
                for (j in 0 until pWl) c2dVert[i][j] = c2dTmpRow[j]
            }
            for (j in 0 until pWl) {
                for (i in 0 until pH) c2dCol[i] = c2dHoriz[i][j]
                for (i in 0 until pH) {
                    var s = 0.0; var cnt = 0
                    for (k in -6..6) {
                        val ii = i + k
                        if (ii in 0 until pH) { s += c2dCol[ii]; cnt++ }
                    }
                    c2dColOut[i] = if (cnt > 0) s / cnt else 0.0
                }
                for (i in 0 until pH) c2dHoriz[i][j] = c2dColOut[i]
            }
            for (i in 0 until pH) for (j in 0 until pWl) {
                val avg = (c2dVert[i][j] + c2dHoriz[i][j]) / 2
                c2dVert[i][j] = avg; c2dHoriz[i][j] = avg
            }
        }
        for (i in 0 until N_FRAMES) for (j in 0 until nb) {
            data[i][j] = c2dVert[i + TIME_PAD][j + FREQ_PAD]
        }
    }

    private fun fastPeaks(smoothedIn: Array<DoubleArray>, maskOut: Array<DoubleArray>, manG: Double, atdG: Double) {
        val nb = nbins
        val alpha = 0.5
        for (each in 0 until N_FRAMES) {
            if (entropyThresh[each].toInt() == 0 && squelchMode) continue
            if (entropyThresh[each].toInt() == 0 && entropyRaw[each] < threshold) continue
            for (j in 0 until nb) tBins[j] = smoothedIn[each][j]
            val manLocal = man1d(tBins, nb)
            val atdLocal = atd1d(tBins, manLocal, nb)
            var entFrac = entropyRaw[each] / max3
            if (entFrac > 1) entFrac = 1.0
            val atdG2 = atdG * (1 - entFrac)
            val manG2 = manG * (1 - entFrac)
            val w1 = exp(-alpha * abs(manG2 - manLocal))
            val manFix = manLocal * w1 + manG2 * (1 - w1)
            val w2 = exp(-alpha * abs(atdG2 - atdLocal))
            val atdFix = atdLocal * w2 + atdG2 * (1 - w2)
            val thresh = manFix + atdFix * mult
            for (i in 0 until nb) if (tBins[i] > thresh) maskOut[each][i] = 1.0
        }
    }

    private fun man2d(mag: Array<DoubleArray>, frames: Int, nb: Int): Double {
        var n = 0
        for (j in 0 until frames) for (i in 0 until nb) {
            val v = mag[j][i]
            if (v != 0.0) { tSort[n] = v; n++ }
        }
        if (n == 0) return 0.0
        java.util.Arrays.sort(tSort, 0, n)
        val med = if (n % 2 == 0) (tSort[n / 2] + tSort[n / 2 - 1]) / 2 else tSort[(n - 1) / 2]
        for (i in 0 until n) tDiff[i] = abs(tSort[i] - med)
        java.util.Arrays.sort(tDiff, 0, n)
        return if (n % 2 == 0) (tDiff[n / 2] + tDiff[n / 2 - 1]) / 2 else tDiff[(n - 1) / 2]
    }

    private fun smoothAndMask() {
        val nb = nbins
        for (i in 0 until N_FRAMES) java.util.Arrays.fill(mask[i], 0.0)
        sawtoothConvolve(fMag, smoothed)
        var manG = man2d(smoothed, N_FRAMES, nb)
        var atdG = atd2d(smoothed, manG, N_FRAMES, nb)
        fastPeaks(smoothed, mask, manG, atdG)

        for (i in 0 until N_FRAMES) for (j in 0 until nb) {
            work[i][j] = if (mask[i][j] == 0.0) 0.0 else fMag[i][j]
        }
        val initial = findMax2d(fMag, N_FRAMES, nb)
        val maxWork = findMax2d(work, N_FRAMES, nb)
        var multiplier = if (initial > 0) maxWork / initial else 1.0
        if (multiplier > 1) multiplier = 1.0

        manG = man2d(work, N_FRAMES, nb)
        atdG = atd2d(work, manG, N_FRAMES, nb)
        sawtoothConvolve(work, smoothed)

        for (i in 0 until N_FRAMES) java.util.Arrays.fill(mask2[i], 0.0)
        fastPeaks(smoothed, mask2, manG, atdG)

        for (i in 0 until N_FRAMES) for (j in 0 until nb) {
            val v1 = mask2[i][j] * multiplier
            if (mask[i][j] > v1) mask[i][j] = v1
            else mask[i][j] = max(mask[i][j], mask2[i][j])
        }
        sawtoothConvolve(mask, mask)   // column-wise independent — safe in place
        convolve2d(mask)
    }

    private fun processBlock(samples: FloatArray): FloatArray {
        updateBins()
        val nb = nbins
        if (nb < 4) return samples

        for (i in 0 until AUDIO_BUF - BLOCK) audio[i] = audio[i + BLOCK]
        for (i in 0 until BLOCK) audio[AUDIO_BUF - BLOCK + i] = samples[i].toDouble()

        stftFull()
        updateMagnitudes()

        flag = 0
        processEntropy()

        val out = FloatArray(BLOCK)
        if (flag == 2 || !squelchMode) {
            smoothAndMask()
            for (f in 0 until OUTPUT_FRAMES) {
                val fi = OUTPUT_START + f
                for (j in 0 until nb) {
                    fRe[fi][j] *= mask[fi][j]
                    fIm[fi][j] *= mask[fi][j]
                }
                for (j in nb until N_BINS) { fRe[fi][j] = 0.0; fIm[fi][j] = 0.0 }
            }
            istftBlock(out)
        } else {
            java.util.Arrays.fill(olaBuf, 0.0)
        }
        return out
    }

    /** One block of lookahead: returns the PREVIOUS processed block; null on
     *  the very first call (caller passes the input through). */
    fun processWithDelay(samples: FloatArray): FloatArray? {
        if (!delayReady) {
            delayBuf = processBlock(samples)
            delayReady = true
            return null
        }
        val result = delayBuf
        delayBuf = processBlock(samples)
        return result
    }
}

// ── Noise blanker (port of noise-blanker.js, minus the FIR bandpass) ────────

class NoiseBlankerEngine(sampleRate: Double) {
    private val threshold = 10.0
    private val blankSamples = max(1, (sampleRate * 0.003).toInt())
    private val avgWindow = max(1, (sampleRate * 0.020).toInt())
    private val fftSize = 128
    private val fftBuffer = DoubleArray(fftSize)
    private var fftBufferPos = 0
    private val spectralFlatnessThreshold = 0.3
    private val cosTable: DoubleArray
    private val sinTable: DoubleArray
    private val window: DoubleArray
    private var avgLevel = 0.0001
    private var blankCounter = 0
    private val history = DoubleArray(avgWindow)
    private var historyPos = 0
    private var historySum = 0.0
    private val warmupSamples = avgWindow * 2
    private var warmupCounter = 0

    init {
        cosTable = DoubleArray(fftSize * fftSize / 2)
        sinTable = DoubleArray(fftSize * fftSize / 2)
        for (k in 0 until fftSize / 2) for (n in 0 until fftSize) {
            val idx = k * fftSize + n
            val angle = -2.0 * Math.PI * k * n / fftSize
            cosTable[idx] = cos(angle)
            sinTable[idx] = kotlin.math.sin(angle)
        }
        window = DoubleArray(blankSamples) { i ->
            val t = (i + 1).toDouble() / blankSamples
            0.5 * (1.0 - cos(Math.PI * t))
        }
    }

    private fun isBroadbandClick(): Boolean {
        val windowed = DoubleArray(fftSize) { i ->
            fftBuffer[i] * 0.5 * (1.0 - cos(2.0 * Math.PI * i / fftSize))
        }
        val half = fftSize / 2
        var geometricMean = 1.0
        var arithmeticMean = 0.0
        val epsilon = 1e-10
        for (k in 0 until half) {
            var re = 0.0; var im = 0.0
            for (n in 0 until fftSize) {
                val idx = k * fftSize + n
                re += windowed[n] * cosTable[idx]
                im += windowed[n] * sinTable[idx]
            }
            val mag = sqrt(re * re + im * im) + epsilon
            geometricMean *= mag.pow(1.0 / half)
            arithmeticMean += mag / half
        }
        if (arithmeticMean < epsilon) return false
        return geometricMean / arithmeticMean > spectralFlatnessThreshold
    }

    fun process(samples: FloatArray) {
        for (i in samples.indices) {
            val sample = samples[i].toDouble()
            val absSample = abs(sample)
            fftBuffer[fftBufferPos] = sample
            fftBufferPos = (fftBufferPos + 1) % fftSize
            historySum -= history[historyPos]
            history[historyPos] = absSample
            historySum += absSample
            historyPos = (historyPos + 1) % avgWindow
            avgLevel = max(historySum / avgWindow, 0.0001)
            if (warmupCounter < warmupSamples) { warmupCounter++; continue }
            if (absSample > avgLevel * threshold && isBroadbandClick()) {
                blankCounter = blankSamples
            }
            if (blankCounter > 0) {
                val windowPos = blankSamples - blankCounter
                samples[i] = (sample * window[windowPos]).toFloat()
                blankCounter--
            }
        }
    }

    fun reset() {
        java.util.Arrays.fill(history, 0.0)
        historyPos = 0; historySum = 0.0; avgLevel = 0.0001
        blankCounter = 0; warmupCounter = 0
        java.util.Arrays.fill(fftBuffer, 0.0)
        fftBufferPos = 0
    }
}

// ── Block chunker (packet sizes → engine block sizes) ───────────────────────

/** Accumulates arbitrary-length audio, runs `process` per fixed block, and
 *  returns exactly as many samples as went in (zero-primed while the first
 *  block fills). `process` may return null to pass that block through. */
class BlockChunker(private val block: Int, private val process: (FloatArray) -> FloatArray?) {
    private val inFifo = ArrayDeque<Float>()
    private val outFifo = ArrayDeque<Float>()

    fun run(samples: FloatArray): FloatArray {
        for (s in samples) inFifo.addLast(s)
        while (inFifo.size >= block) {
            val blk = FloatArray(block) { inFifo.removeFirst() }
            val processed = process(blk) ?: blk
            for (s in processed) outFifo.addLast(s)
        }
        val n = samples.size
        val out = FloatArray(n)
        if (outFifo.size >= n) {
            for (i in 0 until n) out[i] = outFifo.removeFirst()
        } else {
            val deficit = n - outFifo.size
            var i = deficit  // leading zeros = priming latency
            while (outFifo.isNotEmpty()) { out[i] = outFifo.removeFirst(); i++ }
        }
        return out
    }

    fun reset() { inFifo.clear(); outFifo.clear() }
}
