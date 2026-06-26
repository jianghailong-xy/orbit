import Foundation

// Block-level Markdown splitter. SwiftUI's `AttributedString(markdown:)` only interprets *inline*
// spans (bold/italic/code/links); headings, lists, code fences, blockquotes and rules render as
// literal text. This UI-free parser folds a Markdown string into structural blocks so the view
// layer can render each one natively, while inline spans within a block stay AttributedString's
// job. Mirrors the web Transcript's `.md` renderer. Pragmatic, not full CommonMark.

public struct MarkdownListItem: Equatable, Sendable {
    public var indent: Int      // nesting depth, 0 = outermost
    public var ordered: Bool
    public var number: Int?     // source number for ordered items (nil for bullets)
    public var text: String     // inline-Markdown source of the item

    public init(indent: Int, ordered: Bool, number: Int?, text: String) {
        self.indent = indent
        self.ordered = ordered
        self.number = number
        self.text = text
    }
}

public enum MarkdownBlock: Equatable, Sendable {
    case heading(level: Int, text: String)   // text = inline-Markdown source
    case paragraph(text: String)             // soft newlines preserved
    case list(items: [MarkdownListItem])
    case code(language: String?, code: String)
    case quote(text: String)
    case rule
}

/// Split a Markdown string into renderable blocks. Consecutive plain lines fold into one
/// paragraph (soft newlines kept); consecutive list lines fold into one list with per-item
/// nesting depth derived from leading indentation.
public func parseMarkdownBlocks(_ source: String) -> [MarkdownBlock] {
    let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
    var blocks: [MarkdownBlock] = []
    var para: [String] = []
    var i = 0

    func flushPara() {
        guard !para.isEmpty else { return }
        blocks.append(.paragraph(text: para.joined(separator: "\n")))
        para.removeAll()
    }

    while i < lines.count {
        let line = lines[i]
        let trimmed = line.trimmingCharacters(in: .whitespaces)

        // Fenced code block — verbatim until a closing fence of the same char (or EOF).
        if let fence = codeFenceInfo(trimmed) {
            flushPara()
            i += 1
            var code: [String] = []
            while i < lines.count {
                let t = lines[i].trimmingCharacters(in: .whitespaces)
                if t.count >= 3 && t.allSatisfy({ $0 == fence.char }) { i += 1; break }
                code.append(lines[i])
                i += 1
            }
            blocks.append(.code(language: fence.lang, code: code.joined(separator: "\n")))
            continue
        }

        if trimmed.isEmpty { flushPara(); i += 1; continue }

        if let h = headingInfo(trimmed) {
            flushPara(); blocks.append(.heading(level: h.level, text: h.text)); i += 1; continue
        }

        if isThematicBreak(trimmed) { flushPara(); blocks.append(.rule); i += 1; continue }

        if trimmed.hasPrefix(">") {
            flushPara()
            var quoted: [String] = []
            while i < lines.count {
                let t = lines[i].trimmingCharacters(in: .whitespaces)
                guard t.hasPrefix(">") else { break }
                var s = String(t.dropFirst())
                if s.hasPrefix(" ") { s.removeFirst() }
                quoted.append(s)
                i += 1
            }
            blocks.append(.quote(text: quoted.joined(separator: "\n")))
            continue
        }

        if listMarker(line) != nil {
            flushPara()
            var items: [MarkdownListItem] = []
            var levels: [Int] = []   // stack of leading-space widths, ascending → nesting depth
            while i < lines.count, let m = listMarker(lines[i]) {
                while let last = levels.last, last > m.leadingSpaces { levels.removeLast() }
                if levels.last == nil || levels.last! < m.leadingSpaces { levels.append(m.leadingSpaces) }
                items.append(MarkdownListItem(indent: levels.count - 1,
                                              ordered: m.ordered, number: m.number, text: m.text))
                i += 1
            }
            blocks.append(.list(items: items))
            continue
        }

        para.append(line)
        i += 1
    }
    flushPara()
    return blocks
}

// MARK: - Line classifiers

private func codeFenceInfo(_ trimmed: String) -> (char: Character, lang: String?)? {
    for marker in ["```", "~~~"] {
        if trimmed.hasPrefix(marker) {
            let info = trimmed.dropFirst(marker.count).trimmingCharacters(in: .whitespaces)
            return (marker.first!, info.isEmpty ? nil : info)
        }
    }
    return nil
}

private func headingInfo(_ trimmed: String) -> (level: Int, text: String)? {
    guard trimmed.hasPrefix("#") else { return nil }
    let level = trimmed.prefix(while: { $0 == "#" }).count
    guard (1...6).contains(level) else { return nil }
    let after = trimmed.dropFirst(level)
    guard let sp = after.first, sp == " " || sp == "\t" else { return nil }   // ATX requires a space
    return (level, after.trimmingCharacters(in: .whitespaces))
}

private func isThematicBreak(_ trimmed: String) -> Bool {
    let stripped = trimmed.replacingOccurrences(of: " ", with: "")
    guard stripped.count >= 3 else { return false }
    let chars = Set(stripped)
    return chars == ["-"] || chars == ["*"] || chars == ["_"]
}

/// Match a bullet (`-`/`*`/`+`) or ordered (`1.`/`1)`) list line. A marker char must be followed
/// by whitespace — so `**bold**` and `---` are not mistaken for bullets. Tabs count as 4 columns.
private func listMarker(_ line: String) -> (leadingSpaces: Int, ordered: Bool, number: Int?, text: String)? {
    var idx = line.startIndex
    var spaces = 0
    while idx < line.endIndex, line[idx] == " " || line[idx] == "\t" {
        spaces += line[idx] == "\t" ? 4 : 1
        idx = line.index(after: idx)
    }
    let rest = line[idx...]
    guard let first = rest.first else { return nil }

    if first == "-" || first == "*" || first == "+" {
        let after = rest.dropFirst()
        guard let sp = after.first, sp == " " || sp == "\t" else { return nil }
        return (spaces, false, nil, String(after.drop(while: { $0 == " " || $0 == "\t" })))
    }

    let digits = rest.prefix(while: { $0.isNumber })
    if !digits.isEmpty {
        let afterDigits = rest.dropFirst(digits.count)
        guard let delim = afterDigits.first, delim == "." || delim == ")" else { return nil }
        let afterDelim = afterDigits.dropFirst()
        guard let sp = afterDelim.first, sp == " " || sp == "\t" else { return nil }
        return (spaces, true, Int(digits), String(afterDelim.drop(while: { $0 == " " || $0 == "\t" })))
    }
    return nil
}
