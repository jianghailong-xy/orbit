import Foundation

/// The attention inbox's pure logic — a port of web's `InboxView` helpers and `approvalDecision`.
///
/// The per-session approval card answers "what is this session asking", which is the wrong question
/// when the user is the bottleneck across twenty projects. This is the other one: everything in the
/// account waiting on a person, oldest first, each card naming itself well enough to be answered
/// without opening the session it came from.
public enum InboxLogic {
    /// Past this, a card stops being amber and goes red. Half an hour is roughly the point at which
    /// an agent blocked on a permission has stopped being "in progress" and started being stuck.
    public static let urgentAfter: TimeInterval = 30 * 60

    /// Why the session asking exists. Across projects this is more use than the workspace name,
    /// which is why the card's second line leads with it. Web parity: `ROLE_LABEL`.
    public static func roleLabel(_ role: SessionProjectRole) -> String {
        switch role {
        case .coordinator:  return "Coordinator"
        case .verification: return "Verification"
        case .execution:    return "Execution"
        case .user:         return "Direct"
        }
    }

    /// One line naming what is being asked — the command, the plan's title, the question. The server
    /// derives it per kind; `toolName` is the documented fallback for an input with nothing in it
    /// worth showing.
    public static func cardTitle(_ item: InboxApprovalItem) -> String {
        item.summary.isEmpty ? item.toolName : item.summary
    }

    /// The card's second line: who is asking, and what work it belongs to. `taskTitle` falls back to
    /// the session's own title — a session nobody dispatched carries no task, and "Direct" alone
    /// names nothing the reader can find. Absent parts are dropped rather than rendered as gaps.
    public static func metaLine(_ item: InboxApprovalItem) -> String {
        [roleLabel(item.role), item.taskTitle ?? item.sessionTitle, item.projectTitle]
            .compactMap { part -> String? in
                guard let part, !part.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
                return part
            }
            .joined(separator: " · ")
    }

    /// How long this has been waiting, at `now`. Never negative: a card whose server timestamp is a
    /// second ahead of this device's clock reads as "just arrived", not as a negative age.
    public static func waited(_ item: InboxApprovalItem, now: Date = Date()) -> TimeInterval {
        guard let at = RelativeTime.parse(item.waitingSince) else { return 0 }
        return max(0, now.timeIntervalSince(at))
    }

    /// Compact elapsed time for the wait badge: minutes up to an hour, then hours (with the minutes
    /// while they still tell you something), then days. Web parity: `waitedLabel`.
    public static func waitedLabel(_ elapsed: TimeInterval) -> String {
        let minutes = Int(max(0, elapsed) / 60)
        if minutes < 1 { return "<1m" }
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 {
            let rest = minutes % 60
            return rest > 0 ? "\(hours)h \(rest)m" : "\(hours)h"
        }
        return "\(hours / 24)d"
    }

    /// Local midnight as the instant `GET /inbox?resolvedSince=` takes — the window behind the
    /// "Resolved · today" section. Web parity: `startOfTodayIso`.
    public static func startOfToday(now: Date = Date(), calendar: Calendar = .current) -> String {
        RelativeTime.iso(calendar.startOfDay(for: now))
    }

    /// The decision body for one inbox card.
    ///
    /// Deliberately no "allow & remember": that writes a standing permission rule onto a workspace,
    /// which is not a thing to hand someone triaging twenty projects a click at a time — and the
    /// inbox payload carries no `input`, so the rule could not be derived here anyway. The session's
    /// own card still offers it (see `Approvals.rememberRule`). Answers ride only with an allow on a
    /// question: a deny means the user answered some other way.
    public static func decision(for item: InboxApprovalItem, behavior: ApprovalBehavior,
                                answers: [String: [String]]? = nil,
                                message: String? = nil) -> ApprovalDecisionRequest {
        let picks = (behavior == .allow && item.kind == .question) ? answers : nil
        return ApprovalDecisionRequest(behavior: behavior, message: message, answers: picks,
                                       rememberRule: nil)
    }

    /// The inbox as it reads the instant a decision is made, before the server has confirmed it: the
    /// card leaves `pending` and appears at the head of `resolved`, which is where the user just sent
    /// it and where they will look to check.
    ///
    /// Pure, and the same shape the push-driven refetch lands on by itself — so the optimistic frame
    /// and the authoritative one agree, and nothing visibly moves when the truth arrives. An approval
    /// that is not in `pending` (already settled elsewhere, or the cache moved on under a slow
    /// request) is left alone rather than duplicated into `resolved`. Web parity: `settleInCache`.
    public static func settle(_ inbox: InboxResponse, approvalID: String,
                              decision: ApprovalDecisionRequest, at: Date = Date()) -> InboxResponse {
        guard let item = inbox.pending.first(where: { $0.approvalId == approvalID }) else { return inbox }
        let settled = InboxResolvedItem(item: item, decision: decision.behavior,
                                        resolvedAt: RelativeTime.iso(at), message: decision.message)
        return InboxResponse(pending: inbox.pending.filter { $0.approvalId != approvalID },
                             resolved: [settled] + inbox.resolved)
    }
}
