import Foundation

/// What the cross-session "needs you" banner renders, and where a tap on it goes.
///
/// A session blocked on an approval is *stopped work*, not an unread message: there are rarely more
/// than one or two, and the user's job is to unblock it and get back out. So the banner carries a
/// destination rather than a trail of counts to follow down a tree — it names the workspace when
/// exactly one thing is waiting (the name is what lets you decide whether to go now; "1" tells you
/// nothing), counts when several are, and sends you straight to the one that has waited longest.
public struct NeedsYouBanner: Equatable, Sendable {
    /// How many sessions are waiting. Never 0 — `NeedsYouLogic.banner` answers nil instead, so the
    /// bar is absent from the layout entirely rather than present at zero height.
    public let count: Int
    /// Where a tap goes: the session blocked the longest. Clearing it leaves the banner pointing at
    /// the next one, which is what makes this an inbox rather than a notification.
    public let target: Session
    /// The one line the bar shows.
    public let text: String

    public init(count: Int, target: Session, text: String) {
        self.count = count
        self.target = target
        self.text = text
    }
}

/// Pure logic behind the "needs you" surfaces, derived from the cross-agent Open snapshot the
/// clients already hold (every row carries `pendingApprovals` under the same rule the server's
/// `GET /sessions/counts` applies) — so neither surface costs a request.
public enum NeedsYouLogic {
    /// agentID → how many of that agent's sessions are blocked on an approval, for the drawer's
    /// per-agent badge. Agents with nothing waiting are absent rather than zero, so a lookup that
    /// misses means "nothing" without the caller filtering. The agent id is read the way
    /// `SessionFilter.forAgent` reads it — nested `agent.id` first, flat `agentId` as the fallback.
    public static func byAgent(_ sessions: [Session]) -> [String: Int] {
        var counts: [String: Int] = [:]
        for s in sessions where (s.pendingApprovals ?? 0) > 0 {
            guard let id = s.agent?.id ?? s.agentId else { continue }
            counts[id, default: 0] += 1
        }
        return counts
    }

    /// The banner for a screen showing `focused`, or nil when nothing elsewhere is waiting.
    ///
    /// - Parameters:
    ///   - waiting: the blocked sessions — `SessionGrouping.group(...).needsYou`.
    ///   - focused: the session on screen, excluded from the count. Its approval card already
    ///     renders inline at the tail of its own transcript, so a bar pointing at it would point
    ///     at itself. Pass nil from a list, which shows no single session.
    public static func banner(waiting: [Session], excluding focused: String? = nil) -> NeedsYouBanner? {
        let elsewhere = waiting.filter { $0.id != focused }
        // Longest-waiting first (FIFO), on the same key the inbox is ordered by: when the approval
        // was raised (`oldestPendingApprovalAt` — web's `waitingSince` ASC), so the bar and the
        // inbox cannot disagree about which one is most overdue. A row from a server that doesn't
        // serve that timestamp falls back to the parsed recency key Recents uses, and sorts behind
        // every row that does carry a real wait — ordering here rather than on the server's array
        // order, so a re-sorted or locally-upserted snapshot can't quietly change which session a
        // tap opens.
        guard let target = elsewhere.min(by: { waitedLonger($0, than: $1) }) else { return nil }
        return NeedsYouBanner(count: elsewhere.count, target: target,
                              text: text(count: elsewhere.count, target: target))
    }

    /// Whether `a` has been blocked on a human longer than `b`. A row that says since when beats one
    /// that doesn't, whatever their recency: an approval raised two hours ago on a session that has
    /// been streaming output since is the one being forgotten.
    private static func waitedLonger(_ a: Session, than b: Session) -> Bool {
        let wa = a.oldestPendingApprovalAt.flatMap(RelativeTime.parse)
        let wb = b.oldestPendingApprovalAt.flatMap(RelativeTime.parse)
        switch (wa, wb) {
        case (let x?, let y?): return x < y
        case (_?, nil):        return true
        case (nil, _?):        return false
        case (nil, nil):       return RecentsLogic.recency(a) < RecentsLogic.recency(b)
        }
    }

    /// One session names its workspace; several collapse to a count. The workspace name (not the
    /// session title) is the "where" the user navigates by, and it stays short — session titles are
    /// often absent or long enough to truncate away exactly the part that identifies them.
    private static func text(count: Int, target: Session) -> String {
        guard count == 1 else { return "\(count) sessions need you" }
        return "\(target.agent?.name ?? target.title ?? "A session") needs you"
    }
}
