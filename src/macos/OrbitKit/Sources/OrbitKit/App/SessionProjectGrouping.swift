import Foundation

/// Project sectioning for the session list — the structural half of the attention inbox, and a port
/// of web's `projectGrouping.ts` / the ordering half of `sessionRole.ts`.
///
/// A conversation is filed under the project it serves rather than under the day it last ran, so the
/// list's length tracks how many projects are in flight instead of how many sessions exist. Same
/// pure shape as the other two groupers here — an already console-sorted list in, buckets out — and
/// it delegates to `SessionTimeGrouping` for the trailing Unfiled region, which keeps the recency
/// sections it always had.

/// A run of rows inside a group, with the recency heading Unfiled keeps (nil: heading-less).
public struct ProjectSubsection: Identifiable, Equatable, Sendable {
    public let title: String?
    public let sessions: [Session]
    public var id: String { title ?? "__rows__" }
    public init(title: String?, sessions: [Session]) {
        self.title = title
        self.sessions = sessions
    }
}

/// One group of the project-sectioned list: a project, or the leading Pinned / trailing Unfiled
/// bucket, which are not projects and carry no rollup.
public struct ProjectSection: Identifiable, Equatable, Sendable {
    /// Stable across renders and reloads — this is what a persisted collapse state stores.
    public let key: String
    /// The project this group is, or nil for Pinned and Unfiled.
    public let projectId: String?
    public let title: String
    /// The header badge's tallies. Nil for Pinned/Unfiled (not projects), and while the per-project
    /// counts are still in flight. Kept even while collapsed — the whole point of rolling a project
    /// up is that its header still says someone is waiting on you.
    public let counts: ProjectSessionCounts?
    public let collapsed: Bool
    /// Rows the group holds, collapsed or not.
    public let count: Int
    /// The rows to render, empty while collapsed — so a caller flattening these to walk what is
    /// actually on screen never lands inside a rolled-up group.
    public let sections: [ProjectSubsection]
    public var id: String { key }

    public init(key: String, projectId: String?, title: String, counts: ProjectSessionCounts?,
                collapsed: Bool, sections: [ProjectSubsection]) {
        self.key = key
        self.projectId = projectId
        self.title = title
        self.counts = counts
        self.collapsed = collapsed
        self.count = sections.reduce(0) { $0 + $1.sessions.count }
        self.sections = collapsed ? [] : sections
    }
}

/// One part of a group header's rollup — "2 needs you", "1 running", "5/9 done". `kind` drives the
/// colour; the text is the shared wording.
public struct ProjectBadgePart: Identifiable, Equatable, Sendable {
    public enum Kind: String, Sendable { case needsYou, running, done }
    public let kind: Kind
    public let text: String
    public var id: String { kind.rawValue }
    public init(kind: Kind, text: String) {
        self.kind = kind
        self.text = text
    }
}

public enum SessionProjectGrouping {
    /// Keys for the two groups that are not a project, so one collapse set can name all three kinds.
    /// Neither can collide with a project id, which is base62 and never contains an underscore.
    public static let pinnedKey = "__pinned__"
    public static let unfiledKey = "__unfiled__"

    /// Index `GET /sessions/project-counts` by project, for the lookup the grouper wants.
    public static func countsById(_ rows: [ProjectSessionCounts]) -> [String: ProjectSessionCounts] {
        Dictionary(rows.map { ($0.projectId, $0) }, uniquingKeysWith: { _, last in last })
    }

    /// Whether this list has anything to group by project at all. The lists fall back to their
    /// recency sections when it doesn't, so an account that runs no projects sees exactly what it
    /// saw before.
    public static func hasProjects(_ sessions: [Session]) -> Bool {
        sessions.contains { $0.projectId != nil }
    }

    /// Bucket a **console-sorted** list into one section per project, then a trailing "Unfiled"
    /// section for the sessions that belong to none — internally still sectioned by recency, since
    /// without a project to file it under, when it last ran is all the structure a conversation has.
    ///
    /// Projects appear in the order the list first mentions them, which over a recency-sorted list
    /// means most-recently-active project first: no second ordering rule to keep in step with the
    /// server's. Within a project the rows are re-ranked by what the group is asking of you
    /// (`ordered`), which is the one place this grouper reorders anything.
    ///
    /// When `pinnedFirst` (the Open view, where pinning applies) pinned sessions lift into a leading
    /// "Pinned" group ahead of every project, exactly as they lift above the recency sections today
    /// — a pin means "keep this at the top of the list", and a pinned row that sank into a rolled-up
    /// project group would be further from the top than before it was pinned.
    ///
    /// `counts` and `collapsed` are the two facts the grouper cannot derive from the rows: the
    /// tallies are a server rollup over sessions this page has not loaded, and collapse is the
    /// user's. `now`/`calendar` are injectable for deterministic tests, as in `SessionTimeGrouping`.
    public static func sections(_ sessions: [Session],
                                counts: [String: ProjectSessionCounts] = [:],
                                collapsed: Set<String> = [],
                                pinnedFirst: Bool = true,
                                now: Date = Date(),
                                calendar: Calendar = .current) -> [ProjectSection] {
        var pinned: [Session] = []
        var unfiled: [Session] = []
        // Insertion-ordered by `order`, which is what makes "first mentioned" the group order.
        var order: [String] = []
        var grouped: [String: (title: String?, sessions: [Session])] = [:]

        for s in sessions {
            if pinnedFirst, s.pinnedAt != nil { pinned.append(s); continue }
            guard let projectId = s.projectId else { unfiled.append(s); continue }
            if grouped[projectId] == nil {
                order.append(projectId)
                grouped[projectId] = (title: s.projectTitle, sessions: [])
            }
            // A row that names the project wins over one that only carries the id, so a group is
            // never left titleless because its first row happened to be the incomplete one.
            if grouped[projectId]?.title == nil { grouped[projectId]?.title = s.projectTitle }
            grouped[projectId]?.sessions.append(s)
        }

        var out: [ProjectSection] = []
        if !pinned.isEmpty {
            out.append(ProjectSection(key: pinnedKey, projectId: nil, title: "Pinned", counts: nil,
                                      collapsed: collapsed.contains(pinnedKey),
                                      sections: [ProjectSubsection(title: nil, sessions: pinned)]))
        }
        for projectId in order {
            guard let group = grouped[projectId] else { continue }
            out.append(ProjectSection(key: projectId, projectId: projectId,
                                      title: group.title ?? "Untitled project",
                                      counts: counts[projectId],
                                      collapsed: collapsed.contains(projectId),
                                      sections: [ProjectSubsection(title: nil,
                                                                   sessions: ordered(group.sessions))]))
        }
        if !unfiled.isEmpty {
            // Pins were already lifted (or deliberately not lifted, under a tag filter); either way
            // this grouper has settled them, so the recency pass must not lift a second time.
            let timed = SessionTimeGrouping.sections(unfiled, pinnedFirst: false, now: now,
                                                     calendar: calendar)
            out.append(ProjectSection(key: unfiledKey, projectId: nil, title: "Unfiled", counts: nil,
                                      collapsed: collapsed.contains(unfiledKey),
                                      sections: timed.map {
                                          ProjectSubsection(title: $0.title, sessions: $0.sessions)
                                      }))
        }
        return out
    }

    /// Order one project group's rows: Main · needs you · running · everything else.
    ///
    /// Ranked by what the group is asking of you rather than by recency — the coordinator is the way
    /// into the project, a blocked session is the only kind of row that cannot proceed without you,
    /// and a working one at least reports progress.
    ///
    /// Pure and stable: rows the ranking cannot separate keep the order the server sent them in, so
    /// the list's recency sort still holds inside a tier. Within a tier, whoever has been waiting on
    /// a human longest comes first (`oldestPendingApprovalAt` ASC — web's `waitingSince`); a row with
    /// nothing waiting, or an unparseable timestamp, sorts after those that do rather than to 1970.
    public static func ordered(_ sessions: [Session]) -> [Session] {
        sessions.enumerated()
            .sorted { a, b in
                let ta = tier(a.element), tb = tier(b.element)
                if ta != tb { return ta < tb }
                let wa = waitingSince(a.element), wb = waitingSince(b.element)
                if wa != wb { return wa < wb }
                return a.offset < b.offset
            }
            .map(\.element)
    }

    private static func tier(_ s: Session) -> Int {
        if s.role == .coordinator { return 0 }
        if (s.pendingApprovals ?? 0) > 0 { return 1 }
        return s.isGenerating ? 2 : 3
    }

    private static func waitingSince(_ s: Session) -> TimeInterval {
        guard let iso = s.oldestPendingApprovalAt, let at = RelativeTime.parse(iso)
        else { return .greatestFiniteMagnitude }
        return at.timeIntervalSince1970
    }

    /// The group header's rollup, "2 needs you · 1 running · 5/9 done". The two live tallies are
    /// dropped at zero — an idle project should not spend header width saying nothing is happening —
    /// while the done ratio always shows, being the group's progress rather than an event. The three
    /// buckets are disjoint server-side, so they read as parts of one whole.
    public static func badgeParts(_ counts: ProjectSessionCounts) -> [ProjectBadgePart] {
        var parts: [ProjectBadgePart] = []
        if counts.needsYou > 0 {
            parts.append(ProjectBadgePart(kind: .needsYou, text: "\(counts.needsYou) needs you"))
        }
        if counts.running > 0 {
            parts.append(ProjectBadgePart(kind: .running, text: "\(counts.running) running"))
        }
        parts.append(ProjectBadgePart(kind: .done, text: "\(counts.done)/\(counts.total) done"))
        return parts
    }
}
