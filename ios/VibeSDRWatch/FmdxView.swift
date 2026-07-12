import SwiftUI
import WatchKit

/// FM-DX: a SECOND SCREEN, not a variant of the waterfall.
///
/// FM-DX has no spectrum at all, so the STATION is the content. The layout is
/// therefore the inverse of the spectrum screen: the logo fills the background,
/// frosted, and everything you read sits over it.
///
/// ── THE CROWN IS DISARMED BY DEFAULT. This is FM-DX ONLY. ────────────────────
/// An FM-DX server has ONE receiver, shared: retuning it changes the frequency for
/// EVERY listener on that server. So an accidental crown nudge from a wrist
/// movement is not a private mistake — it yanks the radio out from under everyone
/// else. You must arm the crown deliberately, and it disarms itself again.
///
/// Do NOT generalise this to the other backends. Kiwi and OWRX give every user
/// their OWN VFO, so tuning there disturbs nobody and an arming step would be pure
/// friction. (OWRX's only communal surface is the profile switcher, which is
/// deliberately not on the watch.)
///
/// The LISTENER COUNT is the other half of the same idea, and the sharper half: it
/// turns "am I allowed to tune?" from a guess into a fact you can read at a glance.
/// Alone — tune freely. Others listening — think, or go and ask on the phone.
struct FmdxView: View {
  @EnvironmentObject var link: WatchLink

  /// Explicit clock, like the spectrum screen. NOT TimelineView(.animation), whose
  /// cadence watchOS is free to ignore. Only drives the RadioText marquee.
  private let driver = Timer.publish(every: 1.0 / 20.0, on: .main, in: .common).autoconnect()
  @State private var tick = 0

  @State private var armed = false
  @State private var disarmAt: Date? = nil
  @State private var crown = 0.0
  @State private var lastDetent = 0
  @FocusState private var crownFocused: Bool

  private static let detents = 1000.0
  /// Arming times out. A crown left live on a shared receiver is a hazard you have
  /// forgotten about — the whole point is that tuning is a deliberate act.
  private static let armSeconds: TimeInterval = 10

  private var st: WatchLink.FmdxState { link.fmdx ?? .init() }

  var body: some View {
    ZStack {
      background

      // A FIXED SKELETON. Every row that can change height is pinned, and only ONE
      // region is allowed to flex.
      //
      // It was `Spacer / identity / Spacer`, and the identity block changes height
      // constantly — RDS arrives, a PTY capsule appears, the transmitter resolves.
      // Two springs either side of a growing box means every one of those turns into
      // a reflow of the whole screen, so the layout visibly jumped and glitched as
      // the station data trickled in.
      VStack(spacing: 0) {
        topBar
        identity
          .frame(maxWidth: .infinity, maxHeight: .infinity)   // the ONLY flexible row
        dial
        readouts
      }
      // THE DISPLAY IS A ROUNDED RECTANGLE AND EVERY MEASUREMENT YOU GET IS A PLAIN
      // ONE. The top bar sat at x=0,y=0 and the corner curve ate the listener count.
      // Inset generously, and drop into the CLOCK'S BAND rather than above it — the
      // clock is NOT flush to the bezel (it sits ~11pt down), so anything level with
      // the very top is in the curve by definition.
      .padding(.horizontal, 12)
      .padding(.top, 12)
      .padding(.bottom, 8)
    }
    .ignoresSafeArea()
    .focusable(true)
    .focused($crownFocused)
    .digitalCrownRotation(
      $crown,
      from: 0, through: Self.detents, by: 1,
      sensitivity: .low,               // FM channels are 100kHz apart: coarse is fine
      isContinuous: true,
      isHapticFeedbackEnabled: true
    )
    .onChange(of: crown) { _, new in
      let detent = Int(new.rounded())
      guard detent != lastDetent else { return }
      var delta = detent - lastDetent
      let range = Int(Self.detents)
      if delta >  range / 2 { delta -= range }
      if delta < -range / 2 { delta += range }
      lastDetent = detent

      // DISARMED = the crown does nothing at all. Not "does something smaller".
      guard armed else { return }
      disarmAt = Date().addingTimeInterval(Self.armSeconds)   // keep it alive while used
      link.tune(delta: delta)
    }
    .onReceive(driver) { _ in
      tick &+= 1
      if let d = disarmAt, Date() >= d { armed = false; disarmAt = nil }
    }
    .onAppear { crownFocused = true; link.ping() }
  }

  // MARK: - Background

  /// The logo, frosted, filling the screen — with the app icon behind it when there
  /// is no logo, so the glass NEVER sits on nothing (which reads as a broken box).
  ///
  /// The blur is STATIC: it recomputes only when the station changes, never per
  /// frame. Nothing animates behind it — the RadioText scrolls in the layer ABOVE.
  /// ── `.clipped()` CLIPS DRAWING. IT DOES NOT CONSTRAIN LAYOUT. ────────────────
  ///
  /// This bit the layout hard: `Image.resizable().scaledToFill()` reports the
  /// SCALED-UP image as its ideal size, a ZStack sizes to its largest child, and so
  /// the instant a real logo arrived the background claimed a rectangle far bigger
  /// than the screen. Everything else was then laid out against THAT — the listener
  /// count drifted up into the corner curve and the signal bar fell off the bottom.
  /// With no logo it looked perfect, because the drawn fallback has no intrinsic
  /// size. So the bug appeared only once a station's logo actually loaded.
  ///
  /// The cure is to PIN the background to the hardware's rectangle, so it can never
  /// have an opinion about how big this view is. Size off `screenBounds`, not
  /// GeometryReader — the same rule the numpad already learned.
  private var background: some View {
    let screen = WKInterfaceDevice.current().screenBounds

    return ZStack {
      Color.black
      Group {
        if let d = link.logo, let img = UIImage(data: d) {
          Image(uiImage: img).resizable().scaledToFill()
        } else {
          // NOT the app icon asset: an .appiconset can't be loaded by name at
          // runtime, so that fallback would silently render NOTHING — the exact
          // "glass over a broken grey box" this is here to prevent. Draw something
          // that cannot be missing.
          ZStack {
            LinearGradient(colors: [.blue.opacity(0.55), .purple.opacity(0.45)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
            Image(systemName: "antenna.radiowaves.left.and.right")
              .font(.system(size: 90, weight: .light))
              .foregroundStyle(.white.opacity(0.30))
          }
        }
      }
      .frame(width: screen.width, height: screen.height)   // <- the load-bearing line
      .blur(radius: 18)
      .opacity(0.55)
      .clipped()
      // A scrim, NOT more glass. Frosting blurs but does not DARKEN, so white text
      // over a frosted white logo is still white-on-white. Same rule as the
      // spectrum screen's chrome.
      LinearGradient(colors: [.black.opacity(0.25), .black.opacity(0.85)],
                     startPoint: .top, endPoint: .bottom)
    }
    .frame(width: screen.width, height: screen.height)
    .clipped()
    .ignoresSafeArea()
  }

  // MARK: - Top bar (the clock's band — free height)

  /// watchOS reserves this strip whether we use it or not, and the clock only sits
  /// at its RIGHT end. The listener count and the arm button cost ZERO height here.
  private var topBar: some View {
    HStack(spacing: 6) {
      Label("\(st.users)", systemImage: "person.fill")
        .font(.system(size: 12, weight: .semibold, design: .rounded))
        .labelStyle(.titleAndIcon)
        .foregroundStyle(.white.opacity(0.9))

      armButton

      Spacer()
      Color.clear.frame(width: 62, height: 1)   // the clock's territory
    }
    .frame(height: 28)
  }

  /// A RADIO TUNING SCALE, badged: red ✗ when the crown is dead, green ✓ when live.
  ///
  /// Drawn, not an SF Symbol. `slider.horizontal.3` was there first and read as
  /// "settings" or "equaliser" — it told you nothing about what the button DOES. A
  /// tick scale with a needle is the universal picture of tuning a radio (it's the
  /// dial off the front of every receiver ever made), so the button explains itself
  /// without a label, which is the only kind of explanation that fits up here.
  ///
  /// Deliberately small: it's a latch, not a control you use constantly.
  private var armButton: some View {
    Button {
      armed.toggle()
      disarmAt = armed ? Date().addingTimeInterval(Self.armSeconds) : nil
      WKInterfaceDevice.current().play(armed ? .start : .stop)
    } label: {
      TuneScaleGlyph()
        .stroke(.white, style: StrokeStyle(lineWidth: 1.1, lineCap: .round))
        .frame(width: 18, height: 11)
        .overlay(alignment: .bottomTrailing) {
          Image(systemName: armed ? "checkmark.circle.fill" : "xmark.circle.fill")
            .font(.system(size: 8, weight: .bold))
            .foregroundStyle(armed ? .green : .red)
            .background(Circle().fill(.black))
            .offset(x: 5, y: 4)
        }
        .frame(width: 32, height: 26)          // the TAP TARGET is the frame, not the glyph
        .background(RoundedRectangle(cornerRadius: 7)
          .fill(armed ? .green.opacity(0.22) : .white.opacity(0.14)))
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  // MARK: - Identity (the middle — the station, not the numbers)

  /// The logo sits behind everything, so the middle of the screen was dead space.
  /// This is what FM-DX is actually FOR: who is this, what are they playing, and
  /// how far away are they.
  private var identity: some View {
    VStack(spacing: 3) {
      if !st.tx.isEmpty {
        Text(st.tx)
          .font(.system(size: 15, weight: .bold, design: .rounded))
          .foregroundStyle(.white)
          .lineLimit(2)
          .multilineTextAlignment(.center)
          .minimumScaleFactor(0.7)
      }

      HStack(spacing: 4) {
        if !st.flag.isEmpty { Text(st.flag).font(.system(size: 12)) }
        if !st.city.isEmpty {
          Text(st.city)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(.white.opacity(0.8))
            .lineLimit(1)
        }
        // Distance is from the SERVER's location, not yours — it's how far the
        // signal travelled to the receiver, which is the DX part of FM-DX.
        if st.dist > 0 {
          Text("\(Int(st.dist)) km")
            .font(.system(size: 11, weight: .semibold, design: .rounded))
            .monospacedDigit()
            .foregroundStyle(.orange)
        }
      }

      // "46 km" IS MEANINGLESS WITHOUT AN ORIGIN — and the origin is not you, it's
      // the receiver you're borrowing, which may be in another country. Name it.
      if st.dist > 0 && !st.rx.isEmpty {
        Text("to \(st.rx)")
          .font(.system(size: 9, weight: .medium))
          .foregroundStyle(.white.opacity(0.55))
          .lineLimit(1)
          .truncationMode(.tail)
      }

      if !st.pty.isEmpty {
        Text(st.pty.uppercased())
          .font(.system(size: 9, weight: .semibold, design: .rounded))
          .foregroundStyle(.white.opacity(0.75))
          .padding(.horizontal, 6)
          .padding(.vertical, 2)
          .background(Capsule().fill(.white.opacity(0.16)))
          .lineLimit(1)
      }
    }
    .padding(.horizontal, 4)
  }

  // MARK: - Dial (the phone's, mirrored)

  /// The BAND, with the station memory pinned to it — the same dial the phone draws,
  /// from the same learned list, so the wrist is a mirror and not a second idea of
  /// what the band looks like.
  ///
  /// The VFO is FIXED AT THE CENTRE and the band slides under it, exactly as the
  /// waterfall does: you tune the dial to the station, not the marker to the dial.
  /// Same LED palette as the phone's drum — green band, warm red needle.
  private var dial: some View {
    Canvas { ctx, size in
      let midX = size.width / 2
      let span = Self.dialSpanHz                 // total width of the visible band
      let hzToX = { (hz: Double) in midX + (hz - st.freq) / span * size.width }

      // Ticks every 100 kHz (the FM channel raster), taller every 1 MHz.
      let start = ((st.freq - span / 2) / 100_000).rounded(.down) * 100_000
      var hz = start
      while hz <= st.freq + span / 2 {
        let x = hzToX(hz)
        let isMHz = (hz / 1_000_000).truncatingRemainder(dividingBy: 1) == 0
        var p = Path()
        p.move(to: CGPoint(x: x, y: size.height - 1))
        p.addLine(to: CGPoint(x: x, y: size.height - (isMHz ? 13 : 6)))
        ctx.stroke(p, with: .color(.green.opacity(isMHz ? 0.8 : 0.4)),
                   lineWidth: isMHz ? 1.4 : 0.9)
        if isMHz {
          let label = Text("\(Int(hz / 1_000_000))")
            .font(.system(size: 10, weight: .semibold, design: .rounded))
            .foregroundStyle(.green.opacity(0.85))
          ctx.draw(label, at: CGPoint(x: x, y: size.height - 21))
        }
        hz += 100_000
      }

      // Learned stations. EVERY one in range gets a TICK — that's the proof it was
      // saved — but the NAMES are laid out with collision avoidance, exactly as the
      // phone's dial does it (FmdxDial: two rows, a minimum gap, nearest-to-tuned
      // placed first). Without it, a dense city band writes every name at the same
      // height and they overlap into mush.
      let inRange = link.stations
        .filter { abs($0.freqHz - st.freq) < span / 2 && !$0.name.isEmpty }

      for stn in inRange {
        let x = hzToX(stn.freqHz)
        var p = Path()
        p.move(to: CGPoint(x: x, y: size.height - 1))
        p.addLine(to: CGPoint(x: x, y: size.height - 17))
        ctx.stroke(p, with: .color(.green), lineWidth: 1.6)
      }

      // Two rows, and the ones NEAREST what you're tuned to get first refusal — a
      // label that has to be dropped should be a distant one, never the neighbour
      // you're about to tune into.
      let rowY: [CGFloat] = [3, 14]
      let minGap: CGFloat = 34
      var used: [[CGFloat]] = [[], []]

      for stn in inRange.sorted(by: {
        abs($0.freqHz - st.freq) < abs($1.freqHz - st.freq)
      }) {
        // Skip the tuned station: it's already the headline, and its label would sit
        // under the needle.
        guard abs(stn.freqHz - st.freq) > span * 0.04 else { continue }
        let x = hzToX(stn.freqHz)
        guard let row = (0..<rowY.count).first(where: { r in
          used[r].allSatisfy { abs($0 - x) >= minGap }
        }) else { continue }                       // no room on either row — drop it
        used[row].append(x)

        let t = Text(stn.name)
          .font(.system(size: 9, weight: .semibold, design: .rounded))
          .foregroundStyle(.green.opacity(0.85))
        ctx.draw(t, at: CGPoint(x: x, y: rowY[row]), anchor: .top)
      }

      // The needle: fixed at the centre, warm red, like the phone's drum.
      var n = Path()
      n.move(to: CGPoint(x: midX, y: 0))
      n.addLine(to: CGPoint(x: midX, y: size.height))
      ctx.stroke(n, with: .color(Color(hue: 4.0 / 360, saturation: 0.85,
                                       brightness: 1.0)), lineWidth: 1.6)
    }
    .frame(height: 52)
    .background(.black.opacity(0.35), in: RoundedRectangle(cornerRadius: 8))
    .padding(.bottom, 4)
  }

  /// How much band the dial shows. Wide enough that a neighbouring station is
  /// visible before you reach it — the point of a dial is seeing what's coming.
  private static let dialSpanHz: Double = 2_000_000

  // MARK: - Readouts (bottom)

  private var readouts: some View {
    VStack(spacing: 2) {
      // Station name + RadioText, scrolling. The RDS text IS the content on FM-DX.
      marquee(rdsLine)

      Text(freqText)
        .font(.system(size: 26, weight: .semibold, design: .rounded))
        .monospacedDigit()
        .foregroundStyle(.white)
        .lineLimit(1)
        .minimumScaleFactor(0.6)

      // PI, then the transmitter site IF it fits — it's the first thing to go.
      HStack(spacing: 5) {
        if !st.pi.isEmpty {
          Text(st.pi.uppercased())
            .font(.system(size: 10, weight: .semibold, design: .rounded))
            .monospacedDigit()
            .foregroundStyle(.cyan)
        }
        Spacer(minLength: 0)
        if st.stereo {
          Image(systemName: "dot.radiowaves.left.and.right")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(.green)
        }
        Text(st.meter.isEmpty ? "—" : st.meter)   // the phone's own meter, mirrored
          .font(.system(size: 10, weight: .semibold, design: .rounded))
          .monospacedDigit()
          .foregroundStyle(.white.opacity(0.9))
      }

      // dBf is a LEVEL, so draw it as one. Same red->green gradient as the phone's
      // signal bar — the number tells you the value, the bar tells you at a glance
      // whether it's any good, which is what you actually want on a wrist.
      signalBar
    }
    .padding(.horizontal, 7)
    .padding(.vertical, 5)
    .background(.black.opacity(0.45), in: RoundedRectangle(cornerRadius: 11))
  }

  private var signalBar: some View {
    GeometryReader { geo in
      ZStack(alignment: .leading) {
        Capsule().fill(.white.opacity(0.18))
        Capsule()
          .fill(LinearGradient(colors: [.red, .yellow, .green],
                               startPoint: .leading, endPoint: .trailing))
          .frame(width: max(2, geo.size.width * min(1, max(0, st.level))))
      }
    }
    .frame(height: 3)
  }

  private var rdsLine: String {
    let name = st.ps.trimmingCharacters(in: .whitespaces)
    let text = st.rt.trimmingCharacters(in: .whitespaces)
    if name.isEmpty && text.isEmpty { return link.reachable ? "No RDS" : "iPhone not reachable" }
    if text.isEmpty { return name }
    if name.isEmpty { return text }
    return "\(name)  ·  \(text)"
  }

  private var freqText: String {
    guard st.freq > 0 else { return "—" }
    return String(format: "%.2f MHz", st.freq / 1_000_000)
  }

  /// A marquee that only scrolls when it NEEDS to.
  ///
  /// RadioText is up to 64 characters and the screen holds maybe 20, so it has to
  /// move — but a station name that already fits must sit still: text that slides
  /// for no reason is just noise on a screen this size. Driven by the same explicit
  /// clock as everything else; the background behind it never animates.
  private func marquee(_ s: String) -> some View {
    let charW: CGFloat = 6.2                       // caption-ish, rounded
    let width = WKInterfaceDevice.current().screenBounds.width - 30
    let textW = CGFloat(s.count) * charW
    let overflow = max(0, textW - width)

    // Ease across, pause at each end — a constantly-cycling loop is unreadable
    // because you can never catch the start of the sentence.
    let period = 4.0 + Double(overflow) / 18.0     // longer text, slower crawl
    let t = Double(tick) / 20.0
    let phase = period > 0 ? (t.truncatingRemainder(dividingBy: period * 2)) / period : 0
    let eased = phase <= 1 ? phase : 2 - phase     // 0->1->0, with a dwell at the turns
    let offset = -overflow * min(1, max(0, eased * 1.4 - 0.2))

    return Text(s)
      .font(.system(size: 12, weight: .semibold, design: .rounded))
      .foregroundStyle(.white)
      .lineLimit(1)
      .fixedSize(horizontal: true, vertical: false)
      .offset(x: overflow > 0 ? offset : 0)
      .frame(width: width, alignment: overflow > 0 ? .leading : .center)
      .clipped()
  }
}

/// The face of a radio: a scale of ticks with a tuning needle standing over it.
///
/// Drawn rather than borrowed from SF Symbols, which has no dial — and the nearest
/// stand-ins (`slider.horizontal.3`, `dial.medium`) read as "settings" or "volume".
/// This shape is what a tuning scale looks like on every receiver ever built, so the
/// arm button needs no label to say what it does.
struct TuneScaleGlyph: Shape {
  func path(in r: CGRect) -> Path {
    var p = Path()
    let baseY = r.maxY - 1

    // The scale.
    p.move(to: CGPoint(x: r.minX, y: baseY))
    p.addLine(to: CGPoint(x: r.maxX, y: baseY))

    // Ticks, alternating long/short like a real dial's raster.
    let n = 7
    for i in 0..<n {
      let x = r.minX + r.width * CGFloat(i) / CGFloat(n - 1)
      let h: CGFloat = i.isMultiple(of: 2) ? 4 : 2.5
      p.move(to: CGPoint(x: x, y: baseY))
      p.addLine(to: CGPoint(x: x, y: baseY - h))
    }

    // The needle — off-centre, because a needle parked dead centre reads as just
    // another tick.
    let nx = r.minX + r.width * 0.63
    p.move(to: CGPoint(x: nx, y: r.minY))
    p.addLine(to: CGPoint(x: nx, y: baseY + 1))
    return p
  }
}
