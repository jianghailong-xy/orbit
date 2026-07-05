import SwiftUI
import OrbitKit

// The transcript's message rows: the user turn (bubble + attachments + hover meta), the assistant
// turn (full-width Markdown document), the collapsible thinking block, and the streaming dots.
// Split out of ConsoleView.swift; the attachment thumbnails/chips live in AttachmentViews.swift and
// the full-screen viewer they open in ImageViewer.swift.

/// Right-aligned user turn, mirroring web's `.chat-user-wrap`: any attachments (image thumbnails /
/// file chips) above a tinted text bubble, then — revealed on hover — a meta row with a copy button
/// and a relative timestamp. The meta row always occupies its height (only its opacity changes) so
/// revealing it never shifts the message below.
struct UserBubbleView: View {
    let bubble: UserBubble
    @State private var expanded = false
    @State private var hovering = false
    @State private var copied = false
    // Collapse a giant pasted bubble: one huge Text lays out synchronously and stalls the UI.
    private let truncateAt = 6000

    @Environment(AttachmentImageStore.self) private var store
    @Namespace private var previewNS
    // Tapped image → full-screen pager (iOS). Unused on macOS, where thumbnails aren't tappable.
    @State private var previewTarget: ImagePreviewTarget?

    private var images: [TurnAttachment] { bubble.attachments.filter(\.isImage) }
    private var files: [TurnAttachment] { bubble.attachments.filter { !$0.isImage } }

    var body: some View {
        let long = bubble.text.count > truncateAt
        let shown = long && !expanded ? String(bubble.text.prefix(truncateAt)) : bubble.text
        HStack {
            Spacer(minLength: 60)
            VStack(alignment: .trailing, spacing: 3) {
                if !images.isEmpty {
                    imageBlock
                }
                if !files.isEmpty {
                    attachmentRow { ForEach(files) { ChatAttachmentFile(attachment: $0) } }
                }
                if !bubble.text.isEmpty {
                    Text(shown).textSelection(.enabled)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(.tint.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
                }
                if long {
                    Button(expanded ? "Show less" : "Show more") { expanded.toggle() }
                        .buttonStyle(.plain).font(.caption).foregroundStyle(.secondary)
                }
                meta
            }
            // Hover over the bubble column (not the full-width row) reveals the meta — web parity.
            // contentShape makes the WHOLE column rect (incl. the 3pt spacing gaps and the meta's
            // reserved height) one contiguous hover region; without it `.onHover` only fires over
            // the children's drawn glyphs, so moving the cursor down toward the copy button crosses
            // a dead gap, drops hover, and dismisses the row before the click can land.
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
        }
        .imagePreview($previewTarget, images: images, ns: previewNS, store: store)
    }

    // Wrapping row of attachment chips (web's flex-wrap `.chat-files`): flows onto multiple lines so
    // several chips never overflow the bubble column off the edge of a narrow screen.
    @ViewBuilder
    private func attachmentRow<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        FlowLayout(spacing: 6) { content() }
    }

    // A single sent image stays a large fitted thumbnail; two or more become a wrapping grid of
    // uniform square thumbnails (WeChat / web `flex-wrap` parity) so none is clipped off the edge.
    // Tapping any thumbnail opens the full-screen pager at that image (iOS).
    @ViewBuilder
    private var imageBlock: some View {
        if images.count == 1 {
            ChatAttachmentImage(attachment: images[0], onTap: tapAction(0),
                                sourceID: images[0].id, ns: previewNS)
        } else {
            FlowLayout(spacing: 6) {
                ForEach(Array(images.enumerated()), id: \.element.id) { i, att in
                    ChatAttachmentThumb(attachment: att, onTap: tapAction(i),
                                        sourceID: att.id, ns: previewNS)
                }
            }
        }
    }

    private func tapAction(_ i: Int) -> () -> Void {
        { previewTarget = ImagePreviewTarget(index: i, id: images[i].id) }
    }

    // Copy + relative time, hidden until hover (web's `.chat-user-meta`). While the turn is
    // unconfirmed this shows "Queued" (a turn was already in flight) or "Sending…" in place of the
    // time. Always laid out so revealing it doesn't move the bubble. An image-only turn (empty text)
    // has nothing to copy, so the row is suppressed — web parity (`{node.text && …}`).
    @ViewBuilder
    private var meta: some View {
        if !bubble.text.isEmpty || bubble.pending {
            HStack(spacing: 6) {
                if !bubble.text.isEmpty {
                    Button { copy() } label: {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.caption2)
                    }
                    .buttonStyle(.plain).foregroundStyle(.secondary).help("Copy message")
                }
                if bubble.pending {
                    Text(bubble.queued ? "Queued" : "Sending…").font(.caption2).foregroundStyle(.secondary)
                } else if let ts = bubble.ts, let rel = RelativeTime.format(ts) {
                    Text(rel).font(.caption2).foregroundStyle(.secondary)
                }
            }
            .frame(height: 16)
            // The pending indicator (Queued/Sending…) always shows; the copy/time row only on hover (web parity).
            .opacity(bubble.pending || hovering ? 1 : 0)
            .allowsHitTesting(bubble.pending || hovering)
            .animation(.easeOut(duration: 0.12), value: hovering)
        }
    }

    private func copy() {
        PlatformPasteboard.copyString(bubble.text)
        copied = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_600_000_000)
            copied = false
        }
    }
}

struct AssistantBubbleView: View {
    let bubble: AssistantBubble
    // Assistant turns are long-form Markdown — render them as a full-width document on the window
    // background (no bubble), mirroring web's `.chat-assistant`. A tinted panel here would sit
    // gray-on-gray behind the code blocks' own surface and box long content into a narrow column;
    // only the short, conversational user turn keeps a bubble. Horizontal padding matches web's
    // `padding: 0 12px` and keeps the left edge aligned with the tool-card rail.
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Group {
                if bubble.isFinalized {
                    MarkdownView(source: bubble.displayText)
                } else {
                    // Streaming: render the growing text plain. The full Markdown pass (a GFM AST
                    // plus an AttributedString parse per block) would re-run over the WHOLE message
                    // on every published snapshot for the entire turn — the main battery/heat
                    // hotspot on iPhone. Finalize swaps in the parsed rendering once, when the
                    // text stops changing. lineSpacing matches MarkdownView's prose leading so
                    // the swap doesn't shift the layout.
                    Text(bubble.displayText)
                        .lineSpacing(5)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .font(.system(size: 14))
            .foregroundStyle(Color.transcriptInk)
            .textSelection(.enabled)
            if !bubble.isFinalized { TypingDots() }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
    }
}

struct ThinkingView: View {
    let block: ThinkingBlock
    @State private var expanded = false
    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            // Same streaming degrade as AssistantBubbleView: plain text while the block grows,
            // full Markdown only once finalized (this body only runs while expanded).
            Group {
                if block.isFinalized {
                    MarkdownView(source: block.displayText)
                } else {
                    Text(block.displayText).lineSpacing(5)
                }
            }
            .font(.callout).foregroundStyle(.secondary)
            .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Label("Thinking", systemImage: "brain").font(.caption).foregroundStyle(.secondary)
        }
    }
}

struct TypingDots: View {
    @State private var animating = false
    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<3) { i in
                Circle().frame(width: 5, height: 5)
                    .opacity(animating ? 1 : 0.3)
                    .animation(.easeInOut(duration: 0.6).repeatForever().delay(Double(i) * 0.2), value: animating)
            }
        }
        .foregroundStyle(.secondary)
        .onAppear { animating = true }
    }
}
