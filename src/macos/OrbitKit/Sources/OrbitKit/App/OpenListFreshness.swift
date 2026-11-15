import Foundation

/// Whether the Open list on screen is known to be the server's, for the one line under the iPhone
/// session list's workspace name (docs/mocks/ios-launch-updating, owner 2026-11-14: A).
///
/// A *round* starts when the list in hand may be stale — a cold launch drew the previous run's
/// rows, or the app came back from the background — and ends at the first Open read that started
/// after it. What the line says against the round's age:
///
///  - under 0.4 s: nothing, so a quick read never flashes;
///  - from 0.4 s: `updating`; from 4 s: `connecting`;
///  - from 15 s, or once a read in the round fails: `offline`, until a read gets through.
///
/// A read that answers after the line was shown keeps it up until it has been shown 0.6 s, then
/// takes it down. Pure and clock-driven, so the app only redraws at `nextChange`.
public struct OpenListFreshness {
    public enum Status: Equatable {
        case updating, connecting, offline
    }

    public static let showAfter: TimeInterval = 0.4
    public static let connectingAfter: TimeInterval = 4
    public static let offlineAfter: TimeInterval = 15
    public static let minimumShown: TimeInterval = 0.6

    /// Bumped by every `begin`; a read counts for the round it started in, or a later one.
    public private(set) var round = 0
    /// When the round in flight began; nil when no round is open.
    private var startedAt: Date?
    /// When the line first showed this round (`startedAt + showAfter`, or at once on a retry from a
    /// line already up).
    private var visibleFrom: Date?
    private var failed = false
    /// A read answered while the line was up: it stays, saying this, until `heldUntil`.
    private var held: (status: Status, until: Date)?

    public init() {}

    /// The list may be stale from `now`. A round already in flight goes on; otherwise a new one
    /// starts — shown at once if the line is up (a retry from `offline`), after `showAfter` if not.
    public mutating func begin(at now: Date) {
        if startedAt != nil, !failed, status(at: now) != .offline { return }
        let showing = status(at: now) != nil
        round += 1
        startedAt = now
        visibleFrom = showing ? now : now.addingTimeInterval(Self.showAfter)
        failed = false
        held = nil
    }

    /// An Open read that started in `round` finished at `now`. Reads from before the round in
    /// flight say nothing about it.
    public mutating func finish(round: Int, ok: Bool, at now: Date) {
        guard round >= self.round, startedAt != nil else { return }
        guard ok else { failed = true; return }
        if let shown = status(at: now), let visibleFrom, now >= visibleFrom {
            held = (shown, max(now, visibleFrom.addingTimeInterval(Self.minimumShown)))
        }
        startedAt = nil
        failed = false
    }

    /// What the line says at `now`; nil draws no line.
    public func status(at now: Date) -> Status? {
        if let held { return now < held.until ? held.status : nil }
        guard let startedAt, let visibleFrom else { return nil }
        let age = now.timeIntervalSince(startedAt)
        if failed || age >= Self.offlineAfter { return .offline }
        guard now >= visibleFrom else { return nil }
        return age >= Self.connectingAfter ? .connecting : .updating
    }

    /// The next moment after `now` that `status` can change by the clock alone; nil if none.
    public func nextChange(after now: Date) -> Date? {
        if let held { return held.until > now ? held.until : nil }
        guard let startedAt, let visibleFrom, !failed else { return nil }
        return [visibleFrom,
                startedAt.addingTimeInterval(Self.connectingAfter),
                startedAt.addingTimeInterval(Self.offlineAfter)]
            .filter { $0 > now }.min()
    }
}
