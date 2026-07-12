import SwiftUI

/// Direct frequency entry. watchOS has no built-in numpad, so this is a plain
/// SwiftUI button grid — 1-9, then `.` 0 ⌫ — with a unit button (Hz / kHz / MHz)
/// and a Go button.
///
/// The unit matters more than it looks: "7.030" means three different frequencies
/// depending on whether you meant MHz, kHz or Hz, and a ham typing a CW frequency
/// is not going to want to spell out 7030000.
struct NumpadView: View {
  @EnvironmentObject var link: WatchLink
  @Environment(\.dismiss) private var dismiss

  @State private var entry = ""
  @State private var unit  = Unit.mhz

  enum Unit: String, CaseIterable {
    case hz = "Hz", khz = "kHz", mhz = "MHz"
    var multiplier: Double {
      switch self {
      case .hz:  return 1
      case .khz: return 1_000
      case .mhz: return 1_000_000
      }
    }
    var next: Unit {
      let all = Unit.allCases
      return all[(all.firstIndex(of: self)! + 1) % all.count]
    }
  }

  private let keys = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "⌫"]

  var body: some View {
    VStack(spacing: 4) {
      // What you've typed, plus the unit you're typing it in.
      HStack(spacing: 4) {
        Text(entry.isEmpty ? "—" : entry)
          .font(.system(size: 18, weight: .semibold, design: .rounded))
          .monospacedDigit()
          .lineLimit(1)
          .minimumScaleFactor(0.5)
          .frame(maxWidth: .infinity, alignment: .trailing)

        Button(unit.rawValue) { unit = unit.next }
          .font(.system(size: 11, weight: .bold, design: .rounded))
          .buttonStyle(.bordered)
          .tint(.orange)
          .fixedSize()
      }
      .padding(.horizontal, 2)

      LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 3), count: 3),
                spacing: 3) {
        ForEach(keys, id: \.self) { k in
          Button { tap(k) } label: {
            Text(k)
              .font(.system(size: 16, weight: .medium, design: .rounded))
              .frame(maxWidth: .infinity, minHeight: 30)
          }
          .buttonStyle(.bordered)
        }
      }

      Button {
        if let hz = parsed { link.tune(toHz: hz); dismiss() }
      } label: {
        Text("GO").font(.system(size: 14, weight: .bold, design: .rounded))
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .tint(.green)
      .disabled(parsed == nil)
    }
    .padding(.horizontal, 6)
    .navigationTitle("Tune")
  }

  private var parsed: Double? {
    guard let v = Double(entry), v > 0 else { return nil }
    return v * unit.multiplier
  }

  private func tap(_ k: String) {
    switch k {
    case "⌫": if !entry.isEmpty { entry.removeLast() }
    case ".": if !entry.contains(".") { entry += entry.isEmpty ? "0." : "." }
    default:  if entry.count < 10 { entry += k }
    }
  }
}
