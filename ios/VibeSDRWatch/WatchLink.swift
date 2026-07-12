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
  static let kind    = "k"   // "row" | "state" | "fmdx" | "logo" | "settings" | "pong"
  static let meter   = "mt"  // String — the meter text the PHONE is drawing
  static let json    = "j"   // String — FM-DX state blob
  static let image   = "img" // Data — station logo PNG/JPEG bytes
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
  static let peak    = "pk"  // Bool — the phone's peak-hold setting, mirrored
  static let why     = "wy"  // String — WHY there are no rows: live|paused|idle
}

final class WatchLink: NSObject, ObservableObject, WCSessionDelegate {
  static let shared = WatchLink()

  // Rendered state. The waterfall image is @Published so Canvas redraws on it.
  @Published var waterfall  = WaterfallBuffer()
  @Published var frequency  = 0.0
  @Published var span       = 0.0
  @Published var snr        = 0.0
  /// The meter text the PHONE is drawing, mirrored verbatim ("S9+10", "-72dB",
  /// "18db"). NOT derived here.
  ///
  /// The watch used to format SNR itself from the row header — but OWRX, Kiwi and
  /// FM-DX have no SNR to give (they send an absolute S-meter or dBf, with no noise
  /// reference), so the phone sent 0 and this readout was a permanent "—" on those
  /// backends, while the bar beneath it moved perfectly well. Mirroring the phone's
  /// own string means the two can never disagree, and a backend with some other
  /// metric works for free. (Same reasoning as shipping the palette as a LUT rather
  /// than reimplementing the colour maps here.)
  @Published var meter      = ""
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
  /// WHY the phone isn't sending rows, straight from the phone. "No spectrum from
  /// iPhone" is a symptom, not a diagnosis — a paused socket, a stalled renderer and
  /// a dead link all look identical from here, and chasing that cost hours.
  @Published var why = "live"
  @Published var lastStateAt: Date? = nil

  // ── FM-DX ──────────────────────────────────────────────────────────────────
  //
  // A SECOND SCREEN, not a variant of the waterfall: FM-DX has no spectrum at all,
  // so the STATION is the content. We route on whichever message arrived last —
  // the phone never has to tell us which screen to be, because what it SENDS
  // already says: rows mean a spectrum, an fmdx blob means a station.
  @Published var fmdx: FmdxState? = nil
  /// The DAB multiplex, when the phone is on a DAB profile. DAB is a LIST, not a
  /// continuum: the crown SELECTS a service, it does not tune. (The phone already
  /// refuses to tune in DAB — a nudge knocks you off the ensemble block, killing the
  /// decode, and the block is hard to re-find.)
  @Published var dab: DabState? = nil
  /// OWRX ADS-B. Same shape of thing as DAB: the profile IS the content (1090 MHz),
  /// so there is nothing to tune and a waterfall of it is a slab of noise.
  @Published var aircraft: [Aircraft] = []
  @Published var logo: Data? = nil
  /// The phone's dial memory, mirrored — station names pinned to frequencies, learned
  /// from RDS as you tune. The wrist draws the same dial rather than inventing one.
  @Published var stations: [FmdxStation] = []
  /// The user's FAVOURITE instances — a curated handful, not the 2,000-server
  /// directory (which would be absurd on a wrist). This is what rescues the case
  /// where the watch LAUNCHES the phone and the phone has no default instance: the
  /// wrist can pick one instead of staring at nothing.
  @Published var favourites: [Favourite] = []
  /// What the PHONE is doing. A cold launch is a BOOT, not a fault — and the watch
  /// should say which, rather than reporting a missing waterfall as an error.
  /// starting | ready | pick | setup
  @Published var phoneStatus = "ready"
  /// Which screen the watch should be. COMPUTED, not "last message wins".
  ///
  /// FM-DX could be routed by arrival, because an FM-DX server sends no rows. DAB
  /// cannot: the spectrum keeps streaming on a DAB profile, so a row would flip us
  /// straight back to the waterfall. Route on the FACTS instead — what mode the phone
  /// is in, and whether we have a multiplex to show.
  var screen: Screen {
    if isFmdx { return .fmdx }
    if mode == "dab", let d = dab, !d.list.isEmpty { return .dab }
    if mode == "adsb" || !aircraft.isEmpty { return .adsb }
    return .sdr
  }

  /// Set by an FM-DX blob, cleared by a row — an FM-DX server has no spectrum, so
  /// these two can never both be true.
  @Published var isFmdx = false

  enum Screen { case sdr, fmdx, dab, adsb }

  struct Aircraft: Codable, Equatable, Identifiable {
    var icao = ""
    var flight: String? = nil     // callsign
    var reg: String? = nil        // registration
    var ccode: String? = nil      // ISO country of REGISTRY (not of departure)
    var country: String? = nil
    var altitude: Double? = nil   // ft
    var speed: Double? = nil      // kt
    var vspeed: Double? = nil     // ft/min
    var course: Double? = nil
    var squawk: String? = nil
    var rssi: Double? = nil
    var distKm: Double? = nil
    var bearing: Double? = nil
    var id: String { icao }
  }

  struct Favourite: Codable, Equatable, Identifiable {
    var name = ""
    var url = ""
    var type: String? = nil      // ubersdr | kiwi | owrx | fmdx | …
    var id: String { url }
  }

  struct DabService: Codable, Equatable, Identifiable {
    var id = 0            // audio_service_id — what you send to switch
    var name = ""
  }

  struct DabState: Codable, Equatable {
    var ensemble = ""     // the multiplex label, e.g. "BBC National DAB"
    var active = 0        // the audio_service_id currently decoding
    var list: [DabService] = []
  }

  struct FmdxStation: Codable, Equatable, Identifiable {
    var freqHz: Double = 0
    var name = ""
    var id: Double { freqHz }
  }

  struct FmdxState: Codable, Equatable {
    var freq: Double = 0      // Hz
    var ps = ""               // RDS station name
    var rt = ""               // RadioText
    var pi = ""               // PI code (hex)
    var sig: Double = 0       // dBf
    var users = 0             // listeners on the SERVER — see FmdxView
    var stereo = false
    var tx = ""               // transmitter / station name
    var city = ""             // transmitter site
    var dist: Double = 0      // km from the SERVER's QTH (not the listener's)
    var pty = ""              // programme type, already resolved by the phone
    var flag = ""             // country flag emoji
    var rx = ""               // where the RECEIVER is — `dist` is measured from HERE
    var meter = ""            // the phone's meter text, mirrored
    var level: Double = 0     // 0..1 bar fill
  }

  /// Filter edges as Hz offsets from the carrier. NOT symmetric: LSB is entirely
  /// below (both negative), USB entirely above, CW offset. Drawing a single width
  /// about the centre would render every mode as AM.
  @Published var filtLo     = 0.0
  @Published var filtHi     = 0.0
  /// The phone's acrylic-VFO settings, mirrored.
  @Published var needle     = Color.white
  @Published var needleI    = 5.0
  /// Peak hold — MIRRORED from the phone, never decided here. The wrist showing peaks
  /// while the phone doesn't (or the reverse) would be two instruments disagreeing.
  @Published var peakHold   = true

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

  /// An ARMED tune, from the FM-DX screen.
  ///
  /// FM-DX has ONE shared receiver, so tuning it moves the frequency for every
  /// listener — which is why the crown is disarmed by default there. But that gate
  /// lived only in the watch's UI, and the phone accepted any tune command it was
  /// given. When a navigation bug briefly left the watch on the WATERFALL screen
  /// while the phone was on FM-DX, the waterfall's crown tuned the shared receiver
  /// with no arming at all.
  ///
  /// So the assertion travels with the command: the watch says "this tune is armed",
  /// and the phone REQUIRES that before it will touch a shared tuner. The gate no
  /// longer depends on which screen the watch happens to be showing.
  func tuneArmed(delta: Int) {
    send(["cmd": "tune", "delta": delta, "armed": true])
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
  /// Pick a DAB service. NOT a tune — the phone calls setAudioServiceId(), which
  /// re-sends the demod without touching the frequency.
  func selectDab(_ id: Int) { send(["cmd": "dab", "val": id]) }

  /// Switch the PHONE to another instance. Handled outside the SDR screen on the
  /// phone, because the whole point is that it works when no SDR screen is up.
  func selectInstance(_ url: String) { send(["cmd": "inst", "val": url]) }

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

  /// Bytes the meter text occupies in the row blob — MUST match
  /// VibeWatchModule.meterBytes, or the row is sliced at the wrong offset and every
  /// row is silently dropped for being the wrong length.
  private static let meterBytes = 12

  private func handleRow(_ data: Data) {
    let header = 1 + 8 * 6 + Self.meterBytes
    guard data.count > header, data[data.startIndex] == 1 else { return }

    var f = [Double](repeating: 0, count: 6)
    for i in 0..<6 {
      let lo = data.startIndex + 1 + i * 8
      let bits = data[lo..<(lo + 8)].withUnsafeBytes { raw in
        raw.loadUnaligned(as: UInt64.self)
      }
      f[i] = Double(bitPattern: UInt64(littleEndian: bits))
    }

    // The meter text rides IN THE ROW — it must never have a message of its own.
    // (It did, and the extra ~4/sec stream wedged the downlink while the phone was
    // locked, which is the one case the watch exists for.)
    let mStart = data.startIndex + 1 + 8 * 6
    let mBytes = data[mStart..<(mStart + Self.meterBytes)].prefix { $0 != 0 }
    let mText = String(decoding: mBytes, as: UTF8.self)

    let row = [UInt8](data[(data.startIndex + header)...])

    DispatchQueue.main.async {
      self.waterfall.push(row: row)
      self.lastRowAt = Date()
      if !mText.isEmpty { self.meter = mText }
      // Only count a row we can actually DRAW. WaterfallBuffer drops any row of
      // the wrong length silently, so flagging everGotRow on arrival hid the
      // placeholder (and its diagnostics) behind a permanently black canvas.
      if row.count == WaterfallBuffer.width { self.everGotRow = true }
      self.isFmdx = false       // a row means a spectrum — see `screen`
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
    switch m[WK.kind] as? String {
    case "row":
      if let d = m[WK.row] as? Data {
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
      if let md = m[WK.mode] as? String {
        mode = md
        // A STATE MESSAGE MUST BE ABLE TO CONTRADICT THE CURRENT SCREEN, not just
        // confirm it. The screen is computed from facts — but nothing ever cleared
        // the facts, so they went stale and outvoted reality.
        //
        // Symptom: force-quit the phone app with the watch open on ADS-B. The watch
        // relaunches the phone (as a background process), the phone comes up on its
        // default UberSDR instance — and the watch sits there STILL SHOWING THE
        // AIRCRAFT LIST, because it was still holding the last aircraft table and
        // routing on it. It was faithfully rendering a radio that no longer exists.
        //
        // The phone always announces its mode, so let the mode retire whatever it
        // isn't: leaving ADS-B clears the aircraft, leaving DAB clears the mux.
        if md != "adsb" { aircraft = [] }
        if md != "dab"  { dab = nil }
        // Only the SDR screen sends `state` at all — FM-DX sends its own blob — so
        // receiving one is itself proof we are no longer on an FM-DX server.
        isFmdx = false
      }
      if let st = m[WK.step] as? Double { step = st }
      if let mt = m[WK.meter] as? String { meter = mt }
      if let w = m[WK.why] as? String { why = w }
      lastStateAt = Date()
      if let lv = m[WK.level] as? Double { level = lv }

    case "fmdx":
      if let j = m[WK.json] as? String,
         let d = j.data(using: .utf8),
         let st = try? JSONDecoder().decode(FmdxState.self, from: d) {
        fmdx = st
        isFmdx = true
        lastRowAt = Date()        // "the phone is talking to us" — same staleness clock
        everGotRow = true
      }

    case "air":
      if let j = m[WK.json] as? String, let d = j.data(using: .utf8),
         let list = try? JSONDecoder().decode([Aircraft].self, from: d) {
        aircraft = list
      }

    case "dab":
      if let j = m[WK.json] as? String,
         let d = j.data(using: .utf8),
         let st = try? JSONDecoder().decode(DabState.self, from: d) {
        dab = st
      }

    case "phone":
      if let st = m["st"] as? String { phoneStatus = st }

    case "favs":
      if let j = m[WK.json] as? String,
         let d = j.data(using: .utf8),
         let list = try? JSONDecoder().decode([Favourite].self, from: d) {
        favourites = list
      }

    case "stations":
      if let j = m[WK.json] as? String,
         let d = j.data(using: .utf8),
         let list = try? JSONDecoder().decode([FmdxStation].self, from: d) {
        stations = list
      }

    case "logo":
      // Empty = no logo found. Keep it nil so the view falls back to the app icon:
      // glass over nothing reads as a broken grey box.
      if let d = m[WK.image] as? Data { logo = d.isEmpty ? nil : d }

    case "settings":
      if let l = m[WK.lut] as? Data, l.count == 1024 { waterfall.setLUT([UInt8](l)) }
      if let sm = m[WK.smooth] as? Double { waterfall.smoothing = sm }
      if let nc = m[WK.needle] as? String, let c = Color(hex: nc) { needle = c }
      if let ni = m[WK.needleI] as? Double { needleI = ni }
      if let sh = m[WK.sharp] as? Double { waterfall.sharpness = sh }
      if let pk = m[WK.peak] as? Bool {
        peakHold = pk
        waterfall.peakHold = pk   // clears what's held when turned off
      }

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
