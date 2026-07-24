import Foundation

/// URL detection for verbatim prose — the user bubble. It renders literally on every platform (not
/// Markdown-parsed, so a typed '#'/'*' survives), which also means bare links can't come from a
/// Markdown `run.link`. We overlay `.link` attributes on the detected URLs instead, so a pasted link
/// is tappable while the rest of the text stays untouched. The assistant turn already autolinks via
/// its Markdown, so this is only used where the text is plain (iOS: `SelectableText`; macOS: `Text`).
enum LinkDetection {
    // One shared detector: NSDataDetector is costly to build and safe to reuse for detection.
    private static let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    /// URL matches in `text` as UTF-16 (`NSString`) ranges, so they map straight onto an
    /// `NSAttributedString`. Empty when there are none (or the detector failed to build).
    static func matches(in text: String) -> [(range: NSRange, url: URL)] {
        guard let detector, !text.isEmpty else { return [] }
        let full = NSRange(location: 0, length: (text as NSString).length)
        return detector.matches(in: text, range: full).compactMap { m in
            m.url.map { (m.range, $0) }
        }
    }

    /// `text` as an `AttributedString` with `.link` overlaid on detected URLs — for the macOS user
    /// bubble's `Text`, which then draws them tinted and opens them on click. A link-free message
    /// yields a plain `AttributedString`, so it renders exactly as before.
    static func attributed(_ text: String) -> AttributedString {
        let mut = NSMutableAttributedString(string: text)
        for (range, url) in matches(in: text) {
            mut.addAttribute(.link, value: url, range: range)
        }
        return AttributedString(mut)
    }
}
