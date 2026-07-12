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
    heartbeat?.invalidate()
    heartbeat = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in
      self?.ping()
    }
  }

  // MARK: - Watch -> Phone

  /// Tune by `delta` steps. We send a DELTA, never an absolute frequency: the
  /// phone stays the single source of truth and multiplies by the current step.
  func tune(delta: Int) { send(["cmd": "tune", "delta": delta]) }
  func setMode(_ m: String) { send(["cmd": "mode", "val": m]) }
  func setStep(_ hz: Double) { send(["cmd": "step", "val": hz]) }
  func ping() { send(["cmd": "ping"]) }

  /// Absolute tune, from the numpad. The one place the watch sends a frequency
  /// rather than a delta — the phone still clamps it to the receiver's range.
  func tune(toHz hz: Double) { send(["cmd": "freq", "val": hz]) }

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
      // Only count a row we can actually DRAW. WaterfallBuffer drops any row of
      // the wrong length silently, so flagging everGotRow on arrival hid the
      // placeholder (and its diagnostics) behind a permanently black canvas.
      if row.count == WaterfallBuffer.width { self.everGotRow = true }
      self.frequency = f[0]
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
      if let f = m[WK.freq] as? Double { frequency = f }
      if let sp = m[WK.span] as? Double { span = sp }
      if let s = m[WK.snr] as? Double { snr = s }
      if let lv = m[WK.level] as? Double { level = lv }
      if let l = m[WK.filtLo] as? Double { filtLo = l }
      if let hh = m[WK.filtHi] as? Double { filtHi = hh }

    case "state":
      if let f = m[WK.freq] as? Double { frequency = f }
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
