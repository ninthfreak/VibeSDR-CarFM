import SwiftUI
import WatchKit

/// What the Digital Crown does right now.
///
/// The mode is EXPLICIT and PERSISTENT — not a HUD that times out. On a wrist you
/// must never be unsure what the crown is about to do: an accidental turn should
/// be recoverable by knowing, not by guessing.
enum CrownMode: Equatable {
  case tune, volume, zoom

  var glyph: String {
    switch self {
    case .tune:   return "dial.medium"
    case .volume: return "speaker.wave.2.fill"
    case .zoom:   return "magnifyingglass"
    }
  }
}

/// Long-press menu: four large buttons, Control-Centre style.
///
/// Step and Demod open a SCROLLABLE LIST rather than cycling on tap. That matters:
/// tap-to-cycle means walking THROUGH modes you didn't ask for — and landing on
/// wideband FM on the way past is a faceful of static. A picker never makes you
/// pass through anything.
struct ControlMenu: View {
  @EnvironmentObject var link: WatchLink
  @Environment(\.dismiss) private var dismiss

  /// Set by the caller when Volume or Zoom is chosen: the menu closes and the
  /// waterfall returns with the crown in that mode.
  let onPickCrown: (CrownMode) -> Void

  @State private var showModes = false
  @State private var showSteps = false

  private let cols = Array(repeating: GridItem(.flexible(), spacing: 5), count: 2)

  var body: some View {
    GeometryReader { _ in
      let screenH = WKInterfaceDevice.current().screenBounds.height
      let h = min(64, max(38, (screenH - 26 - 5) / 2))

      VStack(spacing: 5) {
        LazyVGrid(columns: cols, spacing: 5) {
          tile(icon: "speaker.wave.2.fill", label: "Volume", h: h) {
            dismiss(); onPickCrown(.volume)
          }
          tile(icon: "magnifyingglass", label: "Zoom", h: h) {
            dismiss(); onPickCrown(.zoom)
          }
          // Each shows its CURRENT value, so the menu doubles as a status readout.
          tile(icon: nil, label: stepLabel(link.step), h: h) { showSteps = true }
          tile(icon: nil, label: link.mode.uppercased(), h: h) { showModes = true }
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
    }
    .padding(.horizontal, 6)
    .toolbar(.hidden, for: .navigationBar)
    .sheet(isPresented: $showModes) {
      PickerList(title: "Demod", items: Self.modes, current: link.mode) { m in
        link.setMode(m); showModes = false; dismiss()
      }
    }
    .sheet(isPresented: $showSteps) {
      PickerList(title: "Step",
                 items: Self.steps.map(stepLabel),
                 current: stepLabel(link.step)) { label in
        if let hz = Self.steps.first(where: { stepLabel($0) == label }) {
          link.setStep(hz)
        }
        showSteps = false; dismiss()
      }
    }
  }

  private func tile(icon: String?, label: String, h: CGFloat,
                    action: @escaping () -> Void) -> some View {
    Button(action: action) {
      VStack(spacing: 2) {
        if let icon {
          Image(systemName: icon).font(.system(size: h * 0.30, weight: .semibold))
        }
        Text(label)
          .font(.system(size: icon == nil ? h * 0.26 : h * 0.16,
                        weight: .semibold, design: .rounded))
          .lineLimit(1)
          .minimumScaleFactor(0.6)
      }
      .foregroundStyle(.white)
      .frame(maxWidth: .infinity)
      .frame(height: h)
      .background(RoundedRectangle(cornerRadius: h * 0.30).fill(.white.opacity(0.16)))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
  }

  // Mirrors sdrTypes.ts. Kept in the order the phone lists them.
  static let modes = ["usb", "lsb", "am", "sam", "fm", "nfm", "cwu", "cwl"]
  static let steps: [Double] = [10, 100, 500, 1_000, 9_000, 10_000, 12_500, 25_000, 100_000]

  private func stepLabel(_ hz: Double) -> String {
    if hz <= 0 { return "—" }
    if hz >= 1_000 {
      let k = hz / 1_000
      return k == k.rounded() ? String(format: "%.0fk", k) : String(format: "%.1fk", k)
    }
    return String(format: "%.0fHz", hz)
  }
}

/// A plain scrollable list. Deliberately dull: you tap the thing you want and it
/// happens, with no chance of passing through anything you didn't.
struct PickerList: View {
  let title: String
  let items: [String]
  let current: String
  let onPick: (String) -> Void

  var body: some View {
    List {
      ForEach(items, id: \.self) { item in
        Button {
          onPick(item)
        } label: {
          HStack {
            Text(item.uppercased())
              .font(.system(size: 16, weight: .semibold, design: .rounded))
            Spacer()
            if item.lowercased() == current.lowercased() {
              Image(systemName: "checkmark").foregroundStyle(.green)
            }
          }
        }
        .buttonStyle(.plain)
      }
    }
    .navigationTitle(title)
  }
}
