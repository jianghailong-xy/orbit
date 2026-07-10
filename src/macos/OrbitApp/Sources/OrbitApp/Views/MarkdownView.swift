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
        #if os(iOS)
        // Coalesce each run of flowable prose (headings, paragraphs, lists) into ONE SelectableText
        // so a long-press can drag a selection across those blocks — a UITextView is a single
        // selection domain, so a view-per-block capped selection at one block (the reported bug).
        // Code blocks, tables and quotes stay their own views (a scrollable snippet / a grid / a
        // barred quote can't live inside a shared text run), so they're selection "islands" between
        // the prose runs; the 8pt block gaps within a run are baked into the text (see ProseSegment).
        let groups = proseGroups(blocks, base: base)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(groups.indices, id: \.self) { i in
                switch groups[i] {
                case .prose(let segments):
                    SelectableText(segments: segments, ink: ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                case .block(let block):
                    MarkdownBlockView(block: block, base: base, ink: ink)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        #else
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
        #endif
    }
}

#if os(iOS)
/// A render unit for the iOS transcript: either a `.prose` run of flowable blocks merged into one
/// selectable text view, or a standalone `.block` (code/table/quote/rule) that renders on its own.
private enum ProseGroup {
    case prose([ProseSegment])
    case block(MarkdownBlock)
}

/// Fold a block list into render groups: maximal runs of flowable prose (headings, paragraphs,
/// lists) collapse into one `.prose` — a single `SelectableText`, hence one selection domain — while
/// code/table/quote/rule each stay a standalone `.block`. Inter-block spacing (8pt, and 6pt between
/// list items) is carried on each segment's `spacingBefore` so the merged view reproduces the gaps
/// the old block `VStack` drew. See `MarkdownView.body`.
private func proseGroups(_ blocks: [MarkdownBlock], base: ProseRole) -> [ProseGroup] {
    var groups: [ProseGroup] = []
    var pending: [ProseSegment] = []
    func flush() {
        if !pending.isEmpty { groups.append(.prose(pending)); pending = [] }
    }
    for block in blocks {
        switch block {
        case .heading(let level, let text):
            pending.append(ProseSegment(text: text, role: .heading(level), markdown: true,
                                        codeBackground: false, spacingBefore: pending.isEmpty ? 0 : 8))
        case .paragraph(let text):
            pending.append(ProseSegment(text: text, role: base, markdown: true,
                                        spacingBefore: pending.isEmpty ? 0 : 8))
        case .list(let items):
            for (i, item) in items.enumerated() {
                let marker = item.ordered ? "\(item.number ?? 1)." : "•"
                // First item is a block gap (8) from the prior block; siblings sit tighter (6).
                let gap: CGFloat = pending.isEmpty ? 0 : (i == 0 ? 8 : 6)
                pending.append(ProseSegment(text: item.text, role: base, markdown: true,
                                            leadingMarker: marker, indent: item.indent, spacingBefore: gap))
            }
        // `.image`, like code/table/quote/rule, is an "island" that can't merge into a text run —
        // hand it to `MarkdownBlockView`, which renders it on both platforms.
        case .code, .table, .quote, .rule, .image:
            flush()
            groups.append(.block(block))
        }
    }
    flush()
    return groups
}
#endif

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
        // On iOS these flowable blocks are merged into one selectable text view upstream
        // (MarkdownView.proseGroups), so this view renders them only on macOS; the "island" blocks
        // below (code/table/quote/rule) can't share a text run and render here on both platforms.
        case .heading(let level, let text):
            inlineMarkdown(text, codeBackground: false).font(headingFont(level)).bold()
                .fixedSize(horizontal: false, vertical: true)

        case .paragraph(let text):
            inlineMarkdown(text)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)

        case .list(let items):
            VStack(alignment: .leading, spacing: 6) {
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

        case .image(let source, let alt):
            MarkdownImageView(source: source, alt: alt)
                .frame(maxWidth: .infinity, alignment: .leading)

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

/// A Markdown image block. The runner (and hand-authored agent messages) reference an uploaded
/// attachment as `orbit-attachment:<id>`; those bytes are bearer-guarded, so an `<img src>` can't
/// reach them — they're fetched + decoded through the shared `AttachmentImageStore`, the same path a
/// user turn's images take, and shown as a rounded, aspect-fitted image (web's `.md-image`). A plain
/// http(s) source loads via `AsyncImage`. Anything else (a local path the client can't reach) falls
/// back to a paperclip chip, mirroring web's `md-image-unavailable`.
private struct MarkdownImageView: View {
    let source: String
    let alt: String
    // Every call site (assistant bubble, thinking block, tool card, approval plan) renders inside the
    // transcript's `AttachmentImageStore` environment — the same store `ChatAttachmentImage` reads.
    @Environment(AttachmentImageStore.self) private var store

    // web `.md-image { max-width: min(100%, 760px); max-height: 70vh }`. A phone is width-bound so the
    // width cap only bites on macOS/iPad; the height cap stops a tall screenshot from filling the pane.
    #if os(iOS)
    private static let cap = CGSize(width: 520, height: 460)
    #else
    private static let cap = CGSize(width: 480, height: 360)
    #endif

    /// Scale the source down to touch the cap (never up — web's `max-*` only shrinks), keeping aspect,
    /// so the rounded border hugs the image with no letterbox margin (see `ChatAttachmentImage`).
    private static func fitted(_ src: CGSize) -> CGSize {
        guard src.width > 0, src.height > 0 else { return cap }
        let k = min(cap.width / src.width, cap.height / src.height, 1)
        return CGSize(width: src.width * k, height: src.height * k)
    }

    var body: some View {
        if let id = attachmentID {
            attachmentImage(id)
        } else if let url = remoteURL {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFit()
                        .frame(maxWidth: Self.cap.width, maxHeight: Self.cap.height, alignment: .leading)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(.primary.opacity(0.08)) }
                case .failure:
                    unavailable
                default:
                    placeholder
                }
            }
        } else {
            unavailable
        }
    }

    @ViewBuilder private func attachmentImage(_ id: String) -> some View {
        Group {
            if let img = store.image(for: id) {
                let size = Self.fitted(img.size)
                Image(platformImage: img)
                    .resizable().scaledToFit()
                    .frame(width: size.width, height: size.height)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(.primary.opacity(0.08)) }
            } else if store.isNotImage(id) {
                unavailable   // the bytes didn't decode as an image
            } else {
                placeholder
            }
        }
        .task(id: id) { await store.load(id) }
    }

    private var placeholder: some View {
        RoundedRectangle(cornerRadius: 8).fill(.quaternary).frame(width: 200, height: 140)
    }

    private var unavailable: some View {
        HStack(spacing: 6) {
            Image(systemName: "paperclip").foregroundStyle(.secondary)
            Text(alt.isEmpty ? "Image" : alt).lineLimit(1).truncationMode(.middle)
        }
        .font(.orbitLabel)
        .padding(.vertical, 4).padding(.horizontal, 8)
        .background(.gray.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
    }

    /// The attachment id from an `orbit-attachment:<id>` source (mirrors web's parse: strip prefix,
    /// trim, take the leading non-whitespace run). `nil` for any other scheme.
    private var attachmentID: String? {
        let prefix = "orbit-attachment:"
        guard source.hasPrefix(prefix) else { return nil }
        let rest = source.dropFirst(prefix.count).trimmingCharacters(in: .whitespacesAndNewlines)
        let id = rest.prefix { !$0.isWhitespace }
        return id.isEmpty ? nil : String(id)
    }

    private var remoteURL: URL? {
        (source.hasPrefix("http://") || source.hasPrefix("https://")) ? URL(string: source) : nil
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
