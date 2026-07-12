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

    case "state":
      if let f = m[WK.freq] as? Double { frequency = f }
      if let md = m[WK.mode] as? String { mode = md }
      if let st = m[WK.step] as? Double { step = st }

    case "settings":
      if let l = m[WK.lut] as? Data, l.count == 1024 { waterfall.setLUT([UInt8](l)) }
      if let sm = m[WK.smooth] as? Double { waterfall.smoothing = sm }

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
