import Foundation

/// When one list that a model holds is read besides the page that shows it (docs/list-freshness-design.md
/// §4 R1, R3, R4): the account's watches and projects, a console's "Tasks created here" card.
///
///  - A nudge (an event that may have moved the list) is one read for a burst, `delay` after its first
///    ask, and none if a read that started after the ask has already answered it.
///  - While the app cannot be seen nothing is read: the nudge's read is owed to the gate under `key`,
///    one read however many nudges came, made when the app is shown again (`VisibilityGate.read`).
///  - The floor, the app's safety read, is due once `interval` has passed since the last read started,
///    whoever made it, so an owed read made on the way back is not made twice.
///
/// The model calls `noteRead` as each of its reads starts, `nudge` on an event, and `isDue` from the
/// app's tick. Kept here, apart from the app, so it is tested against a clock and a request record.
@MainActor
public final class ListReads {
    /// The gate's key for this list's owed read.
    public let key: String
    /// When the last read started, if any has.
    public private(set) var lastReadAt: Date?
    private let gate: VisibilityGate
    private let delay: TimeInterval
    private let now: () -> Date
    private let sleep: (TimeInterval) async -> Void
    private var nudgeTask: Task<Void, Never>?

    /// `gate` nil is `VisibilityGate.app`, the one the app's loops use.
    public init(key: String, delay: TimeInterval, gate: VisibilityGate? = nil,
                now: @escaping () -> Date = Date.init,
                sleep: @escaping (TimeInterval) async -> Void = { seconds in
                    try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
                }) {
        self.key = key
        self.delay = delay
        self.gate = gate ?? .app
        self.now = now
        self.sleep = sleep
    }

    /// A read of the list starts now, whoever makes it: it answers every nudge asked before it.
    public func noteRead() {
        lastReadAt = now()
    }

    /// Whether a nudge is waiting out its delay.
    public var nudging: Bool { nudgeTask != nil }

    /// The list may have moved: `read` once for a burst, `delay` after the first ask — unless a read
    /// started after the ask meanwhile. While the app cannot be seen, the read is owed instead.
    public func nudge(_ read: @escaping () async -> Void) {
        guard nudgeTask == nil else { return }
        let asked = now()
        nudgeTask = Task { @MainActor [weak self] in
            guard let self else { return }
            await self.sleep(self.delay)
            self.nudgeTask = nil
            guard !Task.isCancelled else { return }
            if let last = self.lastReadAt, last >= asked { return }
            self.gate.read(self.key) {
                Task { @MainActor [weak self] in
                    // Owed and made on the way back: a read that started since the ask answers it too.
                    if let last = self?.lastReadAt, last >= asked { return }
                    await read()
                }
            }
        }
    }

    /// Whether the floor's read is due at `now`: `interval` since the last read started, or never read.
    public func isDue(at now: Date, interval: TimeInterval) -> Bool {
        guard let last = lastReadAt else { return true }
        return now.timeIntervalSince(last) >= interval
    }

    /// The nudge waiting out its delay, cancelled (sign-out).
    public func cancel() {
        nudgeTask?.cancel()
        nudgeTask = nil
    }
}
