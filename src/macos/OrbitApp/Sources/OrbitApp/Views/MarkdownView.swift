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
struct MarkdownView: View, Equatable {
    let source: String
    // iOS selectable-leaf styling (see SelectableText): the base role + ink the prose blocks render
    // with, so the same shared renderer reads as the assistant reply here and as the muted "aside" in
    // the thinking block. macOS ignores both — it keeps inheriting `.font`/`.foregroundStyle` from the
    // call site. Defaults are the assistant reply.
    var base: ProseRole = .body
    var ink: ProseInk = .transcript
    /// Take the whole offered width (the assistant's full-width document) or hug the content. The user
    /// bubble hugs: its tinted background sizes to the text, so a prose column pinned to
    /// `maxWidth: .infinity` would stretch that background across the entire row.
    var fillWidth: Bool = true

    var body: some View {
        // No length cap (capping only dropped formatting on long messages — the historic freezes
        // were scroll mechanics, not parsing). But do NOT parse unconditionally either: a row's
        // body re-evaluates whenever anything it observes republishes (~5×/sec during a streaming
        // turn, plus whole-tree diffs), and `parseMarkdownBlocks` builds a full swift-markdown AST
        // per call — on iPhone that repeated re-parse was a top battery/heat hotspot. The cache
        // keys on the exact source string, so re-evaluations of unchanged text cost a hash lookup.
        // A streaming row reaches here only with its *completed-block* prefix (StreamingProse feeds
        // the growing tail to a plain Text), and that prefix changes only when a block completes — a
        // few times a second, not every publish — so the cache still holds a handful of entries.
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
                        .frame(maxWidth: fillWidth ? .infinity : nil, alignment: .leading)
                case .block(let block):
                    MarkdownBlockView(block: block, base: base, ink: ink)
                }
            }
        }
        .frame(maxWidth: fillWidth ? .infinity : nil, alignment: .leading)
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
        .frame(maxWidth: fillWidth ? .infinity : nil, alignment: .leading)
        #endif
    }
}

#if os(iOS)
/// A render unit for the iOS transcript: either a `.prose` run of flowable blocks merged into one
/// selectable text view, or a standalone `.block` (code/table/quote/image/rule) that renders on its own.
private enum ProseGroup {
    case prose([ProseSegment])
    case block(MarkdownBlock)
}

/// Fold a block list into render groups: maximal runs of flowable prose (headings, paragraphs,
/// lists) collapse into one `.prose` — a single `SelectableText`, hence one selection domain — while
/// code/table/quote/image/rule each stay a standalone `.block`. Inter-block spacing (8pt, and 6pt between
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
                // First item is a block gap (8) from the prior block; siblings sit tighter (6).
                let gap: CGFloat = pending.isEmpty ? 0 : (i == 0 ? 8 : 6)
                pending.append(ProseSegment(text: item.text, role: base, markdown: true,
                                            leadingMarker: listMarker(item), markerSymbol: listMarkerSymbol(item),
                                            indent: item.indent, spacingBefore: gap))
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

/// A list item's text marker — an ordered item's source number, or a bullet. Nil for a task item's
/// bullet, whose slot the checkbox takes; an ordered task item keeps its number *beside* the box,
/// the way web draws both the `<ol>` marker and the `<input>`.
private func listMarker(_ item: MarkdownListItem) -> String? {
    if item.ordered { return "\(item.number ?? 1)." }
    return item.checkbox == nil ? "•" : nil
}

/// The SF Symbol a GFM task item draws in place of that marker, mirroring the real (disabled)
/// `<input type="checkbox">` web's remark-gfm renders — the app's own checkbox glyphs (see
/// `ApprovalCards`). `nil` for an ordinary item, which keeps `listMarker`.
private func listMarkerSymbol(_ item: MarkdownListItem) -> String? {
    guard let checked = item.checkbox else { return nil }
    return checked ? "checkmark.square.fill" : "square"
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
                        marker(items[i]).foregroundStyle(.secondary)
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

    /// A list item's marker: a task item's checkbox, else its bullet or number. `Text(Image:)` rather
    /// than a bare `Image` so the symbol sits on the text baseline and scales with the inherited font.
    private func marker(_ item: MarkdownListItem) -> Text {
        let text = listMarker(item).map { Text($0).monospacedDigit() } ?? Text("")
        guard let symbol = listMarkerSymbol(item) else { return text }
        let box = Text(Image(systemName: symbol))
        return item.ordered ? text + Text(" ") + box : box
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

/// A fenced code block: monospaced, horizontally scrollable, with a copy button. The button is
/// hover-revealed on macOS and always visible on iOS, where there is no cursor to reveal it.
private struct CodeBlockView: View {
    let language: String?
    let code: String
    @State private var hovering = false
    @State private var copied = false

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            // iOS: a read-only UITextView so a snippet can still be selected + copied by hand in
            // addition to the always-visible whole-block copy button. It doesn't wrap — the natural
            // width scrolls here, web parity. macOS keeps `Text` plus its hover copy button.
            #if os(iOS)
            SelectableText(text: code, role: .code, ink: .primary)
                // Add scrollable tail room so the last characters of a long line can move fully out
                // from under the fixed trailing copy button.
                .padding(.leading, 10)
                .padding(.vertical, 10)
                .padding(.trailing, 54)
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
            if copyButtonShown {
                Button(action: copy) {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.orbitLabel)
                        #if os(iOS)
                        // Match web's small raised copy tile while keeping a HIG-sized invisible
                        // touch target around it. The opaque tile keeps code legible as it scrolls by.
                        .frame(width: 28, height: 28)
                        .background(Color.editorSurface, in: RoundedRectangle(cornerRadius: 6))
                        .overlay(RoundedRectangle(cornerRadius: 6)
                            .stroke(Color.secondary.opacity(0.18), lineWidth: 1))
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                        #endif
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                #if os(iOS)
                .accessibilityLabel(copied ? "Copied" : "Copy code")
                #else
                .help("Copy code")
                .padding(6)
                #endif
            }
        }
        .onHover { hovering = $0 }
    }

    /// A hover-only action is unreachable on a touch screen. Keep desktop's quiet hover treatment,
    /// but expose the same one-tap whole-block copy action permanently on iPhone and iPad.
    private var copyButtonShown: Bool {
        #if os(iOS)
        true
        #else
        hovering
        #endif
    }

    private func copy() {
        PlatformPasteboard.copyString(code)
        PlatformHaptics.success()
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
    @Namespace private var previewNS
    // A tap opens the shared full-screen viewer, like a sent-image thumbnail. Unused on macOS,
    // where the image isn't tappable.
    @State private var previewTarget: ImagePreviewTarget?
    @Environment(\.sessionImagePreview) private var sessionPreview
    @Environment(\.previewOwnerID) private var ownerID
    /// A file named by path is fetched on the tap (below); the chip says so while it is in flight.
    @State private var fetching = false
    /// The bytes of a path that named an image, once they have landed: drawn where the chip was. Held
    /// here rather than in the store, which is keyed by attachment id for what a turn carried.
    @State private var inlineImage: PlatformImage?
    /// Where a failed fetch is reported. The app model is what the transcript's own prose links
    /// report through, for the same reason: nothing else would.
    @Environment(AppModel.self) private var app: AppModel?

    // web `.md-image { max-width: min(100%, 760px); max-height: 70vh }`, rendered at an exact fitted
    // size (below) against a fixed cap — the same approach as the sibling `ChatAttachmentImage` /
    // `ToolResultImageView` thumbnails. The iOS width cap stays comfortably under the narrowest phone
    // content pane (~328pt on a mini), so a wide image can never push the transcript row past the
    // screen edge; a tap opens the full-screen viewer for anything finer. (A pane-measuring version
    // rendered edge-to-edge, but a `fullScreenCover` transition could hand its `GeometryReader` a
    // stale / inset-free width that stuck, and the image overflowed again — a fixed cap is immune.)
    #if os(iOS)
    private static let cap = CGSize(width: 300, height: 460)
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
            // A path that names an image fetches itself on appearing (and again if the path under this
            // row changes); everything else waits for a tap.
            unavailable.task(id: inlineFetchPath) {
                if let path = inlineFetchPath { loadInline(path) }
            }
        }
    }

    @ViewBuilder private func attachmentImage(_ id: String) -> some View {
        Group {
            if let img = store.image(for: id) {
                let size = Self.fitted(img.size)
                withPreview(
                    Image(platformImage: img)
                        .resizable().scaledToFit()
                        .frame(width: size.width, height: size.height)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(.primary.opacity(0.08)) },
                    image: img
                )
            } else if store.isNotImage(id) {
                unavailable   // the bytes didn't decode as an image
            } else {
                placeholder
            }
        }
        .loadsAttachmentImage(id, from: store)
    }

    /// iOS: a tap expands the image into the shared full-screen viewer (pinch/pan/drag-to-dismiss) —
    /// the same preview, and the same zoom transition, a sent-image thumbnail or a tool-result image
    /// opens. In the console that's the session's viewer, opened on this image's page — named by the
    /// transcript item rendering this Markdown (`previewOwnerID`). Elsewhere its pager holds a single
    /// page: the renderer builds one `MarkdownImageView` per image and never tells any of them about
    /// the others. macOS: the image stays static (both helpers are no-ops there), matching the
    /// transcript's other thumbnails.
    @ViewBuilder private func withPreview(_ view: some View, image img: PlatformImage) -> some View {
        let id = ownerID.map { SessionPreviewImages.markdownKey(itemID: $0, source: source) } ?? source
        let item = PreviewImage.inline(id: id, image: img)
        view
            .imageTap({
                if let sessionPreview {
                    sessionPreview.open(id, [item], 0)
                } else {
                    previewTarget = ImagePreviewTarget(index: 0, id: id)
                }
            }, sourceID: id, ns: sessionPreview?.ns ?? previewNS)
            .imagePreview($previewTarget, images: [item], ns: previewNS)
    }

    private var placeholder: some View {
        RoundedRectangle(cornerRadius: 8).fill(.quaternary).frame(width: 200, height: 140)
    }

    /// The chip an image no client can render falls back to — and, for a file in the session's own
    /// directories, the way back to its bytes: the control plane asks the session's runner for them
    /// (see `fetch`).
    ///
    /// What the path is *named* decides how much is asked of the reader. An image (`.png`, `.jpg`,
    /// the mock an agent drew) is fetched unprompted and drawn in place — a reader who linked a
    /// picture meant to show one, and this is the difference between reading the reply and having to
    /// poke at it. Anything else stays a chip until tapped, which hands it to the platform instead.
    /// A path nobody can serve stays a label, which is what every one of these was before the
    /// artifact route could fetch the session's own files.
    @ViewBuilder
    private var unavailable: some View {
        if let path = fetchablePath {
            if let image = inlineImage {
                let size = Self.fitted(image.size)
                withPreview(Image(platformImage: image)
                    .resizable().scaledToFit()
                    .frame(width: size.width, height: size.height)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(.primary.opacity(0.08)) },
                    image: image)
            } else {
                Button { fetch(path) } label: { chip }
                    .buttonStyle(.plain)
                    .disabled(fetching)
                    .accessibilityHint("Open this file from the session's runner")
            }
        } else {
            chip
        }
    }

    private var chip: some View {
        HStack(spacing: 6) {
            if fetching {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: "paperclip").foregroundStyle(.secondary)
            }
            Text(alt.isEmpty ? "Image" : alt).lineLimit(1).truncationMode(.middle)
        }
        .font(.orbitLabel)
        .padding(.vertical, 4).padding(.horizontal, 8)
        .background(.gray.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
    }

    /// The path to ask the artifact route for, when this source is one of the session's own files
    /// (see `AttachmentLink.runnerArtifactPath`) and a console is around to ask through.
    private var fetchablePath: String? {
        guard let sessionID = sessionPreview?.sessionID else { return nil }
        return AttachmentLink.runnerArtifactPath(source: source, sessionID: sessionID)
    }

    /// What comes back is decided by what it is, not by what the path promised: bytes that decode as
    /// an image are drawn in place (tappable into the same viewer every other image opens), anything
    /// else goes to the platform — the share sheet on iOS, the file's own application on a Mac, which
    /// has no such viewer. A fetch that comes back empty, or a tap on a path that turned out not to
    /// be an image, says so rather than leaving the reader unanswered.
    private func fetch(_ path: String) {
        guard !fetching else { return }
        let preview = sessionPreview
        fetching = true
        Task {
            defer { fetching = false }
            guard let data = await store.artifactData(sessionID: preview?.sessionID ?? "", path: path) else {
                app?.showToast("Couldn't open that file", detail: path, tone: .error)
                return
            }
            if let image = PlatformImage(data: data) {
                inlineImage = image
                return
            }
            if !FileHandoff.deliver(data, named: AttachmentLink.fileName(inPath: path)) {
                app?.showToast("Couldn't open that file", detail: path, tone: .error)
            }
        }
    }

    /// Fetch a path that names an image, unprompted, and draw it where the chip was. Nothing is
    /// handed to the platform here: bytes that do not decode as an image (a file wearing a .png name,
    /// a path whose file is gone) leave the chip in place, and the reader can still tap it.
    private func loadInline(_ path: String) {
        guard inlineImage == nil, !fetching, let sessionID = sessionPreview?.sessionID else { return }
        fetching = true
        Task {
            defer { fetching = false }
            guard let data = await store.artifactData(sessionID: sessionID, path: path),
                  let image = PlatformImage(data: data) else { return }
            inlineImage = image
        }
    }

    /// The path to fetch unprompted: one that names an image (see `AttachmentLink.looksLikeImage`).
    /// Nil for everything else, which is also what keeps `loadInline` off a document.
    private var inlineFetchPath: String? {
        guard let path = fetchablePath, AttachmentLink.looksLikeImage(path: path) else { return nil }
        return path
    }

    /// The attachment id from an `orbit-attachment:<id>` source, `nil` for any other scheme — read the
    /// same way the session's viewer reads it when it gathers its pages.
    private var attachmentID: String? { AttachmentLink.attachmentID(source: source) }

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
    // A link naming a file on the runner's disk can't be opened from a client, so don't draw one —
    // the label reads as prose instead of a tinted link whose click does nothing. (The iOS transcript
    // renders those through SelectableText, which draws web's paperclip chip; a `Text` — a macOS
    // paragraph, or a table cell on either platform — can't hold one.) The same goes for a reference
    // this app has no screen for (`ReferenceLink.isInert`). Ranges first, as above.
    let deadRanges = attributed.runs
        .filter { $0.link.map { AttachmentLink.isRunnerLocalPath($0) || ReferenceLink.isInert($0) } == true }
        .map(\.range)
    for range in deadRanges {
        attributed[range].link = nil
    }
    return Text(LinkDetection.linkifying(attributed))
}

/// The same inline-Markdown parse as `inlineMarkdown`, but returning the raw `AttributedString` so the
/// iOS `SelectableText` can restyle it into a read-only `UITextView` (bold/italic/code/links become
/// concrete `UIFont`s + attributes there; the inline-code tint is applied per run at that point, not
/// baked here). Falls back to the plain string on a parse failure.
func inlineMarkdownAttributed(_ s: String) -> AttributedString {
    let parsed = (try? AttributedString(
        markdown: s,
        options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
    )) ?? AttributedString(s)
    return LinkDetection.linkifying(parsed)
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
