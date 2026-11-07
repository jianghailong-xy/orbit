import Foundation

/// When one poll reads (docs/list-freshness-design.md §4 R1–R3, R6): a value the app's loops consult
/// and tests drive with their own clock.
///
///  - The app cannot be seen (R3: hidden, minimized, covered, closed): never.
///  - The control stream is live (R1): on a hint — an event about what the poll shows — read once
///    for a burst, a second after its first hint and never sooner than `interval` after the last
///    read; otherwise once every `liveInterval`, the safety read for an event that never came.
///  - The stream is down: every `interval`, the poll's own cadence.
///  - What no event reports while it moves (a landing or merge job running, a machine checking in)
///    is the bounded exception: every `inFlight` seconds, regardless of the stream — but, like
///    everything else here, only while the app can be seen.
///  - Reads failing (R2, offline): the wait doubles per consecutive failure, capped at 30 s and
///    stretched by up to a quarter at random, until a read gets through.
public struct PollSchedule: Equatable, Sendable {
    /// The safety read's cadence with the stream live.
    public static let liveFallback: TimeInterval = 60
    /// How long a burst of hints is gathered before the one read it gets.
    public static let mergeWindow: TimeInterval = 1
    /// The longest a failing poll waits between reads.
    public static let backoffCap: TimeInterval = 30

    /// The poll's own cadence, with the stream down.
    public let interval: TimeInterval
    /// Its cadence with the stream live and no hint.
    public let liveInterval: TimeInterval
    public private(set) var lastReadAt: Date?
    /// The first hint since the last read started, if any.
    public private(set) var hintedAt: Date?
    /// The random stretch (0..<1) for the waits after the last read.
    public private(set) var jitter: Double = 0

    public init(interval: TimeInterval, liveInterval: TimeInterval = PollSchedule.liveFallback,
                lastReadAt: Date? = nil) {
        self.interval = interval
        self.liveInterval = liveInterval
        self.lastReadAt = lastReadAt
    }

    /// When the next read is due; nil while none may be made (the app cannot be seen).
    /// `failures` is how many reads in a row have failed; `inFlight`, the bounded exception's
    /// cadence while something no event reports is moving.
    public func nextRead(live: Bool, visible: Bool, failures: Int = 0,
                         inFlight: TimeInterval? = nil) -> Date? {
        guard visible else { return nil }
        guard let last = lastReadAt else { return .distantPast }
        // Failing reads back off whatever the stream says: a live stream does not make a read that
        // keeps failing any likelier to get through.
        let own = last.addingTimeInterval(Self.backoff(interval, failures: failures, jitter: jitter))
        if let inFlight {
            return last.addingTimeInterval(Self.backoff(inFlight, failures: failures, jitter: jitter))
        }
        guard live else { return own }
        let fallback = last.addingTimeInterval(Self.backoff(liveInterval, failures: failures, jitter: jitter))
        guard let hintedAt else { return fallback }
        return min(fallback, max(hintedAt.addingTimeInterval(Self.mergeWindow), own))
    }

    public func isDue(at now: Date, live: Bool, visible: Bool, failures: Int = 0,
                      inFlight: TimeInterval? = nil) -> Bool {
        guard let next = nextRead(live: live, visible: visible, failures: failures, inFlight: inFlight) else {
            return false
        }
        return now >= next
    }

    /// Whether a read due at `now` is the one a poll owes for the time it could not read — it was
    /// due at least a whole interval ago (the app was hidden). Never the first read.
    public func isCatchUp(at now: Date, live: Bool, failures: Int = 0) -> Bool {
        guard lastReadAt != nil,
              let next = nextRead(live: live, visible: true, failures: failures) else { return false }
        return now.timeIntervalSince(next) >= interval
    }

    /// An event about what this poll shows. The first since the last read opens the merge window.
    public mutating func hint(at now: Date) {
        if hintedAt == nil { hintedAt = now }
    }

    /// A read starts at `now`; it answers every hint so far. `jitter` is a random number in 0..<1
    /// for the waits after it.
    public mutating func noteRead(at now: Date, jitter: Double = 0) {
        lastReadAt = now
        hintedAt = nil
        self.jitter = jitter
    }

    /// `interval` after `failures` failed reads in a row: doubled per failure up to `backoffCap`
    /// (never below `interval`), and stretched by up to a quarter — so 4 s becomes 8, 16, then 30.
    public static func backoff(_ interval: TimeInterval, failures: Int, jitter: Double) -> TimeInterval {
        guard failures > 0 else { return interval }
        let doubled = interval * Double(1 << min(failures, 10))
        let capped = max(interval, min(backoffCap, doubled))
        return capped * (1 + 0.25 * min(max(jitter, 0), 1))
    }
}

/// The app's own poll (`AppModel.startPolling`): one tick reads the Open list conditionally when it is
/// due, then the floors — the lists that ride the same tick (runners, watches, projects, the managed
/// runner, the focused console's exact detail). Kept here, apart from the app, so what a tick asks
/// for is tested against a clock and a record of requests.
///
///  - The app cannot be seen (macOS: hidden, minimized, covered, closed): no tick reads anything,
///    however long; the loop sleeps until it is shown.
///  - Shown again after missing a read: one conditional read of the Open list, at once, and nothing
///    else in that tick — the floors follow at the next.
///  - A failing Open read (offline): the floors are skipped, and the wait backs off 4 → 8 → 16 →
///    30 s until a read gets through.
@MainActor
public final class AppPoll {
    public private(set) var schedule: PollSchedule
    /// Open-list reads in a row that failed; what every page poll backs off by too (R2).
    public private(set) var failures = 0
    private let readOpenList: () async -> Bool
    private let readFloors: () async -> Void
    private let jitter: () -> Double

    /// `readOpenList` answers whether the read got through (an unchanged list counts).
    public init(interval: TimeInterval = 4, liveInterval: TimeInterval = 4,
                readOpenList: @escaping () async -> Bool,
                readFloors: @escaping () async -> Void,
                jitter: @escaping () -> Double = { Double.random(in: 0..<1) }) {
        schedule = PollSchedule(interval: interval, liveInterval: liveInterval)
        self.readOpenList = readOpenList
        self.readFloors = readFloors
        self.jitter = jitter
    }

    /// One pass at `now`.
    public func tick(at now: Date, visible: Bool, live: Bool) async {
        guard schedule.isDue(at: now, live: live, visible: visible, failures: failures) else { return }
        let catchUp = schedule.isCatchUp(at: now, live: live, failures: failures)
        schedule.noteRead(at: now, jitter: jitter())
        let ok = await readOpenList()
        failures = ok ? 0 : failures + 1
        guard ok, !catchUp else { return }
        await readFloors()
    }

    /// When the loop should wake for the next tick; nil while the app cannot be seen (it waits to
    /// be shown, which wakes it).
    public func nextWake(visible: Bool, live: Bool) -> Date? {
        schedule.nextRead(live: live, visible: visible, failures: failures)
    }
}
