import Foundation

/// What the plain readings of a Markdown field share: the session row's line
/// (`SessionLine.plainPreview`) and the cards' text (`OwnerConfirmations.plainText`). The native half
/// of the web `lib/markdownText.ts`.
enum MarkdownMarks {
    /// Inline code, its text the second group: a span closes on a run of backticks as long as the
    /// one that opened it.
    static let inlineCode = try? NSRegularExpression(pattern: "(?<!`)(`+)(?!`)([\\s\\S]*?[^`])\\1(?!`)")

    /// A fenced block, its code the second group. Cut off before its closing fence, as a stored
    /// excerpt can be, it runs to the end of the text.
    static let fencedCode = try? NSRegularExpression(
        pattern: "(?m)^[ \\t]*(`{3,}|~{3,})[^`\\n]*\\n?([\\s\\S]*?)\\r?\\n?(?:^[ \\t]*\\1[`~]*[ \\t]*$|\\z)")

    /// Keeps code out of the rules that read marks: `hold` leaves a token that no rule matches in
    /// its place and `putBack` swaps the code in again, so a star or a bracket in it stays what it is.
    struct HeldCode {
        private var spans: [String] = []

        /// One pass over the text, so a span is never read out of what was already held.
        mutating func hold(_ pattern: NSRegularExpression?, group: Int = 2, in text: String) -> String {
            guard let pattern else { return text }
            var held = ""
            var cursor = text.startIndex
            for match in pattern.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                guard let whole = Range(match.range, in: text),
                      let code = Range(match.range(at: group), in: text) else { continue }
                held += text[cursor..<whole.lowerBound]
                held += "\u{E000}\(spans.count)\u{E000}"
                spans.append(String(text[code]))
                cursor = whole.upperBound
            }
            held += text[cursor...]
            return held
        }

        func putBack(_ text: String) -> String {
            var restored = text
            for (index, span) in spans.enumerated() {
                restored = restored.replacingOccurrences(of: "\u{E000}\(index)\u{E000}", with: span)
            }
            return restored
        }
    }

    /// Emphasis marks off, and only those Markdown would draw as marks: the `_` and `*` of
    /// `tea_user_*_cnch` and the `*` of `2 * 3 * 4` are words someone wrote. \p{L}\p{N} rather than
    /// \w because the boundary has to hold for CJK as well as ASCII.
    static func withoutEmphasis(_ text: String) -> String {
        var s = text
        // Underscores before stars: whether a `_` is a mark depends on what stands beside it as written.
        s = s.replacingOccurrences(of: "(?<![\\p{L}\\p{N}_])(_{1,3})(?=[^\\s_])(.*?[^\\s_])\\1(?![\\p{L}\\p{N}_])", with: "$2",
                                   options: .regularExpression)                                     // _em_, never snake_case
        s = s.replacingOccurrences(of: "(\\*{2,3})(?=[^\\s*])(.*?[^\\s*])\\1", with: "$2",
                                   options: .regularExpression)                                     // **bold**, ***both***
        s = s.replacingOccurrences(of: "\\*(?=[^\\s*])(.*?[^\\s*])\\*", with: "$1",
                                   options: .regularExpression)                                     // *italic*
        s = s.replacingOccurrences(of: "~~(?=[^\\s~])(.*?[^\\s~])~~", with: "$1",
                                   options: .regularExpression)                                     // ~~struck~~
        return s
    }
}
