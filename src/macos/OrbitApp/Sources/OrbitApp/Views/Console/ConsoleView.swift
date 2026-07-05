import SwiftUI
import OrbitKit

// The console page and its transcript list + scroll machinery. The row content lives beside this
// file: MessageBubbles.swift (user/assistant/thinking turns), AttachmentViews.swift (thumbnails /
// chips), ImageViewer.swift (full-screen viewers), ToolCards.swift (tool calls + diffs).

/// Console for one session: renders the reduced transcript (resumed from the local store) and the
/// interactive composer/approvals/worktree. The `ConsoleModel` is owned by `ConsoleRegistry`, not
/// this view, so switching sessions reuses a warm, cached console instead of rebuilding one.
struct ConsoleView: View {
    let sessionID: String
    var agentID: String? = nil
    let registry: ConsoleRegistry
    #if os(iOS)
    // Looked up to build the nav-bar title (session name + "state · when"), mirroring how web's
    // console header reads `selected` off the cached session list. iOS-only: macOS shows status in
    // the in-transcript `statusBar` instead.
    @Environment(AppModel.self) private var appModel
    #endif

    var body: some View {
        Group {
            if let console = registry.peek(sessionID) {
                VStack(spacing: 0) {
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
                    // Worktree status bar sits directly above the composer, matching web's layout.
                    WorktreeBar(console: console)
                    ComposerView(console: console)
                }
                // Image cache for user-turn attachments, read by `UserBubbleView` down the tree.
                .environment(registry.attachments)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        // Only hydrate the cached model so the transcript renders warm. The live SSE stream is owned
        // by the ConsoleModel and started/stopped by the registry's focus() off app state (not this
        // view's lifecycle) — so backing out to the list reliably drops the connection even if SwiftUI
        // keeps this off-screen view cached, and at most one session ever streams.
        .task(id: sessionID) {
            _ = registry.model(for: sessionID, agentID: agentID)
        }
        #if os(iOS)
        // Pushed onto the compact NavigationStack (and shown as the split detail on iPad), this page
        // carries no title, so iOS would reserve a *large* — and empty — title bar: a big blank band
        // at the top, above the transcript. Force the slim inline bar so the transcript starts
        // right under the back button. (The New-session compose page already does this; without it the
        // console reverts to the large bar the moment the session is created — the reported gap.)
        .navigationBarTitleDisplayMode(.inline)
        // Inline title: the session name over a "state · when" subtitle, matching the web Agent
        // console header (`AgentView.tsx`). Centered/two-line — the system convention (Messages/Phone)
        // — rather than web's left-aligned bar. The status word lived in the transcript's `statusBar`
        // band before; on iOS that band is now retired in favour of this.
        .toolbar {
            ToolbarItem(placement: .principal) {
                ConsoleNavTitle(session: appModel.session(id: sessionID),
                                console: registry.peek(sessionID))
            }
        }
        #endif
    }
}

#if os(iOS)
/// The pushed console's inline nav-bar title: the session name over a "state · when" subtitle,
/// mirroring the web Agent console header (see OrbitKit `SessionHeader`). The session (with its
/// title + timestamps) comes from the app's cached list; when it isn't loaded yet the title falls
/// back to the live stream's agent name and the subtitle to its current status word.
private struct ConsoleNavTitle: View {
    let session: Session?
    let console: ConsoleModel?

    var body: some View {
        VStack(spacing: 1) {
            Text(SessionHeader.title(for: session, fallbackAgent: console?.agentName))
                .font(.headline)
                .lineLimit(1).truncationMode(.tail)
            Text(subtitle)
                .font(.caption2).foregroundStyle(.secondary)
                .lineLimit(1).truncationMode(.tail)
        }
    }

    private var subtitle: String {
        if let s = SessionHeader.subtitle(for: session) { return s }
        // No cached session yet (fresh deep link): show the live stream's status, prettified like
        // the old band did (AWAITING_INPUT -> "Awaiting Input").
        if let status = console?.state.status {
            return status.rawValue.replacingOccurrences(of: "_", with: " ").capitalized
        }
        return ""
    }
}
#endif

struct TranscriptView: View {
    let console: ConsoleModel
    private let bottomID = "transcript-bottom"
    // Mirrors web's `atBottom` (AgentView.tsx): flips false once the user scrolls up off the live
    // tail. Drives the floating jump-to-latest button AND gates the auto-follow below, so reading
    // history isn't yanked back down by streaming updates. Maintained by `ScrollTracker` (macOS 15+);
    // on the macOS 14 floor it stays true — the view keeps the unconditional follow and hides the button.
    @State private var atBottom = true
    // Id of the user turn the sticky header names — the newest question above the fold — or nil at the
    // very top where none is. Derived from the top anchor + the message list by `recomputeStuck`.
    @State private var stuckID: String?
    // The scroll state the header derives from. A reference type held in @State: rows and the scroll
    // tracker mutate it every frame WITHOUT invalidating the view — only `stuckID`, assigned when the
    // answer changes, redraws. Its ONLY scroll input is `topAnchorID`: the id of the item currently
    // under the viewport top, always set by a row that IS on screen. That's the key to robustness — the
    // header is a pure function of (top anchor, message list), recomputed each scroll, so it can't
    // accumulate the corruption a per-row crossing set did (a recycling List destroys a row the instant
    // it clears the top edge, so "I scrolled above" can never be observed; an accumulating set only
    // grew and the header died). See `recomputeStuck` / `QuestionRuler`.
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
                        .modifier(AnchorRow(itemID: item.id, ruler: ruler, recompute: recomputeStuck))
                        // Row-level preferences must sit OUTSIDE `AnchorRow`: it wraps content in an
                        // `if #available` (`_ConditionalContent`), and `listRow*` set inside that branch
                        // aren't hoisted to the List on iOS — the separators leaked back in. Applied here,
                        // on the outermost row view, they propagate reliably (a chat flow, no hairlines).
                        .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
                // Messages sent while a turn is in flight wait their turn: render them AFTER the
                // transcript so a mid-turn send is never interleaved into the running reply (web's
                // trailing `queued` bubbles). No `AnchorRow` — they haven't been asked yet, so they're
                // never the sticky "Your question" (web's `:not(.chat-queued)`).
                ForEach(console.state.queued, id: \.id) { bubble in
                    UserBubbleView(bubble: bubble)
                        .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
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
            // The transcript viewport's top edge in global space — the line `AnchorRow` tests each row
            // against to find the one under the top. Stable during a scroll (only shifts on layout, e.g.
            // the keyboard), so reading it here doesn't churn.
            .background {
                GeometryReader { g in
                    Color.clear.onChange(of: g.frame(in: .global).minY, initial: true) { _, y in ruler.viewportTop = y }
                }
            }
            // Follow new/streaming content only while pinned at the bottom (web's smart auto-scroll):
            // if the user has scrolled up to read, don't drag them back. A session switch always
            // re-pins. One-shot, non-animated scrollTo — never the per-frame animated scroll that froze
            // the old build. Keyed on `stateRevision`, not `state.items`: the revision is an O(1)
            // compare bumped once per published snapshot, where the items array would be
            // Equatable-compared in full on every publish just to learn "something changed".
            .onChange(of: console.stateRevision) {
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
        // macOS shows the session state in this band; iOS carries it in the nav-bar subtitle
        // (`ConsoleNavTitle`) instead, matching the web header, so the band is retired there.
        #if os(macOS)
        .safeAreaInset(edge: .top, spacing: 0) { statusBar }
        #endif
    }

    // Which question is "stuck" to the top = the last user turn that sits ABOVE the item currently under
    // the viewport top (`topAnchorID`). Everything before that anchor item is above the fold, so the last
    // user turn among them is web's `.chat-user` bottom-above-top answer — and it steps back through
    // earlier questions as the anchor moves up. Pure data: we only read the anchor id (set by an on-screen
    // row) and the message list, so nothing here can be left stale by recycling. If no row has claimed the
    // top yet (freshly opened, before the first geometry callback) but we're scrolled below the top, fall
    // back to naming the last question so the header shows at once; at the very top / short transcripts it
    // stays nil. Queued turns are skipped (web's `:not(.chat-queued)`) — they haven't been asked yet.
    private func recomputeStuck() {
        let items = console.state.items
        var found: String? = nil
        if let anchor = ruler.topAnchorID {
            for item in items {
                if item.id == anchor { break }                       // reached the top item; stop
                if case .user(let b) = item, !b.queued { found = b.id }
            }
        } else if ruler.contentOffset > 40 {
            for item in items.reversed() {
                if case .user(let b) = item, !b.queued { found = b.id; break }
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

    #if os(macOS)
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
    #endif
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

/// Publishes the id of the item currently under the transcript's top edge (`ruler.topAnchorID`). Every
/// row carries this — the anchor can be any kind of turn — and the one whose frame straddles the viewport
/// top claims it. Because that row is by definition on screen, the anchor is always read from live
/// geometry and never has to survive recycling; the header then derives the last question above it purely
/// from the message list (see `recomputeStuck`). `.global` (not the List-ambiguous `.scrollView`) gives
/// an unambiguous screen frame, compared against the viewport top the parent captures. Passive
/// `onGeometryChange` observers, not the per-row scroll-target tracking that froze the List — and the
/// action fires only on the rare frame a row crosses the top line, not every frame. iOS 18+/macOS 15+.
private struct AnchorRow: ViewModifier {
    let itemID: String
    let ruler: QuestionRuler
    let recompute: () -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18, macOS 15, *) {
            content.onGeometryChange(for: Bool.self) { proxy in
                let f = proxy.frame(in: .global)
                return f.minY <= ruler.viewportTop && ruler.viewportTop < f.maxY
            } action: { straddlesTop in
                if straddlesTop, ruler.topAnchorID != itemID { ruler.topAnchorID = itemID; recompute() }
            }
        } else {
            content
        }
    }
}

/// Backing store for the sticky header (see `TranscriptView.recomputeStuck`). A plain reference type,
/// held in `@State`: the rows and the scroll tracker mutate it every frame without invalidating the
/// view; only the recomputed `stuckID` drives redraws.
final class QuestionRuler {
    var viewportTop: CGFloat = 0      // transcript viewport's top edge, in global space
    var contentOffset: CGFloat = 0    // scroll offset (from onScrollGeometryChange) — only for the initial fallback
    var topAnchorID: String?          // id of the item straddling the viewport top — the header's sole scroll input

    func reset() { topAnchorID = nil; contentOffset = 0 }
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
