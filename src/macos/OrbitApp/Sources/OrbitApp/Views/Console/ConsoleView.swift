import SwiftUI
import OrbitKit
#if os(iOS)
import UIKit
#endif

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
    @State private var showShare = false
    #endif

    var body: some View {
        Group {
            if let console = registry.peek(sessionID) {
                VStack(spacing: 0) {
                    TranscriptView(console: console)
                    if let msg = console.statusMessage {
                        HStack {
                            Text(msg).font(.orbitLabel).foregroundStyle(.secondary).lineLimit(2)
                            Spacer()
                            Button { console.statusMessage = nil } label: { Image(systemName: "xmark") }
                                .buttonStyle(.plain).foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 16).padding(.vertical, 4)
                        .background(.bar)
                    }
                    // Pending approvals (incl. the AskUserQuestion form) render inline at the tail of
                    // the transcript now — as the agent's latest turn, web-style — not in a fixed panel
                    // here. See TranscriptView.
                    WorktreeBar(console: console)
                    // Background tray sits directly above the composer, matching web's layout.
                    BackgroundTrayView(procs: console.state.background)
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
            // Public read-only share link (web parity: the "Share…" menu item on the Agent console).
            ToolbarItem(placement: .topBarTrailing) {
                Button { showShare = true } label: {
                    Image(systemName: "square.and.arrow.up")
                }
                .accessibilityLabel("Share session")
            }
        }
        .sheet(isPresented: $showShare) {
            if let baseURL = appModel.baseURL {
                ShareSheet(sessionID: sessionID, baseURL: baseURL, tokenStore: appModel.tokenStore)
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
    #if os(iOS)
    // Handle to the List's UIScrollView (populated by `ScrollTouchConfigurator`) so the jump-to-latest
    // action can force a scroll to the bottom even while the list is coasting.
    @State private var transcriptScroll = TranscriptScroll()
    #endif

    /// Whether the load-earlier row is offered at all. Gated to the same floor as `ScrollTracker`:
    /// below it `atBottom` can never leave true, so the follow-on publish of a prepended page would
    /// yank the reader straight back to the live tail — worse than today's no-paging. The legacy
    /// floor keeps the pre-paging behavior (the loaded tail is all you can scroll).
    private var canPageOlder: Bool {
        guard #available(iOS 18, macOS 15, *) else { return false }
        return console.state.hasMoreOlder
    }

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
                // Scroll-up history paging (web's loadOlder): while older pages remain on the
                // server, the transcript's first row is a spinner that pulls the previous page in
                // when it scrolls into view. List laziness keeps it un-materialized — and the
                // fetch un-fired — while the user stays at the tail; its id changes with each
                // grafted page, so a page too short to push it off-screen re-materializes the row
                // and chains the next fetch until the viewport fills or history is exhausted.
                // (Bool-gated via `canPageOlder`, not an inline `if #available` — listRow* set
                // inside a _ConditionalContent branch aren't hoisted on iOS, see AnchorRow.)
                if canPageOlder {
                    HStack {
                        Spacer()
                        ProgressView().controlSize(.small)
                        Spacer()
                    }
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                    .id("load-older-\(console.state.oldestSeq ?? 0)")
                    .onAppear { Task { await console.loadOlder() } }
                }
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
                // Pending approvals render inline as the agent's latest turn — web's AgentView places
                // the ApprovalPanel right after the messages, so the card scrolls with the conversation
                // and a long AskUserQuestion form wraps + scrolls in the transcript instead of being
                // crushed into a fixed panel above the composer. After items, before queued (web order).
                // No `AnchorRow`: an approval isn't a "Your question" the sticky header names.
                ForEach(console.state.pendingApprovals) { approval in
                    ApprovalCard(console: console, approval: approval)
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
            #if os(iOS)
            // Turn OFF the scroll view's touch delay so an in-list control (the jump-to-latest disc, the
            // sticky header) registers a tap even while the list is still coasting. With the default
            // (`delaysContentTouches == true`) the scroll view delays and consumes that first touch to
            // halt deceleration, so the control only fired once the list settled. No public SwiftUI API.
            .background { ScrollTouchConfigurator(scroll: transcriptScroll) }
            #endif
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
                // A prepend published: re-pin the row under the viewport top so what the user is
                // reading stays put (web's layout-effect scroll compensation). `ruler.topAnchorID`
                // still holds its PRE-prepend reading here (row geometry re-fires only after the
                // new layout), i.e. exactly the row to hold steady — even if the user scrolled
                // away from the trigger while the fetch was in flight. Fallback: the row that was
                // the window's first (the model's anchor; the spinner row above it carries no
                // AnchorRow, so it never claims the top). Always consumed; while pinned at the
                // bottom the follow below wins instead — a short transcript auto-fills upward and
                // must not yank the user off the live tail.
                let prependAnchor = console.takePrependAnchor()
                if atBottom {
                    proxy.scrollTo(bottomID, anchor: .bottom)
                } else if let prependAnchor {
                    proxy.scrollTo(ruler.topAnchorID ?? prependAnchor, anchor: .top)
                }
                recomputeStuck()   // a new turn — or one measured for the first time — can change the answer
            }
            .onChange(of: console.sessionID) {
                atBottom = true; ruler.reset(); stuckID = nil
                proxy.scrollTo(bottomID, anchor: .bottom)
            }
            // A message the user just sent forces the transcript back to the live tail — even if
            // they'd scrolled up to read history (the stateRevision follow above only re-pins while
            // already at the bottom). Web parity: onSend re-pins atBottom on send (AgentView.tsx).
            .onChange(of: console.localSendTick) {
                atBottom = true
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
        // `CoastingButton` (not a plain `Button`) so the tap fires even while the List is still coasting.
        CoastingButton {
            #if os(iOS)
            // Same coast fix as the jump-to-latest disc: cancel the momentum so `proxy.scrollTo` isn't
            // swallowed by the deceleration, then scroll to the question row on the next runloop.
            transcriptScroll.halt()
            DispatchQueue.main.async {
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(bubble.id, anchor: .top) }
            }
            #else
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(bubble.id, anchor: .top) }
            #endif
        } label: { _ in
            HStack(spacing: 8) {
                Text("↑ Your question")
                    .font(.orbitLabel).foregroundStyle(.secondary).fixedSize()
                Text(bubble.text)
                    .font(.orbitSubtext).foregroundStyle(.primary)
                    .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16).padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.bar)
            // Wrap the rule in a stack so it draws as a horizontal bottom hairline: a bare `Divider()`
            // in an overlay has no stack axis and instead renders as a vertical line down the row's center.
            .overlay(alignment: .bottom) { VStack(spacing: 0) { Divider() } }
            .contentShape(Rectangle())
        }
        .accessibilityLabel("Jump to your last question")
        .help("Jump to your last question")
    }

    // Circular "scroll to latest" control (ChatGPT parity). Wrapped in `CoastingButton` so the tap lands
    // even while the List is still coasting, and so a press springs the translucent disc ~1.2× larger
    // (ChatGPT's feel — the material magnifies with it). The disc rests at 40pt inside a 44pt hit target
    // (near-filling it, with a hair of margin); bottom padding is 6, so it floats just above the composer.
    private func scrollToBottomButton(proxy: ScrollViewProxy) -> some View {
        CoastingButton {
            #if os(iOS)
            // Two steps, because neither alone reaches the true bottom while coasting: (1) cancel the
            // momentum in place via UIKit — otherwise `proxy.scrollTo` is swallowed by the deceleration —
            // then (2) on the next runloop scroll to the real bottom *row*. Target `bottomID`, not a
            // computed offset: a lazy List's `contentSize` is only an estimate, so an offset undershoots
            // the end (it scrolled, but stopped short of the bottom).
            transcriptScroll.halt()
            DispatchQueue.main.async {
                withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(bottomID, anchor: .bottom) }
            }
            #else
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(bottomID, anchor: .bottom) }
            #endif
            atBottom = true
        } label: { pressed in
            Image(systemName: "arrow.down")
                // A thin 15pt arrow, not the old chunky semibold — matches ChatGPT's slim glyph and
                // web's `ArrowDownOutlined` (15px). Fixed size (like `orbitHeroGlyph`): a control mark,
                // not body text, so it shouldn't ride Dynamic Type.
                .font(.orbitControlGlyph)
                // Soft gray, not crisp black — ChatGPT's muted arrow.
                .foregroundStyle(.secondary)
                .frame(width: 40, height: 40)
                // ChatGPT's airy disc: translucent + borderless. `.ultraThinMaterial` alone reads nearly
                // solid over the white transcript (and can't reliably blur the scrolled text behind it),
                // so composite it at ~0.7 opacity — the real content bleeds through and it reads as
                // semi-transparent glass, not an opaque chip. Shadow (0.12) alone defines the edge — no
                // ring. `opacity` is the knob: lower = more see-through, higher = more solid.
                .background(Circle().fill(.ultraThinMaterial).opacity(0.7))
                .overlay { Circle().fill(.primary.opacity(pressed ? 0.07 : 0)) }
                .shadow(color: .black.opacity(pressed ? 0.20 : 0.12), radius: pressed ? 6 : 4, y: pressed ? 2 : 1)
                .scaleEffect(pressed ? 1.2 : 1)
                .frame(width: 44, height: 44)
                .contentShape(Circle())
                .animation(.spring(response: 0.28, dampingFraction: 0.6), value: pressed)
        }
        .padding(.bottom, 6)
        .accessibilityLabel("Scroll to latest")
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
        .padding(.horizontal, 16).padding(.vertical, 6)
        .background(.bar)
    }
    #endif
}

/// A tap target that still fires while the enclosing `List` is coasting (momentum scroll) — the whole
/// reason these controls aren't plain `Button`s. On iOS the scroll view's stop-on-tap arbitration eats
/// that first touch, so a SwiftUI `Button`/`onTapGesture`/`DragGesture` does nothing until the list
/// settles (what "滚动中点击无效" was). The iOS interactive layer is instead a raw UIKit
/// `UILongPressGestureRecognizer` (min duration 0) that recognizes *simultaneously* with the scroll and
/// owns its own touch, so it fires on that first tap mid-coast; `minimumPressDuration: 0` also gives an
/// instant press signal. macOS has no such arbitration, so a plain drag gesture suffices there.
///
/// The `label` closure is handed the live `pressed` state to drive press feedback (e.g. the disc's
/// magnify). A swipe that merely begins on the control is treated as a scroll, not a tap — a
/// small-movement check on iOS, near-zero drag translation on macOS. Trade-off: because the iOS layer
/// owns the touch, a drag that *starts* on the control won't scroll the List (a dead-zone the size of
/// the control) — fine for the small disc and the thin sticky bar.
private struct CoastingButton<Label: View>: View {
    private let action: () -> Void
    private let label: (Bool) -> Label
    @State private var pressed = false

    init(action: @escaping () -> Void, @ViewBuilder label: @escaping (Bool) -> Label) {
        self.action = action
        self.label = label
    }

    var body: some View {
        interactive
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { action() }
    }

    @ViewBuilder private var interactive: some View {
        #if os(iOS)
        label(pressed).overlay { CoastingTapCatcher(pressed: $pressed, action: action) }
        #else
        label(pressed)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in if !pressed { pressed = true } }
                    .onEnded { value in
                        pressed = false
                        if abs(value.translation.width) < 12, abs(value.translation.height) < 12 { action() }
                    }
            )
        #endif
    }
}

#if os(iOS)
/// The iOS interactive layer for `CoastingButton`: a transparent UIKit view whose
/// `UILongPressGestureRecognizer` (min duration 0) recognizes alongside the List's scroll and owns the
/// touch, so a tap registers even mid-coast. Recognizer wiring mirrors `KeyboardDismissInstaller`.
private struct CoastingTapCatcher: UIViewRepresentable {
    @Binding var pressed: Bool
    let action: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(pressed: $pressed, action: action) }

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear
        let press = UILongPressGestureRecognizer(
            target: context.coordinator, action: #selector(Coordinator.handle(_:)))
        press.minimumPressDuration = 0
        press.delegate = context.coordinator
        press.cancelsTouchesInView = false
        view.addGestureRecognizer(press)
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.pressed = $pressed
        context.coordinator.action = action
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var pressed: Binding<Bool>
        var action: () -> Void
        private var start: CGPoint?

        init(pressed: Binding<Bool>, action: @escaping () -> Void) {
            self.pressed = pressed
            self.action = action
        }

        @objc func handle(_ gesture: UILongPressGestureRecognizer) {
            switch gesture.state {
            case .began:
                start = gesture.location(in: gesture.view)
                pressed.wrappedValue = true
            case .changed:
                if !isTap(gesture) { pressed.wrappedValue = false }
            // Fire on ANY terminal state, not just .ended. While the List is coasting the scroll view
            // grabs the touch to halt deceleration and CANCELS this recognizer (.began → .cancelled)
            // before the finger lifts — so a mid-coast tap never reached .ended and was silently lost
            // (the touch DID arrive: the press-magnify fired). Treat a stationary cancelled/failed press
            // as the tap too; a real drag that began here moved past isTap's threshold and is filtered.
            case .ended, .cancelled, .failed:
                let tap = isTap(gesture)
                pressed.wrappedValue = false
                if tap { action() }
            default:
                break
            }
        }

        // A tap = the finger never wandered far from where it landed; a longer drag is a scroll that
        // merely began on the control, so it must not fire the action.
        private func isTap(_ gesture: UILongPressGestureRecognizer) -> Bool {
            guard let start else { return true }
            let p = gesture.location(in: gesture.view)
            return abs(p.x - start.x) <= 12 && abs(p.y - start.y) <= 12
        }

        // Recognize alongside the List's scroll — never block it (mirrors KeyboardDismissInstaller).
        func gestureRecognizer(_ gesture: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
    }
}

/// Holds the transcript List's `UIScrollView`, located by `ScrollTouchConfigurator`. The jump-to-latest
/// action uses it to cancel the list's deceleration so the follow-up `proxy.scrollTo(bottomID)` — which
/// the momentum would otherwise swallow — actually reaches the bottom row.
final class TranscriptScroll {
    weak var view: UIScrollView?

    /// Cancel any in-flight deceleration (the coast) in place, so a follow-up `proxy.scrollTo` lands
    /// instead of being swallowed by the momentum. No-op until the scroll view is located.
    func halt() {
        guard let v = view else { return }
        v.setContentOffset(v.contentOffset, animated: false)
    }
}

/// Reaches the transcript List's underlying `UIScrollView` to (1) set `delaysContentTouches = false` so
/// an in-list control registers a tap even while the list is coasting (the default delays and consumes
/// that first touch to halt deceleration), and (2) hand the scroll view to `TranscriptScroll` so the
/// jump-to-latest action can force-scroll to the bottom mid-coast. No public SwiftUI API exposes either,
/// so an inert probe walks the UIKit hierarchy to the scroll view.
private struct ScrollTouchConfigurator: UIViewRepresentable {
    let scroll: TranscriptScroll
    func makeUIView(context: Context) -> ProbeView { ProbeView(scroll: scroll) }
    func updateUIView(_ uiView: ProbeView, context: Context) { uiView.apply() }

    final class ProbeView: UIView {
        let scroll: TranscriptScroll
        init(scroll: TranscriptScroll) {
            self.scroll = scroll
            super.init(frame: .zero)
            isUserInteractionEnabled = false   // inert: only introspects, never intercepts touches
        }
        required init?(coder: NSCoder) { fatalError("not used") }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            apply()
        }

        func apply() {
            guard let scrollView = findScrollView() else { return }
            scrollView.delaysContentTouches = false
            scroll.view = scrollView
        }

        // Walk up from the probe; at each ancestor also scan its subtree, so the List's scroll view is
        // found whether it sits above this background probe or beside it.
        private func findScrollView() -> UIScrollView? {
            var node: UIView? = superview
            while let current = node {
                if let scrollView = current as? UIScrollView { return scrollView }
                if let scrollView = Self.firstScrollView(in: current) { return scrollView }
                node = current.superview
            }
            return nil
        }

        private static func firstScrollView(in view: UIView) -> UIScrollView? {
            for sub in view.subviews {
                if let scrollView = sub as? UIScrollView { return scrollView }
                if let scrollView = firstScrollView(in: sub) { return scrollView }
            }
            return nil
        }
    }
}
#endif

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
            Label("Interrupted", systemImage: "stop.circle").font(.orbitLabel).foregroundStyle(.secondary)
        case .error(_, let message):
            Label(message, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.red).textSelection(.enabled)
        }
    }
}
