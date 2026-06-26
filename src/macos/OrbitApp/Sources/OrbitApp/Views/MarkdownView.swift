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
        let blocks = parseMarkdownBlocks(source)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(blocks.indices, id: \.self) { i in
                MarkdownBlockView(block: blocks[i])
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
    if let attributed = try? AttributedString(
        markdown: s,
        options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    ) {
        return Text(attributed)
    }
    return Text(s)
}
