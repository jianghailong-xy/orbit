import Foundation

/// What a session IS to the project it belongs to, as served on every session-list row and on every
/// inbox card (`SessionProjectRole` / `InboxSessionRole` in src/shared/src/dto.ts — one vocabulary,
/// spelled twice server-side because the two payloads are unrelated).
///
/// Derived server-side (`SessionsService.list` does it in SQL) from three columns no client holds:
/// the project's `coordinatorSessionId`, the task's `verifiesTaskId`, and the session's dispatch
/// origin. Nothing here re-derives it — four clients guessing who is coordinating is four chances to
/// disagree, which is the reason the field is on the wire at all.
public enum SessionProjectRole: String, Codable, Sendable, CaseIterable {
    case coordinator, verification, execution, user

    /// An unknown role decodes as `.user` rather than failing the row: a newer server naming a
    /// fourth kind of worker must not blank the session list on an older client.
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SessionProjectRole(rawValue: raw) ?? .user
    }
}

/// What a pending approval is actually asking for. claude routes plan confirmation and its own
/// question tool through the same permission tool as any gated call, so the tool name is the only
/// thing that tells them apart — the server derives this (`approvalKind` in inbox-item.ts) exactly as
/// `Approvals.kind` does locally, so a card cannot mean one thing in the inbox and another in the
/// session it came from.
public enum InboxApprovalKind: String, Codable, Sendable {
    case permission, plan, question

    /// Unknown kinds read as `.permission` — the allow/deny card, which every approval can answer.
    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = InboxApprovalKind(rawValue: raw) ?? .permission
    }
}

/// One thing waiting on a human, wherever in the account it is (`GET /inbox`). The cross-workspace,
/// cross-project counterpart of `ApprovalInfo`, which only ever names one session's approvals:
/// everything a card needs to be actionable without first loading the session it belongs to.
public struct InboxApprovalItem: Decodable, Equatable, Sendable, Identifiable {
    public let approvalId: String
    public let kind: InboxApprovalKind
    public let toolName: String
    /// One line naming what is being asked — the command, the file, the plan's first line, the first
    /// question — server-truncated. Empty when the input carries nothing summarizable; a card falls
    /// back to `toolName` then (see `InboxLogic.cardTitle`).
    public let summary: String
    public let sessionId: String
    public let sessionTitle: String
    public let workspaceId: String?
    public let taskId: String?
    public let taskTitle: String?
    /// Reached through the session's task, or — for a coordinator session, which carries no task —
    /// by looking the session up as some project's coordinator. There is no `projectId` column on
    /// Session by design.
    public let projectId: String?
    public let projectTitle: String?
    public let role: SessionProjectRole
    /// `approval.createdAt`: how long this has been waiting, which is what the inbox is ordered by
    /// (oldest first) and what a card counts up from.
    public let waitingSince: String

    public var id: String { approvalId }

    public init(approvalId: String, kind: InboxApprovalKind, toolName: String, summary: String,
                sessionId: String, sessionTitle: String, workspaceId: String? = nil,
                taskId: String? = nil, taskTitle: String? = nil,
                projectId: String? = nil, projectTitle: String? = nil,
                role: SessionProjectRole = .user, waitingSince: String) {
        self.approvalId = approvalId
        self.kind = kind
        self.toolName = toolName
        self.summary = summary
        self.sessionId = sessionId
        self.sessionTitle = sessionTitle
        self.workspaceId = workspaceId
        self.taskId = taskId
        self.taskTitle = taskTitle
        self.projectId = projectId
        self.projectTitle = projectTitle
        self.role = role
        self.waitingSince = waitingSince
    }

    /// Decoded leniently in the text fields (a missing title reads as empty rather than dropping the
    /// whole response): the inbox is the surface a blocked agent is unblocked from, so one odd row
    /// must not be able to blank it.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        approvalId = try c.decode(String.self, forKey: .approvalId)
        kind = try c.decodeIfPresent(InboxApprovalKind.self, forKey: .kind) ?? .permission
        toolName = try c.decodeIfPresent(String.self, forKey: .toolName) ?? ""
        summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
        sessionId = try c.decode(String.self, forKey: .sessionId)
        sessionTitle = try c.decodeIfPresent(String.self, forKey: .sessionTitle) ?? ""
        workspaceId = try c.decodeIfPresent(String.self, forKey: .workspaceId)
        taskId = try c.decodeIfPresent(String.self, forKey: .taskId)
        taskTitle = try c.decodeIfPresent(String.self, forKey: .taskTitle)
        projectId = try c.decodeIfPresent(String.self, forKey: .projectId)
        projectTitle = try c.decodeIfPresent(String.self, forKey: .projectTitle)
        role = try c.decodeIfPresent(SessionProjectRole.self, forKey: .role) ?? .user
        waitingSince = try c.decodeIfPresent(String.self, forKey: .waitingSince) ?? ""
    }

    private enum CodingKeys: String, CodingKey {
        case approvalId, kind, toolName, summary, sessionId, sessionTitle, workspaceId
        case taskId, taskTitle, projectId, projectTitle, role, waitingSince
    }
}

/// An approval the human already answered, for the inbox's "Resolved" section. Carries the same
/// identity it had while it waited — `item.waitingSince` still says how long it sat there — plus how
/// it was settled. Composed rather than inherited: `InboxApprovalItem` is a struct, and both halves
/// arrive in one flat object.
public struct InboxResolvedItem: Decodable, Equatable, Sendable, Identifiable {
    public let item: InboxApprovalItem
    /// The decision in the same vocabulary the decision endpoint takes.
    public let decision: ApprovalBehavior
    /// `approval.decidedAt`.
    public let resolvedAt: String
    /// The note left with the decision, when there was one.
    public let message: String?

    public var id: String { item.approvalId }

    public init(item: InboxApprovalItem, decision: ApprovalBehavior, resolvedAt: String,
                message: String? = nil) {
        self.item = item
        self.decision = decision
        self.resolvedAt = resolvedAt
        self.message = message
    }

    public init(from decoder: Decoder) throws {
        item = try InboxApprovalItem(from: decoder)
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // `status` (ALLOWED/DENIED/…) is the durable record; `decision` is the same fact in the
        // decision endpoint's words. Read the narrower field and fall back to the status, so a row
        // from a server that only sends one of them still says how it was settled.
        if let raw = try c.decodeIfPresent(String.self, forKey: .decision) {
            decision = ApprovalBehavior(rawValue: raw) ?? .deny
        } else {
            decision = (try c.decodeIfPresent(String.self, forKey: .status)) == "ALLOWED" ? .allow : .deny
        }
        resolvedAt = try c.decodeIfPresent(String.self, forKey: .resolvedAt) ?? ""
        message = try c.decodeIfPresent(String.self, forKey: .message)
    }

    private enum CodingKeys: String, CodingKey { case decision, status, resolvedAt, message }
}

/// `GET /inbox`. `resolved` is empty unless the request asked for a window with `resolvedSince`.
public struct InboxResponse: Decodable, Equatable, Sendable {
    public let pending: [InboxApprovalItem]
    public let resolved: [InboxResolvedItem]

    public init(pending: [InboxApprovalItem] = [], resolved: [InboxResolvedItem] = []) {
        self.pending = pending
        self.resolved = resolved
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pending = try c.decodeIfPresent([InboxApprovalItem].self, forKey: .pending) ?? []
        resolved = try c.decodeIfPresent([InboxResolvedItem].self, forKey: .resolved) ?? []
    }

    private enum CodingKeys: String, CodingKey { case pending, resolved }
}

/// One project's session tallies, as `GET /sessions/project-counts` serves them — what a project
/// group header rolls up. The four buckets are disjoint server-side, so a header reading
/// "1 needs you · 1 running · 2/4 done" adds up.
public struct ProjectSessionCounts: Decodable, Equatable, Sendable, Identifiable {
    public let projectId: String
    /// Conversations blocked on an approval — the same definition the per-workspace badge uses.
    public let needsYou: Int
    /// Conversations with the engine producing and nothing waiting on the user. Disjoint from
    /// `needsYou`, so a header can state both without counting a session twice.
    public let running: Int
    /// Completed, or finished successfully and not yet filed.
    public let done: Int
    /// Every session the project has, trashed ones excluded. `done`/`total` is the header's ratio.
    public let total: Int

    public var id: String { projectId }

    public init(projectId: String, needsYou: Int, running: Int, done: Int, total: Int) {
        self.projectId = projectId
        self.needsYou = needsYou
        self.running = running
        self.done = done
        self.total = total
    }
}
