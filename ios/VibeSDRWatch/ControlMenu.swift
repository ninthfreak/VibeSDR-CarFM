import SwiftUI
import WatchKit

/// What the Digital Crown does right now.
///
/// The mode is EXPLICIT and PERSISTENT — not a HUD that times out. On a wrist you
/// must never be unsure what the crown is about to do: an accidental turn should
/// be recoverable by knowing, not by guessing.
enum CrownMode: Equatable {
  case tune, zoom

  var glyph: String {
    switch self {
    case .tune: return "dial.medium"
    case .zoom: return "magnifyingglass"
    }
  }
}

/// Crown sensitivity — watchOS's own, exposed as three named levels.
///
/// This maps straight onto SwiftUI's `sensitivity:`, which sets how many detents a
/// rotation produces. Fine is the point: at a 9kHz step, High throws you across half
/// a band on one flick. Because it's the SYSTEM setting, the haptic clicks stay in
/// step with the tuning — one click, one step, whichever level you pick.
enum CrownSens: String, CaseIterable {
  case high, medium, low

  var sensitivity: DigitalCrownRotationalSensitivity {
    switch self {
    case .high:   return .high      // most detents per turn — the twitchiest
    case .medium: return .medium    // the original behaviour
    case .low:    return .low       // turn furthest per step — finest control
    }
  }

  /// Named for what the USER gets, which is the inverse of the detent count: `.low`
  /// sensitivity is the FINEST tuning. Calling it "Low" and leaving it there would
  /// read as "worse".
  var label: String {
    switch self {
    case .high:   return "Coarse"
    case .medium: return "Normal"
    case .low:    return "Fine"
    }
  }

  var detail: String {
    switch self {
    case .high:   return "Fastest — a flick crosses a band"
    case .medium: return "Default"
    case .low:    return "Turn further per step"
    }
  }
}

/// Long-press menu: four large buttons, Control-Centre style.
///
/// Step and Demod open a SCROLLABLE LIST rather than cycling on tap. That matters:
/// tap-to-cycle means walking THROUGH modes you didn't ask for — and landing on
/// wideband FM on the way past is a faceful of static. A picker never makes you
/// pass through anything.
///
/// ── NO VOLUME TILE. Don't add one back. ──────────────────────────────────────
/// There is NO supported way for an app to move the iOS system volume, and we
/// checked every door: AVAudioSession.outputVolume is read-only; MPRemoteCommandCenter
/// has no volume command; AVRCP absolute volume is classic Bluetooth (iOS exposes
/// BLE only, and we'd be trying to control the very phone we run on); AirPlay volume
/// is the receiver's, and an iPhone can't be an AirPlay sink. Every route ends at
/// MPVolumeView's private slider, which is a rejection risk.
///
/// The one thing that DOES work is Apple's own: because we publish Now Playing info,
/// the watch's built-in Now Playing app already drives the phone's volume over its
/// full range, one swipe away. A tile of ours could only ever be the weaker twin of
/// that — an app-local gain, mistakable for the real volume — and on a 40mm screen
/// it isn't worth a third of the menu.
struct ControlMenu: View {
  @EnvironmentObject var link: WatchLink
  @Environment(\.dismiss) private var dismiss

  /// Set by the caller when Volume or Zoom is chosen: the menu closes and the
  /// waterfall returns with the crown in that mode.
  let onPickCrown: (CrownMode) -> Void

  @State private var showModes = false
  @State private var showSteps = false
  @State private var showCrown = false
  @AppStorage("crownSens") private var crownSens = CrownSens.medium.rawValue

  private let cols = Array(repeating: GridItem(.flexible(), spacing: 5), count: 2)

  /// Sits in the clock's band, so the X costs no height.
  private let closeH: CGFloat = 32

  var body: some View {
    Group {
      let screenH = WKInterfaceDevice.current().screenBounds.height
      let h = min(94, max(38, (screenH - closeH - 5 - 22) / 2))

      VStack(spacing: 5) {
        // A visible way OUT. Hiding the nav bar reclaimed the space the pad needed,
        // but it also removed the back chevron — leaving swipe-back as the only
        // exit, and a hidden gesture is not an affordance. This lives in the clock's
        // band, which watchOS reserves whether we use it or not, so it costs no
        // height at all.
        HStack(spacing: 0) {
          Button { dismiss() } label: {
            Image(systemName: "xmark")
              .font(.system(size: 15, weight: .semibold))
              .foregroundStyle(.secondary)
              .frame(width: 36, height: closeH)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          Spacer()
          // The clock's territory — we can't move it, so we don't go there.
          Color.clear.frame(width: 70, height: 1)
        }
        .frame(height: closeH)
        .padding(.leading, 8)

        LazyVGrid(columns: cols, spacing: 5) {
          tile(icon: "magnifyingglass", label: "Zoom", h: h) {
            dismiss(); onPickCrown(.zoom)
          }
          // NAME the control, then show its VALUE. A tile reading just "Fine" (or
          // "9k", or "USB") shows you the setting while leaving you to guess what
          // it's the setting FOR. The name makes the tile a control; the value makes
          // the menu double as a status readout. You need both.
          tile(name: "CROWN", value: crownLabel, h: h) { showCrown = true }
          tile(name: "STEP",  value: stepLabel(link.step), h: h) { showSteps = true }
          tile(name: "DEMOD", value: link.mode.uppercased(), h: h) { showModes = true }
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      .padding(.bottom, 12)
    }
    .padding(.horizontal, 6)
    .ignoresSafeArea(edges: .top)
    .toolbar(.hidden, for: .navigationBar)
    .sheet(isPresented: $showCrown) {
      CrownPicker(current: $crownSens) { showCrown = false; dismiss() }
    }
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

  /// A named setting: the control's name small on top, its current value big below.
  private func tile(name: String, value: String, h: CGFloat,
                    action: @escaping () -> Void) -> some View {
    Button(action: action) {
      VStack(spacing: 1) {
        Text(name)
          .font(.system(size: max(9, h * 0.13), weight: .semibold, design: .rounded))
          .foregroundStyle(.secondary)
          .lineLimit(1)
        Text(value)
          .font(.system(size: h * 0.24, weight: .semibold, design: .rounded))
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

  /// An ACTION tile (it arms the crown, it isn't a setting) — icon over label.
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

  private var crownLabel: String {
    CrownSens(rawValue: crownSens)?.label ?? "Normal"
  }

  private func stepLabel(_ hz: Double) -> String {
    if hz <= 0 { return "—" }
    if hz >= 1_000 {
      let k = hz / 1_000
      return k == k.rounded() ? String(format: "%.0fk", k) : String(format: "%.1fk", k)
    }
    return String(format: "%.0fHz", hz)
  }
}

/// The crown-sensitivity picker. A list, like Step and Demod — you tap the thing you
/// want, which is the right gesture on a surface your finger is already covering.
struct CrownPicker: View {
  @Binding var current: String
  let onPick: () -> Void

  var body: some View {
    List {
      ForEach(CrownSens.allCases, id: \.rawValue) { s in
        Button {
          current = s.rawValue
          onPick()
        } label: {
          HStack {
            VStack(alignment: .leading, spacing: 1) {
              Text(s.label)
                .font(.system(size: 16, weight: .semibold, design: .rounded))
              Text(s.detail)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            }
            Spacer()
            if current == s.rawValue {
              Image(systemName: "checkmark").foregroundStyle(.green)
            }
          }
        }
        .buttonStyle(.plain)
      }
    }
    .navigationTitle("Crown")
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
