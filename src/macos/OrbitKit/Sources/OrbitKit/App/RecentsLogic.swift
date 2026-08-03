import Foundation

/// Pure logic for the drawer's **Recents** section: the sessions you'd jump back into, across every
/// agent and runner, most-recent activity first. UI-free so it's unit-tested; the SwiftUI drawer
/// renders `recent(...)` off the already-fresh cross-agent Open list (`AppModel.sessions`), so it
/// needs no extra fetch.
public enum RecentsLogic {
    /// The top `limit` sessions by last activity, newest first. Pins are ignored: Recents is
    /// ordered purely by time, not by the pin float the list payload applies.
    ///
    /// Recency key: `lastTurnAt` (the last turn) falling back to `updatedAt` then `createdAt`, so a
    /// freshly-queued session that has never run still sorts by when it was created. Parsed to a
    /// `Date` (not compared as raw strings) so mixed fractional-second precision can't misorder.
    ///
    /// The recency key is computed ONCE per session, then sorted (a decorate–sort–undecorate).
    /// Reading it inside the comparator instead meant two timestamp parses per *comparison* —
    /// O(n log n) parses for an O(n) amount of real work, on a path the drawer re-runs on every
    /// session-list refresh. See `RelativeTime`'s shared formatters for the other half of that fix.
    public static func recent(_ sessions: [Session], limit: Int = 6) -> [Session] {
        sessions
            .map { (key: recency($0), session: $0) }
            .sorted { $0.key > $1.key }
            .prefix(max(0, limit))
            .map { $0.session }
    }

    /// Seconds-since-reference of a session's last activity; a missing/unparseable timestamp sinks
    /// the row to the bottom (returns 0) rather than throwing off the sort.
    static func recency(_ s: Session) -> Double {
        guard let iso = s.lastTurnAt ?? s.updatedAt ?? s.createdAt,
              let date = RelativeTime.parse(iso) else { return 0 }
        return date.timeIntervalSinceReferenceDate
    }
}
