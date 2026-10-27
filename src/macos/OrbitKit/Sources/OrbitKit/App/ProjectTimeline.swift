import Foundation

/// One recency section of a project's sessions page: its member sessions.
///
/// The merges into main the project has made are not on this timeline any more: they are rows of the
/// project's Landings window, which the page's Landings row opens (owner 2026-10-27, contract §2.9
/// LS6 and §3.6, revision 28).
public struct ProjectTimelineSection: Identifiable, Equatable, Sendable {
    public let title: String
    public let sessions: [Session]
    public var id: String { title }

    public init(title: String, sessions: [Session]) {
        self.title = title
        self.sessions = sessions
    }
}

public enum ProjectTimeline {
    /// The sessions keep the order they are given in (the page's load sorts them by last activity,
    /// newest first). The buckets and their titles are `SessionTimeGrouping`'s, without a Pinned
    /// section: the project's page has none.
    public static func sections(sessions: [Session], now: Date = Date(),
                                calendar: Calendar = .current) -> [ProjectTimelineSection] {
        let titles = SessionTimeGrouping.bucketTitles
        let today = calendar.startOfDay(for: now)
        var buckets: [[Session]] = Array(repeating: [], count: titles.count)
        for session in sessions {
            buckets[SessionTimeGrouping.bucketIndex(at: session.lastTurnAt ?? session.createdAt,
                                                    today: today, calendar: calendar)].append(session)
        }
        return buckets.enumerated().compactMap { index, sessions in
            sessions.isEmpty ? nil : ProjectTimelineSection(title: titles[index], sessions: sessions)
        }
    }
}
