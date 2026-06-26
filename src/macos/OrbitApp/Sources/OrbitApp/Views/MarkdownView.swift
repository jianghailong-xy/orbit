import SwiftUI
import AppKit
import OrbitKit

/// Renders a Markdown string as stacked block elements — headings, paragraphs, lists, fenced
/// code, blockquotes and rules. Block structure comes from OrbitKit's `parseMarkdownBlocks`
/// (unit-tested); inline spans (bold/italic/code/links) stay AttributedString's job via
/// `inlineMarkdown`. Mirrors the web Transcript's `.md` renderer.
///
/// Inherited `.font`/`.foregroundStyle` from the call site propagate to paragraph/list text;
/// headings and code blocks set their own font and override it deliberately.
struct MarkdownView: View {
    let source: String

    var body: some View {
        // Very large strings: skip block + inline Markdown parsing — both run synchronously on
        // the main actor and stall the UI on huge replies. Plain text suffices at that size.
        if source.count > 8000 {
            Text(source)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            let blocks = parseMarkdownBlocks(source)
            VStack(alignment: .leading, spacing: 8) {
                ForEach(blocks.indices, id: \.self) { i in
                    MarkdownBlockView(block: blocks[i])
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

private struct MarkdownBlockView: View {
    let block: MarkdownBlock

    var body: some View {
        switch block {
        case .heading(let level, let text):
            inlineMarkdown(text).font(headingFont(level)).bold()
                .fixedSize(horizontal: false, vertical: true)

        case .paragraph(let text):
            inlineMarkdown(text)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)

        case .list(let items):
            VStack(alignment: .leading, spacing: 3) {
                ForEach(items.indices, id: \.self) { i in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(marker(items[i])).monospacedDigit().foregroundStyle(.secondary)
                        inlineMarkdown(items[i].text)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.leading, CGFloat(items[i].indent) * 16)
                }
            }

        case .code(let language, let code):
            CodeBlockView(language: language, code: code)

        case .table(let table):
            MarkdownTableView(table: table)

        case .quote(let text):
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5).fill(Color.secondary.opacity(0.4)).frame(width: 3)
                inlineMarkdown(text).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

        case .rule:
            Divider()
        }
    }

    private func marker(_ item: MarkdownListItem) -> String {
        item.ordered ? "\(item.number ?? 1)." : "•"
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1:  return .title2
        case 2:  return .title3
        case 3:  return .headline
        default: return .body
        }
    }
}

/// A GFM table rendered as a bordered grid — the desktop analogue of the web `.md table`. The
/// header row is bold over a faint fill; cells carry inline Markdown, honour per-column alignment,
/// and wrap to fit the available width.
private struct MarkdownTableView: View {
    let table: MarkdownTable
    private let border = Color.secondary.opacity(0.3)

    var body: some View {
        Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
            GridRow {
                ForEach(table.headers.indices, id: \.self) { c in
                    cell(table.headers[c], column: c, header: true)
                }
            }
            ForEach(table.rows.indices, id: \.self) { r in
                GridRow {
                    let row = table.rows[r]
                    ForEach(table.headers.indices, id: \.self) { c in
                        cell(c < row.count ? row[c] : "", column: c, header: false)
                    }
                }
            }
        }
        .overlay(Rectangle().stroke(border, lineWidth: 1))
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func cell(_ text: String, column: Int, header: Bool) -> some View {
        inlineMarkdown(text)
            .font(.system(size: 13))
            .fontWeight(header ? .bold : .regular)
            .frame(maxWidth: .infinity, alignment: frameAlignment(column))
            .padding(.vertical, 4)
            .padding(.horizontal, 8)
            .background(header ? Color.secondary.opacity(0.08) : Color.clear)
            .overlay(Rectangle().stroke(border, lineWidth: 0.5))
    }

    private func frameAlignment(_ column: Int) -> Alignment {
        switch column < table.alignments.count ? table.alignments[column] : .none {
        case .center:      return .center
        case .right:       return .trailing
        case .left, .none: return .leading
        }
    }
}

/// A fenced code block: monospaced, horizontally scrollable, with a hover-revealed copy button —
/// the desktop analogue of the web `.md-codeblock`.
private struct CodeBlockView: View {
    let language: String?
    let code: String
    @State private var hovering = false
    @State private var copied = false

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(code)
                .font(.system(.caption, design: .monospaced))
                .textSelection(.enabled)
                .padding(10)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.gray.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))
        .overlay(alignment: .topTrailing) {
            if hovering {
                Button(action: copy) {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.caption)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .padding(6)
            }
        }
        .onHover { hovering = $0 }
    }

    private func copy() {
        NSPasteboard.general.clearContents()
        _ = NSPasteboard.general.setString(code, forType: .string)
        copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
    }
}

/// Inline-only Markdown (bold/italic/code/links/strikethrough), newlines preserved. Used for the
/// text inside a single block; block structure is handled by `MarkdownBlockView`.
func inlineMarkdown(_ s: String) -> Text {
    guard var attributed = try? AttributedString(
        markdown: s,
        options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    ) else {
        return Text(s)
    }
    // SwiftUI renders the `.code` inline intent as monospace but draws no fill, so inline code
    // blends into prose. Mirror the web `.md code` chip by tinting those runs. Ranges are captured
    // before mutating: attribute-only edits leave the text — and thus these indices — stable, and a
    // single Text keeps wrapping/selection intact. SwiftUI can't round or pad a per-run background,
    // so this is a flat tint rather than web's rounded, bordered pill.
    let codeRanges = attributed.runs
        .filter { $0.inlinePresentationIntent?.contains(.code) == true }
        .map(\.range)
    for range in codeRanges {
        attributed[range].backgroundColor = Color.secondary.opacity(0.2)
    }
    return Text(attributed)
}
