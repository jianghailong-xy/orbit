import Foundation

/// URL detection for prose the Markdown parse leaves plain. CommonMark only linkifies the explicit
/// `[text](url)` / `<url>` forms, so a pasted bare link would render as dead text; web's remark-gfm
/// autolinks those literals, and this is the iOS/macOS half of that parity. Applied to every
/// inline-Markdown parse (see `inlineMarkdown` / `inlineMarkdownAttributed`), so it covers the user
/// bubble — where pasted links are the common case — and the assistant reply alike.
enum LinkDetection {
    // One shared detector: NSDataDetector is costly to build and safe to reuse for detection.
    private static let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    /// URL matches in `text` as UTF-16 (`NSString`) ranges. Empty when there are none (or the
    /// detector failed to build).
    ///
    /// Restricted to explicit `http(s)://` links: NSDataDetector also resolves bare `www.` hosts and
    /// email addresses, and turning a typed address into a link nobody asked for is the kind of
    /// over-reach the verbatim bubble never did.
    static func matches(in text: String) -> [(range: NSRange, url: URL)] {
        guard let detector, !text.isEmpty else { return [] }
        let ns = text as NSString
        let full = NSRange(location: 0, length: ns.length)
        return detector.matches(in: text, range: full).compactMap { m in
            guard let url = m.url else { return nil }
            let matched = ns.substring(with: m.range).lowercased()
            guard matched.hasPrefix("http://") || matched.hasPrefix("https://") else { return nil }
            return (m.range, url)
        }
    }

    /// `attributed` with `.link` overlaid on the bare URLs in its text, so they draw tinted and open
    /// on tap/click. Runs that already carry a link are skipped — a real Markdown link whose *label*
    /// is a URL (`[https://a](https://b)`) must keep pointing at its own href. Text without a bare URL
    /// is returned untouched, so the common case costs one detector pass and no copy.
    static func linkifying(_ attributed: AttributedString) -> AttributedString {
        let plain = String(attributed.characters)
        let hits = matches(in: plain)
        guard !hits.isEmpty else { return attributed }
        var out = attributed
        for (nsRange, url) in hits {
            guard let found = Range(nsRange, in: plain) else { continue }
            // NSRange (UTF-16) → character offsets, which is what AttributedString indexes by. The
            // offsets stay valid across the loop: overlaying an attribute never changes the text.
            let lower = plain.distance(from: plain.startIndex, to: found.lowerBound)
            let upper = plain.distance(from: plain.startIndex, to: found.upperBound)
            let start = out.index(out.startIndex, offsetByCharacters: lower)
            let end = out.index(out.startIndex, offsetByCharacters: upper)
            guard out[start..<end].runs.allSatisfy({ $0.link == nil }) else { continue }
            out[start..<end].link = url
        }
        return out
    }
}
