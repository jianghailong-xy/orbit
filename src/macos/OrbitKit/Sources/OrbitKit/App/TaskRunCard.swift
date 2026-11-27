import Foundation

// The task card opened from a task's own run conversation (docs/task-run-sidebar-design.md, the web
// column signed off 2026-11-27): the same blocks in the web column's order — head with the reasoned
// status pill, the state block, Branch, Done means as a checklist, Runs, then Runs with and Activity
// on a line each. The words are the web's (`TaskDetailPanel.tsx`) and the pill's cause is the shared
// table's (`src/shared/src/taskStatusReason.ts`); `TaskRunCardCopyParityTests` holds both here.

/// Why a task's run ended the way it did, as the status pill says it: `Failed · check exited 1`.
/// The shared table's causes (`TaskStatusReasonKey`), one case each.
public enum TaskStatusReason: Equatable, Sendable {
    case checkExited(Int)
    case runStopped
    case runInterrupted
    case overBudget
    case runnerLost
    case runFailed

    /// The cause in words (`TASK_STATUS_REASON_COPY`).
    public var text: String {
        switch self {
        case .checkExited(let code): return "check exited \(code)"
        case .runStopped: return "run stopped"
        case .runInterrupted: return "run interrupted"
        case .overBudget: return "over budget"
        case .runnerLost: return "runner lost"
        case .runFailed: return "run failed"
        }
    }

    /// What the runner reports for a command that returned no code of its own.
    private static let noComparableExitCode = -1

    /// Why this run failed, or nil when nothing it carries names a cause — `taskFailureReason`, read
    /// newest fact first: the acceptance rounds Orbit ran, the session's error sentence, then how its
    /// last turn ended or why it was ended.
    public static func failure(_ run: SessionRef?) -> TaskStatusReason? {
        guard let run else { return nil }
        if let newest = run.acceptanceRounds?.first, newest.exitCode != newest.expectedExitCode {
            return .checkExited(newest.exitCode ?? noComparableExitCode)
        }
        let error = run.error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if let code = acceptanceSentenceCode(error) { return .checkExited(code) }
        if error.range(of: #"\brunner (offline|lost)\b"#, options: [.regularExpression, .caseInsensitive]) != nil {
            return .runnerLost
        }
        if error.range(of: #"\b(over|exceeded (its|the)) budget\b|\bbudget exceeded\b"#,
                       options: [.regularExpression, .caseInsensitive]) != nil {
            return .overBudget
        }
        let endReason = (run.endReason ?? "").lowercased()
        if run.lastTurnOutcome == .cancelled || endReason == "cancelled" || endReason == "task_cancelled" {
            return .runStopped
        }
        if run.lastTurnOutcome == .interrupted { return .runInterrupted }
        if !error.isEmpty || run.lastTurnOutcome == .failed { return .runFailed }
        return nil
    }

    /// The code in the apiserver's sentence for a disagreeing round: `acceptance command exited N; expected M`.
    static func acceptanceSentenceCode(_ error: String) -> Int? {
        guard let regex = try? NSRegularExpression(pattern: #"^acceptance command exited (-?\d+); expected (-?\d+)$"#),
              let match = regex.firstMatch(in: error, range: NSRange(error.startIndex..., in: error)),
              let code = Range(match.range(at: 1), in: error) else { return nil }
        return Int(error[code])
    }
}

/// The card's words, the web column's.
public enum TaskRunCardCopy {
    public static let kicker = "Task"
    public static let failed = "Failed"
    public static let needsYou = "Needs you"
    public static func needsYouEvidence(_ revision: String) -> String { "Needs you · evidence r\(revision)" }
    public static func soFar(_ cost: String) -> String { "\(cost) so far" }

    public static let reviewTheEvidence = "Review the evidence"
    public static let accept = "Accept"
    public static let sendBack = "Send back"
    public static let delivered = "Delivered"
    public static func evidenceAccepted(_ revision: String, _ time: String) -> String { "Evidence r\(revision) accepted · \(time)" }
    public static func checkExited(_ code: Int, _ time: String) -> String { "Check exited \(code) · \(time)" }
    public static let done = "Done"
    public static let whyItFailed = "Why it failed"
    public static func round(exit: Int?, expected: Int, time: String) -> String {
        "Acceptance check · exit \(exit.map(String.init) ?? "none"), expected \(expected) · \(time)"
    }
    public static let output = "Output"
    public static let printedNothing = "It printed nothing."
    public static func latestNote(_ author: String, _ day: String) -> String { "Latest note (\(author), \(day)): " }
    public static let read = "Read"
    public static let showLess = "Show less"
    public static let rerunTheCheck = "Re-run the check"
    public static let retryTheTask = "Retry the task"
    public static let closeAsNotNeeded = "Close as not needed"

    public static let branch = "Branch"
    public static func versus(_ main: String) -> String { "vs \(main)" }
    public static func inMain(_ main: String) -> String { "In \(main)" }
    public static func ahead(_ count: Int) -> String { "\(count) ahead" }
    public static let left = "Left"
    public static func more(_ count: Int) -> String { "\(count) more" }
    public static let landing = "Landing"
    public static func mergedInto(_ target: String) -> String { "Merged into \(target)" }
    public static let notLanded = "Not landed"
    public static let afterYouAccept = "After you accept"
    public static let afterItsDone = "After it's done"

    public static let doneMeans = "Done means"
    public static let criteriaTextBrief = "Criteria text · Brief"
    public static let show = "Show"
    public static let hide = "Hide"
    public static let runs = "Runs"
    public static func run(_ number: Int) -> String { "Run \(number)" }
    public static let thisConversation = "this conversation"
    public static let edit = "Edit"
    public static func activity(_ count: Int) -> String { "Activity · \(count)" }
    public static func filedFrom(_ title: String) -> String { " · Filed from \(title)" }
    public static let untitledSession = "Untitled session"
}

/// Which state block the card draws first (`compactTaskState`).
public enum TaskRunCardState: String, Sendable, Equatable {
    case failed, running, needsYou, done
}

/// The card's blocks, top to bottom, as the web column draws them.
public enum TaskRunCardBlock: String, Sendable, Identifiable, CaseIterable {
    case head
    case state
    case branch
    case doneMeans
    case runs
    case runsWith
    case activity

    public var id: String { rawValue }
}

/// One row of Done means: ✓ passed, ✕ failed, ○ not settled yet (`DoneMeansRow`).
public struct TaskDoneMeansRow: Equatable, Sendable, Identifiable {
    public enum Mark: String, Sendable { case passed, failed, pending }
    public let id: String
    public let text: String
    /// The acceptance command, drawn as code.
    public let code: Bool
    public let mark: Mark

    public var glyph: String {
        switch mark {
        case .passed: return "✓"
        case .failed: return "✕"
        case .pending: return "○"
        }
    }
}

public enum TaskRunCardLogic {
    /// The state block: a settled task first, then one waiting on the owner, then one with a run going.
    public static func state(status: TaskStatus, needsYou: Bool, running: Bool) -> TaskRunCardState? {
        if status == .done { return .done }
        if status == .failed { return .failed }
        if needsYou { return .needsYou }
        if running { return .running }
        return nil
    }

    /// The blocks the card draws, in the web column's order. A block with nothing to say is left out:
    /// no state for a task at rest, no Branch before the run has one, no Runs before the first run.
    public static func blocks(state: TaskRunCardState?, hasBranch: Bool, hasRuns: Bool) -> [TaskRunCardBlock] {
        var blocks: [TaskRunCardBlock] = [.head]
        if state != nil { blocks.append(.state) }
        if hasBranch { blocks.append(.branch) }
        blocks.append(.doneMeans)
        if hasRuns { blocks.append(.runs) }
        blocks += [.runsWith, .activity]
        return blocks
    }

    /// The run whose conversation the task page was opened over: the frame right under the task's own
    /// page is a conversation, and that conversation is one of the task's runs. Nil anywhere else —
    /// the Tasks list, a project, a link in another conversation — where the full page is drawn.
    public static func hereRun(_ task: TaskItem, path: [NavNode]) -> SessionRef? {
        let taskKey = PublicID.storageKey(task.id)
        guard let index = path.lastIndex(where: {
            if case .taskDetail(let id) = $0 { return PublicID.storageKey(id) == taskKey }
            return false
        }), index > 0, case .console(let sessionID, _) = path[index - 1] else { return nil }
        let sessionKey = PublicID.storageKey(sessionID)
        return (task.sessions ?? []).first { PublicID.storageKey($0.id) == sessionKey }
    }

    /// The status pill, carrying its reason: `Failed · check exited 1`, `Needs you · evidence r1`, or
    /// the page's own pill (`Running · 7m`, `Done`). Needs you draws amber, a queued pill's colour.
    public static func pill(_ task: TaskItem, state: TaskRunCardState?, run: SessionRef?, evidenceRevision: String?,
                            now: Date = Date()) -> TaskPill {
        switch state {
        case .failed:
            let reason = TaskStatusReason.failure(run)
            return TaskPill(kind: .failed, label: [TaskRunCardCopy.failed, reason?.text].compactMap { $0 }
                .joined(separator: " · "))
        case .needsYou:
            return TaskPill(kind: .queued, label: evidenceRevision.map(TaskRunCardCopy.needsYouEvidence)
                ?? TaskRunCardCopy.needsYou)
        default:
            return TaskDetailLogic.headPill(task, now: now)
        }
    }

    /// The line beside the pill: what the run going now has cost, or the run's date and the task's cost.
    public static func meta(_ task: TaskItem, state: TaskRunCardState?, run: SessionRef?,
                            day: (String?) -> String?) -> String? {
        if state == .running {
            return TaskDetailLogic.costLabel(TaskDetailLogic.liveRun(task)?.costUsd).map(TaskRunCardCopy.soFar)
        }
        let parts = [run.flatMap { day($0.createdAt) }, TaskDetailLogic.totalCost(task)].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// The round that judges the command row: this run's newest, else the newest any run ran.
    public static func newestRound(_ task: TaskItem, run: SessionRef?) -> TaskAcceptanceRound? {
        if let first = run?.acceptanceRounds?.first { return first }
        return (task.sessions ?? []).flatMap { $0.acceptanceRounds ?? [] }.max { $0.finishedAt < $1.finishedAt }
    }

    /// Done means as a checklist (`doneMeansChecklist`): the acceptance command, judged by the newest
    /// round Orbit ran, then each criterion of the text (its list items, or the text as one row),
    /// ticked once the task is accepted. No record says which line of a text criterion holds, so a
    /// line is never crossed out on its own.
    public static func doneMeans(criteria: String?, command: String?, round: TaskAcceptanceRound?,
                                 status: TaskStatus, evidenceDecision: String?) -> [TaskDoneMeansRow] {
        var rows: [TaskDoneMeansRow] = []
        if let command, !command.isEmpty {
            let mark: TaskDoneMeansRow.Mark = round.map { $0.exitCode == $0.expectedExitCode ? .passed : .failed } ?? .pending
            rows.append(TaskDoneMeansRow(id: "command", text: command, code: true, mark: mark))
        }
        let settled = status == .done || evidenceDecision == "CONFIRM"
        let text = criteria?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let bullet = #"^([-*•]|\d+[.)])\s+"#
        let items = text.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.range(of: bullet, options: .regularExpression) != nil }
        let lines: [String]
        if !items.isEmpty {
            lines = items.map { $0.replacingOccurrences(of: bullet, with: "", options: .regularExpression) }
        } else if !text.isEmpty {
            lines = [text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)]
        } else {
            lines = []
        }
        for (i, line) in lines.enumerated() {
            rows.append(TaskDoneMeansRow(id: "criterion-\(i)", text: line, code: false, mark: settled ? .passed : .pending))
        }
        return rows
    }

    /// The Branch block's Landing line: the landing's own badge, a merge the conversation made, or
    /// what landing waits on.
    public static func landingLine(landing: String?, mergeStatus: String?, mergeTarget: String?, main: String,
                                   state: TaskRunCardState?) -> String {
        if let landing { return landing }
        if mergeStatus == "merged" { return TaskRunCardCopy.mergedInto(mergeTarget ?? main) }
        switch state {
        case .done, .failed: return TaskRunCardCopy.notLanded
        case .needsYou: return TaskRunCardCopy.afterYouAccept
        default: return TaskRunCardCopy.afterItsDone
        }
    }

    /// The first line of a comment, for the Why it failed note.
    public static func firstLine(_ body: String) -> String {
        body.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
    }

    /// The Activity line: how many entries, and the conversation the task was filed from.
    public static func activityLine(count: Int, filedFrom: SessionRef?) -> String {
        TaskRunCardCopy.activity(count)
            + (filedFrom.map { TaskRunCardCopy.filedFrom(($0.title?.isEmpty == false ? $0.title : nil)
                ?? TaskRunCardCopy.untitledSession) } ?? "")
    }
}
