import Foundation
import AudioToolbox

// Streaming MP3 → interleaved little-endian Int16 PCM decoder for the FM-DX
// Webserver `/audio` path (3LAS: raw MP3 frames over a WebSocket, no container,
// no ID3, frame-independent — the server encodes with `-reservoir 0` so any
// chunk boundary is safe to start on).
//
// Built on AudioFileStream (parses MP3 bytes → packets) + AudioConverter
// (packets → LPCM). Feed raw MP3 bytes in any chunking via feed(_:); decoded
// PCM is delivered through onPcm on the SAME thread that called feed(). The
// caller (VibePowerModule) serialises feed() on audioQ, so this class assumes
// single-threaded use and needs no locking.
//
// v7 FM-DX backend — Phase 0 audio spike. See reference/VibeSDR_v7_FMDX_Plan.md.
final class FmdxMp3Decoder {

  /// (interleaved LE Int16 PCM, channels, sampleRate). Emitted per decoded block.
  var onPcm: ((Data, Int, Double) -> Void)?

  // Sentinel returned by the converter input proc when the packet queue is
  // momentarily empty. Distinct from noErr-with-0-packets, which AudioConverter
  // latches as END-OF-STREAM (→ silence forever after the first block — the
  // "flash of audio then nothing" bug). Returning a non-zero status instead
  // ends the current fill WITHOUT marking EOS, so the next packet resumes.
  private let kNoMoreData: OSStatus = 0x66_6D_64_78   // 'fmdx'

  private var streamID:  AudioFileStreamID?
  private var converter:  AudioConverterRef?
  private var srcASBD = AudioStreamBasicDescription()
  private var dstASBD = AudioStreamBasicDescription()

  // Parsed-but-not-yet-decoded MP3 packets. Filled by the packets callback,
  // consumed by the converter input proc. pktNSData gives a lifetime-stable
  // pointer for the duration of a drain (Data's own storage isn't guaranteed
  // to outlive a withUnsafeBytes scope; NSData.bytes is valid while retained).
  private var pktData = Data()
  private var pktDescs: [AudioStreamPacketDescription] = []
  private var pktNSData: NSData?
  private var pktReadIndex = 0
  // Persistent 1-element packet-description the converter reads via out-param;
  // heap-allocated so the pointer stays valid for the converter's use.
  private let oneDescPtr = UnsafeMutablePointer<AudioStreamPacketDescription>.allocate(capacity: 1)

  init() {
    let ctx = Unmanaged.passUnretained(self).toOpaque()
    let st = AudioFileStreamOpen(ctx, Self.propProc, Self.pktProc, kAudioFileMP3Type, &streamID)
    if st != noErr { NSLog("[FmdxMp3Decoder] AudioFileStreamOpen failed: %d", st) }
  }

  deinit {
    if let c = converter { AudioConverterDispose(c) }
    if let s = streamID  { AudioFileStreamClose(s) }
    oneDescPtr.deallocate()
  }

  /// Feed raw MP3 bytes (any size / boundary).
  func feed(_ data: Data) {
    guard let s = streamID, !data.isEmpty else { return }
    data.withUnsafeBytes { raw in
      _ = AudioFileStreamParseBytes(s, UInt32(data.count), raw.baseAddress, [])
    }
  }

  // MARK: - AudioFileStream callbacks (C function pointers → static thunks)

  private static let propProc: AudioFileStream_PropertyListenerProc = { ctx, _, propID, _ in
    Unmanaged<FmdxMp3Decoder>.fromOpaque(ctx).takeUnretainedValue().onProperty(propID)
  }

  private static let pktProc: AudioFileStream_PacketsProc = { ctx, numBytes, numPackets, inputData, packetDescs in
    Unmanaged<FmdxMp3Decoder>.fromOpaque(ctx).takeUnretainedValue()
      .onPackets(numBytes: numBytes, numPackets: numPackets, data: inputData, descs: packetDescs)
  }

  private func onProperty(_ propID: AudioFileStreamPropertyID) {
    // ReadyToProducePackets fires once the format is known and packets are coming.
    guard propID == kAudioFileStreamProperty_ReadyToProducePackets,
          converter == nil, let s = streamID else { return }
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    guard AudioFileStreamGetProperty(s, kAudioFileStreamProperty_DataFormat, &size, &srcASBD) == noErr else {
      NSLog("[FmdxMp3Decoder] DataFormat query failed"); return
    }
    let channels = max(1, Int(srcASBD.mChannelsPerFrame))
    var dst = AudioStreamBasicDescription()
    dst.mSampleRate       = srcASBD.mSampleRate
    dst.mFormatID         = kAudioFormatLinearPCM
    dst.mFormatFlags      = kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked
    dst.mFramesPerPacket  = 1
    dst.mChannelsPerFrame = UInt32(channels)
    dst.mBitsPerChannel   = 16
    dst.mBytesPerFrame    = UInt32(2 * channels)
    dst.mBytesPerPacket   = UInt32(2 * channels)
    dstASBD = dst
    var conv: AudioConverterRef?
    let st = AudioConverterNew(&srcASBD, &dstASBD, &conv)
    if st == noErr { converter = conv }
    else { NSLog("[FmdxMp3Decoder] AudioConverterNew failed: %d", st) }
    NSLog("[FmdxMp3Decoder] ready: %.0fHz %dch", srcASBD.mSampleRate, channels)
  }

  private func onPackets(numBytes: UInt32, numPackets: UInt32,
                         data: UnsafeRawPointer,
                         descs: UnsafeMutablePointer<AudioStreamPacketDescription>?) {
    guard converter != nil, let descs else { return }   // MP3 is always VBR-described
    let base = pktData.count
    pktData.append(data.assumingMemoryBound(to: UInt8.self), count: Int(numBytes))
    for i in 0..<Int(numPackets) {
      var d = descs[i]
      d.mStartOffset += Int64(base)   // rebase onto the accumulated buffer
      pktDescs.append(d)
    }
    drain()
  }

  // MARK: - Decode

  private func drain() {
    guard let conv = converter, !pktDescs.isEmpty else { return }
    let channels  = Int(dstASBD.mChannelsPerFrame)
    let maxFrames  = 4096
    pktReadIndex   = 0
    pktNSData      = pktData as NSData          // lifetime-stable byte pointer
    let ctx = Unmanaged.passUnretained(self).toOpaque()

    while pktReadIndex < pktDescs.count {
      var outFrames = UInt32(maxFrames)
      var out = Data(count: maxFrames * channels * 2)
      let produced: Int = out.withUnsafeMutableBytes { raw -> Int in
        var abl = AudioBufferList()
        abl.mNumberBuffers = 1
        abl.mBuffers.mNumberChannels = UInt32(channels)
        abl.mBuffers.mDataByteSize   = UInt32(maxFrames * channels * 2)
        abl.mBuffers.mData           = raw.baseAddress
        let st = AudioConverterFillComplexBuffer(conv, Self.inputProc, ctx, &outFrames, &abl, nil)
        // kNoMoreData just means "queue drained mid-fill" — keep any frames it
        // produced; only a genuine error with no output is a real failure.
        if st != noErr && st != kNoMoreData && outFrames == 0 {
          NSLog("[FmdxMp3Decoder] FillComplexBuffer: %d", st)
          return 0
        }
        return Int(outFrames)
      }
      if produced <= 0 { break }
      out.removeSubrange((produced * channels * 2)..<out.count)
      onPcm?(out, channels, dstASBD.mSampleRate)
    }

    pktData.removeAll(keepingCapacity: true)
    pktDescs.removeAll(keepingCapacity: true)
    pktNSData = nil
  }

  private static let inputProc: AudioConverterComplexInputDataProc = { _, ioNumberDataPackets, ioData, outDesc, ctx in
    Unmanaged<FmdxMp3Decoder>.fromOpaque(ctx!).takeUnretainedValue()
      .provideInput(ioNumberDataPackets: ioNumberDataPackets, ioData: ioData, outDesc: outDesc)
  }

  private func provideInput(ioNumberDataPackets: UnsafeMutablePointer<UInt32>,
                            ioData: UnsafeMutablePointer<AudioBufferList>,
                            outDesc: UnsafeMutablePointer<UnsafeMutablePointer<AudioStreamPacketDescription>?>?) -> OSStatus {
    guard pktReadIndex < pktDescs.count, let ns = pktNSData else {
      ioNumberDataPackets.pointee = 0   // queue drained — end fill WITHOUT EOS
      return kNoMoreData
    }
    let d = pktDescs[pktReadIndex]
    ioData.pointee.mNumberBuffers = 1
    ioData.pointee.mBuffers.mNumberChannels = srcASBD.mChannelsPerFrame
    ioData.pointee.mBuffers.mDataByteSize   = d.mDataByteSize
    ioData.pointee.mBuffers.mData = UnsafeMutableRawPointer(mutating: ns.bytes).advanced(by: Int(d.mStartOffset))
    if let outDesc {
      // Buffer starts AT the packet, so offset is 0 relative to what we hand over.
      oneDescPtr.pointee.mStartOffset            = 0
      oneDescPtr.pointee.mDataByteSize           = d.mDataByteSize
      oneDescPtr.pointee.mVariableFramesInPacket = d.mVariableFramesInPacket
      outDesc.pointee = oneDescPtr
    }
    ioNumberDataPackets.pointee = 1     // one packet per call
    pktReadIndex += 1
    return noErr
  }
}
