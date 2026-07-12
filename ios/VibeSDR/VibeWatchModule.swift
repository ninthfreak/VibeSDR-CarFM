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

  /// When the watch last sent us anything.
  ///
  /// `WCSession.isReachable` on the PHONE goes stale — most reliably after the app
  /// is replaced under a live session — and the two directions are not symmetric:
  /// a message FROM the watch wakes the phone regardless, but the phone only sends
  /// when this flag says reachable. So one stale flag kills the entire downlink
  /// while the crown carries on tuning, which is exactly what we saw.
  ///
  /// A command arriving from the watch is PROOF the watch is there and listening —
  /// better proof than the flag. Same lesson as the lock-screen bug: recency beats
  /// flags, because recency cannot desync.
  private var lastWatchMsgAt = Date.distantPast

  private var linkAlive: Bool {
    if session?.isReachable == true { return true }
    return Date().timeIntervalSince(lastWatchMsgAt) < 10
  }

  private func sawWatch() {
    lastWatchMsgAt = Date()
  }

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
    resolve(linkAlive)
  }

  /// One waterfall row, already cropped to the VFO-centred window and quantised
  /// to 0-255 with the phone's brightness/contrast/gain baked in.
  /// Rows go as RAW BINARY, not as a dictionary.
  ///
  /// WCSession is an interactive-message channel, not a pipe. A dictionary message
  /// has to be plist-serialised on every send; at 10fps that cost is real, and
  /// flooding the channel makes it queue and then deliver in BURSTS — which showed
  /// up as the watch's frequency freezing while the phone tuned. sendMessageData
  /// hands over a flat blob and skips all of it.
  ///
  /// Layout (little-endian): u8 kind=1, then f64 freq, span, snr, level, lo, hi,
  /// then the row bytes.
  @objc(sendRow:freq:span:snr:level:lo:hi:)
  func sendRow(_ rowB64: String, freq: NSNumber, span: NSNumber, snr: NSNumber,
               level: NSNumber, lo: NSNumber, hi: NSNumber) {
    guard let s = session, linkAlive,
          let row = Data(base64Encoded: rowB64) else { return }

    var blob = Data(capacity: 1 + 8 * 6 + row.count)
    blob.append(1)                                   // kind: row
    for v in [freq, span, snr, level, lo, hi] {
      var d = v.doubleValue.bitPattern.littleEndian
      withUnsafeBytes(of: &d) { blob.append(contentsOf: $0) }
    }
    blob.append(row)

    // Fire-and-forget: a dropped row is invisible on a scrolling waterfall,
    // whereas a queue that backs up turns into visible lag.
    s.sendMessageData(blob, replyHandler: nil, errorHandler: nil)
  }

  @objc(sendState:mode:step:)
  func sendState(_ freq: NSNumber, mode: String, step: NSNumber) {
    guard let s = session, linkAlive else { return }
    s.sendMessage(
      ["k": "state", "f": freq.doubleValue, "m": mode, "st": step.doubleValue],
      replyHandler: nil,
      errorHandler: nil
    )
  }

  /// Palette + temporal smoothing. We ship the phone's own 256-entry RGBA LUT
  /// (1KB) rather than reimplementing 26 colour maps in Swift — the wrist can
  /// never drift from the phone, and new palettes work for free.
  @objc(sendSettings:smoothing:needle:needleIntensity:sharpness:)
  func sendSettings(_ lutB64: String, smoothing: NSNumber,
                    needle: String, needleIntensity: NSNumber, sharpness: NSNumber) {
    guard let s = session, linkAlive,
          let lut = Data(base64Encoded: lutB64) else { return }
    s.sendMessage(
      ["k": "settings", "l": lut, "sm": smoothing.doubleValue,
       "nc": needle, "ni": needleIntensity.doubleValue, "sh": sharpness.doubleValue],
      replyHandler: nil,
      errorHandler: nil
    )
  }

  // MARK: - Watch -> Phone

  func session(_ s: WCSession, didReceiveMessage message: [String: Any]) {
    sawWatch()
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
