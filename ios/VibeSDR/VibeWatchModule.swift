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

  /// Consecutive phone->watch send failures.
  ///
  /// WCSession's interactive messages require `isReachable`, and when it is false they
  /// are DROPPED SILENTLY — we passed no error handler, so the phone shouted into a
  /// void and never learned. That is the ONE-WAY LINK: the watch's messages still wake
  /// the phone (so the crown tunes perfectly), while nothing we send ever arrives.
  ///
  /// A transport hop can leave the session in that state. Count the failures, and once
  /// it's clearly not a blip, REBUILD the session.
  private var sendFails = 0
  private var lastReviveAt = Date.distantPast

  /// The link is one-way and it isn't recovering. Re-activate WCSession.
  ///
  /// Cheap and safe (activating an active session is a no-op), and it is the only lever
  /// we have: there is no API to force reachability, and the delegate callback that
  /// should have told us is exactly the one that lied.
  private func reviveSession() {
    guard Date().timeIntervalSince(lastReviveAt) > 5 else { return }
    lastReviveAt = Date()
    sendFails = 0
    NSLog("[VibeWatch] link one-way — re-activating WCSession")
    let s = WCSession.default
    s.delegate = self
    s.activate()
    session = s
  }

  /// Only FAILURES are observable — `sendMessageData` has no success callback, so we
  /// can't count successes. Instead the run decays: a failure long after the last one
  /// starts a fresh count, so an occasional drop never accumulates into a false alarm,
  /// while a genuinely one-way link piles up fast (we send ~16 rows a second).
  private var lastFailAt = Date.distantPast
  private func noteSendFailure() {
    if Date().timeIntervalSince(lastFailAt) > 3 { sendFails = 0 }
    lastFailAt = Date()
    sendFails += 1
    if sendFails >= 15 { reviveSession() }   // ~1s of solid failure at row rate
  }

  private var linkAlive: Bool {
    if session?.isReachable == true { return true }
    return Date().timeIntervalSince(lastWatchMsgAt) < 10
  }

  private func sawWatch() {
    // A message from the watch is PROOF it is there — better proof than any flag. If
    // the phone had written the link off (a stale isReachable, a Bluetooth<->Wi-Fi
    // hop), that proof must REVIVE it IMMEDIATELY, not wait for the next poll to
    // notice. This is what turned a momentary transport blip into a permanently dead
    // downlink: the flag went false, nothing was obliged to flip it back, and the wrist
    // sat there tuning perfectly with no waterfall.
    let wasDead = !linkAlive
    lastWatchMsgAt = Date()
    if wasDead, hasListeners {
      sendEvent(withName: "VibeWatchState", body: ["reachable": true])
    }
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
  /// Bytes reserved for the meter text inside each row blob.
  static let meterBytes = 12

  // ── BATCHING: WE ARE ABUSING AN RPC CHANNEL AS A DATA PIPE ─────────────────
  //
  // The bandwidth was never the problem — a row is 317 bytes, so even at 16/sec that's
  // ~5 KB/s, which Bluetooth doesn't notice. THE MESSAGE RATE is the problem.
  // `WCSession.sendMessage` is Apple's INTERACTIVE messaging channel: individually
  // framed, individually queued, meant for occasional request/response between two
  // foregrounded apps. We were making SIXTEEN separate calls a second, forever.
  //
  // That is a long way outside its design envelope, and it explains everything we kept
  // rediscovering: the 30-second backlog, the wedged sessions, the link that silently
  // goes one-way after a transport hop. We kept finding new ways for it to break
  // because we were over-driving it.
  //
  // So: send FEWER, BIGGER messages. Two rows per message at 10fps = 5 messages/sec
  // instead of 16 — a third of the calls, the same data, no rows lost. The watch's
  // jitter buffer was built to absorb bursty arrivals, so a pair landing together is
  // exactly what it already expects.
  //
  // The cost is one row of latency (~100ms). That is a real cost — we spent tonight
  // cutting lag — but a link that stays up is worth more than 100ms.
  private static let rowsPerMessage = 2
  private var pendingRows: [Data] = []

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
  /// The meter text rides HERE, in the row, in a fixed 12-byte field.
  ///
  /// It had a message of its own and that wedged the downlink while the phone was
  /// LOCKED — the text changes every frame, so it became a continuous ~4/sec stream
  /// on top of the rows, and WCSession queues rather than drops. The row is already
  /// going out every frame. 12 bytes, null-padded ("S9+40", "-72dB" — they're short).
  @objc(sendRow:freq:span:snr:level:lo:hi:meter:)
  func sendRow(_ rowB64: String, freq: NSNumber, span: NSNumber, snr: NSNumber,
               level: NSNumber, lo: NSNumber, hi: NSNumber, meter: String) {
    guard let s = session, linkAlive,
          let row = Data(base64Encoded: rowB64) else { return }

    var blob = Data(capacity: 8 * 6 + Self.meterBytes + row.count)
    for v in [freq, span, snr, level, lo, hi] {
      var d = v.doubleValue.bitPattern.littleEndian
      withUnsafeBytes(of: &d) { blob.append(contentsOf: $0) }
    }
    // Fixed-width so the watch can slice the row off without a length field.
    var mt = Array(meter.utf8.prefix(Self.meterBytes))
    mt.append(contentsOf: [UInt8](repeating: 0, count: Self.meterBytes - mt.count))
    blob.append(contentsOf: mt)
    blob.append(row)

    // Hold it back until we have a pair (see rowsPerMessage).
    pendingRows.append(blob)
    guard pendingRows.count >= Self.rowsPerMessage else { return }

    // kind 2 = a BATCH: [2][count][block][block…], each block being the same
    // 6-doubles + meter + row layout a single row uses.
    var batch = Data(capacity: 2 + pendingRows.reduce(0) { $0 + $1.count })
    batch.append(2)
    batch.append(UInt8(pendingRows.count))
    for b in pendingRows { batch.append(b) }
    pendingRows.removeAll(keepingCapacity: true)

    // Fire-and-forget for the ROWS THEMSELVES (a dropped row is invisible on a
    // scrolling waterfall — do NOT reintroduce ack-based backpressure, see above). But
    // we DO listen for the error: a run of failures is how we discover the link has
    // gone one-way, which is otherwise completely silent.
    s.sendMessageData(batch, replyHandler: nil, errorHandler: { [weak self] _ in
      self?.noteSendFailure()
    })
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

  /// What the PHONE is doing — a boot is not a fault, and the watch should say which.
  @objc(sendPhone:)
  func sendPhone(_ status: String) {
    guard let s = session, linkAlive else { return }
    s.sendMessage(["k": "phone", "st": status], replyHandler: nil, errorHandler: nil)
  }

  /// The user's FAVOURITE instances. A curated handful — not the 2,000-server
  /// directory, which would be absurd on a wrist. This is what makes the watch
  /// useful when it LAUNCHES the phone and the phone has no default instance: the
  /// wrist can pick one instead of staring at nothing.
  @objc(sendFavourites:)
  func sendFavourites(_ json: String) {
    guard let s = session, linkAlive else { return }
    s.sendMessage(["k": "favs", "j": json], replyHandler: nil, errorHandler: nil)
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
  @objc(sendState:mode:step:meter:level:why:)
  func sendState(_ freq: NSNumber, mode: String, step: NSNumber,
                 meter: String, level: NSNumber, why: String) {
    guard let s = session, linkAlive else { return }
    s.sendMessage(
      ["k": "state", "f": freq.doubleValue, "m": mode, "st": step.doubleValue,
       "mt": meter, "lv": level.doubleValue, "wy": why],
      replyHandler: nil,
      errorHandler: nil
    )
  }

  /// Palette + temporal smoothing. We ship the phone's own 256-entry RGBA LUT
  /// (1KB) rather than reimplementing 26 colour maps in Swift — the wrist can
  /// never drift from the phone, and new palettes work for free.
  @objc(sendSettings:smoothing:needle:needleIntensity:sharpness:peakHold:)
  func sendSettings(_ lutB64: String, smoothing: NSNumber,
                    needle: String, needleIntensity: NSNumber, sharpness: NSNumber,
                    peakHold: Bool) {
    guard let s = session, linkAlive,
          let lut = Data(base64Encoded: lutB64) else { return }
    s.sendMessage(
      ["k": "settings", "l": lut, "sm": smoothing.doubleValue,
       "nc": needle, "ni": needleIntensity.doubleValue, "sh": sharpness.doubleValue,
       "pk": peakHold],
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
    // `armed` is the FM-DX shared-tuner assertion. It was NOT forwarded, so every
    // armed tune arrived at the phone looking unarmed and was refused — the crown
    // did nothing even after you armed it. A whitelist that silently drops fields is
    // exactly the kind of thing that looks like a logic bug three layers away.
    if let a = message["armed"] { body["armed"] = a }
    sendEvent(withName: "VibeWatchCommand", body: body)
  }

  // MARK: - WCSessionDelegate

  func session(_ s: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {}
  func sessionDidBecomeInactive(_ s: WCSession) {}

  /// Re-activate so a watch switch doesn't silently leave us with a dead session.
  func sessionDidDeactivate(_ s: WCSession) { WCSession.default.activate() }

  func sessionReachabilityDidChange(_ s: WCSession) {
    guard hasListeners else { return }
    // linkAlive, NOT the raw `s.isReachable`.
    //
    // WE FIXED THE STALE-FLAG PROBLEM IN SWIFT AND THEN LEFT THE RAW FLAG AS THE
    // MASTER SWITCH IN JAVASCRIPT. `isReachable` drops out for a moment whenever
    // WCSession hops transport (Bluetooth <-> Wi-Fi), and this event pushed that blip
    // straight up to JS — where `watchProvider.isActive` gates EVERYTHING on it. The
    // phone then stops sending rows entirely, while the UPLINK keeps working (a message
    // from the watch wakes the phone regardless), which is exactly the symptom we kept
    // chasing: the crown tunes perfectly and the waterfall is dead.
    //
    // `linkAlive` is recency-based (reachable OR we heard from the watch < 10s ago), so
    // it rides straight over a transport hop. The wrist is demonstrably there; a flag
    // that says otherwise is wrong, not authoritative.
    sendEvent(withName: "VibeWatchState", body: ["reachable": linkAlive])
  }

}
