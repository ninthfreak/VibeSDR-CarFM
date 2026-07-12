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

  /// BACKPRESSURE. Is a row still in flight?
  ///
  /// WCSession QUEUES what it can't deliver and drains the backlog later — it does
  /// not drop. So firing rows at 10fps into a stalled link builds a queue, and the
  /// watch then faithfully renders a view of the radio from half a minute ago: it
  /// showed 648kHz while the phone was on 4582, and "caught up" ~30s later. Nothing
  /// was stale at the source; we had simply buried the channel.
  ///
  /// So: bound the number of rows in flight and DROP the rest rather than queue
  /// them. A dropped row is invisible on a scrolling waterfall; a backed-up queue
  /// is thirty seconds of lag.
  ///
  /// A small amount of PIPELINING (not one-at-a-time): the send rate would
  /// otherwise equal the WCSession round trip exactly, leaving no headroom if a
  /// single reply is slow. Two in flight hides that without letting a queue build
  /// — the backlog we're guarding against took THIRTY seconds to drain, and two
  /// rows is 0.2s.
  // ── NO ACK-BASED BACKPRESSURE. Rows are FIRE-AND-FORGET. ─────────────────────
  //
  // This was tried, defended for two hours, and REVERTED. Don't put it back.
  //
  // The reasoning was sound and the result was awful. Requiring an acknowledgement
  // before sending the next row makes the send rate a hostage to the WCSession
  // round trip, and every variant degraded: 1 slot gave a 1fps waterfall; 2 slots
  // healing after 2s degraded into "send 2, block, wait, send 2" — a throttle that
  // punishes a slow link by making it slower; widening it further only made the
  // connection thrash and take seconds to establish.
  //
  // It was added to cure ONE incident — a 30-second backlog after a numpad tune —
  // and the cure was permanently worse than the disease. Fire-and-forget is the
  // configuration that measured ~240ms between rows and that the user called
  // "lovely and responsive".
  //
  // If the backlog ever returns, fix it where it belongs: throttle at SOURCE
  // (MIN_ROW_MS in watchProvider), and let the watch's own jitter buffer drop what
  // it can't use. Do NOT try to make WCSession behave like a flow-controlled pipe.
  // It isn't one.

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

    // Fire-and-forget: a dropped row is invisible on a scrolling waterfall.
    s.sendMessageData(blob, replyHandler: nil, errorHandler: nil)
  }

  /// FM-DX state, as JSON. A different SCREEN on the watch, not a variant of the
  /// waterfall — FM-DX has no spectrum at all, so the station is the content.
  ///
  /// JSON rather than a dozen bridge arguments: this payload will keep growing
  /// (PTY, TA, AF...) and a blob absorbs that without touching this signature or
  /// the .m every time.
  @objc(sendFmdx:)
  func sendFmdx(_ json: String) {
    guard let s = session, linkAlive else { return }
    s.sendMessage(["k": "fmdx", "j": json], replyHandler: nil, errorHandler: nil)
  }

  /// OWRX ADS-B — the live aircraft table. A LIST, not a band: the profile IS the
  /// content (1090 MHz), and there is nothing to tune.
  @objc(sendAircraft:)
  func sendAircraft(_ json: String) {
    guard let s = session, linkAlive else { return }
    s.sendMessage(["k": "air", "j": json], replyHandler: nil, errorHandler: nil)
  }

  /// The DAB multiplex — ensemble, services, and which one is playing. DAB is a
  /// LIST, not a continuum: you switch service, you never tune.
  @objc(sendDab:)
  func sendDab(_ json: String) {
    guard let s = session, linkAlive else { return }
    s.sendMessage(["k": "dab", "j": json], replyHandler: nil, errorHandler: nil)
  }

  /// The dial's station memory — the same list the phone's dial draws.
  @objc(sendStations:)
  func sendStations(_ json: String) {
    guard let s = session, linkAlive else { return }
    s.sendMessage(["k": "stations", "j": json], replyHandler: nil, errorHandler: nil)
  }

  /// The station logo, as bytes — the phone has already resolved and drawn it, so
  /// the wrist shows the SAME image rather than fetching a URL it can't reach.
  /// Sent only on change (tens of KB, changes when the station does).
  @objc(sendLogo:)
  func sendLogo(_ b64: String) {
    guard let s = session, linkAlive else { return }
    // Empty = "no logo" — the watch falls back to the app icon, so that the glass
    // never sits on nothing (which reads as a broken grey box).
    let data = Data(base64Encoded: b64) ?? Data()
    s.sendMessage(["k": "logo", "img": data], replyHandler: nil, errorHandler: nil)
  }

  /// State: frequency, mode, step AND the meter the phone is drawing — ONE message.
  ///
  /// The meter had a stream of its own, and that was a mistake: two dictionary
  /// streams at 4/sec each, on top of the 16/sec rows, flooded WCSession — which
  /// QUEUES rather than drops — and the DOWNLINK WEDGED. The uplink kept working
  /// (a message from the watch always wakes the phone), so the wrist could still
  /// tune while having gone completely deaf. One channel, one throttle.
  @objc(sendState:mode:step:meter:level:)
  func sendState(_ freq: NSNumber, mode: String, step: NSNumber,
                 meter: String, level: NSNumber) {
    guard let s = session, linkAlive else { return }
    s.sendMessage(
      ["k": "state", "f": freq.doubleValue, "m": mode, "st": step.doubleValue,
       "mt": meter, "lv": level.doubleValue],
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
