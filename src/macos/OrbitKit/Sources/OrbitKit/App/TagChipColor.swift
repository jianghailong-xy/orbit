import Foundation

/// A session tag's colour as components — the tag's hex read once, for the dot a tag is drawn as
/// (the picker, the tag-grouped list's headers) and the machine colours that reuse the palette.
///
/// It used to paint the named chips the session rows carried as well, with a label colour pushed
/// toward AA on the chip's own wash. The rows draw no tags since the owner's 2026-10-22 decision
/// (docs/mocks/session-recap-display/04-decided), and that half went with them.
public enum TagChipColor {
    /// sRGB in 0…1, ready for `Color(red:green:blue:)`.
    public struct Components: Equatable, Sendable {
        public let red: Double
        public let green: Double
        public let blue: Double
    }

    /// `#RRGGBB` → components in 0…1, or nil when malformed (the API takes any hex, not just ours).
    public static func components(hex: String) -> Components? {
        let s = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        return Components(red: Double((v >> 16) & 0xFF) / 255,
                          green: Double((v >> 8) & 0xFF) / 255,
                          blue: Double(v & 0xFF) / 255)
    }
}
