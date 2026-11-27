import Foundation

/// One recency-bucketed section of the iOS Agent-console session list (ChatGPT-style): a title
/// ("Pinned", "Today", "Yesterday", …) over the sessions that fall in it. Kept in OrbitKit so the
/// bucketing is pure and unit-tested; the SwiftUI list renders one `Section` per section here.
///
/// Distinct from `SessionGrouping` / `SessionGroups`, which bucket the *Open snapshot* by live
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

/// Buckets a per-agent session list into the list's sections, the rule web (`sessionTimeSections`)
/// and Android (`directoryGroups`) are held to as well: contracts/session-list-order.fixtures.json.
/// Pinned sessions are lifted into a leading "Pinned" section, and the rest are grouped by the
/// calendar day they were listed.
public enum SessionTimeGrouping {
    /// Group a session list into ordered sections. Each session goes to the first section that
    /// takes it: "Pinned" (pinnedAt set; only when `pinnedFirst`, Open with no tag filter), "Needs
    /// you" (pending approvals, or FAILED with no retry armed) and "Working" (phase RUNNING or
    /// PENDING, so a background job or SubAgent between turns counts; or FAILED with a retry armed),
    /// both only when `attention` (Open; defaults to `pinnedFirst`); every other session buckets by
    /// the calendar day of `listedAt ?? createdAt` into Today / Yesterday / 2–7 days ago / 8–30 days
    /// ago / Older. Each section is ordered by `listedAt`, then `createdAt`, then id, so a pin
    /// counts only in Pinned; with `keepOrder` (Completed's server order; defaults to `!attention`)
    /// the given order is kept. Empty buckets are dropped, and a session with no/unparseable
    /// timestamp falls to "Older". `now` and `calendar` are injectable for deterministic tests.
    public static func sections(_ sessions: [Session], pinnedFirst: Bool = true, attention: Bool? = nil,
                                keepOrder: Bool? = nil,
                                now: Date = Date(), calendar: Calendar = .current) -> [SessionTimeSection] {
        let attention = attention ?? pinnedFirst
        let keepOrder = keepOrder ?? !attention
        var pinned: [Session] = []
        var needsYou: [Session] = []
        var working: [Session] = []
        // Fixed bucket order; titles double as the rendered section headers.
        var buckets: [[Session]] = Array(repeating: [], count: 5)
        let titles = bucketTitles
        let today = calendar.startOfDay(for: now)

        for s in sessions {
            // Only Open honours pins; elsewhere a (possibly stale) pinnedAt just buckets
            // by time like any other session, so no "Pinned" section appears in Completed/Trash.
            if pinnedFirst, s.pinnedAt != nil { pinned.append(s); continue }
            if attention {
                if needsOwner(s) { needsYou.append(s); continue }
                if isWorking(s) { working.append(s); continue }
            }
            buckets[bucketIndex(for: s, today: today, calendar: calendar)].append(s)
        }

        let ordered: ([Session]) -> [Session] = { keepOrder ? $0 : SessionFilter.listedOrder($0) }
        var out: [SessionTimeSection] = []
        if !pinned.isEmpty { out.append(SessionTimeSection(title: "Pinned", sessions: ordered(pinned))) }
        if !needsYou.isEmpty { out.append(SessionTimeSection(title: "Needs you", sessions: ordered(needsYou))) }
        if !working.isEmpty { out.append(SessionTimeSection(title: "Working", sessions: ordered(working))) }
        for (i, items) in buckets.enumerated() where !items.isEmpty {
            out.append(SessionTimeSection(title: titles[i], sessions: ordered(items)))
        }
        return out
    }

    /// Needs the owner: something is waiting on them, or the run failed and no retry is armed.
    private static func needsOwner(_ s: Session) -> Bool {
        if (s.pendingApprovals ?? 0) > 0 { return true }
        // With the session facts, the state word's own reading (an end the runner never confirmed is Ended, not
        // Failed); from an older server, the legacy run state.
        let failed = s.phase != nil && s.released != nil ? s.displayRunState == .failed : s.effectiveRunState == .failed
        return failed && s.retryAt == nil
    }

    /// Running or queued, or failed with a retry armed (the server is retrying it). With the session
    /// facts, `phase` decides: RUNNING covers work outside a turn (a background job, a SubAgent).
    private static func isWorking(_ s: Session) -> Bool {
        if let phase = s.phase, phase == .running || phase == .pending { return true }
        switch s.effectiveRunState {
        case .running, .queued: return true
        case .failed: return s.retryAt != nil
        default: return false
        }
    }

    /// The bucket titles, in order — `bucketIndex` indexes into these.
    static let bucketTitles = ["Today", "Yesterday", "2–7 days ago", "8–30 days ago", "Older"]

    /// 0 Today · 1 Yesterday · 2 2–7 days ago · 3 8–30 days ago · 4 Older. A future timestamp
    /// (clock skew) reads as Today; a missing/unparseable one falls to Older.
    private static func bucketIndex(for s: Session, today: Date, calendar: Calendar) -> Int {
        bucketIndex(at: s.listedAt ?? s.createdAt, today: today, calendar: calendar)
    }

    /// The same buckets for any instant, so a row that is not a session (a landing in the project's
    /// Landings window) lands in the section its time says.
    static func bucketIndex(at iso: String?, today: Date, calendar: Calendar) -> Int {
        guard let iso, let date = RelativeTime.parse(iso) else { return 4 }
        let day = calendar.startOfDay(for: date)
        let days = calendar.dateComponents([.day], from: day, to: today).day ?? 0
        if days <= 0 { return 0 }
        if days == 1 { return 1 }
        if days <= 7 { return 2 }
        if days <= 30 { return 3 }
        return 4
    }
}

/// One tag-bucketed section of the session list (the "By Tag" grouping mode): the tag heading —
/// `nil` for the trailing "Untagged" bucket — over the sessions filed under it.
public struct SessionTagSection: Identifiable, Equatable, Sendable {
    public let tag: SessionTag?
    public let sessions: [Session]
    public var id: String { tag?.id ?? "__untagged__" }
    public init(tag: SessionTag?, sessions: [Session]) {
        self.tag = tag
        self.sessions = sessions
    }
}

/// Buckets a per-agent session list by tag (the list's optional "By Tag" grouping). Distinct from
/// `SessionTimeGrouping` (by recency) and `SessionGrouping` (by live status).
public enum SessionTagGrouping {
    /// Group a **console-sorted** list by each session's *primary* tag — the first entry in its
    /// server-ordered `tags` (system-first, lowest position) — into one section per tag, ordered as
    /// the tag library is (system first, then by position, then name). A multi-tag session appears
    /// once, under its primary tag (a deliberate divergence from Files.app, which repeats a file
    /// under every tag — one row per id keeps `List` identity/selection unambiguous). Untagged
    /// sessions fall to a trailing "Untagged" section. Order within each section is preserved.
    public static func sections(_ sessions: [Session]) -> [SessionTagSection] {
        var groups: [String: (tag: SessionTag, sessions: [Session])] = [:]
        var untagged: [Session] = []
        for s in sessions {
            guard let primary = (s.tags ?? []).first else { untagged.append(s); continue }
            groups[primary.id, default: (primary, [])].sessions.append(s)
        }
        var sections = groups.values
            .sorted { a, b in
                if a.tag.isSystem != b.tag.isSystem { return a.tag.isSystem }
                if a.tag.position != b.tag.position { return a.tag.position < b.tag.position }
                return a.tag.name < b.tag.name
            }
            .map { SessionTagSection(tag: $0.tag, sessions: $0.sessions) }
        if !untagged.isEmpty { sections.append(SessionTagSection(tag: nil, sessions: untagged)) }
        return sections
    }
}
