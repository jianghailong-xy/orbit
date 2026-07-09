import Foundation
import Markdown

// Block-level Markdown model for the transcript renderer. We parse with apple/swift-markdown
// (a spec-compliant CommonMark + GFM parser, cmark-gfm under the hood) and fold its AST into a
// small set of structural blocks the SwiftUI layer renders natively. Inline spans within a block
// (bold/italic/code/links) stay AttributedString's job: each block carries its inline-Markdown
// *source* string, reconstructed from the AST so SwiftUI's inline parser can re-interpret it.
// Mirrors the web Transcript's `.md` renderer (react-markdown + remark-gfm), tables included.

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

/// A GFM table: a header row, zero or more body rows, and a per-column alignment. Cell strings are
/// inline-Markdown source (so a cell can hold bold/links/emoji), rendered by the view layer.
public struct MarkdownTable: Equatable, Sendable {
    public enum Alignment: Equatable, Sendable { case none, left, center, right }
    public var headers: [String]
    public var rows: [[String]]
    public var alignments: [Alignment]   // one per column, count == headers.count

    public init(headers: [String], rows: [[String]], alignments: [Alignment]) {
        self.headers = headers
        self.rows = rows
        self.alignments = alignments
    }
}

public enum MarkdownBlock: Equatable, Sendable {
    case heading(level: Int, text: String)   // text = inline-Markdown source
    case paragraph(text: String)             // soft newlines preserved
    case list(items: [MarkdownListItem])
    case code(language: String?, code: String)
    case quote(text: String)
    case table(MarkdownTable)
    case image(source: String, alt: String)   // source is usually `orbit-attachment:<id>`; alt text
    case rule
}

/// Parse a Markdown string into renderable blocks via swift-markdown's GFM parser.
public func parseMarkdownBlocks(_ source: String) -> [MarkdownBlock] {
    let document = Document(parsing: source)
    return document.children.flatMap(blocks(from:))
}

/// Split a *streaming* Markdown string into the leading portion that's safe to render as Markdown
/// now and the still-growing tail to keep as plain text until it completes. A block completes at a
/// blank line, so everything up to the last top-level blank line is `stable`; the unfinished block
/// after it stays in `tail`. Text inside an unclosed ``` / ~~~ fence is never complete, so an open
/// fence keeps its own lines in `tail` too (otherwise a half-written fence would render as a code
/// block, then reflow). `stable + tail == source` exactly, so the two halves render adjacently with
/// no gap or dropped character. See `StreamingProse` (the streaming counterpart of `MarkdownView`).
public func splitStreamingMarkdown(_ source: String) -> (stable: Substring, tail: Substring) {
    var inFence = false
    var cut = source.startIndex           // end of the last completed block
    var lineStart = source.startIndex
    while lineStart < source.endIndex {
        let lineEnd = source[lineStart...].firstIndex(of: "\n") ?? source.endIndex
        let line = source[lineStart..<lineEnd]
        let afterLine = lineEnd < source.endIndex ? source.index(after: lineEnd) : source.endIndex
        if isFenceMarker(line) {
            inFence.toggle()
        } else if !inFence && isBlankLine(line) {
            // A top-level blank line closes the block(s) before it: everything up to and including
            // this line's trailing newline is stable.
            cut = afterLine
        }
        lineStart = afterLine
    }
    return (source[..<cut], source[cut...])
}

private func isBlankLine(_ line: Substring) -> Bool {
    line.allSatisfy { $0 == " " || $0 == "\t" }
}

private func isFenceMarker(_ line: Substring) -> Bool {
    let body = line.drop { $0 == " " || $0 == "\t" }
    return body.hasPrefix("```") || body.hasPrefix("~~~")
}

// MARK: - AST → block mapping

/// Most block markup maps to a single block; a paragraph is the exception — one that embeds image(s)
/// fans out into interleaved paragraph/image blocks (see `paragraphBlocks`).
private func blocks(from markup: Markup) -> [MarkdownBlock] {
    if let paragraph = markup as? Paragraph {
        return paragraphBlocks(paragraph)
    }
    return block(from: markup).map { [$0] } ?? []
}

private func block(from markup: Markup) -> MarkdownBlock? {
    switch markup {
    case let heading as Heading:
        return .heading(level: heading.level, text: inlineText(of: heading))

    case let code as CodeBlock:
        let language = code.language.flatMap { $0.isEmpty ? nil : $0 }
        return .code(language: language, code: trimTrailingNewline(code.code))

    case let quote as BlockQuote:
        return .quote(text: quoteText(of: quote))

    case is ThematicBreak:
        return .rule

    case let list as ListItemContainer:   // UnorderedList or OrderedList
        var items: [MarkdownListItem] = []
        flatten(list, depth: 0, into: &items)
        return .list(items: items)

    case let table as Table:
        return .table(makeTable(table))

    default:
        // HTML blocks, directives, etc. — fall back to their formatted source as a paragraph.
        let text = trimTrailingNewline(markup.format())
        return text.isEmpty ? nil : .paragraph(text: text)
    }
}

/// A paragraph becomes a single `.paragraph` — unless it embeds images. The runner rewrites an
/// uploaded attachment to `![alt](orbit-attachment:<id>)` and models emit screenshots the same way,
/// but the view's inline parser (`AttributedString(markdown:)`) drops images entirely, so they'd never
/// show. Split the paragraph instead: each maximal run of non-image inlines stays a `.paragraph`, and
/// each image becomes its own `.image` block the view layer fetches + displays. Mirrors web's
/// react-markdown, where `img` is a first-class node.
private func paragraphBlocks(_ paragraph: Paragraph) -> [MarkdownBlock] {
    let inlines = paragraph.children.compactMap { $0 as? InlineMarkup }
    guard inlines.contains(where: { $0 is Image }) else {
        return [.paragraph(text: inlineText(of: paragraph))]
    }
    var result: [MarkdownBlock] = []
    var run: [InlineMarkup] = []   // non-image inlines awaiting a flush into a paragraph block
    func flushText() {
        let text = trimTrailingNewline(Paragraph(run).format())
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { result.append(.paragraph(text: text)) }
        run.removeAll()
    }
    for inline in inlines {
        if let image = inline as? Image {
            flushText()
            if let source = image.source, !source.isEmpty {
                result.append(.image(source: source, alt: image.plainText))
            }
        } else {
            run.append(inline)
        }
    }
    flushText()
    return result
}

/// Flatten a (possibly nested) list into items tagged with their nesting depth, mirroring the
/// hand-rolled parser's `indent` model. Ordered numbering counts up from the list's start index.
private func flatten(_ list: ListItemContainer, depth: Int, into items: inout [MarkdownListItem]) {
    let ordered = list is OrderedList
    var number: Int? = (list as? OrderedList).map { Int($0.startIndex) }

    for item in list.listItems {
        var text = ""
        var assignedText = false
        var sublists: [ListItemContainer] = []

        for child in item.children {
            if let sublist = child as? ListItemContainer {
                sublists.append(sublist)
            } else if !assignedText {
                text = (child as? Paragraph).map(inlineText(of:)) ?? trimTrailingNewline(child.format())
                assignedText = true
            }
        }

        items.append(MarkdownListItem(indent: depth, ordered: ordered, number: number, text: text))
        if let n = number { number = n + 1 }
        for sublist in sublists { flatten(sublist, depth: depth + 1, into: &items) }
    }
}

private func makeTable(_ table: Table) -> MarkdownTable {
    let headers = Array(table.head.cells.map(inlineText(of:)))
    let rows = Array(table.body.rows.map { row in Array(row.cells.map(inlineText(of:))) })
    let raw = table.columnAlignments
    let alignments: [MarkdownTable.Alignment] = headers.indices.map { i -> MarkdownTable.Alignment in
        let column: Table.ColumnAlignment? = i < raw.count ? raw[i] : nil
        switch column {
        case .some(.left):   return .left
        case .some(.center): return .center
        case .some(.right):  return .right
        case .none:          return .none
        }
    }
    return MarkdownTable(headers: headers, rows: rows, alignments: alignments)
}

// MARK: - Inline reconstruction

/// Reconstruct a block's inline-Markdown source from its inline children. The children are
/// re-parented into a fresh root paragraph before formatting: swift-markdown's formatter is
/// context-sensitive (a child formatted in place re-applies its block ancestors' decoration —
/// list indentation, blockquote `>` prefixes), and detaching strips that so we get just the
/// inline source. Round-trip-correct and multibyte-safe; soft breaks stay as `\n`.
private func inlineText(of markup: Markup) -> String {
    let inlines = markup.children.compactMap { $0 as? InlineMarkup }
    return trimTrailingNewline(Paragraph(inlines).format())
}

/// A blockquote's inline source: each child paragraph's inline text, joined by newlines.
private func quoteText(of quote: BlockQuote) -> String {
    quote.children.map { child in
        (child as? Paragraph).map(inlineText(of:)) ?? trimTrailingNewline(child.format())
    }.joined(separator: "\n")
}

private func trimTrailingNewline(_ s: String) -> String {
    s.hasSuffix("\n") ? String(s.dropLast()) : s
}
