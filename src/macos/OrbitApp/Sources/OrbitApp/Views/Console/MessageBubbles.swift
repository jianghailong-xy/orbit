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
    /// Who sent it when it was somebody outside Orbit (`UserBubble.externalSender`), drawn as one line over
    /// the bubble; nil for the owner's own words. `UserTurnRow` decides it, as it decides every card.
    var sender: ExternalMessageFrom? = nil
    /// Provided only for the queued tail (`ConsoleView`): withdraws this still-waiting message.
    /// Nil for every settled/inline bubble, so the Cancel affordance shows on queued turns alone.
    var onCancelQueued: (() -> Void)? = nil
    /// Provided by the console's rows (`UserTurnRow`): takes back a steer nothing has read yet, and
    /// says when that has been asked. Nil where there is no console to act through.
    var steer: SteerControls? = nil
    /// Provided by the console's rows where `SteerDelivery.offersPutBack` says so: the words of a
    /// message that never reached the engine, back in the composer (`ConsoleModel.putBack`).
    var onPutBack: (() -> Void)? = nil
    @State private var expanded = false
    @State private var hovering = false
    @State private var copied = false
    /// Whether what Orbit attached is open: its line ends the meta row, its rows go under that row.
    @State private var noteOpen = false
    /// Settings › Translation: this message flipped to the English the agent got. Per message and
    /// never persisted (board frame 5).
    @State private var flipped = false
    @Environment(\.translationActions) private var translationActions
    // Collapse a giant pasted bubble: one huge Text lays out synchronously and stalls the UI.
    private let truncateAt = 6000
    // The meta row reserves its height even when hidden (so hover-reveal never shifts the bubble);
    // scale that reservation with the orbitMeta text it holds or large Dynamic Type clips it.
    @ScaledMetric(relativeTo: .caption2) private var metaHeight: CGFloat = 16

    @Environment(AttachmentImageStore.self) private var store
    /// The app's one card store: what a link in this message stands for, and where the bubble
    /// stretches to hold it.
    @Environment(AppModel.self) private var appModel: AppModel?
    @Namespace private var previewNS
    // Tapped image → full-screen pager (iOS): the console's, over the whole session, or this bubble's
    // own where there's no console. Unused on macOS, where thumbnails aren't tappable.
    @State private var previewTarget: ImagePreviewTarget?
    @Environment(\.sessionImagePreview) private var sessionPreview
    /// Set while the session is held by its runner's update, naming the bubble whose foot row says so.
    @Environment(\.runnerUpdatingFoot) private var runnerUpdatingFoot
    /// This bubble's `Queued · runner updating`, where it is the one the update holds.
    private var heldFoot: RunnerUpdatingFoot? {
        guard let foot = runnerUpdatingFoot, foot.bubbleID == bubble.id, !bubble.pending else { return nil }
        return foot
    }

    private var images: [TurnAttachment] { bubble.attachments.filter(\.isImage) }
    /// This bubble's images as viewer pages, keyed the way `SessionPreviewImages` keys them.
    private var pages: [PreviewImage] {
        images.map { .attachment(id: pageID($0), attachmentID: $0.id) }
    }
    private func pageID(_ attachment: TurnAttachment) -> String {
        SessionPreviewImages.attachmentKey(itemID: bubble.id, attachmentID: attachment.id)
    }
    private var files: [TurnAttachment] { bubble.attachments.filter { !$0.isImage } }

    /// The words on screen: what the owner wrote, or — a delivered message flipped — the English the
    /// agent got. Copy hands back the same (`SessionTranslation.shownUserText`).
    private var words: String { SessionTranslation.shownUserText(bubble.text, bubble.translation, flipped: flipped) }

    var body: some View {
        let words = self.words
        let long = words.count > truncateAt
        let shown = long && !expanded ? String(words.prefix(truncateAt)) : words
        let showsCard = self.showsCard(shown)
        HStack(spacing: 0) {
            // web's `.chat-user-wrap` margin-left: 60 — the gutter the person's turn never crosses.
            // A message holding a card asks for the whole row (below), and two flexible children
            // would divide the row between them; the gutter is then a fixed 60, which is exactly
            // what the mock measures (a 361pt column and a 301pt bubble).
            if showsCard { Spacer().frame(width: 60) } else { Spacer(minLength: 60) }
            VStack(alignment: .trailing, spacing: 3) {
                // Who sent it when it was not the owner — `From Feishu · <name>` (`ExternalSender`):
                // one muted line over the bubble, on its trailing edge like the bubble itself (web's
                // `.chat-user-from`).
                if let from = sender {
                    Text(ExternalSender.label(from))
                        .font(.orbitMeta).foregroundStyle(.secondary)
                }
                if !images.isEmpty {
                    imageBlock
                }
                if !files.isEmpty {
                    attachmentRow { ForEach(files) { ChatAttachmentFile(attachment: $0) } }
                }
                // The bubble is the person's words and nothing else: what delivery appended is named
                // on a line in the meta row under it (`AttachedNoteLine`), never in it.
                if !bubble.text.isEmpty {
                    typedText(shown, showsCard: showsCard)
                        .padding(.horizontal, bubbleInset(showsCard))
                        .padding(.vertical, showsCard ? 5 : 8)
                        .background(.tint.opacity(0.15), in: RoundedRectangle(cornerRadius: 12))
                        // A card takes the bubble's whole width (the owner's mock ②: the card sits in
                        // the bubble where the address was), so the bubble grows to the row for it —
                        // where every other message still sizes to its own words.
                        .frame(maxWidth: showsCard ? .infinity : nil, alignment: .leading)
                }
                if long {
                    Button(expanded ? "Show less" : "Show more") { expanded.toggle() }
                        .buttonStyle(.plain).font(.orbitLabel).foregroundStyle(.secondary)
                }
                meta
                why
                translationFoot
                if noteOpen, let attached = bubble.attached {
                    // What the line in the meta row opened, in the bubble's column on a quiet panel of
                    // its own (web's `.chat-user-wrap > .chat-injected-panel`).
                    AttachedNoteBody(attached: attached)
                        .padding(.horizontal, 10).padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.primary.opacity(0.04), in: RoundedRectangle(cornerRadius: 10))
                }
            }
            // Hover over the bubble column (not the full-width row) reveals the meta — web parity.
            // contentShape makes the WHOLE column rect (incl. the 3pt spacing gaps and the meta's
            // reserved height) one contiguous hover region; without it `.onHover` only fires over
            // the children's drawn glyphs, so moving the cursor down toward the copy button crosses
            // a dead gap, drops hover, and dismisses the row before the click can land.
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
        }
        .imagePreview($previewTarget, images: pages, ns: previewNS, store: store)
    }

    // Markdown-rendered by the same renderer as the assistant turn (web parity): the messages sent
    // here are mostly long structured prompts — headings, lists, fenced commands — and reading them as
    // raw '#'/'*' source is what this replaces. The copy button still hands back the original source.
    // `fillWidth: false` keeps the tinted background hugging the text instead of stretching across the
    // row; `.body`/`.primary` are the bubble's own prose token and ink (the reply's reading size,
    // system label). Partial selection still works: iOS selects inside the renderer's own text views,
    // macOS through `.textSelection`.
    private func typedText(_ shown: String, showsCard: Bool = false) -> some View {
        MarkdownView(source: shown, base: .body, ink: .primary,
                     fillWidth: showsCard, inBubble: showsCard)
            .font(.orbitProse)
            .textSelection(.enabled)
            .environment(\.previewOwnerID, bubble.id)
    }

    /// Whether this message draws an Orbit link as a card. The renderer decides that itself
    /// (`orbitRenderBlocks`) and the bubble has to know the same answer twice over: a card is the
    /// width of the bubble, so the bubble stops hugging and takes the row.
    private func showsCard(_ shown: String) -> Bool {
        guard let cards = appModel?.linkCards else { return false }
        return orbitRenderBlocks(shown, cards: cards).hasOrbitCard
    }

    /// The bubble's own horizontal inset. Holding a card it is 5pt — that is the card's inset, and
    /// the words take the rest of theirs back inside the renderer — and 12pt otherwise, as always.
    private func bubbleInset(_ showsCard: Bool) -> CGFloat { showsCard ? 5 : 12 }

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
        let ns = sessionPreview?.ns ?? previewNS
        if images.count == 1 {
            ChatAttachmentImage(attachment: images[0], onTap: tapAction(0),
                                sourceID: pageID(images[0]), ns: ns)
        } else {
            FlowLayout(spacing: 6) {
                ForEach(Array(images.enumerated()), id: \.element.id) { i, att in
                    ChatAttachmentThumb(attachment: att, onTap: tapAction(i),
                                        sourceID: pageID(att), ns: ns)
                }
            }
        }
    }

    private func tapAction(_ i: Int) -> () -> Void {
        {
            let id = pageID(images[i])
            if let sessionPreview {
                sessionPreview.open(id, pages, i)
            } else {
                previewTarget = ImagePreviewTarget(index: i, id: id)
            }
        }
    }

    /// Anything not yet (or never) confirmed keeps its label on screen permanently; a settled turn
    /// shows its timestamp on hover alone.
    /// A steer keeps its line up after it settles too: unlike a message, whose reply is its
    /// receipt, "Read in this turn" is the only thing that ever says the engine took it.
    private var unconfirmed: Bool { bubble.pending || bubble.undelivered || bubble.steer }

    /// Touch has no hover, so a hover-gated copy button can never be reached on iOS: the only user
    /// turns copyable from a phone were the ones whose row is pinned up anyway (a steer, a send in
    /// flight), which is why "Read in this turn" carried a copy button and the message above it
    /// didn't. On iOS it is simply always shown.
    private var copyShown: Bool {
        #if os(iOS)
        true
        #else
        unconfirmed || hovering
        #endif
    }

    /// The same hover problem, on the other half of the row. That slot holds a delivery state when
    /// there is one to report ("Queued", "Sending…", a steer's line) and the send time otherwise —
    /// so on iOS, where the copy button is always up, a hover-gated time left the space beside it
    /// permanently blank. Showing it at rest fills only that otherwise-empty slot. macOS still has
    /// a cursor, and keeps revealing copy and time together.
    private var timeShown: Bool {
        #if os(iOS)
        true
        #else
        hovering
        #endif
    }

    /// Touch has no cursor to aim with, so on iOS the ~12pt glyph gets a wider (invisible) hit area.
    /// Trailing-aligned where it's used, so the extra width falls in the empty space to the glyph's
    /// left and nothing moves. nil on macOS — a mouse doesn't need it, and `.frame(width: nil)`
    /// leaves the row exactly as it was.
    #if os(iOS)
    private let copyHitWidth: CGFloat? = 28
    #else
    private let copyHitWidth: CGFloat? = nil
    #endif

    // Copy + relative time (web's `.chat-user-meta`). While the turn is unconfirmed this shows
    // "Queued" (a turn was already in flight) or "Sending…" in place of the time, and "Not
    // delivered" once the run has ended without ever taking it. A message written into the running
    // turn instead of queued behind it (a steer) shows how far it got there instead — see
    // SteerDelivery. The line naming what Orbit attached ends the row and is always shown. Always
    // laid out so revealing it doesn't move the bubble. An image-only turn (empty text) has nothing
    // to copy, so the row is suppressed unless it has a state or a note to show — web parity.
    @ViewBuilder
    private var meta: some View {
        if !bubble.text.isEmpty || unconfirmed || bubble.attached != nil || heldFoot != nil {
            HStack(spacing: 6) {
                if !bubble.text.isEmpty {
                    Button { copy() } label: {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc").font(.orbitMeta)
                            .frame(width: copyHitWidth, alignment: .trailing)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).foregroundStyle(.secondary).help("Copy message")
                    .opacity(copyShown ? 1 : 0)
                    .allowsHitTesting(copyShown)
                }
                if bubble.undelivered {
                    // Amber, not red: nothing broke on this message — the run ended before its turn
                    // came — and the auth/error card above already says why. Re-sending is the fix,
                    // and the composer (or that card's Retry) is where it happens.
                    Label(SteerDelivery.state("failed").label, systemImage: "exclamationmark.circle")
                        .font(.orbitMeta).foregroundStyle(.orange)
                    putBackButton
                } else if bubble.steer {
                    // A steer is not waiting its turn — it is on its way into the one already
                    // running — and the turn it joined answers something else, so this line is the
                    // only report it gets. Shown whether or not it is still pending: "Read in this
                    // turn" is what says the engine took it, and it arrives after the durable
                    // `user` event has already settled the bubble. While nothing has read it, the
                    // way to take it back sits beside the state it would undo, styled as the queued
                    // Cancel is (web parity: `SteerState`); once asked, the line says so in place of
                    // both, so it cannot be pressed twice.
                    if steer?.withdrawing == true {
                        Text("Withdrawing…").font(.orbitMeta).foregroundStyle(.secondary)
                    } else if SteerDelivery.state(bubble.delivery).tone == .failed {
                        // Nobody can say the engine read it ("Couldn't confirm it was read"): said in
                        // the warning tone, as web's and Android's are. Put back only where all there
                        // is of it is the receipt (`offersPutBack`).
                        Label(SteerDelivery.state(bubble.delivery).label, systemImage: "exclamationmark.circle")
                            .font(.orbitMeta).foregroundStyle(.orange)
                        putBackButton
                    } else {
                        Text(SteerDelivery.state(bubble.delivery).label)
                            .font(.orbitMeta).foregroundStyle(.secondary)
                        if let onWithdraw = steer?.onWithdraw {
                            Button { onWithdraw() } label: {
                                Text("Withdraw").font(.orbitMeta)
                            }
                            .buttonStyle(.plain).foregroundStyle(.tint)
                            .padding(.leading, 2).contentShape(Rectangle())
                        }
                    }
                } else if bubble.pending, bubble.translation?.held == true {
                    // Held for its translation: the line under the meta says where it is (1A / 4A).
                    EmptyView()
                } else if bubble.pending {
                    Text(bubble.queued ? "Queued" : "Sending…").font(.orbitMeta).foregroundStyle(.secondary)
                    // A queued message can be withdrawn until the runner leases it (web parity). Offered
                    // only once the server `turnId` is known — the DELETE keys on it — which lands a tick
                    // after send. `contentShape` widens the small hit target for touch.
                    if bubble.queued, bubble.turnId != nil, let onCancel = onCancelQueued {
                        Button { onCancel() } label: {
                            Text("Cancel").font(.orbitMeta)
                        }
                        .buttonStyle(.plain).foregroundStyle(.tint)
                        .padding(.leading, 2).contentShape(Rectangle())
                    }
                } else if let ts = bubble.ts, let rel = RelativeTime.format(ts) {
                    // Only ever reached on a settled turn — every other branch above is a state that
                    // stays on screen. Gated here rather than on the row so the copy button beside it
                    // can be shown on its own (see `copyShown` / `timeShown`).
                    Text(rel).font(.orbitMeta).foregroundStyle(.secondary)
                        .opacity(timeShown ? 1 : 0)
                }
                // What holds this message (web `QueuedFootCtx`): always shown, unlike the time.
                if let heldFoot {
                    RunnerUpdatingTagView(foot: heldFoot)
                }
                if let attached = bubble.attached {
                    // Named, not hidden: without it the agent answers about a quota outage nobody
                    // appears to have raised. Opened, its rows go under this row (`noteOpen`).
                    AttachedNoteLine(attached: attached, open: $noteOpen)
                }
            }
            // At least one line: a long note line wraps on a phone rather than being cut.
            .frame(minHeight: metaHeight)
            .animation(.easeOut(duration: 0.12), value: hovering)
        }
    }

    /// The words of a message that never reached the engine, back in the composer — beside the state
    /// that says so, styled as Withdraw and Cancel are (web parity: `UserBubble`'s and
    /// `QueuedTurnMeta`'s "Put back in the composer").
    @ViewBuilder
    private var putBackButton: some View {
        if let onPutBack {
            Button { onPutBack() } label: {
                Text("Put back in the composer").font(.orbitMeta)
            }
            .buttonStyle(.plain).foregroundStyle(.tint)
            .padding(.leading, 2).contentShape(Rectangle())
        }
    }

    /// Why a message only the server's receipt speaks for did not land, in the sender's words, under
    /// the line that says it did not (web parity: `QueuedTurnMeta`'s `chat-queued-why`).
    @ViewBuilder
    private var why: some View {
        if bubble.receipt,
           let words = SteerDelivery.failureExplanation(code: bubble.deliveryCode, reason: bubble.deliveryReason),
           !words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            Text(words).font(.orbitMeta).foregroundStyle(.secondary)
                .multilineTextAlignment(.trailing)
        }
    }

    /// Settings › Translation: "Translated · Show original" and its flip, the "Translating…" chip, or
    /// "Couldn't translate, so it wasn't sent · Retry · Send as written" (`SessionTranslation.userFoot`).
    @ViewBuilder
    private var translationFoot: some View {
        let parts = SessionTranslation.userFoot(bubble.translation, flipped: flipped)
        if !parts.isEmpty {
            TranslationFootView(parts: parts, alignment: .trailing) { action in
                switch action {
                case .flip: flipped.toggle()
                case .retryTurn: if let id = bubble.turnId { translationActions?.retryTurn(id) }
                case .sendAsWritten: if let id = bubble.turnId { translationActions?.sendAsWritten(id) }
                case .retryReply: break
                }
            }
        }
    }

    private func copy() {
        PlatformPasteboard.copyString(words)
        copied = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_600_000_000)
            copied = false
        }
    }
}

struct AssistantBubbleView: View {
    let bubble: AssistantBubble
    /// Settings › Translation: this reply flipped to the English the agent wrote (board frame 5).
    @State private var flipped = false
    @Environment(\.translationActions) private var translationActions

    /// Waiting for its translation (2A): streaming while the account translates, or settled in a
    /// translated turn before the server's `translation` event has come.
    private var awaiting: Bool {
        guard bubble.translation == nil else { return false }
        return bubble.isFinalized ? bubble.awaitsTranslation == true : translationActions?.on == true
    }
    // Assistant turns are long-form Markdown — render them as a full-width document on the window
    // background (no bubble), mirroring web's `.chat-assistant`. A tinted panel here would sit
    // gray-on-gray behind the code blocks' own surface and box long content into a narrow column;
    // only the short, conversational user turn keeps a bubble. No extra horizontal inset — the text
    // sits flush with the row's 16pt leading edge, sharing one gutter with the tool-card rail and the
    // status bar / composer below (all at 16pt).
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Group {
                if bubble.isFinalized {
                    MarkdownView(source: SessionTranslation.shownReplyText(bubble.displayText, bubble.translation,
                                                                    flipped: flipped))
                } else {
                    StreamingProse(text: bubble.displayText)
                }
            }
            .font(.orbitProse)
            .foregroundStyle(Color.transcriptInk)
            // The English greyed until its translation replaces it (2A).
            .opacity(awaiting ? 0.5 : 1)
            .textSelection(.enabled)
            .environment(\.previewOwnerID, bubble.id)
            if !bubble.isFinalized { TypingDots() }
            TranslationFootView(parts: SessionTranslation.replyFoot(bubble.translation, pending: awaiting, flipped: flipped)) { action in
                switch action {
                case .flip: flipped.toggle()
                case .retryReply: if let seq = bubble.seq { translationActions?.retryReply(seq) }
                case .retryTurn, .sendAsWritten: break
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The streaming counterpart of `MarkdownView`: renders the *completed* blocks (everything up to the
/// last blank line) as Markdown and keeps the still-growing trailing block as plain text, so a
/// paragraph only snaps into formatted Markdown once it ends — the behaviour requested for the live
/// reply. This bounds the Markdown parse to block *completions* (a few per second) rather than
/// re-parsing the whole message on every ~5Hz stream publish, which is the battery/heat reason the
/// finalized swap in `MarkdownView` had degraded to fully-plain streaming. `splitStreamingMarkdown`
/// guarantees `stable + tail == text`; the fonts (`orbitProse` ↔ SelectableText `.body`) and
/// `ProseLayout.lineSpacing` match across the two halves, so a block snapping from plain to Markdown
/// doesn't shift the layout. `base`/`ink` thread the iOS selectable-leaf styling like `MarkdownView`.
private struct StreamingProse: View {
    let text: String
    var base: ProseRole = .body
    var ink: ProseInk = .transcript

    var body: some View {
        let (stable, tail) = splitStreamingMarkdown(text)
        VStack(alignment: .leading, spacing: 8) {
            if !stable.isEmpty {
                // `.equatable()`: the tail grows every ~5Hz publish, so this body re-runs constantly —
                // but the completed prefix only changes when a *new* block completes. Comparing the
                // source string lets SwiftUI skip the whole subtree (no re-parse, and crucially no
                // per-frame TextKit re-measure of the finished prose) until then. This is what keeps
                // progressive streaming off the iPhone battery/heat path the plain degrade avoided.
                MarkdownView(source: String(stable), base: base, ink: ink).equatable()
            }
            if !tail.isEmpty {
                Text(tail)
                    .lineSpacing(ProseLayout.lineSpacing)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct ThinkingView: View {
    let block: ThinkingBlock
    /// Nil until the reader says otherwise: folded, whether the stretch is still being written or
    /// settled (owner, 2026-11-11, docs/mocks/thinking-fold-live — a box of reasoning scrolling at
    /// the tail of every turn was the biggest moving thing on screen and the least read). The row's
    /// running clock says it is working. A tap pins it open, and that pin survives the block
    /// settling underneath it.
    @State private var pinnedOpen: Bool?
    private static let tailAnchor = "thinking-tail"

    private var expanded: Bool { pinnedOpen ?? false }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            row
            if expanded { content }
        }
        // StepsRowView's List rule, same row: animating the fold has SwiftUI interpolating
        // the contents while the UICollectionView behind the List re-measures and animates the
        // same cell — both driving one height, which is the flicker. The fold is instant instead.
        .animation(nil, value: expanded)
    }

    /// The tap row. The fold is driven by hand — chevron, contentShape, onTapGesture — the way
    /// every other foldable row in this List does it (ToolCardView, StepsRowView): the
    /// `DisclosureGroup` this row was before would not collapse on tap on iOS (reported on a
    /// streaming Kimi turn, 2026-10-09).
    private var row: some View {
        HStack(spacing: 7) {
            // Turned, not swapped — see ToolCardView: the two chevron symbols are different sizes.
            Image(systemName: "chevron.right")
                .font(.orbitMeta.weight(.semibold)).foregroundStyle(.tertiary)
                .rotationEffect(.degrees(expanded ? 90 : 0))
            // Ticks once a second only while the stretch is still being written; a settled row's
            // words do not move, and a turn stacks many of them.
            if block.isFinalized {
                rowLabel(Date())
            } else {
                TimelineView(.periodic(from: .now, by: 1)) { context in rowLabel(context.date) }
            }
            Spacer(minLength: 0)
        }
        .contentShape(Rectangle())
        .onTapGesture { pinnedOpen = !expanded }
    }

    private var content: some View {
        // Same progressive streaming as AssistantBubbleView: completed blocks render as Markdown
        // while the block grows, the trailing partial stays plain (this body only runs while
        // expanded). aside/secondary so the iOS selectable leaves read as the muted "thinking"
        // aside, not the assistant reply; macOS ignores these and keeps the inherited font/colour.
        Group {
            if block.isFinalized {
                MarkdownView(source: block.displayText, base: .aside, ink: .secondary)
            } else {
                // While it streams, the reasoning is held to about ten lines that keep
                // themselves at the newest one. Unbounded it pushed the answer — and the tool
                // calls on the way to it — out of a transcript pinned to the tail: DeepSeek
                // writes 23k characters of reasoning per turn at the median, 122k at p90.
                ScrollViewReader { proxy in
                    ScrollView {
                        StreamingProse(text: block.displayText, base: .aside, ink: .secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .id(Self.tailAnchor)
                    }
                    .frame(maxHeight: 160)
                    .onChange(of: block.displayText, initial: true) { _, _ in
                        proxy.scrollTo(Self.tailAnchor, anchor: .bottom)
                    }
                }
            }
        }
        .font(.orbitProseAside).foregroundStyle(.secondary)
        .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
        .environment(\.previewOwnerID, block.id)
    }

    /// What the row says while it is shut. A bare "Thinking" told a reader nothing about whether
    /// opening it was worth it; this states how long the stretch took and how much it came to.
    private func rowLabel(_ now: Date) -> some View {
        Label(rowText(now: now), systemImage: "brain")
            .font(.orbitLabel).foregroundStyle(.secondary)
            .lineLimit(1)
            .monospacedDigit()
    }

    private func rowText(now: Date) -> String {
        block.isFinalized
            ? ThinkingSummary.settledLabel(chars: block.text.count, blocks: block.blocks,
                                           startedTs: block.startedTs, finishedTs: block.finishedTs,
                                           thinkingMs: block.thinkingMs)
            : ThinkingSummary.liveLabel(chars: block.displayText.count, startedTs: block.startedTs, now: now)
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

/// Tail "the agent is working" indicator, shown from the moment a message is sent until the first
/// token streams in (web's "Waiting for the agent…" note). The same `TypingDots` the streaming
/// reply uses, at the assistant gutter — so the wait reads as continuous, ChatGPT-style feedback
/// (dots → dots beneath the growing reply) instead of an inert page. Gated by
/// `ConsoleModel.showWorkingIndicator`.
struct WorkingIndicatorView: View {
    var body: some View {
        TypingDots()
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityLabel("Working")
    }
}

/// The head of a turn, under the message that opened it: "Worked for 1m 4s", or, while the turn
/// runs, "Working for 12s" counting up once a second (`TurnHead`; web parity: `TurnHead` in
/// Transcript.tsx).
struct TurnHeadRowView: View {
    /// Only drawn when it has something to say (`TranscriptRows.build`): one with no end yet is the
    /// running turn.
    let line: TurnHeadLine

    var body: some View {
        if line.endTs == nil {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                label(at: context.date)
            }
        } else {
            label(at: Date())
        }
    }

    private func label(at now: Date) -> some View {
        Text(TurnHead.label(line, running: true, now: now) ?? "")
            .font(.orbitLabel).monospacedDigit().foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
