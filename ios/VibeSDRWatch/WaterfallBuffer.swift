import Foundation
import CoreGraphics

/// Scrolling RGBA pixel ring for the wrist waterfall.
///
/// Rows arrive as 128 intensity bytes; we colour-map them through the phone's
/// own LUT and blit into a fixed RGBA buffer, newest row at the bottom. One
/// CGImage per redraw beats ~11k Canvas rects (128 cols x 88 rows) by a mile.
///
/// Scrolling is a single memmove of the whole buffer up one row. At 128x88 that
/// is ~45KB/frame at 10fps — trivial, and it keeps the newest row a straight
/// write rather than an index-chasing ring the drawing code has to unwrap.
final class WaterfallBuffer {
  static let width  = 128
  static let height = 88

  /// 0..1 blend of the new row into the previous one. Mirrors the phone's
  /// temporal smoothing so the wrist has the same "feel", not a harder image.
  var smoothing: Double = 0.0

  private var pixels: [UInt8]
  private var lastRow: [UInt8]
  private var lut: [UInt8]
  private(set) var generation = 0

  init() {
    pixels  = [UInt8](repeating: 0, count: Self.width * Self.height * 4)
    lastRow = [UInt8](repeating: 0, count: Self.width)
    // Greyscale until the phone sends its palette, so a dropped settings
    // message shows a working waterfall rather than a black rectangle.
    var l = [UInt8](repeating: 255, count: 256 * 4)
    for i in 0..<256 {
      l[i * 4 + 0] = UInt8(i)
      l[i * 4 + 1] = UInt8(i)
      l[i * 4 + 2] = UInt8(i)
    }
    lut = l
  }

  func setLUT(_ newLUT: [UInt8]) {
    lut = newLUT
    generation += 1
  }

  func push(row: [UInt8]) {
    guard row.count == Self.width else { return }

    var src = row
    if smoothing > 0 {
      let a = smoothing
      for i in 0..<Self.width {
        src[i] = UInt8(clamping: Int(Double(lastRow[i]) * a + Double(row[i]) * (1 - a)))
      }
    }
    lastRow = src

    let stride = Self.width * 4
    // Scroll up one row, then paint the newest row along the bottom edge.
    pixels.withUnsafeMutableBytes { raw in
      guard let base = raw.baseAddress else { return }
      memmove(base, base.advanced(by: stride), stride * (Self.height - 1))
    }

    let bottom = stride * (Self.height - 1)
    for x in 0..<Self.width {
      let l = Int(src[x]) * 4
      let p = bottom + x * 4
      pixels[p + 0] = lut[l + 0]
      pixels[p + 1] = lut[l + 1]
      pixels[p + 2] = lut[l + 2]
      pixels[p + 3] = 255
    }
    generation += 1
  }

  func makeImage() -> CGImage? {
    let stride = Self.width * 4
    guard let provider = CGDataProvider(data: Data(pixels) as CFData) else { return nil }
    return CGImage(
      width: Self.width,
      height: Self.height,
      bitsPerComponent: 8,
      bitsPerPixel: 32,
      bytesPerRow: stride,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
      provider: provider,
      decode: nil,
      shouldInterpolate: false,
      intent: .defaultIntent
    )
  }
}
