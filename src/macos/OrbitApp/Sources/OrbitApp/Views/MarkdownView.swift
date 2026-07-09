import SwiftUI
import Foundation
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
    // iOS selectable-leaf styling (see SelectableText): the base role + ink the prose blocks render
    // with, so the same shared renderer reads as the assistant reply here and as the muted "aside" in
    // the thinking block. macOS ignores both — it keeps inheriting `.font`/`.foregroundStyle` from the
    // call site. Defaults are the assistant reply.
    var base: ProseRole = .body
    var ink: ProseInk = .transcript

    var body: some View {
        // No length cap (capping only dropped formatting on long messages — the historic freezes
        // were scroll mechanics, not parsing). But do NOT parse unconditionally either: a row's
        // body re-evaluates whenever anything it observes republishes (~5×/sec during a streaming
        // turn, plus whole-tree diffs), and `parseMarkdownBlocks` builds a full swift-markdown AST
        // per call — on iPhone that repeated re-parse was a top battery/heat hotspot. The cache
        // keys on the exact source string, so re-evaluations of unchanged text cost a hash lookup.
        // Streaming rows don't reach here at all — they render plain until finalized (see
        // AssistantBubbleView / ThinkingView), so the cache holds one entry per finalized text.
        let blocks = cachedMarkdownBlocks(source)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(blocks.indices, id: \.self) { i in
                MarkdownBlockView(block: blocks[i], base: base, ink: ink)
            }
        }
        // Opens the lines up toward web's `.md { line-height: 1.6 }` (SF's default leading is a
        // cramped ~1.17). Platform-forked in ProseLayout: iOS prose is 17pt and CJK wants more
        // leading than Latin, so it runs looser than macOS's 14pt. Propagates to all prose Text;
        // code blocks tighten it back down to stay dense.
        .lineSpacing(ProseLayout.lineSpacing)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Parse cache backing `MarkdownView` (main-actor only, like the view bodies that call it).
/// Bounded as a leak backstop: past the cap it resets wholesale — visible rows repopulate it
/// lazily on their next body pass, so a reset costs one parse per on-screen Markdown row.
@MainActor private var markdownBlockCache: [String: [MarkdownBlock]] = [:]

@MainActor private func cachedMarkdownBlocks(_ source: String) -> [MarkdownBlock] {
    if let hit = markdownBlockCache[source] { return hit }
    if markdownBlockCache.count >= 512 { markdownBlockCache.removeAll(keepingCapacity: true) }
    let blocks = parseMarkdownBlocks(source)
    markdownBlockCache[source] = blocks
    return blocks
}

private struct MarkdownBlockView: View {
    let block: MarkdownBlock
    // iOS selectable-leaf styling threaded from MarkdownView; unused on macOS (which keeps `Text`).
    let base: ProseRole
    let ink: ProseInk

    var body: some View {
        switch block {
        case .heading(let level, let text):
            // iOS: one selectable run — bake the heading font + weight into the UITextView (SwiftUI's
            // `.font`/`.bold` can't reach a representable). macOS keeps the inherited-font `Text`.
            #if os(iOS)
            SelectableText(text: text, role: .heading(level), ink: ink, markdown: true, codeBackground: false)
                .frame(maxWidth: .infinity, alignment: .leading)
            #else
            inlineMarkdown(text, codeBackground: false).font(headingFont(level)).bold()
                .fixedSize(horizontal: false, vertical: true)
            #endif

        case .paragraph(let text):
            #if os(iOS)
            SelectableText(text: text, role: base, ink: ink, markdown: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            #else
            inlineMarkdown(text)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            #endif

        case .list(let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(items.indices, id: \.self) { i in
                    // iOS: the marker is prepended into the selectable run with a hanging indent, so
                    // the bullet copies with the item and wrapped lines align under the text — and the
                    // marker/body baseline can't drift (a representable exposes no text baseline to an
                    // HStack's `.firstTextBaseline`). macOS keeps the marker + `Text` HStack.
                    #if os(iOS)
                    SelectableText(text: items[i].text, role: base, ink: ink, markdown: true,
                                   leadingMarker: marker(items[i]))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.leading, CGFloat(items[i].indent) * 16)
                    #else
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(marker(items[i])).monospacedDigit().foregroundStyle(.secondary)
                        inlineMarkdown(items[i].text)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.leading, CGFloat(items[i].indent) * 16)
                    #endif
                }
            }

        case .code(let language, let code):
            CodeBlockView(language: language, code: code)

        case .table(let table):
            MarkdownTableView(table: table)

        case .quote(let text):
            HStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5).fill(Color.secondary.opacity(0.4)).frame(width: 3)
                #if os(iOS)
                SelectableText(text: text, role: base, ink: .secondary, markdown: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                #else
                inlineMarkdown(text).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                #endif
            }

        case .rule:
            Divider()
        }
    }

    private func marker(_ item: MarkdownListItem) -> String {
        item.ordered ? "\(item.number ?? 1)." : "•"
    }

    private func headingFont(_ level: Int) -> Font {
        // The per-platform ramp lives in Typography.swift: each step sits at or above orbitProse so
        // an h4 never renders smaller than the prose it heads. Roughly mirrors web's heading em ramp.
        Font.orbitHeading(level)
    }
}

/// A GFM table rendered as a rounded, bordered grid — the desktop analogue of the web `.md table`.
/// The header row is semibold over a gray fill; cells carry inline Markdown, honour per-column
/// alignment, and size each column to its content so the grid hugs its width instead of filling the
/// pane. A table wider than the pane scrolls horizontally within its own bounds (web's `overflow-x`)
/// rather than overflowing the row — on a narrow iPhone an unbounded wide table clipped the table
/// *and* its sibling paragraphs by forcing the whole transcript row past the screen edge.
private struct MarkdownTableView: View {
    let table: MarkdownTable
    private let border = Color.secondary.opacity(0.3)
    private let cornerRadius: CGFloat = 6

    var body: some View {
        // `.fixedSize(horizontal:)` sizes the grid to its content, so a table wider than the pane
        // would push the whole transcript row past the screen edge and clip it (and its siblings)
        // on a narrow iPhone. Wrap it in a horizontal ScrollView — the wide grid scrolls within its
        // own bounds instead, mirroring web's `.md table` overflow-x and the CodeBlockView above. A
        // table narrower than the pane still hugs the left via the outer `maxWidth: .infinity`.
        ScrollView(.horizontal, showsIndicators: false) {
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
            .fixedSize(horizontal: true, vertical: true)
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
            .overlay(RoundedRectangle(cornerRadius: cornerRadius).stroke(border, lineWidth: 1))
            .padding(1)   // keep the 1pt border off the scroll clip edge
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func cell(_ text: String, column: Int, header: Bool) -> some View {
        inlineMarkdown(text)
            .font(.orbitTableCell)
            .fontWeight(header ? .semibold : .regular)
            .frame(maxWidth: .infinity, alignment: frameAlignment(column))
            .padding(.vertical, 4)
            .padding(.horizontal, 8)
            .background(header ? Color.primary.opacity(0.06) : Color.clear)
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
            // iOS: a read-only UITextView so a snippet can be selected + copied by hand (the hover copy
            // button below never shows on iOS). It doesn't wrap — the natural width scrolls here, web
            // parity. macOS keeps the `Text` (its drag-select works) plus the hover copy button.
            #if os(iOS)
            SelectableText(text: code, role: .code, ink: .primary)
                .padding(10)
            #else
            Text(code)
                .font(.orbitMono)
                .lineSpacing(2)
                .textSelection(.enabled)
                .padding(10)
            #endif
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.gray.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))
        .overlay(alignment: .topTrailing) {
            if hovering {
                Button(action: copy) {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.orbitLabel)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .padding(6)
            }
        }
        .onHover { hovering = $0 }
    }

    private func copy() {
        PlatformPasteboard.copyString(code)
        copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
    }
}

/// Inline-only Markdown (bold/italic/code/links/strikethrough), newlines preserved. Used for the
/// text inside a single block; block structure is handled by `MarkdownBlockView`.
func inlineMarkdown(_ s: String, codeBackground: Bool = true) -> Text {
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
    // so this is a flat tint — kept faint so a code-dense paragraph doesn't read as speckled, rather
    // than web's rounded, bordered pill. Headings pass codeBackground: false: a tint bar behind a
    // filename in a large bold heading reads as clutter, and the monospace run alone sets it apart.
    if codeBackground {
        let codeRanges = attributed.runs
            .filter { $0.inlinePresentationIntent?.contains(.code) == true }
            .map(\.range)
        for range in codeRanges {
            attributed[range].backgroundColor = Color.secondary.opacity(0.08)
        }
    }
    return Text(attributed)
}

/// The same inline-Markdown parse as `inlineMarkdown`, but returning the raw `AttributedString` so the
/// iOS `SelectableText` can restyle it into a read-only `UITextView` (bold/italic/code/links become
/// concrete `UIFont`s + attributes there; the inline-code tint is applied per run at that point, not
/// baked here). Falls back to the plain string on a parse failure.
func inlineMarkdownAttributed(_ s: String) -> AttributedString {
    (try? AttributedString(
        markdown: s,
        options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    )) ?? AttributedString(s)
}

extension Color {
    /// Long-form transcript ink, matching web's `--text-1` (#1f2329 light / #c9ced5 dark). A hair
    /// softer and cooler than the system label — over a long reply, full-strength label reads
    /// harsher, and on dark the system white is brighter than web's muted grey.
    static let transcriptInk = Color(
        light: Color(red: 0x1F / 255, green: 0x23 / 255, blue: 0x29 / 255),
        dark:  Color(red: 0xC9 / 255, green: 0xCE / 255, blue: 0xD5 / 255)
    )
}
