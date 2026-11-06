import Foundation

/// Markdown that reads wrongly because CJK runs straight on from it, with no space between, mended in
/// the source before a parser reads it. The parsers stay as they are, so the three clients read one
/// rule (web `lib/cjkMarkdown.ts`, Android `mendCjkMarkdown`). Never in code.
///
/// Bold. CommonMark closes a `**` with punctuation on its inside only if whitespace or punctuation
/// stands on its outside, and an opening one mirrors that: a rule written for languages that put a
/// space after a colon, so a CJK sentence that runs straight on from a bold phrase ending in `：`
/// reaches the reader with its stars. Moving one punctuation mark across the `**` makes it flank and
/// draws the same words: the bold just stops a mark short. Only where CJK stands at the marks, the
/// one place this rule misfires.
///
/// A bare URL. Written as `<https://orbitd.io>` it ends where the address does and draws the same
/// words, where a detector or GFM could take it on through the sentence. An address ends at CJK
/// punctuation, and at a CJK letter unless that letter opens a path segment, as in `/wiki/中文`.
func mendCjkMarkdown(_ markdown: String) -> String {
    guard CjkMarkdown.mightNeedMending(markdown) else { return markdown }
    var open = ""
    let lines = markdown.utf8.split(separator: 0x0A, omittingEmptySubsequences: false)
        .map { String(decoding: $0, as: UTF8.self) }
    return lines.map { line -> String in
        let found = CjkMarkdown.fence?.firstMatch(in: line, range: NSRange(line.startIndex..., in: line))
        let mark = found.flatMap { Range($0.range(at: 1), in: line) }.map { String(line[$0]) }
        let rest = found.flatMap { Range($0.range(at: 2), in: line) }.map { String(line[$0]) } ?? ""
        if !open.isEmpty {
            if let mark, mark.first == open.first, mark.count >= open.count,
               rest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { open = "" }
            return line
        }
        if let mark, !(mark.hasPrefix("`") && rest.contains("`")) {
            open = mark
            return line
        }
        return CjkMarkdown.mightNeedMending(line) ? CjkMarkdown.mendLine(line) : line
    }.joined(separator: "\n")
}

private enum CjkMarkdown {
    static let fence = try? NSRegularExpression(pattern: "^[ \\t>]*(`{3,}|~{3,})(.*?)\\r?\\z")
    static let codeSpan = try? NSRegularExpression(pattern: "(?<!`)(`+)(?!`).*?[^`]\\1(?!`)")
    /// What a mark must not be moved out of, held with the code: a link's or an image's `)`, a
    /// reference link's `]`, a tag's `>`, an entity's `;` and the mark an escape is for.
    static let whole = try? NSRegularExpression(
        pattern: "^[ \\t]*\\[[^\\]\\n]*\\]:[ \\t]*\\S+|!?\\[[^\\]\\n]*\\]\\([^)\\n]*\\)|!?\\[[^\\]\\n]*\\]\\[[^\\]\\n]*\\]|<[A-Za-z/!?][^>\\n]*>|&#?[A-Za-z0-9]+;|\\\\[!-/:-@\\[-`{-~]")
    static let urlMark = "\\x{2010}-\\x{2027}\\x{3000}-\\x{303F}\\x{FE30}-\\x{FE4F}\\x{FF00}-\\x{FFEF}"
    static let cjkLetter = "\\x{2E80}-\\x{2FFF}\\x{3040}-\\x{9FFF}\\x{AC00}-\\x{D7AF}\\x{F900}-\\x{FAFF}\\x{20000}-\\x{3FFFF}"
    static let bareUrl = try? NSRegularExpression(
        pattern: "(?<![A-Za-z])https?://(?:[!-;=?-~]|(?<=/)[\(cjkLetter)][^\\s<\(urlMark)]*)+")
    static let endsAUrl = "^[\(urlMark)\(cjkLetter)]"
    /// What GFM leaves off the end of a bare URL as the sentence's, not the address's.
    static let urlTail = "[?!.,:;*_~'\"]+\\z"
    /// A pair read left to right, so a closing `**` is never taken for the next pair's opening one.
    static let pair = try? NSRegularExpression(
        pattern: "(?<!\\*)\\*\\*(?![\\s*])((?:[^*]|\\*(?!\\*))+?)(?<!\\s)\\*\\*(?!\\*)")
    static let first = "^\\P{M}\\p{M}*"
    static let last = "\\P{M}\\p{M}*\\z"
    /// What a bold phrase opens or ends on in a sentence. Never `/`, `.` or `-`, which stand beside
    /// `**` in what is not bold at all: a path that ends in `/**` and a power like `a**-1`.
    static let sentenceMark = "^(?:[:;,!?()\"'%+#\\$]|(?![\\x00-\\x7F])[\\p{P}\\p{S}])\\p{M}*\\z"
    /// Not whitespace, punctuation or held code. A symbol counts as a word here because cmark-gfm,
    /// the parser behind this package, reads it as one, and the mark moved in front of it flanks for
    /// all of them.
    static let word = "^[^\\s\\p{P}\\x{E000}]"
    static let cjk = "[\\x{2E80}-\\x{9FFF}\\x{AC00}-\\x{D7AF}\\x{F900}-\\x{FAFF}\\x{FE30}-\\x{FE4F}\\x{FF00}-\\x{FFEF}\\x{20000}-\\x{3FFFF}]"

    static func mightNeedMending(_ text: String) -> Bool {
        text.contains("**") || text.contains("://")
    }

    /// The address in `url`: what is left when the sentence's marks and an unmatched `)` come off its end.
    static func address(_ url: String) -> String {
        func withoutTail(_ text: String) -> String {
            text.replacingOccurrences(of: urlTail, with: "", options: .regularExpression)
        }
        func count(_ mark: Character, _ text: String) -> Int { text.filter { $0 == mark }.count }
        var kept = withoutTail(url)
        while kept.hasSuffix(")"), count(")", kept) > count("(", kept) { kept = withoutTail(String(kept.dropLast())) }
        return kept
    }

    static func endingBareUrls(_ text: String, code: inout MarkdownMarks.HeldCode) -> String {
        guard let bareUrl else { return text }
        var ended = ""
        var cursor = text.startIndex
        for match in bareUrl.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            guard let whole = Range(match.range, in: text) else { continue }
            let url = String(text[whole])
            let kept = address(url)
            ended += text[cursor..<whole.lowerBound]
            if has(endsAUrl, String(text[whole.upperBound...])), !kept.hasSuffix("://") {
                ended += code.hold("<\(kept)>") + String(url.dropFirst(kept.count))
            } else {
                ended += url
            }
            cursor = whole.upperBound
        }
        ended += text[cursor...]
        return ended
    }

    static func has(_ pattern: String, _ text: String) -> Bool {
        text.range(of: pattern, options: .regularExpression) != nil
    }

    static func misflanks(_ inside: String, _ outside: String) -> Bool {
        has(sentenceMark, inside) && has(word, outside) && (has(cjk, inside) || has(cjk, outside))
    }

    static func mendLine(_ line: String) -> String {
        guard let pair else { return line }
        var code = MarkdownMarks.HeldCode()
        let held = endingBareUrls(code.hold(whole, group: 0, in: code.hold(codeSpan, group: 0, in: line)), code: &code)
        var mended = ""
        var cursor = held.startIndex
        for match in pair.matches(in: held, range: NSRange(held.startIndex..., in: held)) {
            guard let whole = Range(match.range, in: held),
                  let inner = Range(match.range(at: 1), in: held) else { continue }
            mended += held[cursor..<whole.lowerBound]
            mended += mendPair(String(held[inner]),
                               before: String(held[..<whole.lowerBound]),
                               after: String(held[whole.upperBound...]))
            cursor = whole.upperBound
        }
        mended += held[cursor...]
        return code.putBack(mended)
    }

    /// Ranges rather than character counts: a mark and what follows it can share a grapheme, and only
    /// the mark moves, as it does in the other two clients.
    static func mendPair(_ inner: String, before: String, after: String) -> String {
        let pairAsIs = "**\(inner)**"
        guard let head = inner.range(of: first, options: .regularExpression),
              let tail = inner.range(of: last, options: .regularExpression) else { return pairAsIs }
        func outside(_ pattern: String, _ text: String) -> String {
            text.range(of: pattern, options: .regularExpression).map { String(text[$0]) } ?? ""
        }
        let moveFirst = misflanks(String(inner[head]), outside(last, before))
        let moveLast = misflanks(String(inner[tail]), outside(first, after))
        let from = moveFirst ? head.upperBound : inner.startIndex
        let to = moveLast ? tail.lowerBound : inner.endIndex
        // Nothing left to be bold, or a space now where a mark stood: these marks would not flank either.
        guard from < to else { return pairAsIs }
        let middle = String(inner[from..<to])
        if has("^\\s|\\s\\z", middle) { return pairAsIs }
        return (moveFirst ? String(inner[head]) : "") + "**\(middle)**" + (moveLast ? String(inner[tail]) : "")
    }
}
