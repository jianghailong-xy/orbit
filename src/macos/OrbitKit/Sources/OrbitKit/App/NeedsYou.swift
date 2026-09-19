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
    /// The owner item the line is about, when the oldest thing waiting is one of the four (§7.6
    /// V13): the merge to confirm, the coordinator's question, the exception that became yours, the
    /// pause to lift. Carried rather than re-derived so the press lands on the CARD — the target
    /// conversation is where it is drawn, and this is which one it is. Nil when the oldest thing
    /// waiting is an ordinary blocked tool call, which is the bar as it always was.
    public let ownerItem: SessionOwnerItem?

    public init(count: Int, target: Session, text: String, ownerItem: SessionOwnerItem? = nil) {
        self.count = count
        self.target = target
        self.text = text
        self.ownerItem = ownerItem
    }
}

/// Questions waiting in the conversation ON SCREEN, and where in it they are.
///
/// The bar was cross-session only, and the reason it excluded the session you were looking at was
/// that "its own approval card is already at the tail of its transcript, so a bar pointing at it
/// would point at itself". That reason holds for an APPROVAL — it stops the turn, so nothing can
/// arrive below it — and it does not hold for the two cards a project's ruler is decided from
/// (`DeliveredDecisionCard`): those stop nothing, the conversation goes on underneath them, and a
/// question delivered forty messages ago is off-screen and unfindable. So the bar stays, changes
/// what it says, and points DOWN instead of away.
public struct OpenQuestionsBelow: Equatable, Sendable {
    public let count: Int
    /// The row to scroll to — the first of them in flow order, which is the oldest.
    public let rowID: String
    /// The one line the bar shows.
    public let text: String

    public init(count: Int, rowID: String, text: String) {
        self.count = count
        self.rowID = rowID
        self.text = text
    }
}

/// Pure logic behind the "needs you" surfaces, derived from the cross-agent Open snapshot the
/// clients already hold (every row carries `pendingApprovals` under the same rule the server's
/// `GET /sessions/counts` applies) — so neither surface costs a request.
public enum NeedsYouLogic {

    /// The bar for questions in THIS conversation, or nil when it holds none.
    ///
    /// `rowIDs` are the delivered decision cards in the order they appear, so the destination is
    /// the oldest one — the same FIFO the cross-session bar picks its target by. It reports what is
    /// ON SCREEN rather than what the server has pending: a card the reader dismissed with "Not
    /// yet" is not below them any more, and a bar that counted it would be pointing at nothing.
    public static func below(rowIDs: [String]) -> OpenQuestionsBelow? {
        guard let first = rowIDs.first else { return nil }
        return OpenQuestionsBelow(count: rowIDs.count, rowID: first,
                                  text: belowText(count: rowIDs.count))
    }

    /// "1 open question below" — never a bare number. The count is the useful part here (unlike the
    /// cross-session bar, where "1" told you nothing and the workspace name told you everything),
    /// because the destination is already known: it is this conversation.
    static func belowText(count: Int) -> String {
        "\(count) open question\(count == 1 ? "" : "s") below"
    }
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
    ///   - focused: the session on screen, excluded from the count. Its APPROVAL card already
    ///     renders inline at the tail of its own transcript — an approval stops the turn, so
    ///     nothing can arrive below it — and a bar pointing at that would point at itself. Pass nil
    ///     from a list, which shows no single session. What this exclusion does NOT cover is a
    ///     question that stops no turn and can therefore be pushed out of view by the messages
    ///     after it: that one is `below(rowIDs:)`, which points down into this same conversation.
    public static func banner(waiting: [Session], excluding focused: String? = nil) -> NeedsYouBanner? {
        let elsewhere = waiting.filter { $0.id != focused }
        // An owner item wins when there is one, whatever else is waiting: the other rows are a
        // blocked tool call, which the drawer's badge and every list already say, while these four
        // are the things that stop a whole project and have nowhere else to be seen from here. The
        // oldest one is the one named, by the instant the server says it has been waiting since —
        // the same FIFO the session target below uses, and the same one the project page sorts by.
        if let oldest = oldestOwnerItem(elsewhere) {
            return NeedsYouBanner(count: elsewhere.count, target: oldest.session,
                                  text: ownerItemText(oldest.item, project: oldest.session.projectTitle),
                                  ownerItem: oldest.item)
        }
        // Longest-waiting first (FIFO). Ordered on the same parsed recency key Recents uses rather
        // than on the server's array order, so a re-sorted or locally-upserted snapshot can't
        // quietly change which session a tap opens.
        guard let target = elsewhere.min(by: { RecentsLogic.recency($0) < RecentsLogic.recency($1) })
        else { return nil }
        return NeedsYouBanner(count: elsewhere.count, target: target,
                              text: text(count: elsewhere.count, target: target))
    }

    /// The owner item that has waited longest across these conversations, with the one it is on.
    ///
    /// A kind this build does not know is skipped rather than named: the count already includes it
    /// (the server counted it), and a bar reading "needs you ·" with nothing after it would be
    /// worse than the bar the older wording gives.
    static func oldestOwnerItem(_ sessions: [Session]) -> (session: Session, item: SessionOwnerItem)? {
        var oldest: (session: Session, item: SessionOwnerItem, at: Date)?
        for session in sessions {
            for item in session.ownerItems ?? [] where item.kind != .unknown {
                // An unparseable instant sorts last rather than first: it must not beat an item
                // whose wait is known, and it is still named when it is the only one.
                let at = RelativeTime.parse(item.since) ?? Date.distantFuture
                if oldest == nil || at < oldest!.at { oldest = (session, item, at) }
            }
        }
        guard let found = oldest else { return nil }
        return (found.session, found.item)
    }

    /// What the bar says about one owner item: which of the four, and which project (§7.6 V13).
    ///
    /// The project and not the item's own title, because the title is a sentence written for a
    /// card — "Coordinator asks: should the migration keep the old column?" — and this is one line
    /// that has to answer "is this mine to go and do now" at a glance. A conversation that names no
    /// project says only the first half rather than trailing an empty separator.
    static func ownerItemText(_ item: SessionOwnerItem, project: String?) -> String {
        let what: String
        switch item.kind {
        case .promotionApproval: what = "Approve merge to main"
        case .coordinatorQuestion: what = "Question from coordinator"
        case .escalated: what = "Escalated to you"
        case .fusePaused: what = "Paused"
        case .unknown: what = "Needs you"
        }
        guard let project, !project.isEmpty else { return what }
        return "\(what) · \(project)"
    }

    /// One session names its workspace; several collapse to a count. The workspace name (not the
    /// session title) is the "where" the user navigates by, and it stays short — session titles are
    /// often absent or long enough to truncate away exactly the part that identifies them.
    private static func text(count: Int, target: Session) -> String {
        guard count == 1 else { return "\(count) sessions need you" }
        return "\(target.agent?.name ?? target.title ?? "A session") needs you"
    }
}
