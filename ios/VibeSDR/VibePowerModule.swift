import Foundation
import AVFoundation
import MediaPlayer

// Classic RCT bridge module — accessible via NativeModules.VibePowerModule.
// Owns the audio WebSocket natively so audio survives JS suspension (background).
//
// Packet layout (version=2, always 21-byte header):
//   [0:8]   uint64 LE  timestamp
//   [8:12]  uint32 LE  sample rate
//   [12]    uint8      channels
//   [13:17] float32 LE baseband power
//   [17:21] float32 LE noise density
//   [21:]   Opus payload

@objc(VibePowerModule)
class VibePowerModule: RCTEventEmitter {

  // MARK: - RCTEventEmitter

  override func supportedEvents() -> [String]! {
    return ["VibeTuned"]
  }

  override static func requiresMainQueueSetup() -> Bool { return false }

  // MARK: - State

  private let audioQ       = DispatchQueue(label: "com.vibesdr.audio", qos: .userInteractive)
  private var opusDecoder:       OpaquePointer?
  private var decoderSampleRate: Int32 = 0
  private var decoderChannels:   Int32 = 0
  private var audioEngine:       AVAudioEngine?
  private var playerNode:        AVAudioPlayerNode?
  private var audioFormat:       AVAudioFormat?

  private var wsTask:       URLSessionWebSocketTask?
  private var wsSession:    URLSession?
  private var isRunning     = false
  private var isMuted       = false
  private var currentFreq:  Int    = 14_074_000
  private var currentMode:  String = "usb"
  private var currentBase:  String = ""
  private var currentStep:  Int    = 1_000
  private var currentUuid:  String = ""
  private var packetCount   = 0
  private let FRAME_SIZE: Int32 = 5760
  private var instanceName: String = ""

  // Zombie-socket watchdog. Packets flow ~50/s, so staleness is a reliable
  // death signal. After background suspension (e.g. user switches to another
  // app and iOS freezes us once audio is interrupted), the server reaps the
  // session but our socket never errors — receiveLoop waits forever and audio
  // + spectrum stay dead until app relaunch (bug 2026-06-11).
  private var lastPacketAt  = Date()
  private var healthTimer: Timer?

  // Playback live-edge control (laggy-tuning bug 2026-06-11): scheduleBuffer
  // with no accounting let the queue grow after any delivery burst, so
  // playback ran seconds behind live FOREVER — tuning sounded delayed because
  // you kept hearing the backlog. queuedSeconds is mutated on audioQ only.
  private var queuedSeconds: Double = 0
  // Tune coalescing: the velocity drum can emit 20+ steps/s; one WS tune per
  // step thrashes radiod. Leading send + 80ms trailing timer.
  private var pendingTune: (freq: Int, mode: String)?
  private var lastTuneSentAt = Date(timeIntervalSince1970: 0)
  private var tuneTimer: Timer?

  // MARK: - Exported methods

  @objc func startAudioEngine(_ baseUrl: String, frequency: Int, mode: String, uuid: String) {
    NSLog("[VibePowerModule] startAudioEngine %@ %d %@", baseUrl, frequency, mode)
    stopEngine()
    currentBase  = baseUrl
    currentFreq  = frequency
    currentMode  = mode
    currentUuid  = uuid
    isRunning    = true
    isMuted      = false
    packetCount  = 0
    lastPacketAt = Date()
    startHealthTimer()
    configureAVSession()
    startEngine(sampleRate: 48000, channels: 1)
    openAudioWs(baseUrl: baseUrl, frequency: frequency, mode: mode, uuid: uuid)
    DispatchQueue.main.async {
      self.setupRemoteCommands()
      self.updateNowPlaying()
    }
  }

  @objc func stopAudioEngine() {
    NSLog("[VibePowerModule] stopAudioEngine")
    stopEngine()
  }

  /** Called from JS on app-foreground: instant zombie check instead of
   *  waiting for the next watchdog tick. */
  @objc func revive() {
    DispatchQueue.main.async { [weak self] in
      self?.reviveIfDead(staleAfter: 3)
    }
  }

  // MARK: - Watchdog

  private func startHealthTimer() {
    healthTimer?.invalidate()
    let t = Timer(timeInterval: 4.0, repeats: true) { [weak self] _ in
      self?.reviveIfDead(staleAfter: 8)
    }
    RunLoop.main.add(t, forMode: .common)
    healthTimer = t
  }

  private func reviveIfDead(staleAfter: TimeInterval) {
    guard isRunning else { return }
    let stale  = Date().timeIntervalSince(lastPacketAt)
    let wsDead = (wsTask?.state != .running)
    guard stale > staleAfter || wsDead else { return }
    NSLog("[VibePowerModule] watchdog: stale=%.1fs wsDead=%d — reviving audio WS",
          stale, wsDead ? 1 : 0)
    lastPacketAt = Date() // debounce — one revive attempt per window
    wsTask?.cancel(with: .goingAway, reason: nil)
    wsTask = nil
    if let engine = audioEngine, !engine.isRunning {
      try? AVAudioSession.sharedInstance().setActive(true)
      try? engine.start()
      if !isMuted { playerNode?.play() }
    }
    // SAME uuid — decoders + spectrum WS are keyed to it server-side.
    openAudioWs(baseUrl: currentBase, frequency: currentFreq,
                mode: currentMode, uuid: currentUuid)
  }

  @objc func sendTuneCommand(_ frequency: Int, mode: String) {
    currentFreq = frequency
    currentMode = mode
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.pendingTune = (frequency, mode)
      let since = Date().timeIntervalSince(self.lastTuneSentAt)
      if since >= 0.08 {
        self.flushPendingTune()
      } else if self.tuneTimer == nil {
        let t = Timer(timeInterval: 0.08 - since, repeats: false) { [weak self] _ in
          self?.tuneTimer = nil
          self?.flushPendingTune()
        }
        RunLoop.main.add(t, forMode: .common)
        self.tuneTimer = t
      }
      self.updateNowPlaying()
    }
  }

  private func flushPendingTune() {
    guard let t = pendingTune else { return }
    pendingTune = nil
    lastTuneSentAt = Date()
    sendWsJson(["type": "tune", "frequency": t.freq, "mode": t.mode])
    // Drop queued (pre-tune) audio so what you HEAR snaps to the new
    // frequency — fine-tuning SSB through a stale backlog is impossible.
    audioQ.async { [weak self] in
      guard let self else { return }
      if self.queuedSeconds > 0.15 {
        self.queuedSeconds = 0
        let player = self.playerNode
        DispatchQueue.main.async {
          player?.stop()  // discards scheduled buffers
          if !self.isMuted { player?.play() }
        }
      }
    }
  }

  @objc func sendBandwidth(_ low: Int, high: Int) {
    sendWsJson(["type": "tune", "bandwidthLow": low, "bandwidthHigh": high])
  }

  @objc func setStep(_ hz: Int) {
    currentStep = hz
  }

  @objc func setInstanceName(_ name: String) {
    instanceName = name
    DispatchQueue.main.async { self.updateNowPlaying() }
  }

  @objc func setMuted(_ muted: Bool) {
    isMuted = muted
    if muted { playerNode?.pause() } else { playerNode?.play() }
    DispatchQueue.main.async { self.updateNowPlaying() }
  }

  @objc func setVolume(_ volume: Double) {
    playerNode?.volume = Float(max(0, min(1, volume)))
  }

  @objc func getDebugInfoSync() -> String {
    let eng = audioEngine != nil ? "yes" : "no"
    let dec = opusDecoder != nil ? "yes" : "no"
    let ws  = wsTask?.state == .running ? "open" : "closed"
    return "run=\(isRunning) pkts=\(packetCount) eng=\(eng) dec=\(dec) sr=\(decoderSampleRate) ws=\(ws)"
  }

  // MARK: - Native WebSocket

  private func openAudioWs(baseUrl: String, frequency: Int, mode: String, uuid: String) {
    guard let url = audioWsURL(baseUrl: baseUrl, frequency: frequency, mode: mode, uuid: uuid) else {
      NSLog("[VibePowerModule] bad WS URL from base: %@", baseUrl); return
    }
    NSLog("[VibePowerModule] opening audio WS: %@", url.absoluteString)
    let session = URLSession(configuration: .default)
    wsSession = session
    let task = session.webSocketTask(with: url)
    wsTask = task
    task.resume()
    receiveLoop(task: task)
  }

  private func audioWsURL(baseUrl: String, frequency: Int, mode: String, uuid: String) -> URL? {
    var s = baseUrl.trimmingCharacters(in: .whitespaces)
    if s.hasPrefix("https://") { s = "wss://" + s.dropFirst(8) }
    else if s.hasPrefix("http://") { s = "ws://" + s.dropFirst(7) }
    s = s.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    let path = "/ws?user_session_id=\(uuid)&frequency=\(frequency)&mode=\(mode)&format=opus&version=2"
    return URL(string: s + path)
  }

  private func receiveLoop(task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self, self.isRunning, self.wsTask === task else { return }
      switch result {
      case .success(let msg):
        switch msg {
        case .data(let data):
          self.packetCount += 1
          self.lastPacketAt = Date()
          if self.packetCount <= 3 {
            NSLog("[VibePowerModule] ws pkt#%d len=%d", self.packetCount, data.count)
          }
          if !self.isMuted {
            self.audioQ.async { self.handlePacket(data) }
          }
        case .string(let text):
          NSLog("[VibePowerModule] ws text: %@", text)
        @unknown default: break
        }
        self.receiveLoop(task: task)

      case .failure(let err):
        NSLog("[VibePowerModule] ws error: %@ — reconnecting in 2s", err.localizedDescription)
        guard self.isRunning else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
          guard self.isRunning else { return }
          // MUST reconnect with the SAME session uuid — audio extensions
          // (decoders) and the spectrum WS are keyed to it server-side. A
          // fresh UUID here silently orphans them ("no active audio session").
          self.openAudioWs(
            baseUrl: self.currentBase,
            frequency: self.currentFreq,
            mode: self.currentMode,
            uuid: self.currentUuid
          )
        }
      }
    }
  }

  private func sendWsJson(_ obj: [String: Any]) {
    guard let task = wsTask, task.state == .running else { return }
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let str  = String(data: data, encoding: .utf8) else { return }
    task.send(.string(str)) { err in
      if let err { NSLog("[VibePowerModule] ws send error: %@", err.localizedDescription) }
    }
  }

  // MARK: - Engine

  private func stopEngine() {
    isRunning = false
    healthTimer?.invalidate()
    healthTimer = nil
    wsTask?.cancel(with: .goingAway, reason: nil)
    wsTask    = nil
    wsSession = nil
    destroyDecoder()
    playerNode?.stop()
    audioEngine?.stop()
    playerNode  = nil
    audioEngine = nil
    audioFormat = nil
    MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
  }

  private func configureAVSession() {
    do {
      let s = AVAudioSession.sharedInstance()
      try s.setCategory(.playback, mode: .default)
      try s.setActive(true)
      NSLog("[VibePowerModule] AVAudioSession active")
    } catch {
      NSLog("[VibePowerModule] AVAudioSession error: %@", error.localizedDescription)
    }
    NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification, object: nil, queue: nil
    ) { [weak self] note in
      guard let self, self.isRunning else { return }
      let type = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
      if type == AVAudioSession.InterruptionType.ended.rawValue {
        try? AVAudioSession.sharedInstance().setActive(true)
        DispatchQueue.main.async {
          if !self.isMuted { try? self.audioEngine?.start(); self.playerNode?.play() }
        }
      }
    }
  }

  private func startEngine(sampleRate: Double, channels: Int) {
    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    engine.attach(player)
    guard let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                  sampleRate: sampleRate,
                                  channels: AVAudioChannelCount(channels),
                                  interleaved: false) else {
      NSLog("[VibePowerModule] AVAudioFormat init failed"); return
    }
    engine.connect(player, to: engine.mainMixerNode, format: fmt)
    do {
      try engine.start()
      player.play()
      NSLog("[VibePowerModule] engine started %.0fHz %dch", sampleRate, channels)
    } catch {
      NSLog("[VibePowerModule] engine start error: %@", error.localizedDescription); return
    }
    audioEngine = engine
    playerNode  = player
    audioFormat = fmt

    NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
    ) { [weak self] _ in
      guard let self, self.isRunning else { return }
      NSLog("[VibePowerModule] config change — restarting")
      DispatchQueue.main.async {
        guard let sr = self.audioFormat?.sampleRate, let ch = self.audioFormat?.channelCount else { return }
        self.playerNode?.stop(); self.audioEngine?.stop()
        self.playerNode = nil;   self.audioEngine = nil; self.audioFormat = nil
        self.startEngine(sampleRate: sr, channels: Int(ch))
      }
    }
  }

  private func reconfigureIfNeeded(sr: Double, ch: Int) {
    guard let fmt = audioFormat else { return }
    if fmt.sampleRate == sr && Int(fmt.channelCount) == ch { return }
    DispatchQueue.main.async {
      self.playerNode?.stop(); self.audioEngine?.stop()
      self.playerNode = nil;   self.audioEngine = nil; self.audioFormat = nil
      self.startEngine(sampleRate: sr, channels: ch)
    }
  }

  // MARK: - Packet parsing

  private func handlePacket(_ data: Data) {
    let headerLen = 21
    guard data.count > headerLen else { return }
    let bytes = [UInt8](data)
    let sr = Int32(bytes[8]) | Int32(bytes[9]) << 8 | Int32(bytes[10]) << 16 | Int32(bytes[11]) << 24
    let ch = Int32(bytes[12])
    guard sr >= 8000, sr <= 96000, ch == 1 || ch == 2 else { return }

    let opusLen = data.count - headerLen
    if opusLen < 3 { return }

    if opusDecoder == nil || decoderSampleRate != sr || decoderChannels != ch {
      initDecoder(sr: sr, ch: ch)
    }
    guard let decoder = opusDecoder else { return }

    let maxSamples = Int(FRAME_SIZE) * Int(ch)
    var pcm16 = [Int16](repeating: 0, count: maxSamples)
    let decoded = data.withUnsafeBytes { raw -> Int32 in
      let ptr = raw.baseAddress!.advanced(by: headerLen).assumingMemoryBound(to: UInt8.self)
      return opus_decode(decoder, ptr, Int32(opusLen), &pcm16, FRAME_SIZE, 0)
    }
    guard decoded > 0 else { return }

    reconfigureIfNeeded(sr: Double(sr), ch: Int(ch))

    let total = Int(decoded) * Int(ch)
    var pcmF  = [Float](repeating: 0, count: total)
    vDSP_vflt16(&pcm16, 1, &pcmF, 1, vDSP_Length(total))
    var scale: Float = 1.0 / 32768.0
    var pcmFScaled = [Float](repeating: 0, count: total)
    vDSP_vsmul(&pcmF, 1, &scale, &pcmFScaled, 1, vDSP_Length(total))
    schedulePCM(samples: pcmFScaled, frameCount: Int(decoded), ch: Int(ch))
  }

  private func schedulePCM(samples: [Float], frameCount: Int, ch: Int) {
    guard let player = playerNode, let fmt = audioFormat,
          let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(frameCount))
    else { return }
    // Live-edge bound: if a delivery burst piles up more than ~0.4s of queued
    // audio, drop instead of scheduling — latency stays bounded instead of
    // accumulating forever (runs on audioQ; queuedSeconds audioQ-only).
    let dur = Double(frameCount) / fmt.sampleRate
    if queuedSeconds > 0.4 { return }
    buf.frameLength = AVAudioFrameCount(frameCount)
    if ch == 1 {
      let out = buf.floatChannelData![0]
      for i in 0..<frameCount { out[i] = samples[i] }
    } else {
      let ch0 = buf.floatChannelData![0], ch1 = buf.floatChannelData![1]
      for i in 0..<frameCount { ch0[i] = samples[i*2]; ch1[i] = samples[i*2+1] }
    }
    queuedSeconds += dur
    player.scheduleBuffer(buf) { [weak self] in
      guard let self else { return }
      self.audioQ.async { self.queuedSeconds = max(0, self.queuedSeconds - dur) }
    }
  }

  // MARK: - Opus lifecycle

  private func initDecoder(sr: Int32, ch: Int32) {
    destroyDecoder()
    var err: Int32 = 0
    opusDecoder = opus_decoder_create(sr, ch, &err)
    NSLog("[VibePowerModule] decoder create sr=%d ch=%d err=%d", sr, ch, err)
    decoderSampleRate = sr
    decoderChannels   = ch
  }

  private func destroyDecoder() {
    if let d = opusDecoder { opus_decoder_destroy(d) }
    opusDecoder = nil; decoderSampleRate = 0; decoderChannels = 0
  }

  // MARK: - Lock screen / media controls

  private func updateNowPlaying() {
    let mhz = String(format: "%.3f MHz", Double(currentFreq) / 1_000_000)
    let title  = "\(mhz) \(currentMode.uppercased())\(isMuted ? " ·muted·" : "")"
    let artist = instanceName.isEmpty ? currentBase : instanceName
    MPNowPlayingInfoCenter.default().nowPlayingInfo = [
      MPMediaItemPropertyTitle:             title,
      MPMediaItemPropertyArtist:            artist,
      MPMediaItemPropertyAlbumTitle:        "VibeSDR",
      MPNowPlayingInfoPropertyPlaybackRate: isMuted ? 0.0 : 1.0,
      MPNowPlayingInfoPropertyIsLiveStream: true,
    ]
  }

  private func setupRemoteCommands() {
    let cc = MPRemoteCommandCenter.shared()

    // Play = unmute
    cc.playCommand.isEnabled = true
    cc.playCommand.removeTarget(nil)
    cc.playCommand.addTarget { [weak self] _ in
      self?.setMuted(false)
      return .success
    }

    // Pause = mute
    cc.pauseCommand.isEnabled = true
    cc.pauseCommand.removeTarget(nil)
    cc.pauseCommand.addTarget { [weak self] _ in
      self?.setMuted(true)
      return .success
    }

    // Skip forward = tune up by step
    cc.nextTrackCommand.isEnabled = true
    cc.nextTrackCommand.removeTarget(nil)
    cc.nextTrackCommand.addTarget { [weak self] _ in
      guard let self else { return .commandFailed }
      let newFreq = self.currentFreq + self.currentStep
      self.currentFreq = newFreq
      self.sendWsJson(["type": "tune", "frequency": newFreq])
      self.updateNowPlaying()
      self.sendEvent(withName: "VibeTuned", body: ["frequency": newFreq, "mode": self.currentMode])
      return .success
    }

    // Skip back = tune down by step
    cc.previousTrackCommand.isEnabled = true
    cc.previousTrackCommand.removeTarget(nil)
    cc.previousTrackCommand.addTarget { [weak self] _ in
      guard let self else { return .commandFailed }
      let newFreq = max(100_000, self.currentFreq - self.currentStep)
      self.currentFreq = newFreq
      self.sendWsJson(["type": "tune", "frequency": newFreq])
      self.updateNowPlaying()
      self.sendEvent(withName: "VibeTuned", body: ["frequency": newFreq, "mode": self.currentMode])
      return .success
    }
  }
}
