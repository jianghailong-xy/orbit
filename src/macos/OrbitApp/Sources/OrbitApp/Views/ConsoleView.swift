import SwiftUI
import OrbitKit

/// Console for one session: renders the reduced transcript (resumed from the local store) and the
/// interactive composer/approvals/worktree. The `ConsoleModel` is owned by `ConsoleRegistry`, not
/// this view, so switching sessions reuses a warm, cached console instead of rebuilding one.
struct ConsoleView: View {
    let sessionID: String
    var agentID: String? = nil
    let registry: ConsoleRegistry

    var body: some View {
        Group {
            if let console = registry.peek(sessionID) {
                VStack(spacing: 0) {
                    WorktreeBar(console: console)
                    Divider()
                    TranscriptView(console: console)
                    if let msg = console.statusMessage {
                        HStack {
                            Text(msg).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            Spacer()
                            Button { console.statusMessage = nil } label: { Image(systemName: "xmark") }
                                .buttonStyle(.plain).foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 12).padding(.vertical, 4)
                        .background(.bar)
                    }
                    BackgroundTrayView(procs: console.state.background)
                    ApprovalsView(console: console)
                    ComposerView(console: console)
                }
                // Image cache for user-turn attachments, read by `UserBubbleView` down the tree.
                .environment(registry.attachments)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        // Restarts only when `sessionID` changes: cancels the previous session's stream (its state
        // stays cached) and resumes this one from its persisted `maxSeq` — no full replay.
        .task(id: sessionID) {
            await registry.model(for: sessionID, agentID: agentID).run()
        }
    }
}

struct TranscriptView: View {
    let console: ConsoleModel
    private let bottomID = "transcript-bottom"
    // Mirrors web's `atBottom` (AgentView.tsx): flips false once the user scrolls up off the live
    // tail. Drives the floating jump-to-latest button AND gates the auto-follow below, so reading
    // history isn't yanked back down by streaming updates. Maintained by `ScrollTracker` (macOS 15+);
    // on the macOS 14 floor it stays true — the view keeps the unconditional follow and hides the button.
    @State private var atBottom = true
    // Id of the user turn the sticky header names — the newest question whose bottom sits above the
    // viewport top — or nil at the very top where none do. Recomputed from `ruler` on every scroll.
    @State private var stuckID: String?
    // Scroll + per-row geometry the header derives from. A reference type held in @State: rows and the
    // scroll tracker mutate it every frame WITHOUT invalidating the view — only `stuckID`, assigned when
    // the answer actually changes, redraws. This is a *stateless recompute* from cached positions, not a
    // crossing-observer set: a recycling List destroys a row the instant it clears the top edge, so it
    // can never report "I'm now above" — an accumulating set only grows and the header dies. See
    // `recomputeStuck` / `QuestionRuler`.
    @State private var ruler = QuestionRuler()

    var body: some View {
        // `List` is NSTableView-backed on macOS → true row recycling, so a long transcript stays
        // cheap to lay out. (A `LazyVStack` paired with `scrollPosition(id:anchor:)` /
        // `scrollTargetLayout()` re-measured and re-placed *every* row on each streamed update and
        // froze the UI — never reintroduce those here.)
        //
        // `.defaultScrollAnchor(.bottom)` only positions the bottom on *first* appearance; it does
        // not follow new content. So an explicit, non-animated `scrollTo` on every content change
        // keeps the latest message — and a streaming reply — in view, and re-pins the bottom when
        // you switch sessions (the view is reused, only `console` swaps). This is cheap on a
        // recycling List: a single one-shot scroll per change, not the per-frame *animated* scroll
        // that froze the old LazyVStack build.
        ScrollViewReader { proxy in
            List {
                ForEach(console.state.items) { item in
                    TranscriptItemView(item: item)
                        .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                        .modifier(QuestionRow(item: item, ruler: ruler))
                }
                // Zero-height tail row: a stable `scrollTo` target that always sits below the last
                // message (the last item's own id moves as it streams).
                Color.clear.frame(height: 1)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                    .id(bottomID)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)   // show the window background, not the List's own
            .scrollDismissesKeyboard(.interactively)   // iOS: swipe the transcript to lower the keyboard
            .defaultScrollAnchor(.bottom)
            .modifier(ScrollTracker(atBottom: $atBottom, ruler: ruler, recompute: recomputeStuck))
            // The transcript viewport's top edge in global space — the reference `QuestionRow` uses to
            // convert a row's on-screen frame into a scroll-invariant content offset. Stable during a
            // scroll (only shifts on layout, e.g. the keyboard), so reading it here doesn't churn.
            .background {
                GeometryReader { g in
                    Color.clear.onChange(of: g.frame(in: .global).minY, initial: true) { _, y in ruler.viewportTop = y }
                }
            }
            // Follow new/streaming content only while pinned at the bottom (web's smart auto-scroll):
            // if the user has scrolled up to read, don't drag them back. A session switch always
            // re-pins. One-shot, non-animated scrollTo — never the per-frame animated scroll that froze
            // the old build.
            .onChange(of: console.state.items) {
                if atBottom { proxy.scrollTo(bottomID, anchor: .bottom) }
                recomputeStuck()   // a new turn — or one measured for the first time — can change the answer
            }
            .onChange(of: console.sessionID) {
                atBottom = true; ruler.reset(); stuckID = nil
                proxy.scrollTo(bottomID, anchor: .bottom)
            }
            .onAppear { proxy.scrollTo(bottomID, anchor: .bottom); recomputeStuck() }
            // Floating jump-to-latest button, shown only while scrolled up (web's `.scroll-to-bottom`).
            .overlay(alignment: .bottom) {
                if !atBottom {
                    scrollToBottomButton(proxy: proxy)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                }
            }
            // Sticky "↑ Your question" header (web's `.chat-sticky-question`): pin the newest question
            // *above the fold* to the top so it stays in view during a long reply, and tap it to jump
            // back; it steps back through earlier questions as you scroll up (see `recomputeStuck`) and
            // hides only at the very top where no question is above. Shown whenever such a question
            // exists — including at the bottom — exactly like web, not gated on `atBottom`. In-flow inset
            // (not an overlay) so it pushes content down like web: a `scrollTo(anchor: .top)` then lands
            // the target just *below* the header, not hidden under it. iOS 18+/macOS 15+ (needs the
            // scroll/row geometry); on the earlier floor `stuckID` never updates, so this stays hidden.
            .safeAreaInset(edge: .top, spacing: 0) {
                if #available(iOS 18, macOS 15, *), let q = stuckBubble {
                    stickyQuestion(q, proxy: proxy)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.easeOut(duration: 0.15), value: atBottom)
            // Only fires when the header appears/disappears (not on every text swap), so animating it
            // can't churn during a scroll.
            .animation(.easeOut(duration: 0.15), value: stuckID == nil)
        }
        .safeAreaInset(edge: .top, spacing: 0) { statusBar }
    }

    // Recompute which question is "stuck" to the top: the newest user turn whose cached bottom sits at
    // or above the viewport top (`bottomY <= contentOffset`). Above-fold turns form a prefix (each turn
    // is higher than the next), so we scan oldest→newest and keep the last one that qualifies. A turn we
    // never measured is assumed above *until* we pass a measured below-fold turn (`seenBelow`) — that
    // covers a freshly opened session (all unmeasured ⇒ names the last question at once) without letting
    // an unmeasured turn *below* the fold (e.g. one queued while scrolled up) wrongly win. Stateless —
    // derived fresh from `ruler` each call — so, unlike a crossing-observer set, it can't be left
    // permanently wrong when the List recycles a row before it can report clearing the top edge.
    // Queued turns are skipped (web's `:not(.chat-queued)`) — they haven't been asked yet.
    private func recomputeStuck() {
        let off = ruler.contentOffset
        var found: String? = nil
        var seenBelow = false
        for item in console.state.items {
            guard case .user(let b) = item, !b.queued else { continue }
            if let by = ruler.bottomY[b.id] {
                if by <= off + 1 { found = b.id } else { seenBelow = true }
            } else if !seenBelow {
                found = b.id   // never measured, still in the above-fold run ⇒ assume above
            }
        }
        if found != stuckID { stuckID = found }
    }

    private var stuckBubble: UserBubble? {
        guard let id = stuckID else { return nil }
        for item in console.state.items.reversed() {
            if case .user(let b) = item, b.id == id { return b }
        }
        return nil
    }

    // Sticky header that names the last question and scrolls back to it — web's `.chat-sticky-question`
    // (muted "↑ Your question" label + a single ellipsized line of the text). `anchor: .top` lands the
    // bubble just under this header (it's a safe-area inset, so the scroll region starts below it).
    private func stickyQuestion(_ bubble: UserBubble, proxy: ScrollViewProxy) -> some View {
        Button {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(bubble.id, anchor: .top) }
        } label: {
            HStack(spacing: 8) {
                Text("↑ Your question")
                    .font(.system(size: 12)).foregroundStyle(.secondary).fixedSize()
                Text(bubble.text)
                    .font(.system(size: 13)).foregroundStyle(.primary)
                    .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.bar)
            .overlay(alignment: .bottom) { Divider() }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help("Jump to your last question")
    }

    // Circular "scroll to latest" control (web parity). One user-initiated scroll — not the per-frame
    // animated scroll that previously froze the transcript — so animating this one is safe.
    private func scrollToBottomButton(proxy: ScrollViewProxy) -> some View {
        Button {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(bottomID, anchor: .bottom) }
            atBottom = true
        } label: {
            Image(systemName: "arrow.down")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.primary)
                .frame(width: 32, height: 32)
                .background(.regularMaterial, in: Circle())
                .overlay { Circle().strokeBorder(.primary.opacity(0.12)) }
                .shadow(color: .black.opacity(0.18), radius: 4, y: 1)
        }
        .buttonStyle(.plain)
        .padding(.bottom, 12)
        .help("Scroll to latest")
    }

    private var statusBar: some View {
        HStack(spacing: 8) {
            Circle().fill(console.connected ? .green : .orange).frame(width: 7, height: 7)
            Text(console.state.status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized)
                .font(.caption).foregroundStyle(.secondary)
            Spacer()
            if !console.state.pendingApprovals.isEmpty {
                Label("\(console.state.pendingApprovals.count) pending", systemImage: "hand.raised.fill")
                    .font(.caption).foregroundStyle(.orange)
            }
            if !console.state.background.isEmpty {
                Label("\(console.state.background.count) background", systemImage: "gearshape.2")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(.bar)
    }
}

/// The single scroll observer: drives the jump-to-latest button's `atBottom`, AND feeds the sticky
/// header by stashing the live content offset into `ruler` and asking for a recompute each frame.
/// `onScrollGeometryChange` (macOS 15+/iOS 18+) is read-only — unlike `scrollPosition(id:)` +
/// `scrollTargetLayout()` it registers no per-row scroll targets, so it won't re-break `List`
/// virtualization (see the transcript-freeze history). On the earlier floor it's a no-op, leaving
/// `atBottom` true and the header hidden. `atBottom` mirrors web's `measure()`: pin while near the
/// bottom, un-pin only on an *upward* scroll — a downward content-growth delta must never strand the view.
private struct ScrollTracker: ViewModifier {
    @Binding var atBottom: Bool
    let ruler: QuestionRuler
    let recompute: () -> Void
    @State private var lastOffset: CGFloat = 0
    // Within this many points of the bottom still counts as pinned (web uses 80px).
    private let nearBottom: CGFloat = 80

    private struct Metrics: Equatable { let distance: CGFloat; let offset: CGFloat }

    func body(content: Content) -> some View {
        if #available(macOS 15, iOS 18, *) {
            content.onScrollGeometryChange(for: Metrics.self) { geo in
                Metrics(distance: geo.contentSize.height - geo.visibleRect.maxY, offset: geo.contentOffset.y)
            } action: { _, m in
                if m.distance <= nearBottom { atBottom = true }
                else if m.offset < lastOffset - 1 { atBottom = false }   // genuine upward scroll
                lastOffset = m.offset
                ruler.contentOffset = m.offset
                recompute()
            }
        } else {
            content
        }
    }
}

/// Caches each user turn's *content-space* bottom offset while its row is on-screen, for the header's
/// stateless recompute. content-space = (row bottom − viewport top, in global space) + scroll offset,
/// which is invariant under scrolling, so the value stays valid after the row recycles — the header can
/// then tell the turn is above the top arithmetically (`bottomY <= contentOffset`) without ever
/// observing the crossing, which a recycling List destroys the row too early to report. `.global` is
/// used deliberately (not `.scrollView`, whose meaning inside a `List` is ambiguous): it is
/// unambiguously screen-space, converted to content-space via the viewport top + offset the parent
/// captures. Only user rows carry this — they're sparse, so it's a handful of passive observers, never
/// the per-row scroll-target tracking that froze the List. iOS 18+/macOS 15+.
private struct QuestionRow: ViewModifier {
    let item: TranscriptItem
    let ruler: QuestionRuler

    func body(content: Content) -> some View {
        if #available(iOS 18, macOS 15, *), case .user(let b) = item, !b.queued {
            content.onGeometryChange(for: CGFloat.self) { proxy in
                proxy.frame(in: .global).maxY
            } action: { globalMaxY in
                ruler.bottomY[b.id] = globalMaxY - ruler.viewportTop + ruler.contentOffset
            }
        } else {
            content
        }
    }
}

/// Backing store for the sticky-header geometry (see `TranscriptView.recomputeStuck`). A plain
/// reference type, held in `@State`: the rows and the scroll tracker mutate it every frame without
/// invalidating the view; only the recomputed `stuckID` drives redraws.
final class QuestionRuler {
    var contentOffset: CGFloat = 0            // viewport top, in content space (from onScrollGeometryChange)
    var viewportTop: CGFloat = 0              // transcript viewport's top edge, in global space
    var bottomY: [String: CGFloat] = [:]      // per user-turn id: bottom edge in content space (scroll-invariant)

    func reset() { bottomY.removeAll(); contentOffset = 0 }
}

struct TranscriptItemView: View {
    let item: TranscriptItem
    var body: some View {
        switch item {
        case .user(let b):      UserBubbleView(bubble: b)
        case .assistant(let b): AssistantBubbleView(bubble: b)
        case .thinking(let b):  ThinkingView(block: b)
        case .toolCall(let c):  ToolCardView(card: c)
        case .interrupt:
            Label("Interrupted", systemImage: "stop.circle").font(.caption).foregroundStyle(.secondary)
        case .error(_, let message):
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.red).textSelection(.enabled)
        }
    }
}

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

    private var images: [TurnAttachment] { bubble.attachments.filter(\.isImage) }
    private var files: [TurnAttachment] { bubble.attachments.filter { !$0.isImage } }

    var body: some View {
        let long = bubble.text.count > truncateAt
        let shown = long && !expanded ? String(bubble.text.prefix(truncateAt)) : bubble.text
        HStack {
            Spacer(minLength: 60)
            VStack(alignment: .trailing, spacing: 3) {
                if !images.isEmpty {
                    attachmentRow { ForEach(images) { ChatAttachmentImage(attachment: $0) } }
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
    }

    // Wrapping right-aligned row of attachment thumbnails / chips (web's `.chat-images`/`.chat-files`).
    @ViewBuilder
    private func attachmentRow<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        HStack(alignment: .top, spacing: 6) { content() }
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

/// A user-turn image attachment: fetched once via the shared cache and shown as a rounded thumbnail
/// (web's `.chat-image`). Falls back to a file chip if the bytes don't decode as an image. On iOS,
/// tapping the thumbnail opens a full-screen, pinch-to-zoom viewer (web-preview parity).
struct ChatAttachmentImage: View {
    let attachment: TurnAttachment
    @Environment(AttachmentImageStore.self) private var store
    @State private var preview = false

    // Thumbnail cap. iOS enlarges the sent image so a screenshot reads on a phone, and allows extra
    // height so a portrait shot isn't squeezed into a thin sliver; macOS keeps a compact 220² since
    // thumbnails sit in a wide window. A tap opens the full-screen viewer for anything finer.
    #if os(iOS)
    private static let cap = CGSize(width: 300, height: 360)
    #else
    private static let cap = CGSize(width: 220, height: 220)
    #endif

    /// Scale the source down (or up) to touch the cap while keeping its aspect ratio, and give the
    /// thumbnail that exact size. A `maxWidth/maxHeight` frame is greedy — it fills the whole cap box
    /// and letterboxes a mismatched-aspect image inside, so the rounded border wraps empty space
    /// around a portrait shot. An exact frame makes the border hug the image with no blank margin.
    private static func fitted(_ src: CGSize) -> CGSize {
        guard src.width > 0, src.height > 0 else { return cap }
        let k = min(cap.width / src.width, cap.height / src.height)
        return CGSize(width: src.width * k, height: src.height * k)
    }

    var body: some View {
        Group {
            if let img = store.image(for: attachment.id) {
                let size = Self.fitted(img.size)
                Image(platformImage: img)
                    .resizable().scaledToFit()
                    .frame(width: size.width, height: size.height)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay { RoundedRectangle(cornerRadius: 8).strokeBorder(.primary.opacity(0.08)) }
                    .tappableImagePreview(img, $preview)
            } else if store.isNotImage(attachment.id) {
                ChatAttachmentFile(attachment: attachment)   // not an image after all
            } else {
                RoundedRectangle(cornerRadius: 8)
                    .fill(.quaternary)
                    .frame(width: 120, height: 90)
            }
        }
        .task(id: attachment.id) { await store.load(attachment.id) }
    }
}

/// A non-image attachment: a name chip (web's `.chat-file`).
struct ChatAttachmentFile: View {
    let attachment: TurnAttachment

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "paperclip").foregroundStyle(.secondary)
            Text(attachment.name ?? "file").lineLimit(1).truncationMode(.middle)
        }
        .font(.caption)
        .padding(.vertical, 4).padding(.horizontal, 8)
        .frame(maxWidth: 220, alignment: .leading)
        .background(.gray.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// iOS: make a transcript image thumbnail tappable to open a full-screen, pinch-to-zoom viewer
/// (parity with web's tap-to-preview). macOS: no-op — the thumbnail stays a static rounded image.
private extension View {
    @ViewBuilder func tappableImagePreview(_ image: PlatformImage, _ presented: Binding<Bool>) -> some View {
        #if os(iOS)
        self.contentShape(Rectangle())
            .onTapGesture { presented.wrappedValue = true }
            .fullScreenCover(isPresented: presented) { FullScreenImageView(image: image) }
        #else
        self
        #endif
    }
}

#if os(iOS)
/// Full-screen viewer for a sent image, opened by tapping its transcript thumbnail — the native
/// client previously had no way to enlarge a sent screenshot. The image is centred and fit to the
/// whole screen; pinch or double-tap to zoom, drag to pan while zoomed. To dismiss: the close button,
/// or — at fit scale — an interactive drag where the image tracks the finger and shrinks while the
/// backdrop fades to reveal the transcript underneath (the standard Photos/Messages feel), snapping
/// back if released short of the threshold.
struct FullScreenImageView: View {
    let image: PlatformImage
    @Environment(\.dismiss) private var dismiss

    @GestureState private var pinch: CGFloat = 1
    @State private var scale: CGFloat = 1
    @State private var offset: CGSize = .zero   // committed pan, only meaningful while zoomed
    @State private var drag: CGSize = .zero      // live drag translation

    private var liveScale: CGFloat { max(1, scale * pinch) }
    private var zoomed: Bool { liveScale > 1.01 }
    // 0 while zoomed or idle; 0→1 as a fit-scale downward drag approaches the dismiss threshold.
    private var dismissProgress: CGFloat { zoomed ? 0 : min(1, max(0, drag.height) / 260) }

    var body: some View {
        let magnify = MagnificationGesture()
            .updating($pinch) { value, state, _ in state = value }
            .onEnded { value in scale = min(max(1, scale * value), 6) }

        let pan = DragGesture()
            .onChanged { value in drag = value.translation }
            .onEnded { value in
                if zoomed {
                    offset.width += value.translation.width      // commit the pan
                    offset.height += value.translation.height
                    drag = .zero
                } else if value.translation.height > 150 {
                    dismiss()
                } else {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.86)) { drag = .zero }
                }
            }

        ZStack {
            // Fades out as the dismiss drag progresses; presentationBackground(.clear) lets the
            // transcript show through the gap so the swipe reads as peeling the image away.
            Color.black.opacity(1 - dismissProgress).ignoresSafeArea()

            Image(platformImage: image)
                .resizable()
                .scaledToFit()
                .scaleEffect(liveScale * (1 - dismissProgress * 0.12))
                .offset(x: offset.width + drag.width, y: offset.height + drag.height)
                .frame(maxWidth: .infinity, maxHeight: .infinity)   // fill → scaledToFit centres it
                .contentShape(Rectangle())
                .gesture(pan)
                .simultaneousGesture(magnify)
                .onTapGesture(count: 2) {
                    withAnimation(.easeOut(duration: 0.22)) {
                        if zoomed { scale = 1; offset = .zero } else { scale = 2.6 }
                    }
                }
        }
        .ignoresSafeArea()
        .overlay(alignment: .topTrailing) {
            Button { dismiss() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(11)
                    .background(.ultraThinMaterial, in: Circle())
            }
            .padding(.trailing, 16).padding(.top, 4)
            .opacity(1 - dismissProgress)
            .accessibilityLabel("Close")
        }
        .statusBarHidden(true)
        .presentationBackground(.clear)
    }
}
#endif

struct AssistantBubbleView: View {
    let bubble: AssistantBubble
    // Assistant turns are long-form Markdown — render them as a full-width document on the window
    // background (no bubble), mirroring web's `.chat-assistant`. A tinted panel here would sit
    // gray-on-gray behind the code blocks' own surface and box long content into a narrow column;
    // only the short, conversational user turn keeps a bubble. Horizontal padding matches web's
    // `padding: 0 12px` and keeps the left edge aligned with the tool-card rail.
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            MarkdownView(source: bubble.displayText)
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
            MarkdownView(source: block.displayText).font(.callout).foregroundStyle(.secondary)
                .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        } label: {
            Label("Thinking", systemImage: "brain").font(.caption).foregroundStyle(.secondary)
        }
    }
}

/// A tool call rendered to match the web transcript: a compact folded row (toned icon · name ·
/// abbreviated path/summary · line-range badge · status) that expands to a semantic body (a `$`
/// command, a red/green edit diff, a plan/prompt as prose, otherwise monospace output). The
/// name→display mapping lives in `OrbitKit.ToolDisplay` so it stays in step with web and testable.
struct ToolCardView: View {
    let card: ToolCard
    private let d: ToolDisplay
    @State private var expanded: Bool

    init(card: ToolCard) {
        self.card = card
        let display = ToolDisplay.describe(name: card.name, input: card.input, status: card.status, id: card.id)
        self.d = display
        let hasResult = (card.result?.isEmpty == false)
        _expanded = State(initialValue: display.autoOpen && (display.hasBody || hasResult))
    }

    private var hasResult: Bool { card.result?.isEmpty == false }
    private var hasDetail: Bool { d.hasBody || hasResult }
    private var isOpen: Bool { expanded && hasDetail }

    var body: some View {
        // Folded rows read as a flowing, rail-marked list; once expanded the card regains a
        // border + surface so its detail body stays visually grouped (mirrors web `.is-open`).
        VStack(alignment: .leading, spacing: 6) {
            row
            if isOpen { detail }
        }
        .padding(.leading, 11)
        .padding(.trailing, 10)
        .padding(.vertical, 6)
        .background(isOpen ? Color.gray.opacity(0.06) : Color.clear)
        .overlay(alignment: .leading) { Rectangle().fill(d.tone.color).frame(width: 3) }
        .clipShape(RoundedRectangle(cornerRadius: isOpen ? 8 : 0))
        .overlay {
            if isOpen { RoundedRectangle(cornerRadius: 8).stroke(Color.primary.opacity(0.12), lineWidth: 1) }
        }
    }

    private var row: some View {
        HStack(spacing: 7) {
            if hasDetail {
                Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    .font(.system(size: 9, weight: .semibold)).foregroundStyle(.tertiary)
            }
            Image(systemName: d.symbol)
                .font(.system(size: 11)).foregroundStyle(d.tone.color)
                .frame(width: 20, height: 20)
                .background(d.tone.color.opacity(0.14), in: RoundedRectangle(cornerRadius: 5))
            Text(d.label)
                .font(.system(.caption, design: .monospaced).weight(.semibold))
                .foregroundStyle(.primary)
            summary
            if let meta = d.meta {
                Text(meta)
                    .font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Color.gray.opacity(0.14), in: RoundedRectangle(cornerRadius: 4))
            }
            status
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            guard hasDetail else { return }
            withAnimation(.easeOut(duration: 0.12)) { expanded.toggle() }
        }
    }

    @ViewBuilder private var summary: some View {
        if let p = d.path {
            (Text(p.base).fontWeight(.semibold).foregroundColor(.primary)
             + Text(p.dir.isEmpty ? "" : "  \(p.dir)").foregroundColor(.secondary))
                .font(.system(size: 11, design: .monospaced))
                .lineLimit(1).truncationMode(.middle)
        } else if let s = d.summary, !s.isEmpty {
            Text(s)
                .font(d.summaryMono ? .system(size: 11, design: .monospaced) : .caption)
                .foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
        }
    }

    @ViewBuilder private var status: some View {
        switch card.status {
        case .running: ProgressView().controlSize(.small)
        case .ok:      Image(systemName: "checkmark.circle.fill").font(.system(size: 12)).foregroundStyle(.green)
        case .error:   Image(systemName: "xmark.circle.fill").font(.system(size: 12)).foregroundStyle(.red)
        }
    }

    private var detail: some View {
        VStack(alignment: .leading, spacing: 8) {
            ToolBodyView(kind: d.body)
            if let result = card.result, !result.isEmpty {
                let isErr = card.status == .error
                // Mirrors web `.chat-result`: a tinted panel (red on error, neutral otherwise) with a
                // small uppercase label. The output text itself stays muted even on error (only the
                // panel + label carry the error colour) — matching web's muted `<Pre>`.
                VStack(alignment: .leading, spacing: 3) {
                    Text(isErr ? "ERROR" : "OUTPUT")
                        .font(.system(size: 9, weight: .semibold)).tracking(0.4)
                        .foregroundStyle(isErr ? Color.red : Color.secondary)
                    CollapsibleMono(text: result)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 9).padding(.vertical, 6)
                .background(isErr ? Color.red.opacity(0.10) : Color.secondary.opacity(0.08),
                            in: RoundedRectangle(cornerRadius: 6))
            }
        }
    }
}

private extension ToolTone {
    var color: Color {
        switch self {
        case .read:  return .blue
        case .exec:  return .teal
        case .write: return .orange
        case .agent: return .purple
        case .plain: return .secondary
        }
    }
}

/// The expandable detail under a tool row: a shell command, file content, a markdown plan/prompt,
/// or a red/green edit diff.
struct ToolBodyView: View {
    let kind: ToolBody
    var body: some View {
        switch kind {
        case .none:
            EmptyView()
        case .command(let cmd):
            (Text("$ ").foregroundColor(.blue).fontWeight(.semibold) + Text(cmd))
                .font(.system(size: 11.5, design: .monospaced)).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
                .overlay { RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.18), lineWidth: 1) }
        case .code(let code):
            CollapsibleMono(text: code)
        case .markdown(let md):
            MarkdownView(source: md)
                .font(.callout).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .diff(let hunks):
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(hunks.enumerated()), id: \.offset) { _, hunk in
                    DiffHunkView(lines: ToolDisplay.numbered(hunk))
                }
            }
        }
    }
}

struct DiffHunkView: View {
    let lines: [ToolDisplay.NumberedDiffLine]
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, nl in
                DiffLineView(nl: nl)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay { RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.2), lineWidth: 1) }
    }
}

struct DiffLineView: View {
    let nl: ToolDisplay.NumberedDiffLine
    private var line: DiffLine { nl.line }
    var body: some View {
        if line.kind == .gap {
            HStack(spacing: 0) {
                gutterText("")
                gutterText("")
                Text("⋯ \(line.gapCount) unchanged \(line.gapCount == 1 ? "line" : "lines") ⋯")
                    .font(.system(size: 10.5, design: .monospaced)).italic().foregroundStyle(.tertiary)
                    .padding(.leading, 6)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.secondary.opacity(0.06))
        } else {
            HStack(alignment: .top, spacing: 0) {
                gutter(nl.oldNumber)
                gutter(nl.newNumber)
                Text(sign).font(.system(size: 11, design: .monospaced)).foregroundStyle(fg)
                    .frame(width: 14, alignment: .center)
                Text(line.text.isEmpty ? " " : line.text)
                    .font(.system(size: 11, design: .monospaced)).foregroundStyle(fg)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.trailing, 6)
            }
            .padding(.vertical, 1)
            .background(bg)
        }
    }
    private func gutter(_ n: Int?) -> some View { gutterText(n.map(String.init) ?? "") }
    private func gutterText(_ s: String) -> some View {
        Text(s)
            .font(.system(size: 10, design: .monospaced)).foregroundStyle(.tertiary)
            .frame(width: 30, alignment: .trailing)
            .padding(.vertical, 1)
            .background(Color.secondary.opacity(0.06))
    }
    private var sign: String { line.kind == .add ? "+" : line.kind == .del ? "-" : " " }
    private var fg: Color { line.kind == .add ? .green : line.kind == .del ? .red : .secondary }
    private var bg: Color { line.kind == .add ? Color.green.opacity(0.12) : line.kind == .del ? Color.red.opacity(0.12) : .clear }
}

/// Monospace text that collapses past a line threshold (Read/Bash output, file content) so one
/// tool call can't flood the transcript — mirrors web's `Pre`.
struct CollapsibleMono: View {
    let text: String
    @State private var open = false
    private let threshold = 16
    var body: some View {
        let lines = text.components(separatedBy: "\n")
        let hidden = max(0, lines.count - threshold)
        let shown = (open || hidden == 0) ? text : lines.prefix(threshold).joined(separator: "\n")
        VStack(alignment: .leading, spacing: 4) {
            Text(shown)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(Color.secondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            if hidden > 0 {
                Button(open ? "Show less" : "Show \(hidden) more lines") { open.toggle() }
                    .buttonStyle(.plain).font(.caption2).foregroundStyle(.blue)
            }
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
