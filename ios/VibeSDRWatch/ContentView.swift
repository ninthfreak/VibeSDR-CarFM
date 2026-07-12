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

      // The phone went away. Without this the last waterfall just sits there
      // forever, and a dead link is indistinguishable from a frozen picture —
      // which is exactly how it read when the phone app was closed.
      if link.everGotRow && !link.reachable {
        VStack(spacing: 4) {
          Image(systemName: "iphone.slash").font(.title3)
          Text("iPhone not reachable")
            .font(.caption2)
            .multilineTextAlignment(.center)
        }
        .foregroundStyle(.white)
        .padding(10)
        .background(.black.opacity(0.72))
        .clipShape(RoundedRectangle(cornerRadius: 10))
      }

      VStack(spacing: 2) {
        Spacer()
        ticker
        Button { showNumpad = true } label: { readout }
          .buttonStyle(.plain)
      }
      .padding(.horizontal, 6)
      .padding(.bottom, 4)
    }
    // PUSHED, not presented as a sheet. A watchOS sheet comes with a big header —
    // the X, the clock and a grab handle — which ate ~100pt off the top before the
    // pad's own content began, pushing the bottom row clean off the screen (and
    // hiding the readout behind the X). A navigation push gets a compact back
    // chevron instead, which leaves the pad the room it needs.
    .navigationDestination(isPresented: $showNumpad) {
      NumpadView().environmentObject(link)
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
    .onAppear {
      crownFocused = true
      link.ping()          // tell the phone we're here — see below
    }
    .onChange(of: scenePhase) { _, phase in
      guard phase == .active else { return }
      // Screen woke: the queued rows and the scroll clock are both stale. Draining
      // them as usual fast-forwards through old data and then runs dry — the
      // stutter you get for the first second after a wake. Start clean.
      link.waterfall.reset()
      // ANNOUNCE OURSELVES. The phone's WCSession.isReachable goes stale and it
      // then refuses to send anything, while the crown still tunes — the downlink
      // dies silently. A message from us is proof we're here, so say so rather
      // than waiting for the user to turn the crown before rows start flowing.
      link.ping()
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

      // The spectrum gets a BAND of its own — the top third — and the waterfall
      // takes the rest. A floating overlay was cheaper in pixels, but the trace has
      // to be readable as a HEIGHT: squashed into a strip it is just another
      // texture. The system clock sits in this band and reads as a label there,
      // rather like the receiver name UberSDR puts at the top.
      let specH = (size.height / 3).rounded()

      if let img = wf.makeImage() {
        let rowPx = (size.height - specH) / Double(WaterfallBuffer.visible)
        let p = wf.progress

        // Newest row is index 0 (top) with one row of headroom above the visible
        // edge. As p goes 0->1 the window walks from "newest not yet in" to "newest
        // fully in at the top", exactly as the next row lands and resets p.
        var wctx = ctx
        wctx.clip(to: Path(CGRect(x: 0, y: specH,
                                  width: size.width, height: size.height - specH)))
        wctx.draw(
          Image(decorative: img, scale: 1),
          in: CGRect(x: 0, y: specH - (1 - p) * rowPx,
                     width: size.width,
                     height: rowPx * Double(WaterfallBuffer.height))
        )
      }

      drawSpectrum(ctx, size, wf.specRow, height: specH)
      drawVFO(ctx, size)   // through BOTH: the trace and its history stay aligned
    }
    .ignoresSafeArea()
    .onReceive(driver) { _ in frame &+= 1 }
  }

  /// A thin spectrum trace across the top.
  ///
  /// The waterfall is a TIME view: judging how strong a signal is *right now* means
  /// eyeballing brightness, which is hard work on a small screen. A trace turns
  /// that into a height you can read at a glance.
  ///
  /// It renders the row the waterfall's top edge is currently showing, so the two
  /// are the same instant — spectrum on top, its own history flowing down beneath
  /// it. That only works because we scroll top-down.
  ///
  /// Occupies the top third. The clock lives up here too and reads as a label.
  private func drawSpectrum(_ ctx: GraphicsContext, _ size: CGSize, _ row: [Double],
                            height h: CGFloat) {
    let n = row.count

    // Solid black ground — the trace's own baseline, and what makes a thin line
    // read at a glance.
    ctx.fill(Path(CGRect(x: 0, y: 0, width: size.width, height: h)),
             with: .color(.black))

    guard n > 1 else { return }

    // Peak-preserving downsample to pixels: a narrow carrier must not fall
    // between two samples and vanish — the whole point is to SEE it spike.
    let cols = max(2, Int(size.width))
    var pts: [CGPoint] = []
    pts.reserveCapacity(cols)
    for c in 0..<cols {
      let a = n * c / cols
      let b = max(a + 1, n * (c + 1) / cols)
      var peak: Double = 0
      for i in a..<min(b, n) where row[i] > peak { peak = row[i] }
      let y = h - (CGFloat(peak) / 255) * (h - 2) - 1
      pts.append(CGPoint(x: CGFloat(c) * size.width / CGFloat(cols), y: y))
    }

    // ONE hue, taken from the palette, so the trace belongs to the same instrument
    // as the waterfall. Not white: white fights the system clock, which sits in
    // this band. The fill fades DOWNWARD, so it is at its most transparent where
    // the clock is — the clock stays legible over it and the trace stays readable
    // underneath.
    // The APP's spectrum colouring, ported: a 9-stop gradient sampled from the LUT
    // at index 90->235, hot at the top. It starts at 90, not 0, because black-based
    // palettes (Sonar) are near-invisible below that — so the fill's baseline
    // begins where the palette has actually picked up colour, and weak signals stay
    // visible while the trace still inherits the waterfall's hue.
    //
    // Uncapped brightness: the clock has its own scrim now, so even a near-white
    // palette can't be mistaken for it, and no palette has to be dimmed.
    let wf = link.waterfall
    let stops = (0...8).map { gi -> Gradient.Stop in
      let idx = Int((90 + (Double(gi) / 8) * 145).rounded())
      return .init(color: wf.lutColor(idx), location: 1 - Double(gi) / 8)
    }.reversed()

    var fill = Path()
    fill.move(to: CGPoint(x: 0, y: h))
    pts.forEach { fill.addLine(to: $0) }
    fill.addLine(to: CGPoint(x: size.width, y: h))
    fill.closeSubpath()
    ctx.fill(fill, with: .linearGradient(
      Gradient(stops: Array(stops)),
      startPoint: CGPoint(x: 0, y: 0), endPoint: CGPoint(x: 0, y: h)))

    // The outline is what you actually read a peak off — the palette's hot end.
    var line = Path()
    line.addLines(pts)
    ctx.stroke(line, with: .color(wf.lutColor(235)), lineWidth: 1.2)

    // Scrim behind the system CLOCK, same as the ticker and the frequency pill.
    //
    // watchOS draws the time itself and gives us no way to recolour or hide it — so
    // rather than dimming the trace to avoid clashing with white text (which would
    // punish every palette for the sake of Greyscale and Black Hot), give the clock
    // a dark backing of its own. It then stays legible over ANY trace colour, and
    // the trace keeps the palette's full brightness. Same scrim-not-glass logic as
    // the rest of the chrome.
    // Sits BELOW the top edge: the clock is not flush to the bezel, and a scrim
    // starting at y=2 cut through the digits about halfway down.
    let cw = size.width * 0.42
    let ch: CGFloat = 30
    ctx.fill(
      Path(roundedRect: CGRect(x: size.width - cw - 4, y: 11, width: cw, height: ch),
           cornerRadius: 9),
      with: .color(.black.opacity(0.55))
    )

    // Hairline under the band, so the trace's baseline and the waterfall's top
    // edge don't bleed into one another.
    ctx.stroke(
      Path { $0.move(to: CGPoint(x: 0, y: h)); $0.addLine(to: CGPoint(x: size.width, y: h)) },
      with: .color(.white.opacity(0.18)),
      lineWidth: 1
    )
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

      // Diagnostic: a row of the wrong LENGTH is dropped silently, which looks
      // identical to no row at all. This distinguishes "phone is sending nothing"
      // (msg 0) from "phone is sending rows we're throwing away" (row > 0).
      Text("msg \(link.rxAny) · row \(link.rxRows) · len \(link.lastLen)/\(WaterfallBuffer.width)")
        .font(.system(size: 9, design: .monospaced))
        .foregroundStyle(link.lastLen > 0 && link.lastLen != WaterfallBuffer.width
                         ? .red : .secondary)
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
      Text(formatFreq(link.frequency, step: link.step, unit: link.displayUnit))
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

  /// Two rules, and they're independent.
  ///
  /// UNIT IS INPUT-AWARE: whatever you last entered on the numpad is what it reads
  /// back in. Type 4582 kHz and you get "4582.000 kHz", not "4.582 MHz" —
  /// rendering everything ≥1MHz as MHz was technically right and practically
  /// wrong, because it threw away the frame of reference you were working in.
  /// (.auto keeps the old size-based behaviour until you've told us otherwise.)
  ///
  /// PRECISION FOLLOWS THE STEP: 3 decimals of MHz is 1kHz resolution, so on CW
  /// (1-10Hz steps) you literally could not see what you were tuning. The digits
  /// you get are the ones that can actually move.
  private func formatFreq(_ hz: Double, step: Double, unit: WatchLink.DisplayUnit) -> String {
    if hz <= 0 { return "—" }

    let resolved: WatchLink.DisplayUnit = {
      guard unit == .auto else { return unit }
      if hz >= 1_000_000 { return .mhz }
      if hz >= 1_000     { return .khz }
      return .hz
    }()

    switch resolved {
    case .mhz:
      let dp: Int
      switch step {
      case ..<10:    dp = 6      // 1Hz  — CW
      case ..<100:   dp = 5      // 10Hz
      case ..<1_000: dp = 4      // 100Hz
      default:       dp = 3      // 1kHz+
      }
      return String(format: "%.\(dp)f MHz", hz / 1_000_000)

    case .khz:
      let dp = step < 10 ? 3 : (step < 100 ? 2 : (step < 1_000 ? 1 : 0))
      return String(format: "%.\(dp)f kHz", hz / 1_000)

    case .hz, .auto:
      return String(format: "%.0f Hz", hz)
    }
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
