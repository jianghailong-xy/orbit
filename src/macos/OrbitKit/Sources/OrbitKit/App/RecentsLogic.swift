import Foundation

/// Pure logic for the drawer's **Recents** section: the sessions you'd jump back into, across every
/// agent and runner, most-recent activity first. UI-free so it's unit-tested; the SwiftUI drawer
/// renders `recent(...)` off the already-fresh cross-agent Active list (`AppModel.sessions`), so it
/// needs no extra fetch.
public enum RecentsLogic {
    /// The top `limit` sessions by last activity, newest first. Pins are ignored: Recents is
    /// ordered purely by time, not by the pin float the list payload applies.
    ///
    /// Recency key: `lastTurnAt` (the last turn) falling back to `updatedAt` then `createdAt`, so a
    /// freshly-queued session that has never run still sorts by when it was created. Parsed to a
    /// `Date` (not compared as raw strings) so mixed fractional-second precision can't misorder.
    public static func recent(_ sessions: [Session], limit: Int = 6) -> [Session] {
        sessions
            .sorted { recency($0) > recency($1) }
            .prefix(max(0, limit))
            .map { $0 }
    }

    /// Seconds-since-reference of a session's last activity; a missing/unparseable timestamp sinks
    /// the row to the bottom (returns 0) rather than throwing off the sort.
    static func recency(_ s: Session) -> Double {
        guard let iso = s.lastTurnAt ?? s.updatedAt ?? s.createdAt,
              let date = RelativeTime.parse(iso) else { return 0 }
        return date.timeIntervalSinceReferenceDate
    }
}
