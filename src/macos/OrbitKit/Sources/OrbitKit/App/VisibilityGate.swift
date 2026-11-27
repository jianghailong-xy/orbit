import Foundation

/// Whether the app can be seen, for the timed loops that are not a page poll (docs/list-freshness-design.md
/// §4 R3, R6): a console's worktree bar and "Tasks created here" card, the console registry's pending
/// operations, the Wiki's job and plan cards, a Codex or runner sign-in being waited on, a reply card,
/// the Codex reset card. Each of these pauses between reads with `pause`: while the app cannot be seen
/// (macOS hidden, minimized, covered, closed) it makes no request at all, and shown again it reads
/// once, at once, then keeps its own cadence. The loops that only mean something while an operation
/// is in flight still end when it settles, so they read only while visible and in flight.
///
/// The reads something asks for rather than a timer (a control event, a stream's hint, a nudge) go
/// through `read`: made at once while the app can be seen; while it cannot, owed instead — nothing is
/// requested, every ask for one list meanwhile is that list's one read — and made once each when it is
/// shown again (§4 R3/R4). Events still update what is already held in memory; only the reads wait.
///
/// `AppModel.setAppVisible` sets `app`, the one the app's loops use; iOS never hides it.
@MainActor
public final class VisibilityGate {
    public static let app = VisibilityGate()

    public private(set) var isVisible = true
    private var waiters: [Int: CheckedContinuation<Void, Never>] = [:]
    private var nextWaiter = 0
    /// The reads asked for while the app could not be seen: one per key, in the order first asked.
    private var owed: [(key: String, read: () -> Void)] = []
    /// How long `pause` sleeps by default.
    private let sleep: (TimeInterval) async -> Void

    public init(sleep: @escaping (TimeInterval) async -> Void = { seconds in
        try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
    }) {
        self.sleep = sleep
    }

    /// How many loops are waiting to be shown.
    public var waiting: Int { waiters.count }

    /// What is owed, by key, in the order it will be read when the app is shown.
    public var owedReads: [String] { owed.map(\.key) }

    public func set(_ visible: Bool) {
        guard visible != isVisible else { return }
        isVisible = visible
        guard visible else { return }
        // The reads owed for the time it could not be seen go first, once each, then the timed loops
        // wake: a loop's read that starts after an owed one has started counts from it.
        let due = owed
        owed = []
        for entry in due { entry.read() }
        let resumed = waiters
        waiters = [:]
        for waiter in resumed.values { waiter.resume() }
    }

    /// A read asked for now, under the `key` of what it reads (one list, one card). Visible, `read`
    /// runs at once. Hidden, it is owed: kept, replacing what an earlier ask for the same key left, and
    /// run once when the app is shown again. `read` only starts the read; nothing waits for it here.
    public func read(_ key: String, _ read: @escaping () -> Void) {
        guard !isVisible else {
            read()
            return
        }
        if let index = owed.firstIndex(where: { $0.key == key }) {
            owed[index].read = read
        } else {
            owed.append((key, read))
        }
    }

    /// Sign-out or another instance: what was owed belongs to nobody now.
    public func forgetOwedReads() {
        owed = []
    }

    /// Returns once the app can be seen — at once if it can — or once the task is cancelled.
    public func waitUntilVisible() async {
        guard !isVisible, !Task.isCancelled else { return }
        let id = nextWaiter
        nextWaiter &+= 1
        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                if isVisible || Task.isCancelled {
                    continuation.resume()
                } else {
                    waiters[id] = continuation
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.waiters.removeValue(forKey: id)?.resume() }
        }
    }

    /// The wait between two reads of a timed loop: `seconds`, then for as long as the app cannot be
    /// seen. Returns at once when the task is cancelled; the loop checks that as it did after a sleep.
    public func pause(_ seconds: TimeInterval) async {
        await sleep(seconds)
        if Task.isCancelled { return }
        await waitUntilVisible()
    }

    public func pause(_ duration: Duration) async {
        let parts = duration.components
        await pause(TimeInterval(parts.seconds) + TimeInterval(parts.attoseconds) / 1e18)
    }
}
