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

/// What is waiting in the conversation ON SCREEN, and where in it: a count, the row to scroll to,
/// and the one line the bar says.
///
/// The bar was cross-session only, and the reason it excluded the session you were looking at was
/// that "its own approval card is already at the tail of its transcript, so a bar pointing at it
/// would point at itself". That reason holds for an APPROVAL — it stops the turn, so nothing can
/// arrive below it — and it does not hold for the cards a project's ruler is decided from
/// (`DeliveredDecisionCard`) or for an exception the owner has to press: those stop nothing, the
/// conversation goes on underneath them, and one delivered forty messages ago is off-screen and
/// unfindable. So the bar stays, changes what it says, and points DOWN instead of away.
public struct WaitingBelow: Equatable, Sendable {
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

/// One row waiting below the fold, and whether it is a QUESTION — the only thing the bar's words
/// turn on.
///
/// It is a question when the reader answers it by replying or choosing: a proposal, an evidence
/// revision, a standard set, a confirmation, a merge, the coordinator's own question. It is not when
/// the reader answers it by PRESSING: an exception that became theirs and a pause only they can lift
/// are cards with doors, and calling those questions told the reader to look for something to say
/// (see `below`).
public struct BelowRow: Equatable, Sendable {
    public let rowID: String
    public let isQuestion: Bool

    public init(rowID: String, isQuestion: Bool) {
        self.rowID = rowID
        self.isQuestion = isQuestion
    }
}

/// Pure logic behind the "needs you" surfaces, derived from the cross-agent Open snapshot the
/// clients already hold (every row carries `pendingApprovals` under the same rule the server's
/// `GET /sessions/counts` applies) — so neither surface costs a request.
public enum NeedsYouLogic {

    /// The bar for what is waiting in THIS conversation, or nil when nothing is.
    ///
    /// `rows` are the delivered cards that are still open, in the order they appear, so the
    /// destination is the oldest one — the same FIFO the cross-session bar picks its target by. It
    /// reports what is ON SCREEN rather than what the server has pending: a card the reader dismissed
    /// with "Not yet" is not below them any more, and a bar that counted it would be pointing at
    /// nothing.
    ///
    /// THE EXCEPTIONS ARE IN HERE, and they are why the words are not simply "questions". A card the
    /// owner answers by pressing — an escalation that became theirs, a pause only they can lift — is
    /// as capable of leaving the screen as a proposal is, and it was excluded on the argument that
    /// the browser's rail points at decisions rather than at items. What that argument missed is the
    /// reader: inside a project's coordinator conversation there is no other surface at all (the
    /// needs-you bar excludes the session on screen), so an exception that scrolled away had nothing
    /// pointing at it (the account owner's report, 2026-09-22). So they are counted, and the bar says
    /// which kind of thing it is pointing at rather than calling every one of them a question.
    public static func below(rows: [BelowRow]) -> WaitingBelow? {
        guard let first = rows.first else { return nil }
        return WaitingBelow(count: rows.count, rowID: first.rowID,
                                  text: belowText(count: rows.count,
                                                  allQuestions: rows.allSatisfy(\.isQuestion)))
    }

    /// "1 open question below" while every card below is a question — the words this bar has always
    /// used, unchanged for the case it was built for. Anything else says "2 waiting below": never a
    /// bare number (the count is the useful part here, unlike the cross-session bar, where "1" told
    /// you nothing and the workspace name told you everything), and never a noun that is wrong about
    /// what the press will scroll to — a card reading "Escalated to you" under a line calling it a
    /// question is the same lie as "Waiting for approval" over an escalation.
    static func belowText(count: Int, allQuestions: Bool) -> String {
        guard allQuestions else { return "\(count) waiting below" }
        return "\(count) open question\(count == 1 ? "" : "s") below"
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
    ///     after it: that one is `below(rows:)`, which points down into this same conversation.
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
        let what = kindWord(item.kind) ?? "Needs you"
        guard let project, !project.isEmpty else { return what }
        return "\(what) · \(project)"
    }

    /// Which of the four, in the words the banner and the card share, and nothing else — no project,
    /// no count. Nil for a kind this build does not know, which every caller falls back from rather
    /// than naming (§7.6 V13).
    ///
    /// Separate from `ownerItemText` because a session ROW says this half alone: a row has one line
    /// and the project it is about is the conversation the row already names. Both readers take the
    /// words from here, so the row above a bar can never spell one of the four differently from the
    /// bar itself.
    public static func kindWord(_ kind: OwnerItemKind) -> String? {
        switch kind {
        case .promotionApproval: return "Approve merge to main"
        case .coordinatorQuestion: return "Question from coordinator"
        case .escalated: return "Escalated to you"
        case .fusePaused: return "Paused"
        case .unknown: return nil
        }
    }

    /// The word for the item a row says it is waiting on: the oldest one, which is the same item the
    /// banner names, so the row and the bar above it point at the same card. Nil when nothing on the
    /// row is a kind this build can name.
    public static func oldestItemWord(_ items: [SessionOwnerItem]?) -> String? {
        guard let items else { return nil }
        var oldest: (word: String, at: Date)?
        for item in items {
            guard let word = kindWord(item.kind) else { continue }
            // An unparseable instant sorts last rather than first, exactly as it does for the
            // banner: it must not beat an item whose wait is known.
            let at = RelativeTime.parse(item.since) ?? Date.distantFuture
            if oldest == nil || at < oldest!.at { oldest = (word, at) }
        }
        return oldest?.word
    }

    /// One session names its workspace; several collapse to a count. The workspace name (not the
    /// session title) is the "where" the user navigates by, and it stays short — session titles are
    /// often absent or long enough to truncate away exactly the part that identifies them.
    private static func text(count: Int, target: Session) -> String {
        guard count == 1 else { return "\(count) sessions need you" }
        return "\(target.agent?.name ?? target.title ?? "A session") needs you"
    }
}
