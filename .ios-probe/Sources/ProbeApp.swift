import SwiftUI
import UIKit
import OrbitKit

/// EVIDENCE ONLY — what the transcript's tail-pinning machinery is actually told, on an iOS
/// simulator, at the instant a stretch of reasoning folds to its one-line summary. Never shipped,
/// never a gate; the delivered branch does not carry this directory (see `.ios-probe/run.sh`).
///
/// The complaint (owner, iOS, 2026-09-22, on build 3270 — which contains the 2026-09-17 fix
/// d7b3db9b4 "keep following the tail when a reasoning row folds to its summary"): "when the
/// thinking ends the chat is no longer at the bottom, it has scrolled up a lot". So the rule that
/// was supposed to survive the fold is not surviving it on this platform.
///
/// The rule (`TailPinning`, the real one, imported from OrbitKit) needs one fact per sample beyond
/// the geometry: whether the READER was the one moving the list. Today that fact is SwiftUI's
/// `onScrollPhaseChange`. This probe reproduces the arrangement — a `List` + the transcript's own
/// scroll tracker + a reasoning row that streams inside a 160pt self-scrolling box and then folds
/// to a one-line row + the follow-on `scrollTo(bottomID)` on every state revision — and logs, per
/// frame: the phase, the geometry sample, and what the real `UIScrollView` says about it
/// (`isTracking`/`isDragging`/`isDecelerating`/pan state). The verdict is read off the collection
/// view (is the tail row on screen?), so it does not depend on the probe's own arithmetic.
///
/// The variant comes from the environment; `run.sh` builds once and relaunches the same binary per
/// variant, then collects `Documents/report.txt`.
@main
struct ProbeApp: App {
    var body: some Scene { WindowGroup { ProbeRoot() } }
}

/// Which shape the reasoning row folds in.
enum Variant: String {
    /// Today's real spelling: `DisclosureGroup` whose `isExpanded` binding flips when the block
    /// settles, with the streaming draft in a 160pt inner `ScrollView`.
    case disclosure
    /// The same row without the DisclosureGroup (a plain if/else swap), to tell "the fold" from
    /// "the disclosure".
    case plain
    /// No fold at all: the row keeps its height and only the reply keeps arriving — the control
    /// that says whether the tracker follows at all on this platform.
    case nofold
    /// A programmatic scroll UP to an older row (the sticky header's jump-back) mid-stream: what
    /// phase does a scroll nobody's finger caused report as, and does it un-pin?
    case jump
    /// A REAL finger: the UI test drags the list up while the reply streams, and the app then
    /// re-pins the way the jump-to-latest disc does, waits for the fold — and asks whether the
    /// fold un-pins a tail the reader left long ago. This is the arrangement the owner's phone is
    /// in when the complaint happens: they have touched the transcript at some point in the
    /// session, and from then on every fold strands the view.
    case swipe

    static var current: Variant {
        Variant(rawValue: ProcessInfo.processInfo.environment["PROBE_VARIANT"] ?? "") ?? .disclosure
    }
}

// MARK: - The trace

/// Everything the probe learns, in order, written to Documents at the end. `print` is not a
/// channel here: the app runs under `simctl launch` and its stdout is not collected.
final class Trace {
    static let shared = Trace()
    private var lines: [String] = []
    private let start = Date()

    private func stamp() -> String { String(format: "%.3f", Date().timeIntervalSince(start)) }

    func log(_ what: String) { lines.append("[\(stamp())] \(what)") }

    /// A picture of the end state, written beside the trace: the trace says where the list is, the
    /// screenshot is what a reader would see.
    func snapshot() {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
              let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first else { return }
        let renderer = UIGraphicsImageRenderer(bounds: window.bounds)
        let image = renderer.image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        try? image.pngData()?.write(to: docs.appendingPathComponent("shot.png"))
    }

    func write(extra: [String: String]) {
        var out = lines.joined(separator: "\n") + "\n"
        for key in extra.keys.sorted() { out += "\(key)=\(extra[key] ?? "")\n" }
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        try? out.write(to: docs.appendingPathComponent("report.txt"), atomically: true, encoding: .utf8)
        FileManager.default.createFile(atPath: docs.appendingPathComponent("done").path, contents: nil)
    }
}

// MARK: - The live UIScrollView, and what it says

/// The transcript's own handle on the List's `UIScrollView` (the app has the same thing in
/// `TranscriptScroll`, reached by `ScrollTouchConfigurator`). This probe only reads it.
final class ScrollHandle {
    weak var view: UIScrollView?
    /// What SwiftUI's `onScrollPhaseChange` says about who is moving the list — the fact the
    /// shipped rule reads today, kept beside UIKit's own answer so the trace can compare them.
    var phaseDriven = false

    /// What UIKit itself reports: the facts SwiftUI's phase is derived from, and the ones the app
    /// could ask for directly.
    var flags: String {
        guard let v = view else { return "no-scrollview" }
        let pan: String
        switch v.panGestureRecognizer.state {
        case .possible: pan = "possible"
        case .began: pan = "began"
        case .changed: pan = "changed"
        case .ended: pan = "ended"
        case .cancelled: pan = "cancelled"
        case .failed: pan = "failed"
        @unknown default: pan = "?"
        }
        return "tracking=\(v.isTracking ? 1 : 0) dragging=\(v.isDragging ? 1 : 0) "
             + "decel=\(v.isDecelerating ? 1 : 0) pan=\(pan)"
    }

    /// A finger on the list, or the momentum one left behind. UIKit's own answer — the thing the
    /// fix would read if SwiftUI's phase turns out not to report what its name says.
    var isReader: Bool { (view?.isTracking ?? false) || (view?.isDragging ?? false) }

    /// How far the viewport's bottom edge sits above the content's end. The negative readings this
    /// probe produces are the bottom safe area, not a bug: it is computed the way `TailScrollSample`
    /// computes `bottomGap`, from the same numbers.
    var gap: Int {
        guard let v = view else { return .min }
        return Int(v.contentSize.height - (v.contentOffset.y + v.bounds.height - v.adjustedContentInset.bottom))
    }

    /// The tail row's own visibility — the question the complaint is about, answered without the
    /// probe's arithmetic where the list is a collection view, and by the gap above where it is
    /// not (on iOS 26 the SwiftUI List is evidently not one — see the SCROLLVIEW line in the trace).
    var tail: String {
        let gapText = "gap=\(gap)"
        guard let cv = view as? UICollectionView else {
            return "not-a-collectionview \(gapText)"
        }
        let items = cv.indexPathsForVisibleItems
        guard let last = items.max(by: { ($0.section, $0.item) < ($1.section, $1.item) }) else {
            return "no-visible-items \(gapText)"
        }
        let total = cv.numberOfItems(inSection: last.section)
        return "last=\(last.item) of=\(total - 1) atBottom=\(last.item >= total - 1 ? 1 : 0) \(gapText)"
    }
}

/// Locates the List's scroll view without touching it.
struct ScrollProbeView: UIViewRepresentable {
    let handle: ScrollHandle
    func makeUIView(context: Context) -> ProbeView { ProbeView(handle: handle) }
    func updateUIView(_ uiView: ProbeView, context: Context) { uiView.apply() }

    final class ProbeView: UIView {
        let handle: ScrollHandle
        init(handle: ScrollHandle) {
            self.handle = handle
            super.init(frame: .zero)
            isUserInteractionEnabled = false
        }
        required init?(coder: NSCoder) { fatalError("not used") }
        override func didMoveToWindow() { super.didMoveToWindow(); apply() }

        private var tries = 0

        func apply() {
            if let v = findScrollView() {
                if handle.view !== v {
                    handle.view = v
                    Trace.shared.log("SCROLLVIEW \(type(of: v)) frame=\(v.frame) inset=\(v.adjustedContentInset)")
                }
                return
            }
            // `didMoveToWindow` can fire before the List has built its scroll view, and SwiftUI does
            // not promise another `updateUIView` — so retry rather than report no-scrollview forever
            // (that is exactly what the first run of this probe did).
            tries += 1
            guard tries < 60 else {
                Trace.shared.log("SCROLLVIEW never found after \(tries) tries; window=\(String(describing: window))")
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in self?.apply() }
        }
        private func findScrollView() -> UIScrollView? {
            var node: UIView? = superview
            while let current = node {
                if let sv = current as? UIScrollView { return sv }
                if let sv = Self.firstScrollView(in: current) { return sv }
                node = current.superview
            }
            return nil
        }
        private static func firstScrollView(in view: UIView) -> UIScrollView? {
            for sub in view.subviews {
                if let sv = sub as? UIScrollView { return sv }
                if let sv = firstScrollView(in: sub) { return sv }
            }
            return nil
        }
    }
}

// MARK: - The tracker, copied from ConsoleView.swift

/// The app's single scroll observer — `ConsoleView`'s `ScrollTracker`, with one addition: it logs
/// every phase change and every geometry sample it is handed, with UIKit's own reading beside them.
/// The decision itself is the shipped `TailPinning.pinned`.
private struct ProbeTracker: ViewModifier {
    @Binding var atBottom: Bool
    let handle: ScrollHandle
    @State private var readerDriven = false

    func body(content: Content) -> some View {
        content
            .onScrollPhaseChange { _, phase in
                readerDriven = phase != .idle && phase != .animating
                handle.phaseDriven = readerDriven
                Trace.shared.log("PHASE \(phase) readerDriven=\(readerDriven ? 1 : 0) uikit[\(handle.flags)]")
            }
            .onScrollGeometryChange(for: TailScrollSample.self) { geo in
                TailScrollSample(offset: Double(geo.contentOffset.y),
                                 contentHeight: Double(geo.contentSize.height),
                                 bottomGap: Double(geo.contentSize.height - geo.visibleRect.maxY))
            } action: { was, now in
                let before = atBottom
                atBottom = TailPinning.pinned(wasPinned: atBottom, from: was, to: now,
                                              readerDriven: readerDriven)
                Trace.shared.log("SAMPLE was(\(Int(was.offset)),\(Int(was.contentHeight)),\(Int(was.bottomGap))) "
                                 + "now(\(Int(now.offset)),\(Int(now.contentHeight)),\(Int(now.bottomGap))) "
                                 + "readerDriven=\(readerDriven ? 1 : 0) "
                                 + "atBottom=\(before ? 1 : 0)->\(atBottom ? 1 : 0) uikit[\(handle.flags)]")
            }
    }
}

// MARK: - The transcript under test

struct PRow: Identifiable, Equatable {
    enum Kind: Equatable {
        case prose(String)
        case thinking(String, Bool)
    }
    let id: String
    let kind: Kind
}

/// The reasoning row: the app's `ThinkingView` shape, with `Text` standing in for the markdown body
/// (what is measured here is the row's HEIGHT as it settles, not its prose).
private struct ThinkingRow: View {
    let text: String
    let finalized: Bool
    private static let tailAnchor = "thinking-tail"

    var body: some View {
        if Variant.current == .plain {
            VStack(alignment: .leading, spacing: 6) {
                Label(label, systemImage: "brain").font(.footnote).foregroundStyle(.secondary)
                if !finalized { draft }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            DisclosureGroup(isExpanded: .constant(!finalized)) { draft } label: {
                Label(label, systemImage: "brain").font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder private var draft: some View {
        ScrollViewReader { proxy in
            ScrollView {
                Text(text).font(.callout).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .id(Self.tailAnchor)
            }
            .frame(maxHeight: 160)
            .onChange(of: text, initial: true) { _, _ in proxy.scrollTo(Self.tailAnchor, anchor: .bottom) }
        }
    }

    private var label: String {
        finalized
            ? ThinkingSummary.settledLabel(chars: text.count, blocks: 1, startedTs: nil, finishedTs: nil)
            : "Thinking…"
    }
}

struct ProbeRoot: View {
    @State private var rows: [PRow] = []
    /// The app's `console.stateRevision`: bumped once per published snapshot, and the thing the
    /// follow-on scroll is keyed to.
    @State private var revision = 0
    @State private var atBottom = true
    @State private var handle = ScrollHandle()
    private let bottomID = "transcript-bottom"

    var body: some View {
        ScrollViewReader { proxy in
            List {
                ForEach(rows) { row in
                    rowView(row)
                        .listRowInsets(EdgeInsets(top: 3, leading: 16, bottom: 3, trailing: 16))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
                // The app's `TranscriptRow.bottom`: the 1pt scroll target the follow lands on.
                Color.clear.frame(height: 1).id(bottomID)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
            .listStyle(.plain)
            .environment(\.defaultMinListRowHeight, 0)
            .scrollContentBackground(.hidden)
            .defaultScrollAnchor(.bottom)
            .background { ScrollProbeView(handle: handle) }
            .modifier(ProbeTracker(atBottom: $atBottom, handle: handle))
            // The app's follow: one non-animated scroll to the tail on every state revision, while
            // the reader is still pinned there.
            .onChange(of: revision) {
                if atBottom {
                    proxy.scrollTo(bottomID, anchor: .bottom)
                    Trace.shared.log("FOLLOW scrollTo(bottom) tail[\(handle.tail)]")
                } else {
                    Trace.shared.log("FOLLOW skipped atBottom=0 tail[\(handle.tail)]")
                }
            }
            .onAppear { proxy.scrollTo(bottomID, anchor: .bottom) }
        }
        .task { await script() }
    }

    @ViewBuilder private func rowView(_ row: PRow) -> some View {
        switch row.kind {
        case .prose(let text):
            Text(text).font(.body).frame(maxWidth: .infinity, alignment: .leading)
        case .thinking(let text, let finalized):
            ThinkingRow(text: text, finalized: finalized)
        }
    }

    // MARK: - The script

    private func mark(_ what: String) {
        Trace.shared.log("MARK \(what) atBottom=\(atBottom ? 1 : 0) uikit[\(handle.flags)] tail[\(handle.tail)]")
    }

    @MainActor
    private func script() async {
        let variant = Variant.current
        Trace.shared.log("START variant=\(variant.rawValue) nearBottom=\(Int(TailPinning.nearBottom))")
        for i in 0..<40 {
            rows.append(PRow(id: UUID().uuidString, kind: .prose("history row \(i) — "
                + String(repeating: "the transcript is long enough to scroll. ", count: 6 + (i % 5) * 5))))
            revision += 1
        }
        try? await Task.sleep(for: .seconds(1.2))
        mark("PRE-THINKING")

        let thinkingID = UUID().uuidString
        rows.append(PRow(id: thinkingID, kind: .thinking("", false)))
        revision += 1
        for _ in 0..<30 {
            try? await Task.sleep(for: .milliseconds(80))
            stream(thinkingID, String(repeating: "reasoning words ", count: 6))
        }
        if variant == .swipe {
            // The reader's own drag, whenever the UI test delivers it: the reply keeps streaming
            // slowly underneath, and this waits for the finger rather than for a schedule (the
            // runner made the test swipe 13s in, not the 5s its own sleep asked for).
            Trace.shared.log("GESTURE-WINDOW-OPEN")
            var seen: Date?
            let deadline = Date().addingTimeInterval(40)
            var n = 0
            while seen == nil, Date() < deadline {
                try? await Task.sleep(for: .milliseconds(100))
                n += 1
                if n % 5 == 0 { stream(thinkingID, String(repeating: "reasoning words ", count: 6)) }
                if handle.isReader || handle.phaseDriven || (handle.view?.isDecelerating ?? false) {
                    seen = Date()
                    Trace.shared.log("GESTURE-SEEN uikit[\(handle.flags)] phaseDriven=\(handle.phaseDriven ? 1 : 0)")
                }
            }
            if seen == nil { Trace.shared.log("GESTURE-NEVER-SEEN") }
            // Everything stopped moving: the finger is gone and so is the coast it left.
            var quiet = 0
            while quiet < 15, Date() < deadline {
                try? await Task.sleep(for: .milliseconds(100))
                if !(handle.isReader || handle.view?.isDecelerating ?? false) { quiet += 1 } else { quiet = 0 }
            }
            mark("POST-GESTURE")
            // The disc's own action, verbatim in effect: halt the coast, scroll to the tail row, and
            // declare the reader pinned. This is where the reader was when the complaint happened.
            atBottom = true
            Trace.shared.log("REPINNED (disc action)")
            try? await Task.sleep(for: .milliseconds(500))
            // The app's real shape: the reasoning row settles and the answer's first row arrives in
            // the same publish (the reducer's `finalizeThinking` and the next `text_delta`).
            settle(thinkingID)
            rows.append(PRow(id: UUID().uuidString, kind: .prose("the answer begins — "
                + String(repeating: "and it keeps being written after the reasoning settles. ", count: 8))))
            revision += 1
            Trace.shared.log("FOLD issued (with the answer's first row)")
            try? await Task.sleep(for: .milliseconds(1500))
            mark("POST-FOLD")
            for step in 0..<6 {
                try? await Task.sleep(for: .milliseconds(200))
                mark("POST-FOLD+\(1500 + (step + 1) * 200)ms")
            }
            let swipeTail = handle.tail
            Trace.shared.snapshot()
            Trace.shared.write(extra: [
                "VERDICT variant": variant.rawValue,
                "VERDICT atBottom_end": atBottom ? "1" : "0",
                "VERDICT tail_end": swipeTail,
                "VERDICT gap_end": "\(handle.gap)",
                "VERDICT reproduce": (atBottom && handle.gap <= 80) ? "NO" : "YES",
            ])
            return
        }
        mark("STREAMING-DONE")

        if variant != .nofold {
            settle(thinkingID)
            Trace.shared.log("FOLD issued")
        }
        if variant == .jump {
            // A scroll nobody's finger caused, the way the sticky header's jump-back moves the list.
            if let v = handle.view {
                v.setContentOffset(CGPoint(x: 0, y: max(0, v.contentOffset.y - 600)), animated: false)
            }
            Trace.shared.log("JUMP issued")
        }
        // The frames the fold's own layout lands on.
        for step in 0..<6 {
            try? await Task.sleep(for: .milliseconds(120))
            mark("POST-FOLD+\(step * 120)ms")
        }

        // The reply keeps arriving — this is what "runs away below the fold" means.
        for i in 0..<12 {
            try? await Task.sleep(for: .milliseconds(200))
            rows.append(PRow(id: UUID().uuidString, kind: .prose("reply row \(i) — "
                + String(repeating: "the answer keeps being written after the reasoning settles. ", count: 8))))
            revision += 1
        }
        try? await Task.sleep(for: .milliseconds(600))
        mark("END")

        let tail = handle.tail
        Trace.shared.snapshot()
        Trace.shared.write(extra: [
            "VERDICT variant": variant.rawValue,
            "VERDICT atBottom_end": atBottom ? "1" : "0",
            "VERDICT tail_end": tail,
            "VERDICT gap_end": "\(handle.gap)",
            "VERDICT reproduce": (atBottom && handle.gap <= 80) ? "NO" : "YES",
        ])
    }

    @MainActor private func stream(_ id: String, _ chunk: String) {
        guard let i = rows.firstIndex(where: { $0.id == id }), case .thinking(let text, false) = rows[i].kind
        else { return }
        rows[i] = PRow(id: id, kind: .thinking(text + chunk, false))
        revision += 1
    }

    /// The durable `thinking` event: the open stretch settles and its row folds.
    @MainActor private func settle(_ id: String) {
        guard let i = rows.firstIndex(where: { $0.id == id }), case .thinking(let text, false) = rows[i].kind
        else { return }
        rows[i] = PRow(id: id, kind: .thinking(text, true))
        revision += 1
    }
}
