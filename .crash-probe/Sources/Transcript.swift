import SwiftUI
import UIKit

// `TranscriptView` as shipped in v0.1.2-beta.142 (ConsoleView.swift:336–890): the same List, the same
// modifier chain in the same order, the same scroll calls with the same anchors, animations and
// main-queue hops. What differs: row bodies are plain stand-ins of comparable height, every
// `proxy.scrollTo` goes through `scrollNow` (which logs what SwiftUI was asked for), and the
// synchronous ones go through `deferrable` so a candidate fix can be measured against the same script.

enum ScrollFix {
    /// The shipped code scrolls synchronously inside these handlers; `defer` posts the scroll to the
    /// next main-queue turn instead, after the List has taken the update it arrived with.
    static func deferrable(_ body: @escaping () -> Void) {
        if Probe.fix == "defer" {
            DispatchQueue.main.async(execute: body)
        } else {
            body()
        }
    }
}

enum LastScroll { static var text = "-" }

/// Candidate fix `route`: a scroll asked for outside an update, carried to the next one.
struct PendingScroll: Equatable {
    let id: String
    let anchor: UnitPoint
    let why: String
    let tick: Int
}

struct TranscriptView: View {
    let console: FakeConsole
    private let bottomID = PRow.bottom.id
    @State private var atBottom = true
    @State private var stuckID: String?
    @State private var ruler = QuestionRuler()
    @State private var transcriptScroll = TranscriptScroll()
    @State private var pendingScroll: PendingScroll?
    @State private var pendingTick = 0

    private func tracker(ruler: QuestionRuler) -> some ViewModifier {
        ScrollTracker(atBottom: $atBottom, ruler: ruler, recompute: recomputeStuck,
                      scroll: transcriptScroll)
    }

    private var canPageOlder: Bool {
        guard #available(iOS 18, macOS 15, *) else { return false }
        return console.state.hasMoreOlder
    }

    /// The body of a tap's main-queue hop. As shipped it scrolls right here, outside any update;
    /// under `route` it hands the target to `pendingScroll`, whose `.onChange` scrolls inside the
    /// next update — after that update has applied whatever rows were pending.
    private func hopScroll(_ proxy: ScrollViewProxy, _ id: String, _ anchor: UnitPoint, _ why: String) {
        if Probe.fix == "route" {
            let tick = pendingTick &+ 1
            pendingTick = tick
            pendingScroll = PendingScroll(id: id, anchor: anchor, why: why, tick: tick)
        } else {
            withAnimation(.easeOut(duration: 0.2)) { scrollNow(proxy, id, anchor, why) }
        }
    }

    private func scrollNow(_ proxy: ScrollViewProxy, _ id: String, _ anchor: UnitPoint, _ why: String) {
        let current = rows
        let index = current.firstIndex(where: { $0.id == id }).map { String($0) } ?? "absent"
        Stats.swiftUIScrolls += 1
        LastScroll.text = "\(why) id=\(id) index=\(index) rows=\(current.count)"
        Trace.shared.log("SWIFTUI scrollTo why=\(why) id=\(id) index=\(index) rows=\(current.count) "
                         + "atBottom=\(atBottom ? 1 : 0)")
        proxy.scrollTo(id, anchor: anchor)
    }

    var body: some View {
        ScrollViewReader { proxy in
            List {
                ForEach(rows) { row in
                    transcriptRow(row)
                        .listRowInsets(rowInsets(row))
                        .listRowSeparator(.hidden)
                        .listRowBackground(row.id == console.highlightedRowID
                                           ? Color.accentColor.opacity(0.14) : Color.clear)
                }
            }
            .listStyle(.plain)
            .environment(\.defaultMinListRowHeight, 0)
            .scrollContentBackground(.hidden)
            .background { ScrollTouchConfigurator(scroll: transcriptScroll) }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .modifier(tracker(ruler: ruler))
            .background {
                GeometryReader { g in
                    Color.clear.onChange(of: g.frame(in: .global).minY, initial: true) { _, y in ruler.viewportTop = y }
                }
            }
            .onChange(of: console.stateRevision) {
                let prependAnchor = console.takePrependAnchor()
                if atBottom && !console.detached {
                    ScrollFix.deferrable { scrollNow(proxy, bottomID, .bottom, "follow") }
                } else if let prependAnchor {
                    let target = ruler.topAnchorID ?? prependAnchor
                    ScrollFix.deferrable { scrollNow(proxy, target, .top, "prepend") }
                }
                recomputeStuck()
            }
            .onChange(of: console.stateRevision) { console.linkCardsRefreshStale() }
            .onChange(of: atBottom, initial: true) { _, pinned in
                console.setReadingHistory(!pinned)
            }
            .onChange(of: console.sessionID) {
                atBottom = true; ruler.reset(); stuckID = nil
                console.setReadingHistory(false)
                console.noteTopVisible(nil)
                ScrollFix.deferrable { scrollNow(proxy, bottomID, .bottom, "session") }
            }
            .onChange(of: console.localSendTick) {
                atBottom = true
                ScrollFix.deferrable { scrollNow(proxy, bottomID, .bottom, "send") }
            }
            .onChange(of: console.localStatusCards.count) {
                atBottom = true
                ScrollFix.deferrable { scrollNow(proxy, bottomID, .bottom, "status-card") }
            }
            .onChange(of: console.scrollRequest) { _, request in
                guard let request else { return }
                transcriptScroll.halt()
                DispatchQueue.main.async { hopScroll(proxy, request.rowID, .center, "needs-you") }
            }
            .onChange(of: console.recordRequest, initial: true) { _, request in
                guard let request else { return }
                atBottom = false
                console.recordRequestFollowed(request)
                transcriptScroll.halt()
                DispatchQueue.main.async { hopScroll(proxy, request.rowID, .center, "record") }
            }
            .onChange(of: pendingScroll) { _, request in
                guard let request else { return }
                withAnimation(.easeOut(duration: 0.2)) {
                    scrollNow(proxy, request.id, request.anchor, request.why)
                }
            }
            // Probe-only: the script "presses" the two buttons; the actions are the buttons' own.
            .onChange(of: console.probeStickyTick) { stickyAction(stuckBubble?.id ?? lastQuestionID, proxy) }
            .onChange(of: console.probeJumpTick) { jumpAction(proxy) }
            .onAppear {
                ScrollFix.deferrable { scrollNow(proxy, bottomID, .bottom, "appear") }
                recomputeStuck()
            }
            .overlay(alignment: .bottom) {
                if !atBottom || console.detached {
                    scrollToBottomButton(proxy: proxy)
                        .transition(.opacity.combined(with: .move(edge: .bottom)))
                }
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                if #available(iOS 18, macOS 15, *), let q = stuckBubble {
                    stickyQuestion(q, proxy: proxy)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.easeOut(duration: 0.15), value: atBottom)
            .animation(.easeOut(duration: 0.15), value: stuckID == nil)
        }
    }

    private func recomputeStuck() {
        let items = console.state.items
        console.noteTopVisible(ruler.topAnchorID)
        var found: String? = nil
        if let anchor = ruler.topAnchorID {
            for item in items {
                if item.id == anchor { break }
                if item.kind == .user { found = item.id }
            }
        } else if ruler.contentOffset > 40 {
            for item in items.reversed() where item.kind == .user {
                found = item.id
                break
            }
        }
        if found != stuckID { stuckID = found }
    }

    private var stuckBubble: PItem? {
        guard let id = stuckID else { return nil }
        for item in console.state.items.reversed() where item.kind == .user && item.id == id { return item }
        return nil
    }

    private var lastQuestionID: String? {
        console.state.items.dropLast(30).last(where: { $0.kind == .user })?.id
    }

    private var rows: [PRow] {
        ProbeRows.build(state: console.state,
                        statusCards: console.localStatusCards,
                        canPageOlder: canPageOlder,
                        showWorkingIndicator: console.showWorkingIndicator,
                        decisionCards: console.decisionCards)
    }

    private func rowInsets(_ row: PRow) -> EdgeInsets {
        switch row {
        case .loadOlder: return EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16)
        case .bottom:    return EdgeInsets()
        default:         return EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16)
        }
    }

    @ViewBuilder
    private func transcriptRow(_ row: PRow) -> some View {
        switch row {
        case .loadOlder:
            HStack {
                Spacer()
                ProgressView().controlSize(.small)
                Spacer()
            }
            .onAppear { Task { await console.loadOlder() } }
        case .item(let item):
            ItemRow(item: item)
                .modifier(AnchorRow(itemID: item.id, ruler: ruler, recompute: recomputeStuck))
        case .toolGroup(let cards):
            HStack(spacing: 6) {
                Image(systemName: "square.stack.3d.up")
                Text("\(cards.first?.text ?? "") × \(cards.count)").lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(8)
            .background(Color.gray.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
        case .statusCard(let card):
            CardRow(title: "/status", detail: card.id)
        case .decisionCard(let card):
            CardRow(title: "Confirm the new criteria?", detail: card.id)
        case .approval(let approval):
            CardRow(title: "Approval needed", detail: approval.id)
        case .working:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Working…").foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
        case .queued(let bubble):
            HStack {
                Spacer(minLength: 40)
                Text(bubble.text).padding(10)
                    .background(Color.gray.opacity(0.15), in: RoundedRectangle(cornerRadius: 14))
            }
        case .bottom:
            if console.detached {
                HStack {
                    Spacer()
                    ProgressView().controlSize(.small)
                    Spacer()
                }
                .padding(.vertical, 8)
                .onAppear { Task { await console.loadNewer() } }
            } else {
                Color.clear.frame(height: 1)
            }
        }
    }

    // The sticky header's tap (iOS branch of `stickyQuestion`'s action).
    private func stickyAction(_ id: String?, _ proxy: ScrollViewProxy) {
        atBottom = false
        transcriptScroll.halt()
        guard let id else { return }
        DispatchQueue.main.async { hopScroll(proxy, id, .top, "sticky") }
    }

    // The jump-to-latest disc's tap (iOS branch of `scrollToBottomButton`'s action).
    private func jumpAction(_ proxy: ScrollViewProxy) {
        if console.detached {
            atBottom = true
            Task { await console.jumpToLatest() }
            return
        }
        transcriptScroll.halt()
        DispatchQueue.main.async { hopScroll(proxy, bottomID, .bottom, "jump") }
        atBottom = true
    }

    private func stickyQuestion(_ bubble: PItem, proxy: ScrollViewProxy) -> some View {
        CoastingButton {
            stickyAction(bubble.id, proxy)
        } label: { _ in
            HStack(spacing: 8) {
                Text("Your question").font(.caption).foregroundStyle(.secondary)
                    .lineLimit(1).truncationMode(.tail).layoutPriority(1)
                Text(bubble.text).font(.subheadline).foregroundStyle(.primary)
                    .lineLimit(1).truncationMode(.tail)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16).padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.bar)
            .overlay(alignment: .bottom) { VStack(spacing: 0) { Divider() } }
            .contentShape(Rectangle())
        }
    }

    private func scrollToBottomButton(proxy: ScrollViewProxy) -> some View {
        CoastingButton {
            jumpAction(proxy)
        } label: { pressed in
            Image(systemName: "arrow.down")
                .foregroundStyle(.primary)
                .frame(width: 40, height: 40)
                .background(Circle().fill(Color(uiColor: .systemBackground)))
                .shadow(radius: pressed ? 6 : 3)
                .scaleEffect(pressed ? 1.2 : 1)
                .frame(width: 44, height: 44)
        }
        .padding(.bottom, 6)
    }
}

struct ItemRow: View {
    let item: PItem

    var body: some View {
        switch item.kind {
        case .user:
            HStack {
                Spacer(minLength: 40)
                Text(item.text).padding(10)
                    .background(Color.accentColor.opacity(0.15), in: RoundedRectangle(cornerRadius: 14))
            }
        case .assistant:
            Text(item.text.isEmpty ? " " : item.text)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .thinking:
            VStack(alignment: .leading, spacing: 4) {
                Label(item.finalized ? "Thought" : "Thinking…", systemImage: "brain")
                    .font(.footnote).foregroundStyle(.secondary)
                if !item.finalized {
                    Text(item.text).font(.callout).foregroundStyle(.secondary).lineLimit(6)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .tool:
            HStack(spacing: 6) {
                Image(systemName: item.running ? "circle.dotted" : "checkmark.circle")
                Text(item.text).font(.callout.monospaced()).lineLimit(1)
                Spacer(minLength: 0)
            }
        }
    }
}

struct CardRow: View {
    let title: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.headline)
            Text(detail).font(.footnote).foregroundStyle(.secondary)
            HStack {
                Text("Yes").padding(.horizontal, 12).padding(.vertical, 6)
                    .background(Color.accentColor.opacity(0.2), in: Capsule())
                Text("No").padding(.horizontal, 12).padding(.vertical, 6)
                    .background(Color.gray.opacity(0.2), in: Capsule())
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.gray.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
    }
}

// ---- copied verbatim from src/macos/OrbitApp/Sources/OrbitApp/Views/Console/ConsoleView.swift @ v0.1.2-beta.142 (only `private` dropped) ----

struct CoastingButton<Label: View>: View {
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
struct CoastingTapCatcher: UIViewRepresentable {
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
struct ScrollTouchConfigurator: UIViewRepresentable {
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
struct ScrollTracker: ViewModifier {
    @Binding var atBottom: Bool
    let ruler: QuestionRuler
    let recompute: () -> Void
    #if os(iOS)
    /// The List's own `UIScrollView`, for the one fact UIKit knows better than any geometry: whether
    /// a finger is on it. See `readerIsMoving`.
    let scroll: TranscriptScroll
    #endif
    /// Whether the reader is the one moving the list: a finger on it, or the momentum of one.
    /// `.animating` is SwiftUI moving it (a jump-to-latest, the sticky header) and `.idle` is it
    /// sitting still while content is re-laid-out underneath — neither is a reader. `TailPinning`
    /// needs the difference to tell a drag up from the clamp a row that shrank forces.
    @State private var readerDriven = false

    /// What the platform can say about that — see `TailPinning.ReaderEvidence`. iOS reports drags,
    /// measured with a synthesized one on the simulator: `interacting` for the finger and
    /// `decelerating` for its coast, each with the offset following it. macOS keeps the geometry
    /// rule, where a fall over content that did not resize is the only evidence of a reader there
    /// is.
    #if os(iOS)
    private static let evidence = TailPinning.ReaderEvidence.reported
    #else
    private static let evidence = TailPinning.ReaderEvidence.inferred
    #endif

    /// The reader's own movement, from the phase plus — on iOS — UIKit's unambiguous "a finger is
    /// down", so a drag is never missed because SwiftUI happened to be animating something else.
    private var readerIsMoving: Bool {
        if readerDriven { return true }
        #if os(iOS)
        guard let v = scroll.view else { return false }
        return v.isTracking || v.isDragging
        #else
        return false
        #endif
    }

    func body(content: Content) -> some View {
        if #available(macOS 15, iOS 18, *) {
            content
                .onScrollPhaseChange { _, phase in
                    readerDriven = phase != .idle && phase != .animating
                }
                .onScrollGeometryChange(for: TailScrollSample.self) { geo in
                    TailScrollSample(offset: Double(geo.contentOffset.y),
                                     contentHeight: Double(geo.contentSize.height),
                                     bottomGap: Double(geo.contentSize.height - geo.visibleRect.maxY))
                } action: { was, now in
                    atBottom = TailPinning.pinned(wasPinned: atBottom, from: was, to: now,
                                                  readerDriven: readerIsMoving,
                                                  evidence: Self.evidence)
                    ruler.contentOffset = CGFloat(now.offset)
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
struct AnchorRow: ViewModifier {
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
