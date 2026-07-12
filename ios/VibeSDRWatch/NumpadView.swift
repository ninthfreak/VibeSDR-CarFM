import SwiftUI

/// Direct frequency entry — laid out like the system passcode pad.
///
/// That layout fits on one screen precisely because it is ONLY the digits, so
/// everything else has to get out of the grid's way: the readout goes above it,
/// backspace appears beside the readout only once there is something to delete,
/// and the bottom row's two spare slots become "." and TUNE.
///
/// The unit is asked AFTER you commit, not before: you dial the number you were
/// thinking of, then say what it was. ("7.155" is three different frequencies —
/// and no ham typing a CW frequency wants to spell out 7155000.)
///
/// A native TextField was tried and abandoned: watchOS gives it the ALPHANUMERIC
/// input surface, so Scribble reads "1" as "l" or "I", and the keys are too small
/// to hit. There is no public API for Apple's own numeric pad.
struct NumpadView: View {
  @EnvironmentObject var link: WatchLink
  @Environment(\.dismiss) private var dismiss

  @State private var entry = ""
  @State private var askUnit = false

  private let cols = Array(repeating: GridItem(.flexible(), spacing: 5), count: 3)

  var body: some View {
    // Key HEIGHT is derived from the space actually available, not hardcoded.
    // The columns were already flexible (so width scaled), but a fixed height
    // would overflow a 41mm — four rows plus the readout simply don't fit — and
    // we'd be back to scrolling, which is the thing we just got rid of. Apple's
    // passcode pad scales for the same reason. Test hardware is an Ultra 3, the
    // biggest watch made, which is exactly the case that hides this.
    GeometryReader { geo in
      let rows: CGFloat = 4
      let gaps: CGFloat = 5 * (rows - 1)
      let free = geo.size.height - readoutH - gaps - 6
      // Clamped: never so small it can't be hit, never so large it wastes space.
      let keyH = min(46, max(30, free / rows))

      VStack(spacing: 5) {
        readout
        LazyVGrid(columns: cols, spacing: 5) {
          ForEach(1...9, id: \.self) { d in key("\(d)", h: keyH) }
          key(".", h: keyH)
          key("0", h: keyH)
          tuneKey(h: keyH)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
    .padding(.horizontal, 3)
    .confirmationDialog("Tune to", isPresented: $askUnit) {
      // The unit is the whole question, so it gets the whole screen — and each
      // option spells out what it will actually do, so a mis-tap is visible
      // BEFORE the radio jumps a thousandfold.
      ForEach(Unit.allCases, id: \.self) { u in
        if let hz = value(in: u) {
          Button(u.label(for: hz)) { link.tune(toHz: hz); dismiss() }
        }
      }
      Button("Cancel", role: .cancel) { }
    }
  }

  private let readoutH: CGFloat = 26

  private var readout: some View {
    HStack(spacing: 4) {
      Text(entry.isEmpty ? "—" : entry)
        .font(.system(size: 22, weight: .semibold, design: .rounded))
        .monospacedDigit()
        .lineLimit(1)
        .minimumScaleFactor(0.5)
        .frame(maxWidth: .infinity)

      // Only when there's something to delete — otherwise it's a dead key taking
      // up room the digits need.
      if !entry.isEmpty {
        Button { entry.removeLast() } label: {
          Image(systemName: "delete.left").font(.system(size: 13))
        }
        .buttonStyle(.plain)
        .foregroundStyle(.orange)
      }
    }
    .frame(height: readoutH)
  }

  private func key(_ k: String, h: CGFloat) -> some View {
    Button { tap(k) } label: {
      Text(k)
        // The glyph scales with the key, so a smaller watch gets a smaller digit
        // rather than a cramped one.
        .font(.system(size: h * 0.48, weight: .medium, design: .rounded))
        .frame(maxWidth: .infinity, minHeight: h)
    }
    .buttonStyle(.bordered)
  }

  private func tuneKey(h: CGFloat) -> some View {
    Button { if !entry.isEmpty { askUnit = true } } label: {
      Text("TUNE")
        .font(.system(size: max(10, h * 0.30), weight: .bold, design: .rounded))
        .minimumScaleFactor(0.7)
        .frame(maxWidth: .infinity, minHeight: h)
    }
    .buttonStyle(.borderedProminent)
    .tint(.green)
    .disabled(entry.isEmpty)
  }

  private func tap(_ k: String) {
    if k == "." {
      guard !entry.contains(".") else { return }
      entry += entry.isEmpty ? "0." : "."
    } else if entry.count < 10 {
      entry += k
    }
  }

  private func value(in u: Unit) -> Double? {
    guard let v = Double(entry), v > 0 else { return nil }
    let hz = v * u.multiplier
    return hz.isFinite ? hz : nil
  }

  enum Unit: CaseIterable {
    case mhz, khz, hz
    var multiplier: Double {
      switch self {
      case .hz:  return 1
      case .khz: return 1_000
      case .mhz: return 1_000_000
      }
    }
    /// Spell out the destination, not just the unit — "7.155 MHz" tells you far
    /// more than "MHz" does.
    func label(for hz: Double) -> String {
      switch self {
      case .mhz: return String(format: "%.4f MHz", hz / 1_000_000)
      case .khz: return String(format: "%.2f kHz", hz / 1_000)
      case .hz:  return String(format: "%.0f Hz", hz)
      }
    }
  }
}
