import Foundation

/// One recency section of a project's sessions page: its member sessions, with the merges into main
/// that happened in the same bucket drawn among them at their own instant.
///
/// A merge is something that happened to the project, not a message in the coordinator's
/// conversation, so its record sits on the project's own timeline (owner decision 2026-10-06). It
/// is a row of its own kind — never a session — and opens the merge's receipt.
public struct ProjectTimelineSection: Identifiable, Equatable, Sendable {
    public enum Item: Identifiable, Equatable, Sendable {
        case session(Session)
        case merge(PromotionCards.Receipt)

        public var id: String {
            switch self {
            case .session(let session): return session.id
            case .merge(let receipt): return receipt.id
            }
        }
    }

    public let title: String
    public let items: [Item]
    public var id: String { title }

    public init(title: String, items: [Item]) {
        self.title = title
        self.items = items
    }
}

public enum ProjectTimeline {
    /// The sessions keep the order they are given in (the page's load sorts them by last activity,
    /// newest first) and each merge goes in front of the first session older than it, so within a
    /// bucket the newest thing leads whichever kind it is. The buckets and their titles are
    /// `SessionTimeGrouping`'s, without a Pinned section: the project's page has none.
    public static func sections(sessions: [Session], merges: [PromotionCards.Receipt],
                                now: Date = Date(), calendar: Calendar = .current) -> [ProjectTimelineSection] {
        let titles = SessionTimeGrouping.bucketTitles
        let today = calendar.startOfDay(for: now)
        func bucket(_ iso: String?) -> Int {
            SessionTimeGrouping.bucketIndex(at: iso, today: today, calendar: calendar)
        }
        var buckets: [[ProjectTimelineSection.Item]] = Array(repeating: [], count: titles.count)
        var pending = merges.sorted { instant($0.moment) > instant($1.moment) }[...]
        for session in sessions {
            let at = session.lastTurnAt ?? session.createdAt
            while let merge = pending.first, instant(merge.moment) >= instant(at) {
                buckets[bucket(merge.moment)].append(.merge(merge))
                pending = pending.dropFirst()
            }
            buckets[bucket(at)].append(.session(session))
        }
        for merge in pending { buckets[bucket(merge.moment)].append(.merge(merge)) }
        return buckets.enumerated().compactMap { index, items in
            items.isEmpty ? nil : ProjectTimelineSection(title: titles[index], items: items)
        }
    }

    /// An instant this clock cannot read sorts after every one it can, as `SessionTimeGrouping`
    /// files it under Older.
    private static func instant(_ iso: String?) -> TimeInterval {
        iso.flatMap(RelativeTime.parse)?.timeIntervalSince1970 ?? -.infinity
    }
}
