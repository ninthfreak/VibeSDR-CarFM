import SwiftUI
import Combine


/// Spectrum screen: full-bleed waterfall with chrome FLOATING over it.
///
/// Solid bars would cut the waterfall in two and steal height at both ends, and
/// waterfall height is the scarcest thing on a watch. Legibility comes from a
/// dark scrim, not glass/frosting: frosting blurs but does not darken, so green
/// text over a sonar-green waterfall would still be green-on-green — and the
/// waterfall scrolls under the chrome at ~10fps, which would re-blur every frame
/// on the watch GPU.
///
/// ALL chrome lives at the BOTTOM. The system clock owns the top-right corner of
/// every standard watch app and cannot be moved or hidden, so a frequency ticker
/// up there would collide with it.
struct ContentView: View {
  @EnvironmentObject var link: WatchLink
  @Environment(\.scenePhase) private var scenePhase

  /// Digital Crown position, in step-detents. We only ever read the DELTA out of
  /// this and hand it to the phone — the phone owns the frequency, multiplies by
  /// its own step size, and echoes back what it actually landed on.
  ///
  /// The range is deliberately SMALL and wrapping. A huge from/through span with
  /// `by: 1` makes watchOS materialise a detent map that size and tick haptics
  /// across it — rotating then hangs the main thread and the watchdog SIGKILLs
  /// the app (which reads as "the app bounced back to the app list").
  @State private var crown = 0.0
  @State private var lastDetent = 0
  @FocusState private var crownFocused: Bool

  /// Explicit 30fps redraw clock.
  ///
  /// We do NOT use `TimelineView(.animation)`: on watchOS its `minimumInterval` is
  /// a floor on the GAP, not a promise of cadence, and it proved free to update
  /// lazily — in practice it fired sometimes and not others, so the waterfall
  /// scrolled smoothly for a few frames, stalled, then lurched. (It only looked
  /// right at all while a second TimelineView — a debug overlay — happened to be
  /// forcing repaints.) The scroll glide and the jitter buffer both advance on
  /// this clock, so a cadence we don't control is a cadence we can't render on.
  @State private var frame = 0
  @State private var showNumpad = false
  private let driver = Timer.publish(every: 1.0 / 30.0, on: .main, in: .common).autoconnect()

  private static let detents = 1000.0


  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()

      if link.everGotRow { waterfall } else { placeholder }

      VStack(spacing: 2) {
        Spacer()
        ticker
        Button { showNumpad = true } label: { readout }
          .buttonStyle(.plain)
      }
      .padding(.horizontal, 6)
      .padding(.bottom, 4)
    }
    .sheet(isPresented: $showNumpad) {
      NavigationStack { NumpadView().environmentObject(link) }
    }
    .ignoresSafeArea()
    .focusable(true)
    .focused($crownFocused)
    .digitalCrownRotation(
      $crown,
      from: 0, through: Self.detents, by: 1,
      sensitivity: .medium,
      isContinuous: true,               // wraps at the ends
      isHapticFeedbackEnabled: true     // detents: the "fidget-spinner" feel
    )
    .onChange(of: crown) { _, new in
      let detent = Int(new.rounded())
      guard detent != lastDetent else { return }

      // Unwrap: the crown is continuous, so crossing 0 <-> 999 is a step of one,
      // not a leap of 999. Without this a single detent at the wrap point would
      // fling the VFO across the band.
      var delta = detent - lastDetent
      let range = Int(Self.detents)
      if delta >  range / 2 { delta -= range }
      if delta < -range / 2 { delta += range }

      lastDetent = detent
      link.tune(delta: delta)
    }
    .onAppear { crownFocused = true }
    .onChange(of: scenePhase) { _, phase in
      // Screen woke: the queued rows and the scroll clock are both stale. Draining
      // them as usual fast-forwards through old data and then runs dry — the
      // stutter you get for the first second after a wake. Start clean.
      if phase == .active { link.waterfall.reset() }
    }
  }

  // ── Waterfall ──────────────────────────────────────────────────────────────

  /// WCSession delivers rows in BURSTS, not on a clock. So the renderer owns the
  /// scroll clock: it ticks the jitter buffer on a steady timeline, which drains
  /// queued rows at an even cadence and hands back a sub-row offset to glide by.
  /// Drawing on arrival — however you interpolate it — always lurches, because
  /// during a gap there is nothing to interpolate towards.
  private var waterfall: some View {
    Canvas { ctx, size in
      // `frame` is read here purely so the Canvas content changes every tick and
      // SwiftUI is obliged to redraw. See `driver` below for why we don't use
      // TimelineView.
      _ = frame

      let wf = link.waterfall
      wf.tick(at: ProcessInfo.processInfo.systemUptime)
      guard let img = wf.makeImage() else { return }

      let rowPx = size.height / Double(WaterfallBuffer.visible)
      let p = wf.progress

      // Newest row is index 0 (top) with one row of headroom above the visible
      // edge. As p goes 0->1 the window walks from "newest not yet in" to "newest
      // fully in at the top", exactly as the next row lands and resets p.
      ctx.draw(
        Image(decorative: img, scale: 1),
        in: CGRect(x: 0, y: -(1 - p) * rowPx,
                   width: size.width,
                   height: rowPx * Double(WaterfallBuffer.height))
      )

      drawVFO(ctx, size)
    }
    .ignoresSafeArea()
    .onReceive(driver) { _ in frame &+= 1 }
  }

  /// The VFO. Always dead-centre — the phone crops the bin window around it — so
  /// this is a fixed mark and the signal slides under it as you tune.
  ///
  /// Deliberately NOT a port of the phone's acrylic pane. At ~184px wide a diffuse
  /// tinted panel just reads as a smudge and buries the signal underneath it. On a
  /// watch, crisp geometry beats soft geometry: a bright solid carrier, and the
  /// passband edges as 1px DASHED lines, so you can see the filter width without
  /// it competing with the waterfall for the same pixels.
  ///
  /// Colour and intensity come from the phone's own VFO settings, so the two
  /// screens agree — but intensity drives BRIGHTNESS here, not glow spread.
  /// Nothing is blurred: it would only smear the signal under the line, and it
  /// would re-blur 30x/sec on the watch GPU for the privilege.
  private func drawVFO(_ ctx: GraphicsContext, _ size: CGSize) {
    let x = size.width / 2
    let h = size.height
    let c = link.needle
    let k = max(0.2, link.needleI / 5)   // 1-10, 5 = the phone's stock look

    // ── Passband edges: 1px dashed, drawn at their TRUE offsets from the carrier.
    //    Not mirrored: on LSB both edges fall to the LEFT of the carrier, on USB
    //    both to the right, and CW is offset — mirroring a single width would draw
    //    every mode as AM.
    if link.span > 0, link.filtHi != link.filtLo {
      let hzToPx = size.width / link.span
      let dash = StrokeStyle(lineWidth: 1, dash: [3, 3])
      for edge in [link.filtLo, link.filtHi] {
        let ex = x + edge * hzToPx
        guard ex > 1, ex < size.width - 1 else { continue }   // off-span: skip
        ctx.stroke(
          Path { $0.move(to: CGPoint(x: ex, y: 0)); $0.addLine(to: CGPoint(x: ex, y: h)) },
          with: .color(c.opacity(min(1, 0.75 * k))),
          style: dash
        )
      }
    }

    // ── The carrier: bright, solid, crisp. NO glow, NO blur — on a watch those
    //    only smear the signal sitting underneath the line. Intensity drives
    //    brightness, not spread.
    ctx.stroke(
      Path { $0.move(to: CGPoint(x: x, y: 0)); $0.addLine(to: CGPoint(x: x, y: h)) },
      with: .color(c.opacity(min(1, 0.55 + 0.09 * link.needleI))),
      lineWidth: 2.5
    )
  }

  private var placeholder: some View {
    VStack(spacing: 6) {
      Image(systemName: link.reachable ? "dot.radiowaves.left.and.right" : "iphone.slash")
        .font(.title3)
        .foregroundStyle(.secondary)
      Text(link.reachable ? "Waiting for signal" : "Open VibeSDR on iPhone")
        .font(.caption2)
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)
    }
    .padding(.horizontal, 12)
  }

  // ── Frequency ticker ───────────────────────────────────────────────────────

  private var ticker: some View {
    Canvas { ctx, size in
      guard link.span > 0 else { return }
      let lo = link.frequency - link.span / 2
      let hi = link.frequency + link.span / 2
      let stepHz = tickStep(span: link.span)
      let x = { (hz: Double) in (hz - lo) / (hi - lo) * size.width }

      var hz = (lo / stepHz).rounded(.up) * stepHz
      while hz <= hi {
        let px = x(hz)
        ctx.stroke(
          Path { $0.move(to: CGPoint(x: px, y: size.height - 4))
                 $0.addLine(to: CGPoint(x: px, y: size.height)) },
          with: .color(.white.opacity(0.5)),
          lineWidth: 1
        )
        var label = ctx.resolve(
          Text(tickLabel(hz, span: link.span))
            .font(.system(size: 8, weight: .medium, design: .rounded))
        )
        label.shading = .color(.white.opacity(0.75))
        let w = label.measure(in: size).width
        // Don't let an edge label hang off the screen.
        let cx = min(max(px, w / 2), size.width - w / 2)
        ctx.draw(label, at: CGPoint(x: cx, y: 5), anchor: .center)
        hz += stepHz
      }
    }
    .frame(height: 14)
    .background(.black.opacity(0.45))
    .clipShape(RoundedRectangle(cornerRadius: 4))
  }

  /// A 1/2/5 x 10^n step giving ~4 ticks across the span. Tick density therefore
  /// reacts to zoom instead of crowding as you narrow the span.
  private func tickStep(span: Double) -> Double {
    let raw = span / 4
    let mag = pow(10, floor(log10(raw)))
    let n = raw / mag
    let mult: Double = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10
    return mult * mag
  }

  /// Labels must switch UNITS with the span — decimal places alone overflow a
  /// ~150px bar (CW at ~5kHz wants Hz; FM broadcast at ~2MHz wants 100s of kHz).
  private func tickLabel(_ hz: Double, span: Double) -> String {
    if span >= 1_000_000 { return String(format: "%.1fM", hz / 1_000_000) }
    if span >= 10_000    { return String(format: "%.0fk", hz / 1_000) }
    if span >= 1_000     { return String(format: "%.1fk", hz / 1_000) }
    return String(format: "%.0f", hz)
  }

  // ── Frequency + signal ─────────────────────────────────────────────────────
  //
  // The pill's BACKGROUND *is* the signal meter — same trick as the phone's
  // ControlsBar, so there's no separate bar stealing height. The fill is the
  // phone's own smoothed 0..1 level, drawn with the phone's own red->green ramp.

  private var readout: some View {
    // Hugs its content and centres, rather than stretching edge-to-edge with the
    // two figures pushed into opposite corners — the watch's rounded corners were
    // clipping them there.
    HStack(spacing: 8) {
      Text(formatFreq(link.frequency, step: link.step))
        .font(.system(size: 15, weight: .semibold, design: .rounded))
        .monospacedDigit()
        // Shrink to fit rather than scroll. A marquee would be an animation
        // running behind the waterfall forever, for text that is only long in the
        // CW case; scaling costs nothing and is always readable at a glance.
        .lineLimit(1)
        .minimumScaleFactor(0.55)
      Text(link.snr > 0 ? String(format: "%.0f dB", link.snr) : "—")
        .font(.system(size: 11, weight: .semibold, design: .rounded))
        .monospacedDigit()
        .foregroundStyle(.white.opacity(0.9))
        .layoutPriority(-1)   // the frequency wins the space
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 4)
    .background(alignment: .leading) {
      GeometryReader { geo in
        ZStack(alignment: .leading) {
          Color.black.opacity(0.55)                       // track + scrim in one
          LinearGradient(
            stops: SignalGradient.stops(for: link.level),
            startPoint: .leading, endPoint: .trailing
          )
          .frame(width: geo.size.width * min(1, max(0, link.level)))
          .animation(.easeOut(duration: 0.12), value: link.level)
        }
      }
    }
    .clipShape(Capsule())
  }

  /// PRECISION FOLLOWS THE STEP. Showing 3 decimals of MHz is 1kHz resolution —
  /// on CW (1-10Hz steps) you literally cannot see what you are tuning, and the
  /// digits that matter are the ones that move. So derive the decimal count from
  /// the current step, and don't waste width on zeros that can never change.
  private func formatFreq(_ hz: Double, step: Double) -> String {
    if hz <= 0 { return "—" }

    if hz >= 1_000_000 {
      let dp: Int
      switch step {
      case ..<10:    dp = 6      // 1Hz  — CW
      case ..<100:   dp = 5      // 10Hz
      case ..<1_000: dp = 4      // 100Hz
      default:       dp = 3      // 1kHz+
      }
      return String(format: "%.\(dp)f MHz", hz / 1_000_000)
    }
    if hz >= 1_000 {
      let dp = step < 100 ? 3 : (step < 1_000 ? 2 : 1)
      return String(format: "%.\(dp)f kHz", hz / 1_000)
    }
    return String(format: "%.0f Hz", hz)
  }
}

/// Port of the phone's sigGradient() (ControlsBar.tsx). The ramp GROWS with the
/// level — a weak signal is pure red, and green only enters once the bar is
/// actually long — so the colour at the tip means the same thing on both screens.
enum SignalGradient {
  static func stops(for sig: Double) -> [Gradient.Stop] {
    let red    = Color(red: 0xbb / 255, green: 0x11 / 255, blue: 0x00 / 255)
    let orange = Color(red: 0xff / 255, green: 0x44 / 255, blue: 0x00 / 255)
    let amber  = Color(red: 0xff / 255, green: 0xaa / 255, blue: 0x00 / 255)
    let green  = Color(red: 0x00 / 255, green: 0xdd / 255, blue: 0x44 / 255)

    if sig < 0.20 {
      return [.init(color: red, location: 0), .init(color: orange, location: 1)]
    }
    if sig < 0.58 {
      return [.init(color: red, location: 0),
              .init(color: orange, location: 0.20 / sig),
              .init(color: amber, location: 1)]
    }
    return [.init(color: red, location: 0),
            .init(color: orange, location: 0.15),
            .init(color: amber, location: 0.45),
            .init(color: green, location: 1)]
  }
}
