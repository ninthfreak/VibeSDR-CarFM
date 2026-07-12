import Foundation
import SwiftUI
import WatchConnectivity

/// The watch end of the phone<->watch pipe.
///
/// The watch is a thin client: the phone owns all state (frequency, mode, step,
/// gain) and does all DSP. We receive rows that are already quantised to 0-255
/// with the phone's brightness/contrast/gain baked in, plus the phone's palette
/// as a raw 256-entry RGBA LUT — so the wrist is a pixel-faithful mirror of the
/// phone waterfall without any DSP or palette logic living here.
///
/// Keys are terse because every row rides this dictionary at ~10fps.
enum WK {
  static let kind    = "k"   // "row" | "state" | "settings" | "pong"
  static let row     = "r"   // Data, 128 bytes, 0-255 intensity
  static let freq    = "f"   // Double, Hz — VFO centre (the row is centred on it)
  static let span    = "sp"  // Double, Hz — width the 128 bins cover
  static let snr     = "s"   // Double, dB
  static let level   = "lv"  // Double, 0..1 — the phone's own smoothed meter fill
  static let mode    = "m"   // String
  static let step    = "st"  // Double, Hz
  static let lut     = "l"   // Data, 1024 bytes RGBA x256
  static let smooth  = "sm"  // Double, 0..1 row blend factor
  static let filtLo  = "lo"  // Double, Hz offset from carrier (negative = below)
  static let filtHi  = "hi"  // Double, Hz offset from carrier
  static let needle  = "nc"  // String, "#rrggbb" — the phone's VFO colour
  static let needleI = "ni"  // Double, 1..10 — needle intensity
  static let sharp   = "sh"  // Double, 0..10 — waterfall sharpness
}

final class WatchLink: NSObject, ObservableObject, WCSessionDelegate {
  static let shared = WatchLink()

  // Rendered state. The waterfall image is @Published so Canvas redraws on it.
  @Published var waterfall  = WaterfallBuffer()
  @Published var frequency  = 0.0
  @Published var span       = 0.0
  @Published var snr        = 0.0
  @Published var level      = 0.0
  @Published var mode       = ""
  @Published var step       = 0.0
  @Published var reachable  = false
  @Published var everGotRow = false

  /// When a row last arrived. The watch used to know only two states — "iPhone not
  /// reachable" or "fine" — but there is a THIRD: the phone is right there and
  /// simply isn't sending. That happens whenever the SDR screen isn't up: the
  /// instance picker, a disconnect, or an FM-DX instance (which routes to a
  /// different screen entirely and has no spectrum at all). The watch just sat on
  /// its last frame looking frozen, which is indistinguishable from a lock-up.
  @Published var lastRowAt: Date? = nil

  // Diagnostics for the "link up but no rows" case: a row of the wrong length is
  // DROPPED SILENTLY by WaterfallBuffer, which looks identical to no row at all.
  @Published var rxRows     = 0     // row messages received
  @Published var rxAny      = 0     // messages of ANY kind received
  @Published var lastLen    = 0     // payload length of the last row
  /// Filter edges as Hz offsets from the carrier. NOT symmetric: LSB is entirely
  /// below (both negative), USB entirely above, CW offset. Drawing a single width
  /// about the centre would render every mode as AM.
  @Published var filtLo     = 0.0
  @Published var filtHi     = 0.0
  /// The phone's acrylic-VFO settings, mirrored.
  @Published var needle     = Color.white
  @Published var needleI    = 5.0

  /// The unit the readout displays in — INPUT-AWARE, like the main app.
  ///
  /// Type 4582 in kHz and it reads back "4582.000 kHz", not "4.582 MHz". Rendering
  /// everything ≥1MHz as MHz was technically right and practically wrong: it threw
  /// away the frame of reference you were working in. Shortwave listeners think in
  /// kHz, hams think in MHz, and the unit you just typed says which you are.
  /// Crown-tuning keeps whatever you last chose.
  @Published var displayUnit: DisplayUnit = .auto {
    didSet { UserDefaults.standard.set(displayUnit.rawValue, forKey: "vibe.displayUnit") }
  }

  enum DisplayUnit: String {
    case auto, hz, khz, mhz
  }

  private var session: WCSession?

  private var heartbeat: Timer?

  override init() {
    super.init()
    if let raw = UserDefaults.standard.string(forKey: "vibe.displayUnit"),
       let u = DisplayUnit(rawValue: raw) {
      displayUnit = u
    }
  }

  func activate() {
    guard WCSession.isSupported() else { return }
    let s = WCSession.default
    s.delegate = self
    s.activate()
    session = s

    // HEARTBEAT. The phone's WCSession.isReachable goes stale and it then refuses
    // to send, while our crown messages still get through — the downlink dies
    // silently and the watch sits on "Waiting for signal" forever. The phone treats
    // any message from us as proof we're here, but that proof expires; without a
    // heartbeat it would only hold while the user happened to be turning the crown.
    // .common mode, NOT the default. A Timer scheduled in default mode STOPS FIRING
    // while the run loop is in tracking mode — i.e. exactly while you are turning
    // the crown or touching the screen. The heartbeat would stall, the phone's
    // 10-second linkAlive window would expire, and it would stop sending rows: the
    // watch dropped to "waiting for connection" mid-use, for no reason but this.
    heartbeat?.invalidate()
    let t = Timer(timeInterval: 4, repeats: true) { [weak self] _ in self?.ping() }
    RunLoop.main.add(t, forMode: .common)
    heartbeat = t
  }

  // MARK: - Watch -> Phone

  /// Tune by `delta` steps. We send a DELTA, never an absolute frequency: the
  /// phone stays the single source of truth and multiplies by the current step.
  // ── Crown commands are COALESCED ─────────────────────────────────────────────
  //
  // Every crown detent used to send its own WCSession message. Spin the crown and
  // that's 40-60 messages/sec, fired from the main thread, on top of the row stream
  // and its acknowledgements — and WCSession is an interactive-message channel that
  // QUEUES under load rather than dropping (the same lesson the row feed already
  // taught us). It saturates, and the app wedges: the watch locked up mid-tune.
  //
  // So: accumulate detents and flush at most ~16/sec. Deltas ADD, so nothing is
  // lost — a fast spin arrives as one big delta instead of forty small ones, which
  // is exactly what the phone wants anyway (it multiplies by the step size).
  private var pendingTune = 0
  private var pendingZoom = 0
  private var flushScheduled = false

  /// PREDICT while turning, ADOPT when still — the same pattern as the phone's own
  /// view sender (UberSDRClient._sendView / _armSettle).
  ///
  /// The readout must move WITH THE CROWN, not with the radio. Anything the phone
  /// sends us is a report of where the radio WAS, a WCSession hop ago at best.
  /// Steering off it means steering off the past: you turn, nothing moves, you turn
  /// further to compensate, and the number sails past what you wanted — laggy AND
  /// overshooting, which is exactly what it was.
  ///
  /// So the crown owns the number while it is moving, and the phone's `state` echo
  /// takes over once it stops. We must ignore state echoes DURING the turn too:
  /// they are throttled to 4/sec, so mid-spin one carries a frequency we have
  /// already tuned past, and adopting it yanks the readout backwards.
  ///
  /// The settle is generous — longer than the phone's echo throttle plus a hop —
  /// because the echo is TRAILING-EDGE: once the crown is quiet the phone always
  /// sends the final truth, and that truth is worth waiting for. It clamps to the
  /// band edges and snaps to the step grid, and we may be wrong about either.
  ///
  /// The prediction MUST use the phone's grid-snap maths, or the adopted value
  /// would visibly jump.
  private var tuneSettle: DispatchWorkItem?
  /// True while the readout is ours rather than the phone's.
  private var tuning: Bool { tuneSettle != nil }

  func tune(delta: Int) {
    predictTune(delta: delta)
    pendingTune += delta
    scheduleFlush()
  }

  func zoom(delta: Int) { pendingZoom += delta; scheduleFlush() }

  private func predictTune(delta: Int) {
    guard step > 0, frequency > 0 else { return }   // nothing to predict from yet
    // Same snap the phone applies (SDRScreen.onTuneDelta): a detent lands ON the
    // step grid rather than offsetting the current fraction.
    let base = delta > 0 ? floor(frequency / step) : ceil(frequency / step)
    frequency = (base + Double(delta)) * step
    armTuneSettle()
  }

  /// Hand the readout back to the phone once the crown has been still long enough
  /// for the trailing-edge echo (≤250ms) plus a hop to land. Adopting early is what
  /// produces the backwards yank.
  private func armTuneSettle() {
    tuneSettle?.cancel()
    let work = DispatchWorkItem { [weak self] in
      guard let self else { return }
      self.tuneSettle = nil
      // ASK, don't wait. The phone only echoes the frequency when it CHANGES — so
      // if our prediction ran past a band edge (or the phone rejected the tune),
      // its frequency stopped moving, no echo was ever sent, and the watch would sit
      // on a wrong prediction forever with no way back. A ping makes the phone state
      // its truth unconditionally, so the wrist ALWAYS resyncs when the crown stops.
      self.ping()
    }
    tuneSettle = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: work)
  }

  /// DispatchQueue, NOT Timer.
  ///
  /// `Timer.scheduledTimer` installs on the main run loop in DEFAULT mode — and
  /// while you are turning the crown or touching the screen, the run loop is in
  /// TRACKING mode, where default-mode timers DO NOT FIRE. So the flush never ran
  /// while the crown was moving, detents piled up, nothing was sent, and (because
  /// `flushScheduled` stayed true) it never rescheduled: the crown went
  /// permanently dead. The coalescing added to cure a hang caused a worse one.
  ///
  /// asyncAfter doesn't care what the run loop is doing.
  private func scheduleFlush() {
    guard !flushScheduled else { return }
    flushScheduled = true
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) { [weak self] in
      self?.flushCrown()
    }
  }

  private func flushCrown() {
    flushScheduled = false
    if pendingTune != 0 { send(["cmd": "tune", "delta": pendingTune]); pendingTune = 0 }
    if pendingZoom != 0 { send(["cmd": "zoom", "delta": pendingZoom]); pendingZoom = 0 }
  }
  func setMode(_ m: String) { send(["cmd": "mode", "val": m]) }
  func setStep(_ hz: Double) { send(["cmd": "step", "val": hz]) }
  func ping() { send(["cmd": "ping"]) }


  /// Absolute tune, from the numpad. The one place the watch sends a frequency
  /// rather than a delta — the phone still clamps it to the receiver's range.
  ///
  /// Shows the typed frequency at once (you typed it; waiting a round trip to see
  /// it is absurd), but ALSO drops the settle so the phone's answer is adopted as
  /// soon as it lands — that answer may differ, because the phone clamps to the
  /// band edges and we don't know where those are.
  func tune(toHz hz: Double) {
    send(["cmd": "freq", "val": hz])
    frequency = hz
    armTuneSettle()
  }

  private func send(_ msg: [String: Any]) {
    guard let s = session, s.isReachable else { return }
    s.sendMessage(msg, replyHandler: nil, errorHandler: nil)
  }

  // MARK: - Phone -> Watch

  func session(_ s: WCSession, didReceiveMessage message: [String: Any]) {
    // Hop to main: we mutate @Published state and the pixel buffer.
    DispatchQueue.main.async { self.apply(message) }
  }

  /// Rows arrive as a flat binary blob (see VibeWatchModule.sendRow) — dictionary
  /// messages cost a plist serialise per send, and at 10fps that flooded the
  /// channel into delivering in bursts.
  func session(_ s: WCSession, didReceiveMessageData data: Data) {
    handleRow(data)
  }

  /// Kept only in case the phone ever sends with a reply handler — answer at once
  /// and never make the ack wait on rendering. (The phone does NOT do this: rows
  /// are fire-and-forget. Ack-based backpressure was tried and reverted — it made
  /// the send rate a hostage to the round trip and the link degraded badly.)
  func session(_ s: WCSession, didReceiveMessageData data: Data,
               replyHandler: @escaping (Data) -> Void) {
    replyHandler(Data())
    handleRow(data)
  }

  private func handleRow(_ data: Data) {
    let header = 1 + 8 * 6
    guard data.count > header, data[data.startIndex] == 1 else { return }

    var f = [Double](repeating: 0, count: 6)
    for i in 0..<6 {
      let lo = data.startIndex + 1 + i * 8
      let bits = data[lo..<(lo + 8)].withUnsafeBytes { raw in
        raw.loadUnaligned(as: UInt64.self)
      }
      f[i] = Double(bitPattern: UInt64(littleEndian: bits))
    }
    let row = [UInt8](data[(data.startIndex + header)...])

    DispatchQueue.main.async {
      self.waterfall.push(row: row)
      self.rxRows += 1
      self.lastLen = row.count
      self.lastRowAt = Date()
      // Only count a row we can actually DRAW. WaterfallBuffer drops any row of
      // the wrong length silently, so flagging everGotRow on arrival hid the
      // placeholder (and its diagnostics) behind a permanently black canvas.
      if row.count == WaterfallBuffer.width { self.everGotRow = true }
      // NOTE: f[0] is the row's frequency, and we deliberately IGNORE it.
      //
      // Rows are fire-and-forget pixels — lossy by design, and WCSession QUEUES
      // them, so on a busy link a row can be SECONDS old. Reading the readout off
      // them made it lurch backwards mid-tune and then crawl forward as the backlog
      // drained. The frequency now comes from the throttled `state` echo (which
      // cannot build a backlog) and from our own prediction while the crown moves.
      self.span      = f[1]
      self.snr       = f[2]
      self.level     = f[3]
      self.filtLo    = f[4]
      self.filtHi    = f[5]
    }
  }

  private func apply(_ m: [String: Any]) {
    rxAny += 1
    switch m[WK.kind] as? String {
    case "row":
      if let d = m[WK.row] as? Data {
        rxRows += 1
        lastLen = d.count
        waterfall.push(row: [UInt8](d))
        if d.count == WaterfallBuffer.width { everGotRow = true }
      }
      // Rows never set the frequency — see handleRow.
      if let sp = m[WK.span] as? Double { span = sp }
      if let s = m[WK.snr] as? Double { snr = s }
      if let lv = m[WK.level] as? Double { level = lv }
      if let l = m[WK.filtLo] as? Double { filtLo = l }
      if let hh = m[WK.filtHi] as? Double { filtHi = hh }

    case "state":
      if let f = m[WK.freq] as? Double, !tuning { frequency = f }
      if let md = m[WK.mode] as? String { mode = md }
      if let st = m[WK.step] as? Double { step = st }

    case "settings":
      if let l = m[WK.lut] as? Data, l.count == 1024 { waterfall.setLUT([UInt8](l)) }
      if let sm = m[WK.smooth] as? Double { waterfall.smoothing = sm }
      if let nc = m[WK.needle] as? String, let c = Color(hex: nc) { needle = c }
      if let ni = m[WK.needleI] as? Double { needleI = ni }
      if let sh = m[WK.sharp] as? Double { waterfall.sharpness = sh }

    default:
      break
    }
  }

  // MARK: - WCSessionDelegate

  func session(_ s: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
    DispatchQueue.main.async { self.reachable = s.isReachable }
  }

  func sessionReachabilityDidChange(_ s: WCSession) {
    DispatchQueue.main.async { self.reachable = s.isReachable }
  }
}

extension Color {
  /// "#rrggbb" as sent by the phone's VFO colour picker.
  init?(hex: String) {
    var s = hex.trimmingCharacters(in: .whitespaces)
    if s.hasPrefix("#") { s.removeFirst() }
    guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
    self.init(
      red:   Double((v >> 16) & 0xff) / 255,
      green: Double((v >>  8) & 0xff) / 255,
      blue:  Double( v        & 0xff) / 255
    )
  }
}
