import SwiftUI

/// Spectrum screen: full-bleed waterfall with chrome FLOATING over it.
///
/// Solid bars would cut the waterfall in two and steal height at both ends, and
/// waterfall height is the scarcest thing on a watch. Legibility comes from a
/// dark scrim, not glass/frosting: frosting blurs but does not darken, so green
/// text over a sonar-green waterfall would still be green-on-green — and the
/// waterfall scrolls under the chrome at ~10fps, which would re-blur every
/// frame on the watch GPU. A scrim costs nothing per frame.
struct ContentView: View {
  @EnvironmentObject var link: WatchLink

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()

      if link.everGotRow {
        waterfall
      } else {
        placeholder
      }

      VStack {
        Spacer()
        readout
      }
    }
    .ignoresSafeArea()
  }

  private var waterfall: some View {
    Canvas { ctx, size in
      guard let img = link.waterfall.makeImage() else { return }
      ctx.draw(
        Image(decorative: img, scale: 1),
        in: CGRect(origin: .zero, size: size)
      )

      // Centre marker — the VFO is always dead-centre, because the phone crops
      // the bin window around it. Chasing a signal with the crown slides it in
      // to park under this line.
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

  private var readout: some View {
    HStack(spacing: 6) {
      Text(formatFreq(link.frequency))
        .font(.system(size: 15, weight: .semibold, design: .rounded))
        .monospacedDigit()
      Spacer(minLength: 0)
      Text(String(format: "%.0f dB", link.snr))
        .font(.system(size: 12, weight: .medium, design: .rounded))
        .monospacedDigit()
        .foregroundStyle(.secondary)
    }
    .padding(.horizontal, 10)
    .padding(.vertical, 5)
    .background(.black.opacity(0.55))
    .clipShape(Capsule())
    .padding(.horizontal, 8)
    .padding(.bottom, 6)
  }

  /// Switch UNITS with magnitude — decimal places alone overflow a ~150px bar.
  private func formatFreq(_ hz: Double) -> String {
    if hz <= 0 { return "—" }
    if hz >= 1_000_000 { return String(format: "%.3f MHz", hz / 1_000_000) }
    if hz >= 1_000     { return String(format: "%.1f kHz", hz / 1_000) }
    return String(format: "%.0f Hz", hz)
  }
}
