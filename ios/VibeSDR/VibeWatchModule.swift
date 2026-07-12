import Foundation
import WatchConnectivity

/// Phone end of the watch pipe.
///
/// The watch is a thin client: it draws what we send and sends back deltas. All
/// state (frequency, mode, step, gain) and all DSP stay here — the watch binary
/// contains no DSP or codec at all, which also keeps the licensing story clean.
///
/// Shaped after VibeCarPlayData: JS pushes display state down, and commands come
/// back up as a single RN event that SDRScreen routes into its existing
/// onTuneHzRef / onModeRef handlers.
@objc(VibeWatchModule)
class VibeWatchModule: RCTEventEmitter, WCSessionDelegate {

  private var session: WCSession?
  private var hasListeners = false

  override init() {
    super.init()
    guard WCSession.isSupported() else { return }
    let s = WCSession.default
    s.delegate = self
    s.activate()
    session = s
  }

  override static func requiresMainQueueSetup() -> Bool { return false }
  override func supportedEvents() -> [String]! { return ["VibeWatchCommand", "VibeWatchState"] }
  override func startObserving() { hasListeners = true }
  override func stopObserving() { hasListeners = false }

  // MARK: - Phone -> Watch

  /// True only when the watch app is actually in the foreground with a live
  /// link. JS gates row sending on this: streaming to a backgrounded watch
  /// burns battery for pixels nobody sees, and Apple frowns on it.
  @objc(isReachable:rejecter:)
  func isReachable(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {
    resolve(session?.isReachable ?? false)
  }

  /// One waterfall row, already cropped to the VFO-centred window and quantised
  /// to 0-255 with the phone's brightness/contrast/gain baked in.
  @objc(sendRow:freq:span:snr:level:)
  func sendRow(_ rowB64: String, freq: NSNumber, span: NSNumber, snr: NSNumber, level: NSNumber) {
    guard let s = session, s.isReachable,
          let row = Data(base64Encoded: rowB64) else { return }
    // Fire-and-forget: a dropped row is invisible on a scrolling waterfall,
    // whereas a queue that backs up turns into visible lag.
    s.sendMessage(
      ["k": "row", "r": row, "f": freq.doubleValue, "sp": span.doubleValue,
       "s": snr.doubleValue, "lv": level.doubleValue],
      replyHandler: nil,
      errorHandler: nil
    )
  }

  @objc(sendState:mode:step:)
  func sendState(_ freq: NSNumber, mode: String, step: NSNumber) {
    guard let s = session, s.isReachable else { return }
    s.sendMessage(
      ["k": "state", "f": freq.doubleValue, "m": mode, "st": step.doubleValue],
      replyHandler: nil,
      errorHandler: nil
    )
  }

  /// Palette + temporal smoothing. We ship the phone's own 256-entry RGBA LUT
  /// (1KB) rather than reimplementing 26 colour maps in Swift — the wrist can
  /// never drift from the phone, and new palettes work for free.
  @objc(sendSettings:smoothing:)
  func sendSettings(_ lutB64: String, smoothing: NSNumber) {
    guard let s = session, s.isReachable,
          let lut = Data(base64Encoded: lutB64) else { return }
    s.sendMessage(
      ["k": "settings", "l": lut, "sm": smoothing.doubleValue],
      replyHandler: nil,
      errorHandler: nil
    )
  }

  // MARK: - Watch -> Phone

  func session(_ s: WCSession, didReceiveMessage message: [String: Any]) {
    guard hasListeners, let cmd = message["cmd"] as? String else { return }
    var body: [String: Any] = ["cmd": cmd]
    if let d = message["delta"] { body["delta"] = d }
    if let v = message["val"]   { body["val"] = v }
    sendEvent(withName: "VibeWatchCommand", body: body)
  }

  // MARK: - WCSessionDelegate

  func session(_ s: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {}
  func sessionDidBecomeInactive(_ s: WCSession) {}

  /// Re-activate so a watch switch doesn't silently leave us with a dead session.
  func sessionDidDeactivate(_ s: WCSession) { WCSession.default.activate() }

  func sessionReachabilityDidChange(_ s: WCSession) {
    guard hasListeners else { return }
    sendEvent(withName: "VibeWatchState", body: ["reachable": s.isReachable])
  }
}
