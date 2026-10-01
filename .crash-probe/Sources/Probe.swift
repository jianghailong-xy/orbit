import SwiftUI
import UIKit
import ObjectiveC

// EVIDENCE ONLY — never shipped, never a gate. Reproduces TestFlight crash D8B79F89 (Orbit 0.1.2
// build 4028 = v0.1.2-beta.142, iPhone17,2, iOS 26.6.1): SIGABRT from
// -[UICollectionView _validateScrollingTargetIndexPath:] under SwiftUI's
// UpdateCoalescingCollectionView.updateContent(), 4.9s after launch. The transcript `List` is the
// only `List` in the iOS app that is scrolled programmatically, so this app renders that List the
// way `TranscriptView` (v0.1.2-beta.142) does and feeds it the row changes `ConsoleModel` makes.
//
// Every scroll SwiftUI hands UIKit goes through the swizzled private entry point named in the crash
// (`_scrollToItemAtPresentationIndexPath:…`), which logs the target against the collection view's
// item count at that instant. `PROBE_MODE=count` skips an out-of-bounds one (so a run counts every
// occurrence); `crash` lets it through to abort exactly as the phone did.

enum Probe {
    static let env = ProcessInfo.processInfo.environment
    static let scenario = env["PROBE_SCENARIO"] ?? "fuzz"
    static let mode = env["PROBE_MODE"] ?? "count"
    /// `none` = the scroll calls as shipped. Anything else names a candidate fix (see `ScrollFix`).
    static let fix = env["PROBE_FIX"] ?? "none"
    static let seed = UInt64(env["PROBE_SEED"] ?? "1") ?? 1
    static let seconds = Double(env["PROBE_SECONDS"] ?? "14") ?? 14
}

enum Stats {
    static var uikitScrolls = 0
    static var outOfBounds = 0
    static var swiftUIScrolls = 0
    static var batches = 0
    static var publishes = 0
    static var firstOOB = ""
}

// MARK: - Trace (buffered; flushed on a timer, on the uncaught exception, and at the end)

final class Trace {
    static let shared = Trace()
    private let start = Date()
    private var buffer: [String] = []
    private let url: URL
    private let doneURL: URL

    init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        url = docs.appendingPathComponent("trace.txt")
        doneURL = docs.appendingPathComponent("done")
        try? FileManager.default.removeItem(at: doneURL)
        try? "".write(to: url, atomically: true, encoding: .utf8)
    }

    func log(_ s: String) {
        buffer.append(String(format: "[%7.3f] ", Date().timeIntervalSince(start)) + s)
        if buffer.count >= 400 { flush() }
    }

    func flush() {
        guard !buffer.isEmpty else { return }
        let text = buffer.joined(separator: "\n") + "\n"
        buffer.removeAll()
        if let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile()
            h.write(Data(text.utf8))
            try? h.close()
        }
    }

    func finish(_ verdict: String) {
        log(verdict)
        flush()
        FileManager.default.createFile(atPath: doneURL.path, contents: Data(verdict.utf8))
        FileHandle.standardError.write(Data((verdict + "\n").utf8))
    }
}

func verdictLine(_ word: String) -> String {
    "VERDICT \(word) scenario=\(Probe.scenario) mode=\(Probe.mode) fix=\(Probe.fix) seed=\(Probe.seed) "
        + "oob=\(Stats.outOfBounds) uikitScrolls=\(Stats.uikitScrolls) swiftuiScrolls=\(Stats.swiftUIScrolls) "
        + "batches=\(Stats.batches) publishes=\(Stats.publishes) first=[\(Stats.firstOOB)]"
}

func installExceptionHandler() {
    NSSetUncaughtExceptionHandler { e in
        Trace.shared.log("EXCEPTION \(e.name.rawValue): \(e.reason ?? "-")")
        Trace.shared.log("STACK " + e.callStackSymbols.prefix(18).joined(separator: " | "))
        Trace.shared.finish(verdictLine("CRASHED"))
    }
}

// MARK: - What UIKit is asked to do

extension UICollectionView {
    /// The private entry point on the crash's stack. NSIndexPath, not IndexPath: a bridged
    /// IndexPath traps on `.item` when the path is not two levels deep.
    @objc(probe_scrollToItemAtPresentationIndexPath:atScrollPosition:additionalInsets:animated:)
    func probe_scrollToItem(atPresentationIndexPath ip: NSIndexPath, atScrollPosition position: UInt,
                            additionalInsets insets: UIEdgeInsets, animated: Bool) {
        let section = ip.length > 0 ? ip.index(atPosition: 0) : -1
        let item = ip.length > 1 ? ip.index(atPosition: 1) : -1
        let sections = numberOfSections
        let count = (section >= 0 && section < sections) ? numberOfItems(inSection: section) : -1
        let oob = section < 0 || section >= sections || item < 0 || item >= count
        Stats.uikitScrolls += 1
        let line = "UIKIT scrollTo item=\(item) section=\(section) count=\(count) sections=\(sections) "
            + "pos=\(position) animated=\(animated ? 1 : 0) offset=\(Int(contentOffset.y)) "
            + "contentH=\(Int(contentSize.height))\(oob ? " OUT-OF-BOUNDS" : "")"
        Trace.shared.log(line)
        if oob {
            Stats.outOfBounds += 1
            if Stats.firstOOB.isEmpty { Stats.firstOOB = "item=\(item) count=\(count) data=\(LastCause.text) scroll=\(LastScroll.text)" }
            Trace.shared.log("OOB data=\(LastCause.text) scroll=\(LastScroll.text)")
            Trace.shared.flush()
            if Probe.mode == "count" { return }
        }
        // Exchanged: this calls UIKit's original.
        probe_scrollToItem(atPresentationIndexPath: ip, atScrollPosition: position,
                           additionalInsets: insets, animated: animated)
    }

    // Counting items BEFORE a batch update would make UIKit ask the data source early — the very
    // "invalid number of items" abort — so only the after-count is read.
    @objc(probe_performBatchUpdates:completion:)
    func probe_performBatchUpdates(_ updates: (() -> Void)?, completion: ((Bool) -> Void)?) {
        Stats.batches += 1
        Trace.shared.log("UIKIT batch begin")
        probe_performBatchUpdates(updates, completion: completion)
        let after = numberOfSections > 0 ? numberOfItems(inSection: 0) : -1
        Trace.shared.log("UIKIT batch end items=\(after)")
    }

    @objc(probe_insertItemsAtIndexPaths:)
    func probe_insertItems(_ paths: [NSIndexPath]) {
        Trace.shared.log("UIKIT insert n=\(paths.count) \(Self.span(paths))")
        probe_insertItems(paths)
    }

    @objc(probe_deleteItemsAtIndexPaths:)
    func probe_deleteItems(_ paths: [NSIndexPath]) {
        Trace.shared.log("UIKIT delete n=\(paths.count) \(Self.span(paths))")
        probe_deleteItems(paths)
    }

    @objc(probe_reloadData)
    func probe_reloadData() {
        Trace.shared.log("UIKIT reloadData")
        probe_reloadData()
    }

    @objc(probe_reloadSections:)
    func probe_reloadSections(_ sections: NSIndexSet) {
        Trace.shared.log("UIKIT reloadSections \(sections.count)")
        probe_reloadSections(sections)
    }

    private static func span(_ paths: [NSIndexPath]) -> String {
        let items = paths.compactMap { $0.length > 1 ? $0.index(atPosition: 1) : nil }
        guard let lo = items.min(), let hi = items.max() else { return "" }
        return "items=\(lo)...\(hi)"
    }
}

func installSwizzles() {
    let pairs: [(String, Selector)] = [
        ("_scrollToItemAtPresentationIndexPath:atScrollPosition:additionalInsets:animated:",
         #selector(UICollectionView.probe_scrollToItem(atPresentationIndexPath:atScrollPosition:additionalInsets:animated:))),
        ("performBatchUpdates:completion:", #selector(UICollectionView.probe_performBatchUpdates(_:completion:))),
        ("insertItemsAtIndexPaths:", #selector(UICollectionView.probe_insertItems(_:))),
        ("deleteItemsAtIndexPaths:", #selector(UICollectionView.probe_deleteItems(_:))),
        ("reloadData", #selector(UICollectionView.probe_reloadData)),
        ("reloadSections:", #selector(UICollectionView.probe_reloadSections(_:))),
    ]
    for (name, replacement) in pairs {
        guard let original = class_getInstanceMethod(UICollectionView.self, NSSelectorFromString(name)),
              let swapped = class_getInstanceMethod(UICollectionView.self, replacement) else {
            Trace.shared.log("SWIZZLE missing \(name)")
            continue
        }
        method_exchangeImplementations(original, swapped)
        Trace.shared.log("SWIZZLE ok \(name)")
    }
}

/// The last thing the script did before UIKit was asked to scroll — named in an OOB line.
enum LastCause { static var text = "-" }

// MARK: - App

@main
struct CrashProbeApp: App {
    init() {
        installExceptionHandler()
        installSwizzles()
        Trace.shared.log("START scenario=\(Probe.scenario) mode=\(Probe.mode) fix=\(Probe.fix) "
                         + "seed=\(Probe.seed) seconds=\(Probe.seconds) ios=\(UIDevice.current.systemVersion) "
                         + "device=\(UIDevice.current.name)")
    }

    var body: some Scene { WindowGroup { ProbeShell() } }
}

/// `CompactShell`'s shape on a phone: a section's `NavigationStack`, the console pushed onto it.
struct ProbeShell: View {
    @State private var model = ProbeModel()

    var body: some View {
        NavigationStack(path: $model.path) {
            List(model.sessionIDs, id: \.self) { sid in
                Button(sid) { model.open(sid) }
            }
            .navigationTitle("Agent")
            .navigationDestination(for: String.self) { sid in
                if sid == "swap" {
                    SwapScreen(model: model)
                } else {
                    ConsoleScreen(sessionID: sid, registry: model.registry)
                }
            }
        }
        .task { await model.runScenario() }
    }
}

/// `ConsoleView.consoleBody` on iOS: a GeometryReader around the transcript and the composer band.
struct ConsoleScreen: View {
    let sessionID: String
    let registry: FakeRegistry

    var body: some View {
        GeometryReader { _ in
            Group {
                if let console = registry.peek(sessionID) {
                    VStack(spacing: 0) {
                        TranscriptView(console: console)
                        ComposerStub()
                    }
                } else {
                    ProgressView()
                }
            }
        }
        .navigationTitle(sessionID)
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// iPad's reuse: one transcript whose console is swapped under it (`onChange(of: sessionID)`).
struct SwapScreen: View {
    let model: ProbeModel

    var body: some View {
        GeometryReader { _ in
            Group {
                if let console = model.registry.peek(model.swapSessionID) {
                    VStack(spacing: 0) {
                        TranscriptView(console: console)
                        ComposerStub()
                    }
                } else {
                    ProgressView()
                }
            }
        }
        .navigationTitle("swap")
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct ComposerStub: View {
    @State private var text = ""
    var body: some View {
        HStack {
            TextField("Message", text: $text).textFieldStyle(.roundedBorder)
            Image(systemName: "arrow.up.circle.fill").font(.title2)
        }
        .padding(.horizontal, 16).padding(.vertical, 8)
        .background(.bar)
    }
}

// MARK: - Scenario driver

@Observable @MainActor
final class ProbeModel {
    var path: [String] = []
    var swapSessionID = "s-big"
    let registry = FakeRegistry()
    let sessionIDs = ["s-main", "s-big", "s-small", "swap"]
    private var rng = SplitMix(seed: Probe.seed)

    /// `AppModel.route(to: .session)`: focus the console (create + start its stream) and push it.
    func open(_ sid: String) {
        LastCause.text = "open \(sid)"
        if sid == "swap" {
            registry.focus(swapSessionID)
        } else {
            registry.focus(sid)
        }
        path = [sid]
        Trace.shared.log("NAV push \(sid)")
    }

    func popToRoot() {
        LastCause.text = "pop"
        path = []
        registry.focus(nil)
        Trace.shared.log("NAV pop")
    }

    func runScenario() async {
        let started = Date()
        let flusher = Task { @MainActor in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 500_000_000)
                Trace.shared.flush()
            }
        }
        // A launch: the shell is up, then the session is opened (a tap, or a notification's route).
        try? await Task.sleep(nanoseconds: 500_000_000)
        switch Probe.scenario {
        case "switch":
            await switchScenario(until: started.addingTimeInterval(Probe.seconds))
        case "swap":
            await swapScenario(until: started.addingTimeInterval(Probe.seconds))
        default:
            open("s-main")
            while Date() < started.addingTimeInterval(Probe.seconds) {
                try? await Task.sleep(nanoseconds: 250_000_000)
            }
        }
        flusher.cancel()
        Trace.shared.finish(verdictLine("SURVIVED"))
        exit(0)
    }

    /// iPhone: leaving a session pops it, opening another pushes a new console view.
    private func switchScenario(until end: Date) async {
        var which = 0
        while Date() < end {
            let sid = ["s-big", "s-small", "s-main"][which % 3]
            open(sid)
            try? await Task.sleep(nanoseconds: UInt64(rng.int(700, 1600)) * 1_000_000)
            popToRoot()
            try? await Task.sleep(nanoseconds: UInt64(rng.int(150, 600)) * 1_000_000)
            which += 1
        }
    }

    /// iPad: the same transcript view, its console swapped out from under it.
    private func swapScenario(until end: Date) async {
        swapSessionID = "s-big"
        open("swap")
        while Date() < end {
            try? await Task.sleep(nanoseconds: UInt64(rng.int(500, 1400)) * 1_000_000)
            let next = swapSessionID == "s-big" ? "s-small" : "s-big"
            LastCause.text = "swap -> \(next)"
            registry.focus(next)
            swapSessionID = next
            Trace.shared.log("SWAP \(next)")
        }
    }
}

/// Deterministic randomness, so a seed that finds something can be run again.
struct SplitMix {
    private var state: UInt64
    init(seed: UInt64) { state = seed &* 0x9E3779B97F4A7C15 &+ 1 }
    mutating func next() -> UInt64 {
        state &+= 0x9E3779B97F4A7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58476D1CE4E5B9
        z = (z ^ (z >> 27)) &* 0x94D049BB133111EB
        return z ^ (z >> 31)
    }
    mutating func int(_ lo: Int, _ hi: Int) -> Int { lo + Int(next() % UInt64(max(1, hi - lo + 1))) }
    mutating func chance(_ p: Double) -> Bool { Double(next() % 10_000) / 10_000 < p }
}
