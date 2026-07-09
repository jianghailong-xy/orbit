import Foundation

/// One recency-bucketed section of the iOS Agent-console session list (ChatGPT-style): a title
/// ("Pinned", "Today", "Yesterday", …) over the sessions that fall in it. Kept in OrbitKit so the
/// bucketing is pure and unit-tested; the SwiftUI list renders one `Section` per section here.
///
/// Distinct from `SessionGrouping` / `SessionGroups`, which bucket the *Active sidebar* by live
/// status (needs-you / running / queued) — this groups a *per-agent* list by time.
public struct SessionTimeSection: Identifiable, Equatable, Sendable {
    public let title: String
    public let sessions: [Session]
    public var id: String { title }
    public init(title: String, sessions: [Session]) {
        self.title = title
        self.sessions = sessions
    }
}

/// Buckets a per-agent session list into the iOS list's recency sections. The clients diverge from
/// web's flat list here (a deliberate, ChatGPT-style redesign): pinned sessions are lifted into a
/// leading "Pinned" section, and the rest are grouped by the calendar day of their last activity.
public enum SessionTimeGrouping {
    /// Group a **console-sorted** list (pinned-first, then most-recent activity — see `SessionFilter`)
    /// into ordered sections. When `pinnedFirst` (the Active view, where pinning applies — mirrors the
    /// row's `showsPin`), pinned sessions become a leading "Pinned" section in their given order;
    /// every other session buckets by the calendar day of `lastTurnAt ?? createdAt` into Today /
    /// Yesterday / Previous 7 Days / Previous 30 Days / Older. Order within each bucket is preserved
    /// (so recency still holds), empty buckets are dropped, and a session with no/unparseable
    /// timestamp falls to "Older". `now` and `calendar` are injectable for deterministic tests.
    public static func sections(_ sessions: [Session], pinnedFirst: Bool = true,
                                now: Date = Date(), calendar: Calendar = .current) -> [SessionTimeSection] {
        var pinned: [Session] = []
        // Fixed bucket order; titles double as the rendered section headers.
        var buckets: [[Session]] = Array(repeating: [], count: 5)
        let titles = ["Today", "Yesterday", "Previous 7 Days", "Previous 30 Days", "Older"]
        let today = calendar.startOfDay(for: now)

        for s in sessions {
            // Only the Active view honours pins; elsewhere a (possibly stale) pinnedAt just buckets
            // by time like any other session, so no "Pinned" section appears in Completed/System.
            if pinnedFirst, s.pinnedAt != nil { pinned.append(s); continue }
            buckets[bucketIndex(for: s, today: today, calendar: calendar)].append(s)
        }

        var out: [SessionTimeSection] = []
        if !pinned.isEmpty { out.append(SessionTimeSection(title: "Pinned", sessions: pinned)) }
        for (i, items) in buckets.enumerated() where !items.isEmpty {
            out.append(SessionTimeSection(title: titles[i], sessions: items))
        }
        return out
    }

    /// 0 Today · 1 Yesterday · 2 Previous 7 Days · 3 Previous 30 Days · 4 Older. A future timestamp
    /// (clock skew) reads as Today; a missing/unparseable one falls to Older.
    private static func bucketIndex(for s: Session, today: Date, calendar: Calendar) -> Int {
        guard let iso = s.lastTurnAt ?? s.createdAt, let date = RelativeTime.parse(iso) else { return 4 }
        let day = calendar.startOfDay(for: date)
        let days = calendar.dateComponents([.day], from: day, to: today).day ?? 0
        if days <= 0 { return 0 }
        if days == 1 { return 1 }
        if days <= 7 { return 2 }
        if days <= 30 { return 3 }
        return 4
    }
}
