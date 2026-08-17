import Foundation

/// The colours a session-tag chip is painted with — the pure half of `SessionTagChips`, ported from
/// web's `lib/tagColor` so both ends treat a tag the same way.
///
/// A palette hex is a swatch, not a label: `#FFCC00` as text on the chip's own pale wash measures
/// about 1.4:1, so the tag's *name* read as a smudge while the dot beside it carried the hue
/// perfectly well. Each colour is therefore pushed toward the row's background — black in light,
/// white in dark — but only as far as it must to clear AA against the wash it sits on. A colour that
/// was already legible barely moves; only the pale ones darken visibly. One fixed blend can't do
/// this: the amount yellow needs turns red into near-black, throwing away what the colour is for.
public enum TagChipColor {
    /// sRGB in 0…1, ready for `Color(red:green:blue:)`.
    public struct Components: Equatable, Sendable {
        public let red: Double
        public let green: Double
        public let blue: Double
    }

    /// The chip background's opacity over the row — kept in step with web's `.session-tag-chip`,
    /// including its stronger dark-mode wash (13% over a near-black row is invisible).
    public static func backgroundOpacity(dark: Bool) -> Double { dark ? 0.22 : 0.13 }

    /// The row a chip sits on: `systemBackground` in each appearance. The dark value is the lighter
    /// of the two greys a list can use, so a row that is actually black only gains contrast.
    private static func rowBackground(dark: Bool) -> [Double] {
        dark ? [28, 28, 30] : [255, 255, 255]
    }

    /// WCAG AA for the chip's 11pt text.
    private static let targetContrast: Double = 4.5

    /// `#RRGGBB` → components in 0…1, or nil when malformed (the API takes any hex, not just ours).
    public static func components(hex: String) -> Components? {
        guard let c = channels(hex) else { return nil }
        return Components(red: c[0] / 255, green: c[1] / 255, blue: c[2] / 255)
    }

    /// The tag colour as chip *text*: blended toward the appearance's extreme in 2% steps until it
    /// clears AA against the chip's background. Stepping (rather than solving) keeps the blend as
    /// small as it can be — the loop stops at the first legible shade, so the label stays as close
    /// to the tag's own colour as AA allows. Nil when the hex is malformed, so the caller can fall
    /// back to its own text colour. Rounds each step, because a whole-channel colour is what ships.
    public static func label(hex: String, dark: Bool) -> Components? {
        guard let color = channels(hex) else { return nil }
        let background = over(color, rowBackground(dark: dark), alpha: backgroundOpacity(dark: dark))
        let extreme: [Double] = dark ? [255, 255, 255] : [0, 0, 0]
        var t = 0.0
        while t < 1 {
            let candidate = mix(color, extreme, t)
            if contrast(candidate, background) >= targetContrast {
                return Components(red: candidate[0] / 255, green: candidate[1] / 255, blue: candidate[2] / 255)
            }
            t += 0.02
        }
        return Components(red: extreme[0] / 255, green: extreme[1] / 255, blue: extreme[2] / 255)
    }

    private static func channels(_ hex: String) -> [Double]? {
        let s = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        return [Double((v >> 16) & 0xFF), Double((v >> 8) & 0xFF), Double(v & 0xFF)]
    }

    /// `a` over `b` at `alpha` — how the chip's translucent background actually lands on the row.
    private static func over(_ a: [Double], _ b: [Double], alpha: Double) -> [Double] {
        (0..<3).map { a[$0] * alpha + b[$0] * (1 - alpha) }
    }

    private static func mix(_ a: [Double], _ b: [Double], _ t: Double) -> [Double] {
        (0..<3).map { (a[$0] + (b[$0] - a[$0]) * t).rounded() }
    }

    private static func luminance(_ c: [Double]) -> Double {
        func linear(_ channel: Double) -> Double {
            let v = channel / 255
            return v <= 0.03928 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear(c[0]) + 0.7152 * linear(c[1]) + 0.0722 * linear(c[2])
    }

    private static func contrast(_ a: [Double], _ b: [Double]) -> Double {
        let (hi, lo) = (max(luminance(a), luminance(b)), min(luminance(a), luminance(b)))
        return (hi + 0.05) / (lo + 0.05)
    }
}
