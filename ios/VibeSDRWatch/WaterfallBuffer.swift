import Foundation
import CoreGraphics

/// Scrolling RGBA pixel buffer for the wrist waterfall.
///
/// Three things conspire to make a naive implementation judder, and each needs
/// its own fix:
///
///  1. **WCSession is not a stream.** It delivers rows in BURSTS — several land
///     together, then nothing for a few hundred ms. Blitting on arrival lurches
///     no matter how you interpolate, because during a gap there is nothing to
///     interpolate towards. Fix: a JITTER BUFFER — queue arrivals, drain on a
///     steady clock (`tick`). Same medicine as the rtl_tcp client buffer.
///  2. **The feed is only ~5fps**, deliberately (halving the message rate buys
///     real battery, and the phone can then run a quarter-rate FFT). At one row
///     per frame that is a slow march of fat bands. Fix: INTERPOLATE UP —
///     synthesise `subRows` blended rows between each pair of received rows, so
///     the waterfall still scrolls at ~15 rows/sec. This is what lets VibeServer
///     look fine at 5fps too.
///  3. **The image is tiny** (128 bins x 89 rows, stretched to the screen).
///     Fix: bilinear on the way up — smooths row banding AND the fat bins you
///     get when the phone is zoomed out.
final class WaterfallBuffer {
  static let width  = 128
  /// One row of headroom beyond what's shown: the newest row lives just ABOVE the
  /// visible edge and slides down into view, which is what makes the scroll a
  /// glide rather than a step.
  ///
  /// NEWEST AT THE TOP, ageing downward — the opposite of the phone. On a watch
  /// the chrome (ticker + frequency bar) lives at the BOTTOM, so a bottom-up
  /// waterfall would give birth to every new row underneath it: you'd only see a
  /// new signal once it had already scrolled clear of the furniture. Tuning is
  /// done off the newest row, so the newest row must be the one in clear air.
  static let height  = 89
  static let visible = 88

  /// Synthesised rows per received row. 3 x 5fps = ~15 rows/sec of scroll.
  private let subRows = 3

  /// 0..1 extra temporal blend from the phone's settings, on top of the
  /// interpolation. 0 = rely on interpolation alone.
  var smoothing: Double = 0.0

  private var pixels: [UInt8]
  private var lut: [UInt8]
  private var cached: CGImage?

  // Jitter buffer + interpolation state
  private var queue: [[UInt8]] = []
  private var prevRow: [UInt8]          // last fully-applied row (blend source)
  private var target: [UInt8]?          // row we're interpolating towards
  private var subStep = 0

  /// Scroll clock, in SUB-rows.
  private var accum: Double = 0
  private var lastTick: CFTimeInterval = 0
  private var lastArrivalAt: CFTimeInterval = 0
  /// Measured arrival cadence of RECEIVED rows (not sub-rows).
  private var interval: CFTimeInterval = 0.2
  private var arrivals = 0
  private let targetDepth = 2.0

  /// PREFILL. A jitter buffer that starts draining while empty alternates between
  /// running dry and catching up — which is a stutter, and it's why the first
  /// second after launch (and after a screen wake) looked rough. Hold still until
  /// a couple of rows are banked, then drain; drop back to holding if we ever run
  /// dry. Costs a fraction of a second of latency at the start, once.
  private var prefilling = true

  /// Sub-row offset for the renderer, 0..1.
  var progress: Double { min(1, max(0, accum)) }

  // Diagnostics — is the render loop actually ticking, and is the queue healthy?
  private(set) var renderFps: Double = 0
  var queueDepth: Int { queue.count }
  var arrivalMs: Int { Int(interval * 1000) }

  init() {
    pixels  = [UInt8](repeating: 0, count: Self.width * Self.height * 4)
    prevRow = [UInt8](repeating: 0, count: Self.width)
    // Greyscale until the phone sends its palette, so a dropped settings message
    // shows a working waterfall rather than a black rectangle.
    var l = [UInt8](repeating: 255, count: 256 * 4)
    for i in 0..<256 {
      l[i * 4 + 0] = UInt8(i); l[i * 4 + 1] = UInt8(i); l[i * 4 + 2] = UInt8(i)
    }
    lut = l
  }

  func setLUT(_ newLUT: [UInt8]) {
    lut = newLUT
    cached = nil
  }

  /// A row arrived. Queue it — do NOT draw here.
  func push(row: [UInt8]) {
    guard row.count == Self.width else { return }

    let now = ProcessInfo.processInfo.systemUptime
    if lastArrivalAt > 0 {
      let dt = now - lastArrivalAt
      // Only learn from plausible gaps: a burst (dt~0) and a stall (watch app was
      // backgrounded) would both poison the cadence estimate.
      if dt > 0.05, dt < 1.0 {
        // Converge FAST for the first few rows, then settle. Starting from a
        // guessed cadence and creeping towards the real one is itself a stutter.
        arrivals += 1
        let alpha = arrivals < 5 ? 0.5 : 0.1
        interval += alpha * (dt - interval)
      }
    }
    lastArrivalAt = now

    queue.append(row)
    // If we somehow can't keep up, drop the OLDEST: the newest row is the one
    // that matters, and a growing queue is just latency.
    if queue.count > 8 { queue.removeFirst(queue.count - 8) }
  }

  /// Screen woke / link came back. The queue holds stale rows and the clock is
  /// stale, so drain-as-usual would fast-forward through old data and then run
  /// dry. Start clean and re-prefill instead.
  func reset() {
    queue.removeAll()
    target = nil
    subStep = 0
    accum = 0
    lastTick = 0
    lastArrivalAt = 0
    arrivals = 0
    prefilling = true
  }

  /// Advance the scroll clock. Called every redraw (~30fps), NOT on arrival.
  func tick(at now: CFTimeInterval) {
    defer { lastTick = now }
    guard lastTick > 0, interval > 0 else { return }
    let dt = min(0.25, now - lastTick)   // a long gap (app resumed) must not fling
    if dt > 0 { renderFps += 0.1 * (1.0 / dt - renderFps) }

    // Hold still until the buffer has banked enough to drain smoothly.
    if prefilling {
      guard Double(queue.count) >= targetDepth else { return }
      prefilling = false
    }

    // Drain rate tracks queue pressure: run slightly fast when backing up, slow
    // when running dry. Keeps the scroll smooth across a feed whose true rate
    // drifts (foreground vs locked) without ever stalling or visibly fast-forwarding.
    let depth = Double(queue.count) + (target != nil ? 1 : 0)
    let rate: Double
    if depth == 0                   { rate = 0; prefilling = true }  // dry — re-prefill
    else if depth > targetDepth + 2 { rate = 1.5 }                   // behind — catch up
    else                            { rate = 0.85 + 0.15 * (depth / targetDepth) }

    let subInterval = interval / Double(subRows)
    accum += (dt / subInterval) * rate

    while accum >= 1 {
      guard emitSubRow() else { break }
      accum -= 1
    }
    // Ran dry mid-row: park at the boundary rather than drifting past it.
    if target == nil && queue.isEmpty { accum = min(accum, 1) }
  }

  /// Blit ONE synthesised row, interpolating from the last applied row towards
  /// the row we're heading for. Returns false when there's nothing to draw.
  private func emitSubRow() -> Bool {
    if target == nil {
      guard !queue.isEmpty else { return false }
      target = queue.removeFirst()
      subStep = 0
    }
    guard let dst = target else { return false }

    subStep += 1
    let t = Double(subStep) / Double(subRows)

    var row = [UInt8](repeating: 0, count: Self.width)
    for i in 0..<Self.width {
      let v = Double(prevRow[i]) + (Double(dst[i]) - Double(prevRow[i])) * t
      row[i] = UInt8(clamping: Int(v.rounded()))
    }
    blit(row)

    if subStep >= subRows {
      prevRow = dst
      target = nil
    }
    return true
  }

  private func blit(_ row: [UInt8]) {
    let stride = Self.width * 4
    // Scroll DOWN one row, then paint the newest along the TOP edge.
    pixels.withUnsafeMutableBytes { raw in
      guard let base = raw.baseAddress else { return }
      memmove(base.advanced(by: stride), base, stride * (Self.height - 1))
    }

    for x in 0..<Self.width {
      let l = Int(row[x]) * 4
      let p = x * 4
      pixels[p + 0] = lut[l + 0]
      pixels[p + 1] = lut[l + 1]
      pixels[p + 2] = lut[l + 2]
      pixels[p + 3] = 255
    }
    cached = nil
  }

  /// Cached: rebuilt only when pixels change, not on every one of the ~30
  /// redraws/sec the glide needs. On a watch, waste is battery.
  func makeImage() -> CGImage? {
    if let c = cached { return c }
    let stride = Self.width * 4
    guard let provider = CGDataProvider(data: Data(pixels) as CFData) else { return nil }
    let img = CGImage(
      width: Self.width,
      height: Self.height,
      bitsPerComponent: 8,
      bitsPerPixel: 32,
      bytesPerRow: stride,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
      provider: provider,
      decode: nil,
      // Bilinear on the way up to screen size: smooths row banding AND the fat
      // bins you get when the phone is zoomed out. The GPU is scaling this
      // image anyway, so it costs nothing.
      shouldInterpolate: true,
      intent: .defaultIntent
    )
    cached = img
    return img
  }
}
