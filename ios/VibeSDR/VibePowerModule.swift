import Foundation
import AVFoundation
import CoreLocation
import MediaPlayer
import UIKit
import AppIntents
import Network

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
    return ["VibeTuned", "VibeMuted", "VibeWsText", "VibeSkip", "VibeCarConnected", "VibeCarTune",
            "VibeDataSaverDisconnect", "VibeDataSaverResume", "VibeSignal",
            "VibeVoiceQuery", "VibeVoiceTune", "VibeMdnsFound", "VibeMdnsLost"]
  }

  override static func requiresMainQueueSetup() -> Bool { return false }

  override init() {
    super.init()
    startVoiceObserver()
  }

  // MARK: - State

  // mDNS/Bonjour RTL-TCP discovery
  private var mdnsBrowser:   NWBrowser?
  private var mdnsResolvers: [NWConnection] = []
  private let mdnsQueue      = DispatchQueue(label: "com.vibesdr.mdns", qos: .utility)

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
  // ── Native audio WebSocket transport ────────────────────────────────────
  // iOS 27 beta regressed Foundation's URLSessionWebSocketTask for this stream:
  // the task reports `.running` but stops delivering frames (server keeps
  // streaming at the right bitrate — confirmed) → audio dies, media card sticks
  // paused. Only UberSDR hit it (the one path on URLSession; Kiwi/OWRX use the RN
  // socket). Fix = run the native audio WS on Network.framework (NWConnection +
  // NWProtocolWebSocket), a lower-level Apple transport that doesn't share the
  // regression, while staying off the JS thread so background audio survives.
  // Toggle kept so the proven iOS-26 URLSession path can be restored in one line
  // until NWConnection is device-confirmed on both 26 and 27.
  private static let useNWConnectionAudioWs = true
  private var wsConn:  NWConnection?
  private var wsReady = false
  private var wsGen   = 0   // generation — ignore callbacks from a superseded socket
  private let wsQueue = DispatchQueue(label: "com.vibesdr.ws", qos: .userInteractive)
  // Set on every WS (re)open; the first received packet triggers a tune
  // re-assert so the server session always matches app state — sends during
  // the handshake window can be lost, which left the session on the URL's
  // freq/mode while the UI showed the restored tune.
  private var wsNeedsTuneAssert = false
  // SERVER BUG WORKAROUND (FM half-speed, root-caused 2026-06-12): ubersdr
  // creates its opus encoder ONCE per WS at the then-current sample rate;
  // a mode change flips radiod to a new rate but keeps the old encoder, so
  // the audio is time-stretched INSIDE the opus stream (tape-with-dying-
  // batteries FM). Cycling the WS makes the server build a fresh encoder.
  private var wsBaseSr: Int32 = 0
  private var srFlipCount = 0
  private var lastSrCycleAt = Date(timeIntervalSince1970: 0)
  private var isRunning     = false
  private var isMuted       = false
  // Client-side auto notch for NETWORK backends (UberSDR/OWRX/Kiwi). Local/RTL-TCP
  // are notched in the shim, so this stays off for them (the JS toggle routes
  // local → LocalHw.setNotch, network → here). One filter per output channel.
  private var notchOn       = false
  private var notch: [AutoNotch] = []
  // Client-side audio squelch gate (network backends, e.g. Kiwi). JS drives it
  // from the S-meter dBm vs the threshold; when closed we output silence (engine
  // keeps running — distinct from pause/isMuted). Defaults open.
  private var squelchOpen   = true
  // External-audio pause behaviour (matches Android): "release" (OWRX/Kiwi —
  // pause drops the card), "resume" (local/RTL-TCP — pause mutes in place, keeps
  // the card, play resumes; no server to disconnect).
  private var externalPauseMode = "release"
  // Pause disconnects the SDR (the server drops it almost instantly on suspend
  // anyway) and Play reconnects; these track the two non-playing media-card
  // states: cleanly disconnected vs a reconnect that failed (server full /
  // rate-limited) and needs the user to open the app.
  private var dataSaverDisconnected = false
  private var reconnectFailed = false
  private var lastSignalEmit: TimeInterval = 0   // throttle the SNR (VibeSignal) event
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
    // Fresh session — clear the disconnected / reconnect-failed card state.
    dataSaverDisconnected = false
    reconnectFailed = false
    lastArtworkKey = ""
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

  // ── External PCM path (OWRX/Kiwi: the WS + decode live in JS; the native
  //    engine just plays the PCM JS pushes — foreground-first, no WS here) ──
  private var externalAudio = false
  private var externalRate: Double = 12000

  @objc func startExternalAudio(_ sampleRate: NSNumber, pauseMode: String) {
    NSLog("[VibePowerModule] startExternalAudio %@ pauseMode=%@", sampleRate, pauseMode)
    stopEngine()
    externalAudio = true
    externalPauseMode = pauseMode.isEmpty ? "release" : pauseMode
    externalRate  = max(8000, sampleRate.doubleValue)
    isRunning     = true
    isMuted       = false
    dataSaverDisconnected = false
    reconnectFailed = false
    packetCount   = 0
    lastPacketAt  = Date()
    configureAVSession()
    startEngine()
    DispatchQueue.main.async {
      self.setupRemoteCommands()
      self.updateNowPlaying()
    }
  }

  /// base64 of little-endian Int16 mono PCM at `sampleRate` → resample → play.
  /// Per-frame rate so type-2 (12 kHz) and type-4 HD/WFM (48 kHz) both work.
  @objc func pushExternalPcm(_ base64: String, sampleRate: NSNumber, channels: NSNumber) {
    guard externalAudio, !isMuted,
          let data = Data(base64Encoded: base64), data.count >= 2 else { return }
    let rate = max(8000, sampleRate.doubleValue)
    let ch2  = channels.intValue == 2   // interleaved L,R (local WFM stereo)
    audioQ.async { [weak self] in
      guard let self else { return }
      let total = data.count / 2
      let n = ch2 ? total / 2 : total
      guard n > 0,
            let inFmt = AVAudioFormat(commonFormat: .pcmFormatFloat32,
                                      sampleRate: rate, channels: 1, interleaved: false),
            let inBuf = AVAudioPCMBuffer(pcmFormat: inFmt, frameCapacity: AVAudioFrameCount(n)) else { return }
      inBuf.frameLength = AVAudioFrameCount(n)
      let ch = inBuf.floatChannelData![0]
      data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        let s16 = raw.bindMemory(to: Int16.self)
        if ch2 {
          // Downmix interleaved L,R → mono (the engine plays mono).
          for i in 0..<n { ch[i] = (Float(Int16(littleEndian: s16[i*2])) + Float(Int16(littleEndian: s16[i*2+1]))) / 65536.0 }
        } else {
          for i in 0..<n { ch[i] = Float(Int16(littleEndian: s16[i])) / 32768.0 }
        }
      }
      self.packetCount += 1
      self.lastPacketAt = Date()
      if let out = self.convertTo48k(inBuf) {
        if self.recArmed { self.writeRecording(out) }   // OWRX/external audio recording
        self.scheduleOut(out)
      }
    }
  }

  @objc func stopExternalAudio() {
    NSLog("[VibePowerModule] stopExternalAudio")
    externalAudio = false
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
    // externalAudio (OWRX/Kiwi) has NO native WS to revive — the socket + decode
    // live in JS, which drives its own resume. Reviving here would (re)open a
    // UberSDR audio WS to the stale currentBase = UberSDR audio under the OWRX
    // stream. Only the native Opus engine (startAudioEngine) is the watchdog's.
    guard isRunning, !externalAudio, !dataSaverDisconnected else { return }  // data saver owns the closed WS
    let stale  = Date().timeIntervalSince(lastPacketAt)
    // Packet staleness stays the PRIMARY zombie detector — the regression is
    // "state says alive, frames stop", so wsReady/.running is only a secondary cue.
    let wsDead = Self.useNWConnectionAudioWs ? !wsReady : (wsTask?.state != .running)
    guard stale > staleAfter || wsDead else { return }
    NSLog("[VibePowerModule] watchdog: stale=%.1fs wsDead=%d — reviving audio WS",
          stale, wsDead ? 1 : 0)
    lastPacketAt = Date() // debounce — one revive attempt per window
    closeAudioWs()
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

  /** Auto notch on/off for network backends (routed here by JS for
   *  UberSDR/OWRX/Kiwi; local/RTL-TCP are handled by the shim). */
  @objc func setNotch(_ on: Bool) {
    audioQ.async { [weak self] in
      guard let self else { return }
      self.notchOn = on
      if !on { for nf in self.notch { nf.reset() } }
    }
  }

  /** Client-side audio squelch gate (network, e.g. Kiwi). JS opens/closes it
   *  from the S-meter level vs the threshold. open=true is the default. */
  @objc func setSquelchOpen(_ open: Bool) {
    audioQ.async { [weak self] in self?.squelchOpen = open }
  }

  /** Forward a raw JSON command over the native audio WS (set_dsp,
   *  set_dsp_params, get_dsp_filters, set_audio_gate, set_squelch — these
   *  are AUDIO-WS message types; the spectrum WS doesn't know them). */
  @objc func sendAudioCommand(_ json: String) {
    sendWsText(json)
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

  /// Car browse tree (bookmarks + band plan) pushed from JS. Cached here for the
  /// CarPlay scene (CPListTemplate) — inert until the CarPlay-audio entitlement
  /// and App Store/TestFlight distribution are in place. See VibeCarPlay.swift.
  @objc func setBrowseItems(_ json: String) {
    VibeCarPlayData.shared.payloadJSON = json
    VibeVoice.setBrowse(json)   // persist for Siri entity resolution (incl. cold)
  }

  // ── Siri voice control ───────────────────────────────────────────────────

  /// JS pushes the default-instance name ('' = none) so the Siri intent can
  /// auto-connect (or tell the user to set a default). Persisted in VibeVoice.
  @objc func setDefaultInstance(_ name: String) { VibeVoice.setDefaultInstance(name) }

  /// JS pushes whether the SDR is connected (app open + live), so the intent can
  /// emit the command now vs stash it for a cold launch.
  @objc func setVoiceConnected(_ connected: Bool) { VibeVoice.setConnected(connected) }

  /// Cold-launch: JS reads the spoken query the intent stashed, once connected.
  @objc func getPendingVoiceQuery(_ resolve: @escaping RCTPromiseResolveBlock,
                                  rejecter _: @escaping RCTPromiseRejectBlock) {
    resolve(VibeVoice.takePending())
  }

  /// Bridge the Siri intent (which runs separately) to JS via a notification.
  private func startVoiceObserver() {
    NotificationCenter.default.addObserver(
      forName: VibeVoice.note, object: nil, queue: .main
    ) { [weak self] n in
      guard let event = n.userInfo?["event"] as? String,
            let body = n.userInfo?["body"] as? [String: Any] else { return }
      self?.sendEvent(withName: event, body: body)
    }
  }

  @objc func setInstanceName(_ name: String) {
    instanceName = name
    DispatchQueue.main.async { self.updateNowPlaying() }
  }

  @objc func setMuted(_ muted: Bool) {
    isMuted = muted
    sendEvent(withName: "VibeMuted", body: ["muted": muted])
    // OWRX/Kiwi (external): tuning + WS live in JS, and an OWRX reconnect RESETS
    // the server to its default profile — so we deliberately do NOT offer a
    // play-to-reconnect card here. PAUSE fully releases the media controls
    // (stopExternalAudio → stopEngine clears the now-playing card); JS closes its
    // WS on the VibeMuted event and shows an in-app reconnect prompt instead, so
    // reconnection (and the profile reset) is always a deliberate user action.
    if externalAudio {
      switch externalPauseMode {
      case "resume":
        // Local / RTL-TCP: no server to disconnect. The shim keeps running and
        // pushExternalPcm drops samples while muted, so mute in place and keep the
        // media card (▶ resumes). We must actually pause()/play() the player node:
        // if we only gate the buffers, iOS still sees a "playing" node and springs
        // the lock-screen button back to ▶. updateNowPlaying() reads isMuted so the
        // card reflects the paused state.
        DispatchQueue.main.async {
          if muted { self.playerNode?.pause() }
          else     { try? self.audioEngine?.start(); self.playerNode?.play() }
          self.updateNowPlaying()
        }
      case "reconnect":
        // Kiwi: behave like UberSDR — pause disconnects but keeps the card, play
        // reconnects. JS closes/reopens the Kiwi WS off the VibeDataSaver* events.
        DispatchQueue.main.async {
          if muted { self.disconnectForPause() }
          else if self.dataSaverDisconnected { self.resumeFromDataSaver() }
        }
      default:  // "release" — OWRX: pause drops the card; reconnect is manual in-app.
        if muted { DispatchQueue.main.async { self.stopExternalAudio() } }
      }
      return
    }
    // Pause = disconnect, Play = reconnect. The server drops the session almost
    // immediately on suspend anyway, and reconnecting is near-instant, so there's
    // no point keeping a muted-but-streaming state — we just disconnect cleanly
    // and show a "Disconnected" card with a working ▶ button.
    DispatchQueue.main.async {
      if muted {
        self.disconnectForPause()
      } else if self.dataSaverDisconnected {
        self.resumeFromDataSaver()
      }
    }
  }

  private func disconnectForPause() {
    guard !dataSaverDisconnected else { return }
    dataSaverDisconnected = true
    healthTimer?.invalidate(); healthTimer = nil
    closeAudioWs()
    isRunning = false
    playerNode?.stop(); audioEngine?.stop()   // releases the audio route (AirPods)
    // KEEP the media session + remote commands so ▶ reconnects; show it as a
    // clearly "Disconnected" card (handled in updateNowPlaying / refreshArtwork).
    DispatchQueue.main.async {
      self.updateNowPlaying()
      MPNowPlayingInfoCenter.default().playbackState = .paused
    }
    sendEvent(withName: "VibeDataSaverDisconnect", body: [:])
  }

  private func resumeFromDataSaver() {
    guard dataSaverDisconnected else { return }
    // Don't reopen the old session here — a partial reopen lands in a broken
    // half-state (frozen waterfall/zoom, no audio). Hand off to JS, which does a
    // full from-scratch reconnect (new uuid → fresh startAudioEngine, which
    // clears our data-saver state). The flag stays set until then so the
    // watchdog won't revive the stale socket.
    sendEvent(withName: "VibeDataSaverResume", body: [:])
  }

  /// JS calls this when a reconnect attempt fails (server full / rate-limited) so
  /// the lock-screen card tells the user to open the app.
  @objc func setReconnectFailed(_ failed: Bool) {
    reconnectFailed = failed
    if failed { dataSaverDisconnected = false }
    DispatchQueue.main.async { self.updateNowPlaying() }
  }

  @objc func setVolume(_ volume: Double) {
    playerNode?.volume = Float(max(0, min(1, volume)))
  }

  @objc func getDebugInfoSync() -> String {
    let eng = audioEngine != nil ? "yes" : "no"
    let dec = opusDecoder != nil ? "yes" : "no"
    let ws  = (Self.useNWConnectionAudioWs ? wsReady : (wsTask?.state == .running)) ? "open" : "closed"
    return "run=\(isRunning) pkts=\(packetCount) eng=\(eng) dec=\(dec) sr=\(decoderSampleRate) ws=\(ws) rec=\(recArmed)"
  }

  // MARK: - Recording

  @objc func startRecording(_ frequency: NSNumber, mode: NSString,
                            resolver resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    guard isRunning else {
      reject("not_running", "Audio engine is not running", nil); return
    }
    // JS passes the LIVE freq/mode — the native currentFreq/currentMode are only
    // tracked on the UberSDR audio-WS path, so for OWRX (external audio) they're
    // stale; fall back to them only if JS didn't supply a value.
    let freqHz = frequency.intValue > 0 ? frequency.intValue : currentFreq
    let modeStr = (mode as String).isEmpty ? currentMode : (mode as String)
    let df = DateFormatter()
    df.dateFormat = "yyyy-MM-dd'T'HH-mm-ss"
    let mhz  = String(format: "%.4fMHz", Double(freqHz) / 1e6)
    let name = "VibeSDR_\(df.string(from: Date()))_\(mhz)_\(modeStr.uppercased()).m4a"
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

  /// Open the native audio WS via whichever transport the toggle selects.
  private func openAudioWs(baseUrl: String, frequency: Int, mode: String, uuid: String) {
    if Self.useNWConnectionAudioWs {
      openAudioWsNW(baseUrl: baseUrl, frequency: frequency, mode: mode, uuid: uuid)
    } else {
      openAudioWsURLSession(baseUrl: baseUrl, frequency: frequency, mode: mode, uuid: uuid)
    }
  }

  /// Tear down whichever transport is live (both calls are no-ops if nil).
  private func closeAudioWs() {
    wsTask?.cancel(with: .goingAway, reason: nil); wsTask = nil; wsSession = nil
    wsConn?.cancel(); wsConn = nil; wsReady = false
  }

  // ── Shared per-packet handling (identical semantics for both transports) ──
  // Returns true if the socket was cycled (sr-flip) so the caller stops re-arming
  // the now-superseded receive loop.
  private func onAudioData(_ data: Data) -> Bool {
    packetCount += 1
    lastPacketAt = Date()
    if wsNeedsTuneAssert {
      wsNeedsTuneAssert = false
      sendWsJson(["type": "tune", "frequency": currentFreq, "mode": currentMode])
    }
    // Header sample-rate flip → server's per-WS opus encoder is now mismatched
    // (see wsBaseSr note) — cycle the socket for a fresh encoder. 3-packet
    // confirmation + 4s cooldown so stragglers around the flip can't storm.
    if data.count > 21 {
      let b = [UInt8](data.prefix(12))
      let sr = Int32(b[8]) | Int32(b[9]) << 8 | Int32(b[10]) << 16 | Int32(b[11]) << 24
      if sr >= 8000 && sr <= 96000 {
        if wsBaseSr == 0 {
          wsBaseSr = sr
        } else if sr != wsBaseSr {
          srFlipCount += 1
          if srFlipCount >= 3, Date().timeIntervalSince(lastSrCycleAt) > 4 {
            NSLog("[VibePowerModule] sample rate %d→%d — cycling WS for a fresh server encoder", wsBaseSr, sr)
            lastSrCycleAt = Date()
            closeAudioWs()                  // bumps to no live socket
            openAudioWs(baseUrl: currentBase, frequency: currentFreq,
                        mode: currentMode, uuid: currentUuid)  // NW: bumps wsGen
            return true                     // new receive loop owns the socket now
          }
        } else {
          srFlipCount = 0
        }
      }
    }
    if packetCount <= 3 {
      NSLog("[VibePowerModule] ws pkt#%d len=%d", packetCount, data.count)
    }
    // Recording must keep decoding through mutes (file taps the converter feed);
    // playback gating happens after conversion.
    if !isMuted || recArmed {
      audioQ.async { self.handlePacket(data) }
    }
    return false
  }

  // ── Transport A: Network.framework (iOS 27-safe, default) ────────────────
  private func openAudioWsNW(baseUrl: String, frequency: Int, mode: String, uuid: String) {
    guard let url = audioWsURL(baseUrl: baseUrl, frequency: frequency, mode: mode, uuid: uuid) else {
      NSLog("[VibePowerModule] bad WS URL from base: %@", baseUrl); return
    }
    NSLog("[VibePowerModule] opening audio WS (NWConnection): %@", url.absoluteString)
    wsNeedsTuneAssert = true
    wsBaseSr = 0
    srFlipCount = 0
    wsReady = false
    wsGen &+= 1
    let gen = wsGen

    let secure = (url.scheme == "wss")
    let params: NWParameters = secure ? .tls : .tcp   // tunnel cert valid → default trust
    let wsOpts = NWProtocolWebSocket.Options()
    wsOpts.autoReplyPing = true                        // answer server pings natively
    params.defaultProtocolStack.applicationProtocols.insert(wsOpts, at: 0)

    let conn = NWConnection(to: .url(url), using: params)
    wsConn = conn
    conn.stateUpdateHandler = { [weak self] state in
      guard let self, self.isRunning, self.wsGen == gen else { return }
      switch state {
      case .ready:
        self.wsReady = true
        NSLog("[VibePowerModule] audio WS ready")
        self.wsReceive(conn, gen: gen)
      case .waiting(let err):
        // Path not satisfiable yet (e.g. just after airplane-mode off). NWConnection
        // auto-retries toward .ready; don't reconnect here — the watchdog covers a
        // stuck wait via packet staleness.
        NSLog("[VibePowerModule] audio WS waiting: %@", "\(err)")
      case .failed(let err):
        self.wsReady = false
        NSLog("[VibePowerModule] audio WS failed: %@ — reconnecting in 2s", "\(err)")
        self.scheduleAudioWsReconnect(gen: gen)
      case .cancelled:
        self.wsReady = false
      default:
        break
      }
    }
    conn.start(queue: wsQueue)
  }

  private func wsReceive(_ conn: NWConnection, gen: Int) {
    conn.receiveMessage { [weak self] (data, context, _, error) in
      guard let self, self.isRunning, self.wsGen == gen, self.wsConn === conn else { return }
      if let error {
        NSLog("[VibePowerModule] audio WS receive error: %@ — reconnecting", "\(error)")
        self.scheduleAudioWsReconnect(gen: gen); return
      }
      let op = (context?.protocolMetadata(definition: NWProtocolWebSocket.definition)
                as? NWProtocolWebSocket.Metadata)?.opcode
      switch op {
      case .binary:
        if let data, self.onAudioData(data) { return }  // cycled → superseded loop
        if self.wsGen != gen { return }
      case .text:
        if let data {
          self.sendEvent(withName: "VibeWsText",
                         body: ["text": String(decoding: data, as: UTF8.self)])
        }
      case .close:
        NSLog("[VibePowerModule] audio WS closed by peer — reconnecting")
        self.scheduleAudioWsReconnect(gen: gen); return
      default:
        break   // ping/pong auto-handled; continuation frames coalesced
      }
      self.wsReceive(conn, gen: gen)   // re-arm
    }
  }

  /// Idempotent 2s reconnect (a receive error, .failed and a peer .close can all
  /// route here; the wsGen guard makes it fire at most once per generation).
  private func scheduleAudioWsReconnect(gen: Int) {
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
      guard let self, self.isRunning, self.wsGen == gen else { return }  // superseded → drop
      // SAME uuid — decoders + spectrum WS are keyed to it server-side.
      self.openAudioWs(baseUrl: self.currentBase, frequency: self.currentFreq,
                       mode: self.currentMode, uuid: self.currentUuid)
    }
  }

  // ── Transport B: URLSessionWebSocketTask (legacy, iOS 26 path) ───────────
  private func openAudioWsURLSession(baseUrl: String, frequency: Int, mode: String, uuid: String) {
    guard let url = audioWsURL(baseUrl: baseUrl, frequency: frequency, mode: mode, uuid: uuid) else {
      NSLog("[VibePowerModule] bad WS URL from base: %@", baseUrl); return
    }
    NSLog("[VibePowerModule] opening audio WS (URLSession): %@", url.absoluteString)
    let session = URLSession(configuration: .default)
    wsSession = session
    let task = session.webSocketTask(with: url)
    wsTask = task
    wsNeedsTuneAssert = true
    wsBaseSr = 0
    srFlipCount = 0
    task.resume()
    receiveLoopURLSession(task: task)
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

  private func receiveLoopURLSession(task: URLSessionWebSocketTask) {
    task.receive { [weak self] result in
      guard let self, self.isRunning, self.wsTask === task else { return }
      switch result {
      case .success(let msg):
        switch msg {
        case .data(let data):
          if self.onAudioData(data) { return }   // cycled → new receive loop owns
        case .string(let text):
          // dsp_filters / dsp_status / dsp_error etc. — JS owns the server-NR
          // UI, so forward every text message up as an event.
          self.sendEvent(withName: "VibeWsText", body: ["text": text])
        @unknown default: break
        }
        self.receiveLoopURLSession(task: task)

      case .failure(let err):
        NSLog("[VibePowerModule] ws error: %@ — reconnecting in 2s", err.localizedDescription)
        guard self.isRunning else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
          guard self.isRunning, !Self.useNWConnectionAudioWs else { return }
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

  /// Transport-agnostic text send (tune asserts, DSP commands). No-op unless the
  /// active socket is connected.
  private func sendWsText(_ text: String) {
    if Self.useNWConnectionAudioWs {
      guard let conn = wsConn, wsReady, let data = text.data(using: .utf8) else { return }
      let md  = NWProtocolWebSocket.Metadata(opcode: .text)
      let ctx = NWConnection.ContentContext(identifier: "send", metadata: [md])
      conn.send(content: data, contentContext: ctx, isComplete: true,
                completion: .contentProcessed { err in
                  if let err { NSLog("[VibePowerModule] ws send error: %@", "\(err)") }
                })
    } else {
      guard let task = wsTask, task.state == .running else { return }
      task.send(.string(text)) { err in
        if let err { NSLog("[VibePowerModule] ws send error: %@", err.localizedDescription) }
      }
    }
  }

  private func sendWsJson(_ obj: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let str  = String(data: data, encoding: .utf8) else { return }
    sendWsText(str)
  }

  // MARK: - Engine

  private func stopEngine() {
    isRunning = false
    // Reset external mode so switching OWRX→UberSDR doesn't leave us in external
    // mode (which made UberSDR pause take the external release path).
    // startExternalAudio re-sets it true right after its stopEngine() call.
    externalAudio = false
    externalPauseMode = "release"
    healthTimer?.invalidate()
    healthTimer = nil
    closeAudioWs()
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
      guard let self else { return }
      let type = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
      if type == AVAudioSession.InterruptionType.began.rawValue {
        // Something grabbed the audio session — could be transient (Siri in the
        // car, a phone call) or persistent (a Mac took the shared AirPods). iOS
        // pauses us; sync our state so the UI shows muted. NB this calls
        // disconnectForPause() → isRunning=false, so .ended must NOT gate on it.
        guard self.isRunning else { return }
        DispatchQueue.main.async { if !self.isMuted { self.setMuted(true) } }
      } else if type == AVAudioSession.InterruptionType.ended.rawValue {
        // Only auto-resume when iOS says the interruption was transient
        // (.shouldResume) — e.g. Siri voice tuning in CarPlay. Without this the
        // Siri interruption disconnected VibeSDR and it sat dead until a manual
        // Play. A persistent takeover (no .shouldResume) still waits for Play.
        let opts = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
        let shouldResume = (opts & AVAudioSession.InterruptionOptions.shouldResume.rawValue) != 0
        guard shouldResume else { return }
        try? AVAudioSession.sharedInstance().setActive(true)
        DispatchQueue.main.async {
          if self.dataSaverDisconnected {
            self.setMuted(false)   // full reconnect, identical to pressing ▶
          } else if !self.isMuted {
            try? self.audioEngine?.start(); self.playerNode?.play()
          }
        }
      }
    }
    // Car-audio route → gates band-aware auto mode/step on iPhone. Works through
    // the normal media route (CarPlay or car Bluetooth) with no CarPlay
    // entitlement; emits VibeCarConnected on every route change.
    NotificationCenter.default.addObserver(
      forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil
    ) { [weak self] _ in self?.emitCarConnected() }
    emitCarConnected()
  }

  private func isCarAudioRoute() -> Bool {
    return AVAudioSession.sharedInstance().currentRoute.outputs.contains {
      $0.portType == .carAudio
    }
  }

  private var lastCarConnected: Bool?
  private func emitCarConnected() {
    let connected = isCarAudioRoute()
    if connected == lastCarConnected { return }   // de-dupe route-change spam
    lastCarConnected = connected
    sendEvent(withName: "VibeCarConnected", body: ["connected": connected])
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

    // SNR meter = radiod channel SNR = basebandPower − noiseDensity (both dBFS),
    // carried per-packet. This is the demodulator's own channel measurement, so
    // it's independent of the spectrum/zoom — same as UberSDR's meter.
    let bb = Float(bitPattern: UInt32(bytes[13]) | UInt32(bytes[14]) << 8 | UInt32(bytes[15]) << 16 | UInt32(bytes[16]) << 24)
    let nd = Float(bitPattern: UInt32(bytes[17]) | UInt32(bytes[18]) << 8 | UInt32(bytes[19]) << 16 | UInt32(bytes[20]) << 24)
    if bb > -900, nd > -900 {
      let now = ProcessInfo.processInfo.systemUptime
      if now - lastSignalEmit > 0.2 {
        lastSignalEmit = now
        sendEvent(withName: "VibeSignal", body: ["snr": Double(bb - nd), "dbfs": Double(bb)])
      }
    }

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
    // Only skip conversion when BOTH rate and channel count match — a 48 kHz MONO
    // input (OWRX WFM HD audio) has the engine's rate but not its stereo layout;
    // returning it unconverted scheduled a mono buffer on the stereo node → crash.
    if inBuf.format.sampleRate == fmt.sampleRate && inBuf.format.channelCount == fmt.channelCount { return inBuf }
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

  // Last time ensureRendering() forced a session/engine/player recovery — debounce
  // so a burst of buffers can't thrash setActive.
  private var lastRenderKick: TimeInterval = 0

  /** Make sure the player is ACTUALLY rendering before we schedule real audio.
   *  UberSDR opens its WS ~1s AFTER startEngine, so startEngine's play() runs on
   *  an empty player; on iOS 27 a play()-before-any-buffer leaves the node idle
   *  and it never re-engages when buffers finally arrive (UberSDR-only: OWRX/Kiwi
   *  push PCM immediately so they never hit the gap). The system audio session can
   *  also wedge (observed nominal sample rate 0) and survive an app force-quit —
   *  only a full session rebuild (a phone call, or Kiwi warming it first) cured it.
   *  This applies that rebuild proactively the moment we have a buffer to play. */
  private func ensureRendering() {
    guard isRunning else { return }
    let engineDown = !(audioEngine?.isRunning ?? false)
    let playerDown = !(playerNode?.isPlaying ?? false)
    guard engineDown || playerDown else { return }
    let now = ProcessInfo.processInfo.systemUptime
    guard now - lastRenderKick > 2 else { return }   // one rebuild per 2s
    lastRenderKick = now
    NSLog("[VibePowerModule] ensureRendering: engineDown=%d playerDown=%d — rebuilding session",
          engineDown, playerDown)
    DispatchQueue.main.async { [weak self] in
      guard let self, self.isRunning else { return }
      let s = AVAudioSession.sharedInstance()
      // Deactivate→reactivate clears a wedged session (sample-rate 0) that a bare
      // setActive(true) won't — this is what the phone-call teardown did.
      try? s.setActive(false, options: .notifyOthersOnDeactivation)
      try? s.setCategory(.playback, mode: .default)
      try? s.setActive(true)
      if !(self.audioEngine?.isRunning ?? false) { try? self.audioEngine?.start() }
      if !(self.playerNode?.isPlaying ?? false) { self.playerNode?.play() }
    }
  }

  private func scheduleOut(_ buf: AVAudioPCMBuffer) {
    guard let player = playerNode, let fmt = audioFormat else { return }
    ensureRendering()
    // Auto notch (network backends): adaptive line enhancer per channel, applied
    // on the final 48 kHz feed. Runs on audioQ (single-threaded), so the filter
    // state is safe. Local/RTL-TCP never enable it here (shim already notched).
    if notchOn, let chans = buf.floatChannelData {
      let nch = Int(buf.format.channelCount)
      while notch.count < nch { notch.append(AutoNotch()) }
      let n = Int(buf.frameLength)
      for c in 0..<nch { notch[c].process(chans[c], n) }
    }
    // Squelch closed → output silence (keeps the player fed, no underrun).
    if !squelchOpen, let chans = buf.floatChannelData {
      let nch = Int(buf.format.channelCount)
      let n = Int(buf.frameLength)
      for c in 0..<nch { memset(chans[c], 0, n * MemoryLayout<Float>.size) }
    }
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
    refreshArtwork()  // keep the inset glyph/countdown in step with the state
    let mhz = String(format: "%.3f MHz", Double(currentFreq) / 1_000_000)
    let fallbackTitle  = "\(mhz) \(currentMode.uppercased())"
    let fallbackArtist = instanceName.isEmpty ? currentBase : instanceName
    let title: String
    let artist: String
    if reconnectFailed {
      title  = "Failed to reconnect"
      artist = "Open VibeSDR to reconnect"
    } else if dataSaverDisconnected {
      title  = "Disconnected"
      artist = "VibeSDR — press ▶ to reconnect"
    } else {
      title  = npTitleOverride ?? fallbackTitle
      artist = npArtistOverride ?? fallbackArtist
    }
    // RTL-TCP/local "resume" pause = muted in place (engine kept alive) — that's a
    // paused state for the lock screen even though we're not disconnected.
    let paused = dataSaverDisconnected || reconnectFailed
              || (externalAudio && externalPauseMode == "resume" && isMuted)
    var info: [String: Any] = [
      MPMediaItemPropertyTitle:             title,
      MPMediaItemPropertyArtist:            artist,
      MPMediaItemPropertyAlbumTitle:        "VibeSDR",
      MPNowPlayingInfoPropertyPlaybackRate: paused ? 0.0 : 1.0,
      MPNowPlayingInfoPropertyIsLiveStream: true,
    ]
    if let art = npArtwork { info[MPMediaItemPropertyArtwork] = art }
    let center = MPNowPlayingInfoCenter.default()
    center.nowPlayingInfo = info
    // The lock-screen / Control-Center play-pause button and route arbitration
    // (which device owns the AirPods) follow playbackState, NOT the playbackRate
    // in the info dict. Without this the button springs back to ▶ on pause and
    // iOS keeps grabbing shared AirPods from the Mac because it thinks we're
    // still playing.
    center.playbackState = paused ? .paused : .playing
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
    DispatchQueue.main.async { self.updateNowPlaying() }  // refreshes art + pushes
  }

  // Composite the album art with a state-aware bottom-right inset: the server
  // logo while playing, a muted-speaker glyph + minutes-to-disconnect while
  // muted, a disconnected glyph once the data saver has dropped the stream.
  private var lastArtworkKey = ""
  private func refreshArtwork() {
    guard let base = UIImage(named: "artwork_base") else { return }
    let key = reconnectFailed ? "fail"
            : dataSaverDisconnected ? "disc"
            : "play-\(npArtworkType)"
    guard key != lastArtworkKey else { return }
    lastArtworkKey = key

    let size  = base.size
    let inset = size.width * 0.30
    let pad   = size.width * 0.045
    let rect  = CGRect(x: size.width - inset - pad, y: size.height - inset - pad,
                       width: inset, height: inset)
    let red    = UIColor(red: 0.92, green: 0.32, blue: 0.28, alpha: 1)
    let amber  = UIColor(red: 1.0, green: 0.74, blue: 0.20, alpha: 1)
    let img = UIGraphicsImageRenderer(size: size).image { _ in
      base.draw(in: CGRect(origin: .zero, size: size))
      if reconnectFailed {
        // disconnected glyph + a little exclamation badge bottom-right
        drawSymbol("wifi.slash", in: rect, tint: red)
        let b = CGRect(x: rect.maxX - rect.width * 0.5, y: rect.maxY - rect.height * 0.5,
                       width: rect.width * 0.5, height: rect.height * 0.5)
        drawSymbol("exclamationmark.circle.fill", in: b, tint: amber)
      } else if dataSaverDisconnected {
        drawSymbol("wifi.slash", in: rect, tint: red)
      } else if npArtworkType == "rtltcp", let icon = UIImage(named: "logo_rtltcp") {
        // RTL-TCP icon is black line art → amber-tint it (matches the Android card
        // + the RTL-TCP menu icon) so it reads on the dark album base.
        icon.withTintColor(amber, renderingMode: .alwaysOriginal).draw(in: rect)
      } else if let overlay = UIImage(named: "logo_\(npArtworkType)") {
        overlay.draw(in: rect)
      }
    }
    npArtwork = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
  }

  private func drawSymbol(_ name: String, in rect: CGRect, tint: UIColor) {
    let cfg = UIImage.SymbolConfiguration(pointSize: rect.height, weight: .semibold)
    guard let sym = UIImage(systemName: name, withConfiguration: cfg)?
            .withTintColor(tint, renderingMode: .alwaysOriginal) else { return }
    // aspect-fit the symbol inside rect
    let s = min(rect.width / sym.size.width, rect.height / sym.size.height)
    let w = sym.size.width * s, h = sym.size.height * s
    sym.draw(in: CGRect(x: rect.midX - w / 2, y: rect.midY - h / 2, width: w, height: h))
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
      // External (OWRX/Kiwi): tuning lives in JS — delegate the skip so we don't
      // tune the native UberSDR WS (which resurrects a UberSDR session). JS
      // handles step vs bookmark from its own media-skip setting.
      if self.externalAudio || self.skipMode == "bookmark" {
        self.sendEvent(withName: "VibeSkip", body: ["direction": "next"])
        return .success
      }
      let newFreq = self.snapStep(1)
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
      if self.externalAudio || self.skipMode == "bookmark" {
        self.sendEvent(withName: "VibeSkip", body: ["direction": "prev"])
        return .success
      }
      let newFreq = self.snapStep(-1)
      self.currentFreq = newFreq
      self.sendWsJson(["type": "tune", "frequency": newFreq])
      self.npTitleOverride = nil; self.npArtistOverride = nil
      self.updateNowPlaying()
      self.sendEvent(withName: "VibeTuned", body: ["frequency": newFreq, "mode": self.currentMode])
      return .success
    }
  }

  /// Snap a media-control skip to the step grid, matching the VFO drum: an
  /// off-grid frequency lands on the next/previous multiple of the step; an
  /// on-grid one moves exactly one step. direction +1 = up, -1 = down.
  private func snapStep(_ direction: Int) -> Int {
    let s = currentStep
    guard s > 0 else { return max(100_000, currentFreq) }
    let snapped = direction > 0 ? (currentFreq / s + 1) * s
                                : ((currentFreq + s - 1) / s - 1) * s
    return max(100_000, snapped)
  }

  // MARK: - mDNS / Bonjour discovery of networked RTL-TCP servers
  //
  // Browses for `_rtl_tcp._tcp` services on the local network via NWBrowser (the
  // Apple-blessed, App-Store-clean path — no subnet scanning). Each discovered
  // service is resolved to host:port with a short-lived NWConnection, and the
  // friendly name is taken from the service's `name` TXT record when present.
  // Results are pushed to JS as VibeMdnsFound / VibeMdnsLost. Lives here (rather
  // than a separate module) so it compiles in the app target with no pbxproj
  // change — JS reaches it via NativeModules.VibePowerModule.
  private static let rtlTcpServiceType = "_rtl_tcp._tcp"

  @objc(startDiscovery)
  func startDiscovery() {
    stopDiscovery()
    let params = NWParameters()
    params.includePeerToPeer = true
    let browser = NWBrowser(
      for: .bonjourWithTXTRecord(type: VibePowerModule.rtlTcpServiceType, domain: nil),
      using: params)
    mdnsBrowser = browser
    browser.browseResultsChangedHandler = { [weak self] _, changes in
      guard let self = self else { return }
      for change in changes {
        switch change {
        case .added(let result):
          self.resolveMdns(result)
        case .removed(let result):
          if case let .service(name, _, _, _) = result.endpoint {
            self.sendEvent(withName: "VibeMdnsLost", body: ["name": name])
          }
        default:
          break
        }
      }
    }
    browser.start(queue: mdnsQueue)
  }

  @objc(stopDiscovery)
  func stopDiscovery() {
    mdnsBrowser?.cancel()
    mdnsBrowser = nil
    for conn in mdnsResolvers { conn.cancel() }
    mdnsResolvers.removeAll()
  }

  private func resolveMdns(_ result: NWBrowser.Result) {
    guard case let .service(serviceName, _, _, _) = result.endpoint else { return }
    // Friendly name from the `name` TXT record, falling back to the service name.
    var friendly = serviceName
    if case let .bonjour(txt) = result.metadata, let n = txt["name"], !n.isEmpty {
      friendly = n
    }
    let conn = NWConnection(to: result.endpoint, using: .tcp)
    mdnsResolvers.append(conn)
    conn.stateUpdateHandler = { [weak self, weak conn] state in
      guard let self = self, let conn = conn else { return }
      switch state {
      case .ready:
        if let path = conn.currentPath,
           case let .hostPort(host, port) = path.remoteEndpoint {
          var h = "\(host)"
          if let pct = h.firstIndex(of: "%") { h = String(h[..<pct]) }  // strip IPv6 zone id
          h = h.replacingOccurrences(of: "[", with: "").replacingOccurrences(of: "]", with: "")
          self.sendEvent(withName: "VibeMdnsFound",
                         body: ["name": friendly, "host": h, "port": Int(port.rawValue)])
        }
        self.dropResolver(conn)
      case .failed, .cancelled:
        self.dropResolver(conn)
      default:
        break
      }
    }
    conn.start(queue: mdnsQueue)
  }

  private func dropResolver(_ conn: NWConnection) {
    conn.cancel()
    mdnsResolvers.removeAll { $0 === conn }
  }
}

/// Holds the car browse payload pushed from JS (bookmarks + band plan) so a
/// future CarPlay scene (CPListTemplate) can render it. Inert today: VibeSDR
/// ships as a dev-signed sideload, and CarPlay browsing needs Apple's
/// `com.apple.developer.carplay-audio` entitlement + App Store/TestFlight
/// distribution. When that lands, add a CPTemplateApplicationSceneDelegate that
/// reads `payloadJSON` and calls `onTune` (wire it to emit "VibeCarTune" the
/// same way Android Auto's onPlayFromMediaId does). Band-aware auto mode/step
/// already works in the car today via the AVAudioSession car-audio route — it
/// does NOT depend on this.
final class VibeCarPlayData {
  static let shared = VibeCarPlayData()
  private init() {}
  var payloadJSON: String = "{}"
  /// Set by the CarPlay scene once it exists: (frequency, mode, isBand).
  var onTune: ((Double, String?, Bool) -> Void)?
}

// MARK: - Siri voice control (App Intents)

/// UserDefaults-backed glue between the Siri intents (which can run before/around
/// the React layer) and JS. All resolution (frequency parse, bookmark/band match,
/// step/mode synonyms) happens in JS (reusing searchStations); the intent only
/// passes the spoken text + a kind. Live commands post a notification that
/// VibePowerModule forwards to JS; cold-launch commands are stashed for JS to read
/// after it connects to the default instance.
enum VibeVoice {
  static let note = Notification.Name("VibeVoiceCommand")
  private static let d = UserDefaults.standard
  private static let kPending = "vibeVoicePending"     // JSON {kind, query} for cold launch
  private static let kDefault = "vibeDefaultInstance"
  private static let kConnected = "vibeVoiceConnected"
  private static let kBookmarks = "vibeVoiceBookmarks"  // JSON [{name,frequency,mode}] for Siri disambiguation

  static func setDefaultInstance(_ name: String) { d.set(name, forKey: kDefault) }
  static func setConnected(_ c: Bool) { d.set(c, forKey: kConnected) }
  /// Cache the bookmark list (from the car-browse payload) so the Tune intent can
  /// match a spoken name against it natively and, on multiple hits, drive a Siri
  /// spoken pick-list. Persisted to UserDefaults so it survives a cold launch.
  static func setBrowse(_ json: String) {
    guard let data = json.data(using: .utf8),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let bms = obj["bookmarks"] as? [[String: Any]] else { return }
    if let out = try? JSONSerialization.data(withJSONObject: bms) {
      d.set(out, forKey: kBookmarks)
    }
  }
  static var hasDefault: Bool { !(d.string(forKey: kDefault) ?? "").isEmpty }
  static var isConnected: Bool { d.bool(forKey: kConnected) }

  /// Fuzzy-match a spoken station name against the cached bookmarks: every word of
  /// the query must appear in the bookmark name (case-insensitive). Frequencies
  /// ("7150") won't match a name, so they fall through to the JS resolver.
  static func allBookmarks() -> [VibeBookmarkEntity] {
    guard let data = d.data(forKey: kBookmarks),
          let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
    return arr.compactMap { b in
      guard let name = b["name"] as? String,
            let freq = (b["frequency"] as? NSNumber)?.intValue else { return nil }
      return VibeBookmarkEntity(id: "\(name)|\(freq)", name: name, freq: freq, mode: b["mode"] as? String)
    }
  }

  static func bookmark(id: String) -> VibeBookmarkEntity? { allBookmarks().first { $0.id == id } }

  /// Parse an explicit frequency hint ("11mhz", "909 khz", "at 11 mhz") → Hz. Only
  /// fires when a unit is present, so "Radio 5" is never read as a frequency.
  private static func freqHint(_ s: String) -> Int? {
    guard let re = try? NSRegularExpression(pattern: #"(\d+(?:\.\d+)?)\s*(mhz|khz|hz)\b"#),
          let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)),
          let nr = Range(m.range(at: 1), in: s), let n = Double(s[nr]) else { return nil }
    let unit = Range(m.range(at: 2), in: s).map { String(s[$0]) } ?? ""
    switch unit {
    case "mhz": return Int(n * 1_000_000)
    case "khz": return Int(n * 1000)
    default:    return Int(n)
    }
  }

  /// Fuzzy-match a spoken station name against the cached bookmarks: every name
  /// word of the query must appear in the bookmark name (case-insensitive). An
  /// explicit frequency hint ("China Radio at 11MHz") narrows the matches to ±1
  /// MHz of that frequency. Returns the matches and whether a hint was present.
  /// Frequencies alone ("7150") won't match a name → fall through to JS.
  static func matchBookmarks(_ query: String) -> (matches: [VibeBookmarkEntity], hinted: Bool) {
    let lower = query.lowercased()
    let hint = freqHint(lower)
    let stop: Set<String> = ["at", "around", "near", "on", "about", "of", "the", "to", "mhz", "khz", "hz"]
    let words = lower.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
      .filter { w in
        if stop.contains(w) { return false }
        // When a frequency hint is present, drop bare numbers (they're the hint,
        // not part of the name); otherwise keep them ("Radio 5").
        if hint != nil && w.allSatisfy({ $0.isNumber }) { return false }
        return true
      }
    guard !words.isEmpty else { return ([], hint != nil) }
    var out = allBookmarks().filter { e in
      let ln = e.name.lowercased()
      return words.allSatisfy { ln.contains($0) }
    }
    if let h = hint { out = out.filter { abs($0.freq - h) <= 1_000_000 } }
    return (out, hint != nil)
  }

  // Candidate list persisted across the "which frequency?" re-prompt so the spoken
  // answer always has the right options to match (the intent's `target` may not
  // survive the re-run).
  private static let kCandidates = "vibeVoiceCandidates"
  static func setCandidates(_ list: [VibeBookmarkEntity]) {
    let arr = list.map { ["id": $0.id, "name": $0.name, "frequency": $0.freq, "mode": ($0.mode ?? "") as Any] }
    if let data = try? JSONSerialization.data(withJSONObject: arr) { d.set(data, forKey: kCandidates) }
  }
  static func takeCandidates() -> [VibeBookmarkEntity] {
    guard let data = d.data(forKey: kCandidates),
          let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return [] }
    return arr.compactMap { b in
      guard let id = b["id"] as? String, let name = b["name"] as? String,
            let f = (b["frequency"] as? NSNumber)?.intValue else { return nil }
      let mode = (b["mode"] as? String).flatMap { $0.isEmpty ? nil : $0 }
      return VibeBookmarkEntity(id: id, name: name, freq: f, mode: mode)
    }
  }

  /// Parse a spoken frequency answer → Hz. Mirrors the JS bare-number rule (< 30 =
  /// MHz, else kHz) so "909"→909 kHz, "11.650"→11.650 MHz, "11650"→11650 kHz.
  /// Spaces inside a number ("11 650") are collapsed first.
  static func spokenToHz(_ s: String) -> Int? {
    var lower = s.lowercased()
    // Collapse "11 650" / "11,650" thousands grouping into "11650".
    if let re = try? NSRegularExpression(pattern: #"(\d)[\s,](?=\d{3}\b)"#) {
      lower = re.stringByReplacingMatches(in: lower, range: NSRange(lower.startIndex..., in: lower), withTemplate: "$1")
    }
    guard let re = try? NSRegularExpression(pattern: #"(\d+(?:[.,]\d+)?)\s*(mhz|khz|hz)?"#),
          let m = re.firstMatch(in: lower, range: NSRange(lower.startIndex..., in: lower)),
          let nr = Range(m.range(at: 1), in: lower),
          let n = Double(lower[nr].replacingOccurrences(of: ",", with: ".")) else { return nil }
    let unit = Range(m.range(at: 2), in: lower).map { String(lower[$0]) } ?? ""
    switch unit {
    case "mhz": return Int(n * 1_000_000)
    case "khz": return Int(n * 1000)
    case "hz":  return Int(n)
    default:    return Int(n < 30 ? n * 1_000_000 : n * 1000)
    }
  }

  /// Match the user's spoken frequency to the nearest candidate in the list — we
  /// own this matching because Siri's AppEntity voice disambiguation mis-picks.
  static func pickBySpokenFreq(_ ans: String, among: [VibeBookmarkEntity]) -> VibeBookmarkEntity? {
    guard let hz = spokenToHz(ans) else { return nil }
    return among.min(by: { abs($0.freq - hz) < abs($1.freq - hz) })
  }

  /// Spoken text + kind ("tune" | "mode" | "step"). All resolution (frequency
  /// parse, bookmark/band match, mode/step synonyms) is in JS — the intent just
  /// passes the text. Live commands emit now; cold launch stashes for JS.
  static func handle(query: String, kind: String) -> String {
    let q = query.trimmingCharacters(in: .whitespaces)
    if isConnected {
      NotificationCenter.default.post(name: note, object: nil,
        userInfo: ["event": "VibeVoiceQuery", "body": ["query": q, "kind": kind]])
      switch kind {
      case "step": return "Setting step to \(q)"
      case "mode": return "Switching to \(q)"
      default:     return "Tuning to \(q)"
      }
    }
    // Not running/connected: stash so it applies when VibeSDR is next opened (we
    // no longer foreground the app, to keep tuning unlock-free while listening).
    if hasDefault {
      if let data = try? JSONSerialization.data(withJSONObject: ["kind": kind, "query": q]),
         let s = String(data: data, encoding: .utf8) { d.set(s, forKey: kPending) }
      return "Open VibeSDR to \(kind == "tune" ? "tune to \(q)" : "apply that")."
    }
    return "Open VibeSDR and connect to an instance first to use voice control."
  }

  /// Dispatch a specific picked bookmark as an explicit Hz+mode tune (reuses the
  /// JS frequency path) but speaks the friendly station name back.
  static func handleBookmark(_ b: VibeBookmarkEntity) -> String {
    // Space before "hz" is required: JS parses "\(freq) hz" but a glued "\(freq)hz"
    // fails its \bhz\b boundary and misroutes to the band search.
    let q = "\(b.freq) hz" + (b.mode.map { " \($0)" } ?? "")
    if isConnected {
      NotificationCenter.default.post(name: note, object: nil,
        userInfo: ["event": "VibeVoiceQuery", "body": ["query": q, "kind": "tune"]])
      return "Tuning to \(b.name)"
    }
    if hasDefault {
      if let data = try? JSONSerialization.data(withJSONObject: ["kind": "tune", "query": q]),
         let s = String(data: data, encoding: .utf8) { d.set(s, forKey: kPending) }
      return "Open VibeSDR to tune to \(b.name)."
    }
    return "Open VibeSDR and connect to an instance first to use voice control."
  }

  static func takePending() -> String? {
    guard let s = d.string(forKey: kPending) else { return nil }
    d.removeObject(forKey: kPending)
    return s
  }
}

/// A bookmark surfaced to Siri for native spoken disambiguation when a name hits
/// several entries (e.g. "Radio 5"). The title is frequency-forward ("909 kHz")
/// so Siri reliably matches the spoken number; the picked entity tunes exactly.
@available(iOS 16.0, *)
struct VibeBookmarkEntity: AppEntity, Identifiable {
  let id: String
  let name: String
  let freq: Int
  let mode: String?

  var freqLabel: String {
    let mhz = Double(freq) / 1_000_000.0
    return mhz >= 1 ? String(format: "%.3f MHz", mhz)
                    : String(format: "%.0f kHz", Double(freq) / 1000.0)
  }

  static var typeDisplayRepresentation: TypeDisplayRepresentation = "Frequency"
  static var defaultQuery = VibeBookmarkQuery()
  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(freqLabel)", subtitle: "\(name)")
  }
}

@available(iOS 16.0, *)
struct VibeBookmarkQuery: EntityQuery {
  func entities(for identifiers: [String]) async throws -> [VibeBookmarkEntity] {
    identifiers.compactMap { VibeVoice.bookmark(id: $0) }
  }
  func suggestedEntities() async throws -> [VibeBookmarkEntity] { [] }
}

@available(iOS 16.0, *)
struct TuneIntent: AppIntent {
  static var title: LocalizedStringResource = "Tune VibeSDR"
  // false = run in the background without foregrounding the app, so Siri can tune
  // from the lock screen / headphones / CarPlay WITHOUT an unlock (the app is
  // already alive playing audio and receives the command via NotificationCenter).
  static var openAppWhenRun = false
  @Parameter(title: "Station or frequency",
             requestValueDialog: "What frequency or station?") var target: String
  // Set only via native disambiguation when the spoken name matched several
  // bookmarks. Optional so Siri doesn't auto-prompt for it on every invocation.
  @Parameter(title: "Frequency") var pick: VibeBookmarkEntity?

  func perform() async throws -> some IntentResult & ProvidesDialog {
    // If the user already picked from a spoken list, tune that exact bookmark.
    if let chosen = pick {
      let full = VibeVoice.bookmark(id: chosen.id) ?? chosen
      return .result(dialog: IntentDialog(stringLiteral: VibeVoice.handleBookmark(full)))
    }
    // A spoken station name can hit multiple bookmarks (e.g. "Radio 5"). A
    // frequency hint ("China Radio at 11MHz") narrows the list to that vicinity.
    // A frequency or band (no name match) falls through to the JS resolver.
    let (matches, _) = VibeVoice.matchBookmarks(target)
    if matches.count > 1 {
      // Apple-native spoken pick-list — Siri reads the frequencies and the user
      // picks by voice; it manages the multi-turn session cleanly.
      let name = matches.first?.name ?? target
      let chosen = try await $pick.requestDisambiguation(
        among: matches,
        dialog: IntentDialog(stringLiteral: "\(name) has \(matches.count). Which frequency?"))
      let full = VibeVoice.bookmark(id: chosen.id) ?? chosen
      return .result(dialog: IntentDialog(stringLiteral: VibeVoice.handleBookmark(full)))
    }
    if matches.count == 1 {
      return .result(dialog: IntentDialog(stringLiteral: VibeVoice.handleBookmark(matches[0])))
    }
    return .result(dialog: IntentDialog(stringLiteral: VibeVoice.handle(query: target, kind: "tune")))
  }
}

@available(iOS 16.0, *)
struct StepIntent: AppIntent {
  static var title: LocalizedStringResource = "Set VibeSDR step rate"
  // false = run in the background without foregrounding the app, so Siri can tune
  // from the lock screen / headphones / CarPlay WITHOUT an unlock (the app is
  // already alive playing audio and receives the command via NotificationCenter).
  static var openAppWhenRun = false
  @Parameter(title: "Step rate", requestValueDialog: "What step rate?") var rate: String
  func perform() async throws -> some IntentResult & ProvidesDialog {
    .result(dialog: IntentDialog(stringLiteral: VibeVoice.handle(query: rate, kind: "step")))
  }
}

@available(iOS 16.0, *)
struct ModeIntent: AppIntent {
  static var title: LocalizedStringResource = "Set VibeSDR mode"
  // false = run in the background without foregrounding the app, so Siri can tune
  // from the lock screen / headphones / CarPlay WITHOUT an unlock (the app is
  // already alive playing audio and receives the command via NotificationCenter).
  static var openAppWhenRun = false
  @Parameter(title: "Mode", requestValueDialog: "Which mode?") var mode: String
  func perform() async throws -> some IntentResult & ProvidesDialog {
    .result(dialog: IntentDialog(stringLiteral: VibeVoice.handle(query: mode, kind: "mode")))
  }
}

@available(iOS 16.0, *)
struct VibeShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    // Two-step (Siri prompts for the value) — same pattern as the working Mode
    // shortcut. App name MUST be in the phrase (Apple rule).
    AppShortcut(intent: TuneIntent(), phrases: [
      "Tune \(.applicationName)",
      "Tune with \(.applicationName)",
      "\(.applicationName) tune",
    ], shortTitle: "Tune", systemImageName: "dot.radiowaves.left.and.right")
    AppShortcut(intent: ModeIntent(), phrases: [
      "Change \(.applicationName) mode",
      "Set \(.applicationName) mode",
    ], shortTitle: "Mode", systemImageName: "waveform")
    AppShortcut(intent: StepIntent(), phrases: [
      "Set \(.applicationName) step rate",
      "Change \(.applicationName) step rate",
    ], shortTitle: "Step", systemImageName: "arrow.left.and.right")
  }
}

// MARK: - Auto notch (NLMS adaptive line enhancer)
//
// Swift port of the shared C++ vibe::AutoNotch (android/.../decoders/auto_notch).
// Same spec/constants so local-shim and network notch sound identical: outputs
// the prediction error so stationary tones (carriers/heterodynes) are removed
// while broadband speech passes. Tap span (~3.5 ms) kept below the voice pitch
// period so it can't subtract voiced speech; very slow adaptation so loud voice
// neither builds a notch nor pulls the lock off the tone.
final class AutoNotch {
  private let D = 8, L = 160
  private let mu: Float = 0.003, leak: Float = 0.9999, eps: Float = 1e-6
  private var buf: [Float]
  private var w:   [Float]
  private var p = 0
  init() { buf = [Float](repeating: 0, count: 2 * (8 + 160)); w = [Float](repeating: 0, count: 160) }
  func reset() {
    for i in 0..<buf.count { buf[i] = 0 }
    for i in 0..<w.count { w[i] = 0 }
    p = 0
  }
  func process(_ x: UnsafeMutablePointer<Float>, _ count: Int) {
    let M = D + L
    buf.withUnsafeMutableBufferPointer { b in
      w.withUnsafeMutableBufferPointer { wp in
        for n in 0..<count {
          p = (p == 0) ? M - 1 : p - 1
          let inp = x[n]
          b[p] = inp; b[p + M] = inp
          let base = p + D
          var fir: Float = 0, pwr: Float = 0
          for i in 0..<L { let s = b[base + i]; fir += wp[i] * s; pwr += s * s }
          let err = inp - fir
          x[n] = err
          let g = mu * err / (eps + pwr)
          for i in 0..<L { wp[i] = leak * wp[i] + g * b[base + i] }
        }
      }
    }
  }
}
