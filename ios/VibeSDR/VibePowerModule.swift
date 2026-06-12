import Foundation
import AVFoundation
import CoreLocation
import MediaPlayer
import UIKit

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
class VibePowerModule: RCTEventEmitter, CLLocationManagerDelegate {

  // MARK: - CLLocationManagerDelegate (one-shot location for the picker)

  func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    guard locResolve != nil else { return }
    switch manager.authorizationStatus {
    case .authorizedWhenInUse, .authorizedAlways:
      manager.requestLocation()
    case .denied, .restricted:
      locResolve?(nil)
      locResolve = nil
    default: break  // .notDetermined — prompt still showing
    }
  }

  func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard let loc = locations.last else { return }
    locResolve?(["lat": loc.coordinate.latitude, "lon": loc.coordinate.longitude])
    locResolve = nil
  }

  func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    locResolve?(nil)
    locResolve = nil
  }

  // MARK: - RCTEventEmitter

  override func supportedEvents() -> [String]! {
    return ["VibeTuned", "VibeMuted", "VibeWsText", "VibeSkip"]
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

  // FIXED-FORMAT ENGINE (half-speed FM bug 2026-06-12): the server flips
  // sample rate per mode (linear 12k, FM 24k). The old design rebuilt the
  // engine on main.async while the Opus decoder swapped synchronously on
  // audioQ — packets decoded at the new rate were scheduled into buffers of
  // the old format during the window = half-speed stretched audio. Now the
  // engine runs at 48 kHz stereo FOREVER and an AVAudioConverter (audioQ-only,
  // rebuilt when the packet format changes) resamples each packet. No engine
  // rebuilds, no race.
  private let ENGINE_RATE: Double = 48_000
  private let ENGINE_CH:   AVAudioChannelCount = 2
  private var converter:      AVAudioConverter?
  private var converterInFmt: AVAudioFormat?

  // Recorder — taps the uniform post-converter 48 kHz feed, so mode/rate
  // flips mid-recording are invisible to the file (same reason the skin
  // recorder behaved: Web Audio resampled upstream). AVAudioFile encodes
  // AAC .m4a in hardware. recFile is audioQ-only; recArmed is read on the
  // WS callback thread (same benign cross-thread pattern as isMuted).
  private var recFile:  AVAudioFile?
  private var recPath:  String = ""
  private var recArmed  = false

  // Client noise DSP (VibeDSP.swift — verbatim skin ports) applied to the
  // MONO packet-rate feed before stereo duplication + 48k conversion, the
  // same point the skin's Web Audio graph ran them. All state audioQ-only;
  // engines are lazy and rebuilt whenever the stream sample rate flips.
  private var nrModeStr     = "off"   // "off" | "nr" | "nr2"
  private var nbOn          = false
  private var dspRate: Int32 = 0
  private var nbEngine:      NoiseBlankerEngine?
  private var nr2Engine:     NR2Engine?
  private var nr2Chunker:    BlockChunker?
  private var websdrEngine:  WebSDRNREngine?
  private var websdrChunker: BlockChunker?
  private var nrBandwidthHz: Double = 2700

  private var wsTask:       URLSessionWebSocketTask?
  private var wsSession:    URLSession?
  // Set on every WS (re)open; the first received packet triggers a tune
  // re-assert so the server session always matches app state — sends during
  // the handshake window can be lost, which left the session on the URL's
  // freq/mode while the UI showed the restored tune.
  private var wsNeedsTuneAssert = false
  private var isRunning     = false
  private var isMuted       = false
  private var currentFreq:  Int    = 14_074_000
  private var currentMode:  String = "usb"
  private var currentBase:  String = ""
  private var currentStep:  Int    = 1_000
  private var currentUuid:  String = ""
  // Bypass password (rate-limit/ban bypass) — appended to the audio WS URL
  private var bypassPassword: String = ""
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
  // Now-playing overrides — JS computes a VTS-aware title/artist (station or
  // band name, user's frequency unit, tune step) and pushes them here. A
  // native lock-screen skip clears them until JS catches up (VibeTuned →
  // setNowPlaying round-trip, sub-second; background audio keeps JS alive).
  private var npTitleOverride:  String?
  private var npArtistOverride: String?
  // Composited album art (app icon + server-type logo inset), cached per type
  private var npArtwork: MPMediaItemArtwork?
  private var npArtworkType = ""
  // Media skip routing: "step" = native tune±step; "bookmark" = emit
  // VibeSkip and let JS jump bookmarks (it owns the VTS station list)
  private var skipMode = "step"

  // Tune coalescing: the velocity drum can emit 20+ steps/s; one WS tune per
  // step thrashes radiod. Leading send + 80ms trailing timer.
  private var pendingTune: (freq: Int, mode: String)?
  private var lastTuneSentAt = Date(timeIntervalSince1970: 0)
  private var tuneTimer: Timer?

  // MARK: - Exported methods

  @objc func startAudioEngine(_ baseUrl: String, frequency: Int, mode: String, uuid: String, password: String) {
    NSLog("[VibePowerModule] startAudioEngine %@ %d %@", baseUrl, frequency, mode)
    stopEngine()
    currentBase  = baseUrl
    currentFreq  = frequency
    currentMode  = mode
    currentUuid  = uuid
    bypassPassword = password
    isRunning    = true
    isMuted      = false
    packetCount  = 0
    lastPacketAt = Date()
    startHealthTimer()
    configureAVSession()
    startEngine()
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
    audioQ.async { [weak self] in
      guard let self else { return }
      // Audio occupies 0..max-edge Hz regardless of sideband
      self.nrBandwidthHz = Double(max(abs(low), abs(high)))
      self.websdrEngine?.syncBins(bandwidthHz: self.nrBandwidthHz,
                                  sampleRate: Double(self.dspRate > 0 ? self.dspRate : 12_000))
    }
  }

  // MARK: - Client noise DSP control

  @objc func setNrMode(_ mode: String) {
    audioQ.async { [weak self] in
      guard let self else { return }
      self.nrModeStr = mode
      // Fresh start on every (re)engage — matches the skin's reset-on-toggle
      self.nr2Engine?.reset();    self.nr2Chunker?.reset()
      self.websdrEngine?.reset(); self.websdrChunker?.reset()
    }
  }

  @objc func setNoiseBlanker(_ on: Bool) {
    audioQ.async { [weak self] in
      guard let self else { return }
      self.nbOn = on
      self.nbEngine?.reset()
    }
  }

  /** Forward a raw JSON command over the native audio WS (set_dsp,
   *  set_dsp_params, get_dsp_filters, set_audio_gate, set_squelch — these
   *  are AUDIO-WS message types; the spectrum WS doesn't know them). */
  @objc func sendAudioCommand(_ json: String) {
    guard let task = wsTask, task.state == .running else { return }
    task.send(.string(json)) { err in
      if let err { NSLog("[VibePowerModule] audio cmd send error: %@", err.localizedDescription) }
    }
  }

  /** audioQ-only. Applies NB → NR/NR2 to the mono packet-rate feed. */
  private func dspProcessMono(_ samples: inout [Float], sr: Int32) {
    if dspRate != sr {
      dspRate = sr
      nbEngine = nil
      nr2Engine = nil; nr2Chunker = nil
      websdrEngine = nil; websdrChunker = nil
    }
    if nbOn {
      if nbEngine == nil { nbEngine = NoiseBlankerEngine(sampleRate: Double(sr)) }
      nbEngine?.process(&samples)
    }
    switch nrModeStr {
    case "nr2":
      if nr2Engine == nil {
        let eng = NR2Engine()
        nr2Engine  = eng
        nr2Chunker = BlockChunker(block: 512) { blk in eng.processHop(blk) }
      }
      if let c = nr2Chunker { samples = c.run(samples) }
    case "nr":
      if websdrEngine == nil {
        let eng = WebSDRNREngine()
        eng.syncBins(bandwidthHz: nrBandwidthHz, sampleRate: Double(sr))
        websdrEngine  = eng
        websdrChunker = BlockChunker(block: WebSDRNREngine.BLOCK) { blk in eng.processWithDelay(blk) }
      }
      if let c = websdrChunker { samples = c.run(samples) }
    default: break
    }
  }

  @objc func setStep(_ hz: Int) {
    currentStep = hz
  }

  @objc func setMediaSkipMode(_ mode: String) {
    skipMode = mode
  }

  @objc func setInstanceName(_ name: String) {
    instanceName = name
    DispatchQueue.main.async { self.updateNowPlaying() }
  }

  @objc func setMuted(_ muted: Bool) {
    isMuted = muted
    if muted { playerNode?.pause() } else { playerNode?.play() }
    // JS shows a MUTED banner — media-control pause (AirPods squeeze) maps to
    // mute, which is otherwise invisible in the UI.
    sendEvent(withName: "VibeMuted", body: ["muted": muted])
    DispatchQueue.main.async { self.updateNowPlaying() }
  }

  @objc func setVolume(_ volume: Double) {
    playerNode?.volume = Float(max(0, min(1, volume)))
  }

  @objc func getDebugInfoSync() -> String {
    let eng = audioEngine != nil ? "yes" : "no"
    let dec = opusDecoder != nil ? "yes" : "no"
    let ws  = wsTask?.state == .running ? "open" : "closed"
    return "run=\(isRunning) pkts=\(packetCount) eng=\(eng) dec=\(dec) sr=\(decoderSampleRate) ws=\(ws) rec=\(recArmed)"
  }

  // MARK: - Recording

  @objc func startRecording(_ resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard isRunning else {
      reject("not_running", "Audio engine is not running", nil); return
    }
    let df = DateFormatter()
    df.dateFormat = "yyyy-MM-dd'T'HH-mm-ss"
    let mhz  = String(format: "%.4fMHz", Double(currentFreq) / 1e6)
    let name = "VibeSDR_\(df.string(from: Date()))_\(mhz)_\(currentMode.uppercased()).m4a"
    let url  = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      .appendingPathComponent(name)
    audioQ.async { [weak self] in
      guard let self else { reject("gone", "module deallocated", nil); return }
      do {
        // AAC straight from the hardware encoder; the file format is fixed
        // 48 kHz so tune/mode/BW changes mid-recording need no handling.
        let settings: [String: Any] = [
          AVFormatIDKey:         kAudioFormatMPEG4AAC,
          AVSampleRateKey:       self.ENGINE_RATE,
          AVNumberOfChannelsKey: Int(self.ENGINE_CH),
          AVEncoderBitRateKey:   128_000,
        ]
        self.recFile = try AVAudioFile(forWriting: url, settings: settings,
                                       commonFormat: .pcmFormatFloat32, interleaved: false)
        self.recPath  = url.path
        self.recArmed = true
        NSLog("[VibePowerModule] recording → %@", name)
        resolve(url.path)
      } catch {
        reject("rec_open", error.localizedDescription, error)
      }
    }
  }

  @objc func stopRecording(_ resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: @escaping RCTPromiseRejectBlock) {
    recArmed = false
    audioQ.async { [weak self] in
      guard let self else { resolve(nil); return }
      let path = self.recPath
      self.recFile = nil  // closing the AVAudioFile finalises the .m4a
      self.recPath = ""
      NSLog("[VibePowerModule] recording stopped: %@", path)
      resolve(path.isEmpty ? nil : path)
    }
  }

  /** audioQ-only — called from handlePacket with the converted 48 kHz buffer. */
  private func writeRecording(_ buf: AVAudioPCMBuffer) {
    guard let f = recFile else { return }
    do { try f.write(from: buf) }
    catch {
      NSLog("[VibePowerModule] rec write error: %@", error.localizedDescription)
      recArmed = false
      recFile  = nil
    }
  }

  // MARK: - Location (one-shot, for nearest-first instance sorting)
  // navigator.geolocation doesn't exist in React Native — the JS picker
  // never prompted and the directory fell back to IP geolocation (wildly
  // wrong on cellular). NSLocationWhenInUseUsageDescription is in Info.plist.

  private var locManager: CLLocationManager?
  private var locResolve: RCTPromiseResolveBlock?

  @objc func getLocation(_ resolve: @escaping RCTPromiseResolveBlock,
                         rejecter reject: @escaping RCTPromiseRejectBlock) {
    DispatchQueue.main.async {
      self.locResolve?(nil)  // settle any stale request
      self.locResolve = resolve
      let mgr = self.locManager ?? CLLocationManager()
      self.locManager = mgr
      mgr.delegate = self
      mgr.desiredAccuracy = kCLLocationAccuracyKilometer
      switch mgr.authorizationStatus {
      case .notDetermined:
        mgr.requestWhenInUseAuthorization()  // continues in the delegate
      case .authorizedWhenInUse, .authorizedAlways:
        mgr.requestLocation()
      default:
        self.locResolve = nil
        resolve(nil)  // denied — picker falls back to unsorted/IP order
      }
    }
  }

  /** Half-height iOS share sheet (medium detent, grabber to expand) — skin
   *  parity with the web navigator.share card. Unlike the skin, no save-mode
   *  workaround is needed: the audio WS is native, so presenting the sheet
   *  can't defocus/kill the connection. */
  @objc func shareRecording(_ path: String) {
    DispatchQueue.main.async {
      let url = URL(fileURLWithPath: path)
      guard FileManager.default.fileExists(atPath: path) else {
        NSLog("[VibePowerModule] shareRecording: missing file %@", path); return
      }
      guard let scene = UIApplication.shared.connectedScenes
              .compactMap({ $0 as? UIWindowScene })
              .first(where: { $0.activationState == .foregroundActive })
              ?? UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
            let root = (scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first)?
              .rootViewController else {
        NSLog("[VibePowerModule] shareRecording: no root VC"); return
      }
      var top = root
      while let presented = top.presentedViewController { top = presented }
      let avc = UIActivityViewController(activityItems: [url], applicationActivities: nil)
      if let sheet = avc.sheetPresentationController {
        sheet.detents = [.medium(), .large()]
        sheet.selectedDetentIdentifier = .medium
        sheet.prefersGrabberVisible = true
      }
      top.present(avc, animated: true)
    }
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
    wsNeedsTuneAssert = true
    task.resume()
    receiveLoop(task: task)
  }

  private func audioWsURL(baseUrl: String, frequency: Int, mode: String, uuid: String) -> URL? {
    var s = baseUrl.trimmingCharacters(in: .whitespaces)
    if s.hasPrefix("https://") { s = "wss://" + s.dropFirst(8) }
    else if s.hasPrefix("http://") { s = "ws://" + s.dropFirst(7) }
    s = s.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    var path = "/ws?user_session_id=\(uuid)&frequency=\(frequency)&mode=\(mode)&format=opus&version=2"
    if !bypassPassword.isEmpty,
       let pw = bypassPassword.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
      path += "&password=\(pw)"
    }
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
          if self.wsNeedsTuneAssert {
            self.wsNeedsTuneAssert = false
            self.sendWsJson(["type": "tune",
                             "frequency": self.currentFreq, "mode": self.currentMode])
          }
          if self.packetCount <= 3 {
            NSLog("[VibePowerModule] ws pkt#%d len=%d", self.packetCount, data.count)
          }
          // Recording must keep decoding through mutes (file taps the
          // converter feed); playback gating happens after conversion.
          if !self.isMuted || self.recArmed {
            self.audioQ.async { self.handlePacket(data) }
          }
        case .string(let text):
          // dsp_filters / dsp_status / dsp_error etc. — JS owns the server-NR
          // UI, so forward every text message up as an event.
          self.sendEvent(withName: "VibeWsText", body: ["text": text])
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
    recArmed = false
    audioQ.async { [weak self] in
      guard let self else { return }
      self.recFile   = nil  // closing the AVAudioFile finalises the .m4a
      self.converter = nil
      self.converterInFmt = nil
      self.dspRate = 0      // force DSP engine rebuild on next session
    }
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

  private func startEngine() {
    let engine = AVAudioEngine()
    let player = AVAudioPlayerNode()
    engine.attach(player)
    guard let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                  sampleRate: ENGINE_RATE,
                                  channels: ENGINE_CH,
                                  interleaved: false) else {
      NSLog("[VibePowerModule] AVAudioFormat init failed"); return
    }
    engine.connect(player, to: engine.mainMixerNode, format: fmt)
    do {
      try engine.start()
      player.play()
      NSLog("[VibePowerModule] engine started %.0fHz %dch", ENGINE_RATE, Int(ENGINE_CH))
    } catch {
      NSLog("[VibePowerModule] engine start error: %@", error.localizedDescription); return
    }
    audioEngine = engine
    playerNode  = player
    audioFormat = fmt

    // Route changes (AirPods connect etc.) still need an engine restart, but
    // the format is fixed so a restart can never disagree with the decoder.
    NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
    ) { [weak self] _ in
      guard let self, self.isRunning else { return }
      NSLog("[VibePowerModule] config change — restarting")
      DispatchQueue.main.async {
        self.playerNode?.stop(); self.audioEngine?.stop()
        self.playerNode = nil;   self.audioEngine = nil; self.audioFormat = nil
        self.startEngine()
      }
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

    let total = Int(decoded) * Int(ch)
    var pcmF  = [Float](repeating: 0, count: total)
    vDSP_vflt16(&pcm16, 1, &pcmF, 1, vDSP_Length(total))
    var scale: Float = 1.0 / 32768.0
    var pcmFScaled = [Float](repeating: 0, count: total)
    vDSP_vsmul(&pcmF, 1, &scale, &pcmFScaled, 1, vDSP_Length(total))

    // Client noise DSP (NB / NR / NR2) on the mono feed at the packet rate —
    // the recorder downstream captures the processed audio, like the skin.
    if ch == 1 && (nbOn || nrModeStr != "off") {
      dspProcessMono(&pcmFScaled, sr: sr)
    }

    // Packet-rate stereo buffer (mono duplicated to both channels) so the
    // converter only ever resamples 2ch→2ch — no channel-map ambiguity.
    let frameCount = Int(decoded)
    guard let inFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                    sampleRate: Double(sr),
                                    channels: ENGINE_CH,
                                    interleaved: false),
          let inBuf = AVAudioPCMBuffer(pcmFormat: inFmt,
                                       frameCapacity: AVAudioFrameCount(frameCount))
    else { return }
    inBuf.frameLength = AVAudioFrameCount(frameCount)
    let left  = inBuf.floatChannelData![0]
    let right = inBuf.floatChannelData![1]
    if ch == 1 {
      for i in 0..<frameCount { let v = pcmFScaled[i]; left[i] = v; right[i] = v }
    } else {
      for i in 0..<frameCount { left[i] = pcmFScaled[i*2]; right[i] = pcmFScaled[i*2+1] }
    }

    guard let outBuf = convertTo48k(inBuf) else { return }
    if recArmed { writeRecording(outBuf) }
    if !isMuted { scheduleOut(outBuf) }
  }

  /** Resample a packet-rate buffer to the fixed engine format. Runs on
   *  audioQ, same thread as the decoder swap — a rate flip rebuilds the
   *  converter and the very next packet is already correct. */
  private func convertTo48k(_ inBuf: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    guard let fmt = audioFormat else { return nil }
    if inBuf.format.sampleRate == fmt.sampleRate { return inBuf }
    if converter == nil || converterInFmt != inBuf.format {
      converter      = AVAudioConverter(from: inBuf.format, to: fmt)
      converterInFmt = inBuf.format
      NSLog("[VibePowerModule] converter %.0f→%.0fHz", inBuf.format.sampleRate, fmt.sampleRate)
    }
    guard let conv = converter else { return nil }
    let ratio  = fmt.sampleRate / inBuf.format.sampleRate
    let outCap = AVAudioFrameCount(Double(inBuf.frameLength) * ratio) + 64
    guard let outBuf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: outCap) else { return nil }
    var fed = false
    var err: NSError?
    let status = conv.convert(to: outBuf, error: &err) { _, outStatus in
      if fed { outStatus.pointee = .noDataNow; return nil }
      fed = true
      outStatus.pointee = .haveData
      return inBuf
    }
    if status == .error {
      NSLog("[VibePowerModule] convert error: %@", err?.localizedDescription ?? "?")
      return nil
    }
    return outBuf.frameLength > 0 ? outBuf : nil
  }

  private func scheduleOut(_ buf: AVAudioPCMBuffer) {
    guard let player = playerNode, let fmt = audioFormat else { return }
    // Live-edge bound: if a delivery burst piles up more than ~0.4s of queued
    // audio, drop instead of scheduling — latency stays bounded instead of
    // accumulating forever (runs on audioQ; queuedSeconds audioQ-only).
    let dur = Double(buf.frameLength) / fmt.sampleRate
    if queuedSeconds > 0.4 { return }
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
    let fallbackTitle  = "\(mhz) \(currentMode.uppercased())"
    let fallbackArtist = instanceName.isEmpty ? currentBase : instanceName
    let title  = (npTitleOverride ?? fallbackTitle) + (isMuted ? " ·muted·" : "")
    let artist = npArtistOverride ?? fallbackArtist
    var info: [String: Any] = [
      MPMediaItemPropertyTitle:             title,
      MPMediaItemPropertyArtist:            artist,
      MPMediaItemPropertyAlbumTitle:        "VibeSDR",
      MPNowPlayingInfoPropertyPlaybackRate: isMuted ? 0.0 : 1.0,
      MPNowPlayingInfoPropertyIsLiveStream: true,
    ]
    if let art = npArtwork { info[MPMediaItemPropertyArtwork] = art }
    MPNowPlayingInfoCenter.default().nowPlayingInfo = info
  }

  /** VTS-aware now-playing strings from JS (empty string clears). */
  @objc func setNowPlaying(_ title: String, artist: String) {
    npTitleOverride  = title.isEmpty ? nil : title
    npArtistOverride = artist.isEmpty ? nil : artist
    DispatchQueue.main.async { self.updateNowPlaying() }
  }

  /** Album art: VibeSDR icon with the server-type logo inset bottom-right
   *  (multi-server prep — type picks the overlay, "ubersdr" for now). */
  @objc func setArtwork(_ serverType: String) {
    guard serverType != npArtworkType else { return }
    npArtworkType = serverType
    DispatchQueue.main.async {
      guard let base = UIImage(named: "artwork_base") else {
        NSLog("[VibePowerModule] artwork_base missing"); return
      }
      var composed = base
      if let overlay = UIImage(named: "logo_\(serverType)") {
        let size = base.size
        let inset = size.width * 0.30
        let pad   = size.width * 0.045
        composed = UIGraphicsImageRenderer(size: size).image { _ in
          base.draw(in: CGRect(origin: .zero, size: size))
          overlay.draw(in: CGRect(x: size.width - inset - pad,
                                  y: size.height - inset - pad,
                                  width: inset, height: inset))
        }
      }
      let img = composed
      self.npArtwork = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
      self.updateNowPlaying()
    }
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
      if self.skipMode == "bookmark" {
        self.sendEvent(withName: "VibeSkip", body: ["direction": "next"])
        return .success
      }
      let newFreq = self.currentFreq + self.currentStep
      self.currentFreq = newFreq
      self.sendWsJson(["type": "tune", "frequency": newFreq])
      // Stale VTS strings (old station name) — fall back until JS catches up
      self.npTitleOverride = nil; self.npArtistOverride = nil
      self.updateNowPlaying()
      self.sendEvent(withName: "VibeTuned", body: ["frequency": newFreq, "mode": self.currentMode])
      return .success
    }

    // Skip back = tune down by step
    cc.previousTrackCommand.isEnabled = true
    cc.previousTrackCommand.removeTarget(nil)
    cc.previousTrackCommand.addTarget { [weak self] _ in
      guard let self else { return .commandFailed }
      if self.skipMode == "bookmark" {
        self.sendEvent(withName: "VibeSkip", body: ["direction": "prev"])
        return .success
      }
      let newFreq = max(100_000, self.currentFreq - self.currentStep)
      self.currentFreq = newFreq
      self.sendWsJson(["type": "tune", "frequency": newFreq])
      self.npTitleOverride = nil; self.npArtistOverride = nil
      self.updateNowPlaying()
      self.sendEvent(withName: "VibeTuned", body: ["frequency": newFreq, "mode": self.currentMode])
      return .success
    }
  }
}
