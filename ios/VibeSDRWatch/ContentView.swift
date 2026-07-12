import SwiftUI

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

  /// Digital Crown position, in step-detents. We only ever read the DELTA out of
  /// this and hand it to the phone — the phone owns the frequency, multiplies by
  /// its own step size, and echoes back what it actually landed on.
  @State private var crown = 0.0
  @State private var lastDetent = 0
  @FocusState private var crownFocused: Bool

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()

      if link.everGotRow { waterfall } else { placeholder }

      VStack(spacing: 2) {
        Spacer()
        ticker
        readout
      }
      .padding(.horizontal, 6)
      .padding(.bottom, 4)
    }
    .ignoresSafeArea()
    .focusable(true)
    .focused($crownFocused)
    .digitalCrownRotation(
      $crown,
      from: -1_000_000, through: 1_000_000, by: 1,
      sensitivity: .medium,
      isContinuous: true,
      isHapticFeedbackEnabled: true   // detents: the "fidget-spinner" feel
    )
    .onChange(of: crown) { _, new in
      let detent = Int(new.rounded())
      guard detent != lastDetent else { return }
      link.tune(delta: detent - lastDetent)
      lastDetent = detent
    }
    .onAppear { crownFocused = true }
  }

  // ── Waterfall ──────────────────────────────────────────────────────────────

  private var waterfall: some View {
    Canvas { ctx, size in
      guard let img = link.waterfall.makeImage() else { return }
      ctx.draw(Image(decorative: img, scale: 1), in: CGRect(origin: .zero, size: size))

      // Centre marker — the VFO is always dead-centre, because the phone crops
      // the bin window around it. Crown-tune towards a signal and it slides in
      // and parks under this line.
      let x = size.width / 2
      ctx.stroke(
        Path { $0.move(to: CGPoint(x: x, y: 0)); $0.addLine(to: CGPoint(x: x, y: size.height)) },
        with: .color(.white.opacity(0.55)),
        lineWidth: 1
      )
    }
    .ignoresSafeArea()
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
    HStack(spacing: 6) {
      Text(formatFreq(link.frequency))
        .font(.system(size: 15, weight: .semibold, design: .rounded))
        .monospacedDigit()
      Spacer(minLength: 0)
      Text(link.snr > 0 ? String(format: "%.0f dB", link.snr) : "—")
        .font(.system(size: 11, weight: .semibold, design: .rounded))
        .monospacedDigit()
        .foregroundStyle(.white.opacity(0.9))
    }
    .padding(.horizontal, 8)
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

  private func formatFreq(_ hz: Double) -> String {
    if hz <= 0 { return "—" }
    if hz >= 1_000_000 { return String(format: "%.3f MHz", hz / 1_000_000) }
    if hz >= 1_000     { return String(format: "%.1f kHz", hz / 1_000) }
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
