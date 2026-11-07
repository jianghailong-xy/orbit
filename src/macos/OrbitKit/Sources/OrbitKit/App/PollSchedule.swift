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

/// The app's own poll (`AppModel.startPolling`): when the Open list is read, conditionally, and when
/// the floors are — the lists that ride the same loop (runners, watches, projects, the managed
/// runner, the focused console's exact detail), each behind its own gate. Kept here, apart from the
/// app, so what the loop asks for is tested against a clock and a record of requests.
///
///  - The stream is live (docs/list-freshness-design.md §4 R1): no timed Open read. A
///    `sessions.list_changed` hint (`hint`) is one read for a burst, a second after its first hint;
///    otherwise one conditional read a minute, the safety read for a hint that never came.
///  - The stream is down (R2): every 4 s, then 8, 16 and 30 s between reads — whether or not they
///    get through — until the stream is live again.
///  - Reads failing (offline): the floors wait too, and the wait backs off the same way.
///  - The app cannot be seen (R3: macOS hidden, minimized, covered, closed): no read at all, however
///    long, hints included; the loop sleeps until it is shown. Shown again after missing a read: one
///    conditional read of the Open list at once, and the floors follow at their next wake.
@MainActor
public final class AppPoll {
    /// The Open list's schedule.
    public private(set) var schedule: PollSchedule
    /// When the floors are next looked at; each floor keeps its own cadence behind it.
    private var floors: PollSchedule
    /// Open-list reads in a row that failed; what every page poll backs off by too (R2).
    public private(set) var failures = 0
    /// Open-list reads made since the stream went down: the first waits `interval`, each after it
    /// twice as long, up to 30 s (R2).
    public private(set) var downReads = 0
    /// The version of the last hint taken, on this connection. A hint naming it again moves nothing.
    private var hintVersion: String?
    private let readOpenList: () async -> Bool
    private let readFloors: () async -> Void
    private let jitter: () -> Double

    /// `readOpenList` answers whether the read got through (an unchanged list counts).
    public init(interval: TimeInterval = 4, liveInterval: TimeInterval = PollSchedule.liveFallback,
                floorInterval: TimeInterval = 4,
                readOpenList: @escaping () async -> Bool,
                readFloors: @escaping () async -> Void,
                jitter: @escaping () -> Double = { Double.random(in: 0..<1) }) {
        schedule = PollSchedule(interval: interval, liveInterval: liveInterval)
        floors = PollSchedule(interval: floorInterval, liveInterval: floorInterval)
        self.readOpenList = readOpenList
        self.readFloors = readFloors
        self.jitter = jitter
    }

    /// How many doublings the Open read's wait takes: a failing read's, or the stream being down.
    private func steps(live: Bool) -> Int {
        live ? failures : max(failures, downReads - 1)
    }

    /// One pass at `now`.
    public func tick(at now: Date, visible: Bool, live: Bool) async {
        guard visible else { return }
        if live { downReads = 0 }
        let steps = steps(live: live)
        if schedule.isDue(at: now, live: live, visible: true, failures: steps) {
            let catchUp = schedule.isCatchUp(at: now, live: live, failures: steps)
            schedule.noteRead(at: now, jitter: jitter())
            if !live { downReads += 1 }
            let ok = await readOpenList()
            failures = ok ? 0 : failures + 1
            guard ok else { return }
            if catchUp {
                // The read owed for the time the app could not be seen goes alone; the floors follow
                // at their next wake.
                floors.noteRead(at: now)
                return
            }
        } else if failures > 0 {
            return
        }
        guard floors.isDue(at: now, live: false, visible: true) else { return }
        floors.noteRead(at: now)
        await readFloors()
    }

    /// A `sessions.list_changed` hint at `now` (`version` its payload's): the Open list is read once
    /// for a burst, a second after the first. False — nothing moved — for the version last taken on
    /// this connection.
    @discardableResult
    public func hint(version: String?, at now: Date) -> Bool {
        if let version {
            guard version != hintVersion else { return false }
            hintVersion = version
        }
        schedule.hint(at: now)
        return true
    }

    /// The stream connected or dropped: the next connection tells its own versions, and the first
    /// hint it sends is always read (docs/realtime-control-plane-stream.md §4.8).
    public func streamChanged() {
        hintVersion = nil
    }

    /// The Open list was read at `now` outside the tick (an event that needs it, a reconnect): that
    /// read answers every hint before it, and the minute's safety read counts from it.
    public func noteOpenRead(at now: Date) {
        schedule.noteRead(at: now, jitter: jitter())
    }

    /// When the loop should wake for the next tick; nil while the app cannot be seen (it waits to
    /// be shown, which wakes it).
    public func nextWake(visible: Bool, live: Bool) -> Date? {
        guard visible else { return nil }
        let open = schedule.nextRead(live: live, visible: true, failures: steps(live: live))
        guard failures == 0, let floor = floors.nextRead(live: false, visible: true) else { return open }
        return open.map { min($0, floor) } ?? floor
    }
}
