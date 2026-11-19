import Foundation

// The task page led by the agent's work (docs/mocks/task-detail-agent-first, boards 04–05): one
// status line, Now, Delivered, Done means with the brief folded, In the plan, Runs with as one
// line, and one Activity timeline. The words are the web panel's (`TaskDetailPanel.tsx`);
// `TaskDetailCopyParityTests` holds each one here to the web source. The rules are pure, so each
// is tested on Linux.

extension TaskDetailCopy {
    // MARK: headings of the page led by the run

    public static let nowHeading = "Now"
    /// The evidence card's heading on a done task; `evidenceHeading` on any other.
    public static let deliveredHeading = "Delivered"
    public static let evidenceHeading = "Evidence"
    public static let doneMeansHeading = "Done means"
    public static let briefHeading = "Brief for the agent"
    public static let planHeading = "In the plan"
    public static let runsWithHeading = "Runs with"
    public static let activityHeading = "Activity"

    public static let showGraph = "Show graph"
    public static let hideGraph = "Hide graph"
    /// The menu entry a stopped task's header no longer draws.
    public static let runAgain = "Run again"
    /// Under the Runs with fields while a run is going.
    public static let changesApplyToNextRun = "Changes apply to the next run. The run going now keeps what it started with."

    // MARK: the composer's addressee

    public static let toTheRun = "To the run"
    public static let comment = "Comment"
    public static let sentToTheRun = "Sent to the run"
    public static func messageWhileItWorks(_ name: String) -> String { "Message \(name) while it works…" }

    // MARK: Now

    public static func isWorking(_ name: String) -> String { "\(name) is working" }
    public static let theAgent = "The agent"
    /// The same, inside the composer's sentence.
    public static let theAgentInASentence = "the agent"

    // MARK: evidence

    public static let evidenceAccepted = "Accepted"
    public static let evidenceSentBack = "Sent back"
    public static let evidenceAwaiting = "Awaiting a decision"
    public static let notCovered = "Not covered: "

    // MARK: activity

    public static let filed = "Filed"
}

/// One entry of the Activity timeline, oldest first.
public enum TaskActivityItem: Equatable, Sendable, Identifiable {
    case filed(at: String?)
    case run(SessionRef)
    case evidenceSubmitted(revision: String, at: String?)
    case evidenceDecided(revision: String, accepted: Bool, byOwner: Bool, at: String?)
    case comment(TaskComment)

    public var id: String {
        switch self {
        case .filed: return "filed"
        case .run(let session): return "run-\(session.id)"
        case .evidenceSubmitted(let revision, _): return "evidence-\(revision)"
        case .evidenceDecided(let revision, _, _, _): return "decision-\(revision)"
        case .comment(let comment): return "comment-\(comment.id)"
        }
    }

    var at: String? {
        switch self {
        case .filed(let at): return at
        case .run(let session): return session.createdAt
        case .evidenceSubmitted(_, let at): return at
        case .evidenceDecided(_, _, _, let at): return at
        case .comment(let comment): return comment.createdAt
        }
    }
}

extension TaskDetailLogic {
    // MARK: the status line

    /// How long something has been going: `<1m`, `7m`, `1h 12m`, `2h` — the web's `elapsedLabel`.
    public static func elapsedLabel(_ iso: String?, now: Date = Date()) -> String? {
        guard let iso, let start = RelativeTime.parse(iso) else { return nil }
        let seconds = now.timeIntervalSince(start)
        guard seconds >= 0 else { return nil }
        let minutes = Int(seconds / 60)
        if minutes < 1 { return "<1m" }
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        return minutes % 60 == 0 ? "\(hours)h" : "\(hours)h \(minutes % 60)m"
    }

    /// A cost as the page prints it, or nil when nothing has been booked — the web's `costLabel`.
    public static func costLabel(_ usd: Double?) -> String? {
        guard let usd, usd > 0 else { return nil }
        if usd < 0.01 { return "<$0.01" }
        // Half away from zero, as JavaScript's `toFixed(2)` rounds $3.125: `%.2f` alone gives $3.12.
        return String(format: "$%.2f", (usd * 100).rounded() / 100)
    }

    /// What every run of the task has cost together.
    public static func totalCost(_ task: TaskItem) -> String? {
        costLabel((task.sessions ?? []).reduce(0) { $0 + ($1.costUsd ?? 0) })
    }

    /// The run going now: running first, else queued. Nil when nothing is moving.
    public static func liveRun(_ task: TaskItem) -> SessionRef? {
        let sessions = task.sessions ?? []
        return sessions.first { $0.resolvedRunState == .running }
            ?? sessions.first { $0.resolvedRunState == .queued }
    }

    /// The status pill, with how long the run has been going while one is: one status, not an Open
    /// beside a run that says otherwise.
    public static func headPill(_ task: TaskItem, now: Date = Date()) -> TaskPill {
        let pill = TaskListLogic.pill(task)
        guard pill.kind == .running,
              let started = (task.sessions ?? []).first(where: { $0.resolvedRunState == .running })?.createdAt,
              let elapsed = elapsedLabel(started, now: now) else { return pill }
        return TaskPill(kind: .running, label: "\(pill.label) · \(elapsed)")
    }

    // MARK: Now

    /// The reported position, or nil for a task that never reported (revision 0) or reported nothing
    /// a reader could use.
    public static func progress(_ task: TaskItem) -> TaskProgressView? {
        guard let progress = task.progress, progress.revision > 0 else { return nil }
        guard progress.current != nil || progress.phase != nil || progress.message != nil else { return nil }
        return progress
    }

    /// `Step 3 of 5`, `Step 3`, or nil without a count.
    public static func progressStep(_ progress: TaskProgressView) -> String? {
        guard let current = progress.current else { return nil }
        if let total = progress.total { return "Step \(current) of \(total)" }
        return "Step \(current)"
    }

    /// How far along, 0…1, where a total bounds the count.
    public static func progressFraction(_ progress: TaskProgressView) -> Double? {
        guard let current = progress.current, let total = progress.total, total > 0 else { return nil }
        return Double(min(current, total)) / Double(total)
    }

    // MARK: Delivered

    /// The evidence card's chip: its decision, or that none has been made yet.
    public static func evidenceOutcome(_ row: TaskEvidenceRevision) -> (label: String, accepted: Bool?) {
        switch row.decision?.decision {
        case "CONFIRM": return (TaskDetailCopy.evidenceAccepted, true)
        case "SEND_BACK": return (TaskDetailCopy.evidenceSentBack, false)
        default: return (TaskDetailCopy.evidenceAwaiting, nil)
        }
    }

    /// The line beside the chip: which version, and who decided it when, or when it was submitted.
    public static func evidenceMeta(_ row: TaskEvidenceRevision, when: (String?) -> String) -> String {
        guard let decision = row.decision else {
            return "Evidence r\(row.revision) · submitted \(when(row.submittedAt))"
        }
        let by = decision.decidedByType == "USER" ? "you" : "a reviewing agent"
        let verb = decision.decision == "CONFIRM" ? "accepted" : "sent back"
        return "Evidence r\(row.revision) · \(verb) by \(by) · \(when(decision.decidedAt))"
    }

    /// One cited check, in words: the command a tool call ran, or the kind and its reference.
    public static func evidenceCheckText(_ check: TaskEvidenceRevision.Check) -> String {
        switch check.kind {
        case "TOOL_CALL":
            let command = check.command?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return command.isEmpty ? "Tool call \(check.ref)" : command
        case "COMMIT": return "Commit \(check.ref.prefix(9))"
        case "ARTIFACT": return "Artifact \(check.ref)"
        case "FILE": return "File \(check.ref)"
        default: return "\(check.kind) \(check.ref)"
        }
    }

    // MARK: In the plan

    /// The plan in one sentence — the web's `planSentence`: whether anything still blocks the task
    /// (only when the blocked notice is not already saying so), and which open task waits on it.
    public static func planSentence(_ task: TaskItem) -> String {
        let prerequisites = task.dependsOn ?? []
        var parts: [String] = []
        if !TaskListLogic.isBlocked(task) {
            if prerequisites.isEmpty { parts.append("Nothing blocks this task.") }
            else if prerequisites.count == 1 { parts.append("Its prerequisite is done.") }
            else { parts.append("All \(prerequisites.count) prerequisites are done.") }
        }
        let waiting = (task.dependedOnBy ?? []).compactMap(\.task)
            .filter { $0.status != .done && $0.status != .cancelled }
        if let first = waiting.first {
            let title = first.title ?? "Untitled task"
            parts.append(waiting.count == 1
                         ? "“\(title)” waits on it."
                         : "“\(title)” and \(waiting.count - 1) more wait on it.")
        }
        return parts.joined(separator: " ")
    }

    // MARK: Attribution and Followed by, only when they say something

    /// The web's `attributionNeedsCard`: a crossing, a blocker, or work counting towards a project
    /// other than the one the header names.
    public static func attributionNeedsCard(_ view: TaskAttribution, projectId: String?) -> Bool {
        if view.crossing != nil || view.blocker != nil { return true }
        guard let owning = view.owning else { return false }
        return owning.projectId != projectId
    }

    // MARK: Activity

    /// Filing, runs, evidence and its decisions, and comments, oldest first. A run in the Trash is
    /// not one anybody should be sent to.
    public static func activity(_ task: TaskItem, evidence: [TaskEvidenceRevision]) -> [TaskActivityItem] {
        var items: [TaskActivityItem] = []
        if task.createdAt != nil { items.append(.filed(at: task.createdAt)) }
        for session in task.sessions ?? [] where session.deletedAt == nil { items.append(.run(session)) }
        for row in evidence {
            items.append(.evidenceSubmitted(revision: row.revision, at: row.submittedAt))
            if let decision = row.decision {
                items.append(.evidenceDecided(revision: row.revision, accepted: decision.decision == "CONFIRM",
                                              byOwner: decision.decidedByType == "USER", at: decision.decidedAt))
            }
        }
        for comment in task.comments ?? [] { items.append(.comment(comment)) }
        // Stable: entries at the same instant keep the order above.
        return items.enumerated().sorted { a, b in
            let left = a.element.at.flatMap(RelativeTime.parse) ?? .distantPast
            let right = b.element.at.flatMap(RelativeTime.parse) ?? .distantPast
            return left == right ? a.offset < b.offset : left < right
        }.map(\.element)
    }

    /// An evidence entry's words on the timeline.
    public static func activityText(_ item: TaskActivityItem) -> String? {
        switch item {
        case .evidenceSubmitted(let revision, _): return "Evidence r\(revision) submitted"
        case .evidenceDecided(let revision, let accepted, let byOwner, _):
            return "Evidence r\(revision) \(accepted ? "accepted" : "sent back") by \(byOwner ? "you" : "a reviewing agent")"
        default: return nil
        }
    }

    // MARK: the composer

    /// Whom the comment box writes to by default: the run, when one is going and has a workspace to
    /// mention — the mention delivery puts it into that workspace's live run on this task.
    public static func runRecipient(_ task: TaskItem) -> String? {
        guard liveRun(task) != nil else { return nil }
        return task.assignee?.id
    }

    /// The mentions a comment carries, with the run's workspace added when it goes to the run.
    public static func mentions(_ mentioned: [String], toRun recipient: String?) -> [String] {
        guard let recipient, !mentioned.contains(recipient) else { return mentioned }
        return mentioned + [recipient]
    }
}
