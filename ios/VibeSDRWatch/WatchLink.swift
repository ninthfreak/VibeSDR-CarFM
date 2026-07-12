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
  /// Filter edges as Hz offsets from the carrier. NOT symmetric: LSB is entirely
  /// below (both negative), USB entirely above, CW offset. Drawing a single width
  /// about the centre would render every mode as AM.
  @Published var filtLo     = 0.0
  @Published var filtHi     = 0.0
  /// The phone's acrylic-VFO settings, mirrored.
  @Published var needle     = Color.white
  @Published var needleI    = 5.0

  private var session: WCSession?

  func activate() {
    guard WCSession.isSupported() else { return }
    let s = WCSession.default
    s.delegate = self
    s.activate()
    session = s
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

  private func apply(_ m: [String: Any]) {
    switch m[WK.kind] as? String {
    case "row":
      if let d = m[WK.row] as? Data {
        waterfall.push(row: [UInt8](d))
        everGotRow = true
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
