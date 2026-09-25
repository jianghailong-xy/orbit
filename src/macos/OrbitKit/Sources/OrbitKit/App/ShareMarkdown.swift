import Foundation

/// Copy as Markdown (docs/share-links-design.md §8): a task or a project as Markdown, for pasting
/// into a chat or a PR — ports of web's `taskMarkdown` (TaskDetailPanel.tsx) and `projectMarkdown`
/// (ProjectShareControls.tsx), in the words those use. It is the owner's own read, for the owner's
/// own use: nothing is made public by copying it, and the link it carries is the signed-in address.
public enum ShareMarkdown {
    /// How many runs the task's Markdown lists one by one before it only counts the rest.
    public static let listedRuns = 10
    /// What a task with no acceptance criteria says in their place (web `ACCEPTANCE_EMPTY`).
    public static let acceptanceEmpty = "No acceptance criteria set."

    // MARK: a task

    /// The task: its title, how it stands and how that is judged, what settles it, its
    /// dependencies, its runs in brief, and the link back to it. `time` writes a run's start the way
    /// the panel does ("Sep 25, 2:12 AM").
    public static func task(_ task: TaskItem, link: String,
                            time: (String?) -> String = runTime) -> String {
        let judged = TaskJudgmentCopy.completionCriterionChip[task.completionCriterion ?? ""]
            .map(firstSeparatorAsSpace)
        let status = [outcomeLabel(status: task.status.rawValue, terminalReason: task.terminalReason), judged]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        var out = ["# \(task.title)", "", "**Status:** \(status)"]
        if let note = supersessionNote(task) { out.append("**Outcome:** \(note)") }
        let acceptance = task.acceptanceCriteria?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        out += ["**Link:** \(link)", "", "## Acceptance", "", acceptance.isEmpty ? acceptanceEmpty : acceptance]
        if let command = task.acceptanceCommand, !command.isEmpty, let code = task.acceptanceExpectedExitCode {
            out += ["", "Command: `\(command)` — done when it exits `\(code)`"]
        }

        let needs = (task.dependsOn ?? []).compactMap(\.dependsOnTask)
        let unblocks = (task.dependedOnBy ?? []).compactMap(\.task)
        out += ["", "## Dependencies", ""]
        if needs.isEmpty && unblocks.isEmpty { out.append("No dependencies") }
        for t in needs { out.append("- Needs: \(t.title ?? "") — \(outcomeLabel(status: t.status?.rawValue))") }
        for t in unblocks { out.append("- Unblocks: \(t.title ?? "") — \(outcomeLabel(status: t.status?.rawValue))") }

        // Newest first, as the panel lists them; one in the Trash is not a run anybody should be
        // sent to.
        let runs = (task.sessions ?? []).filter { $0.deletedAt == nil }
        out += ["", "## Runs", ""]
        if runs.isEmpty { out.append("No runs yet") } else { out += ["\(runs.count) run\(runs.count == 1 ? "" : "s")", ""] }
        for run in runs.prefix(listedRuns) {
            // `agent` is the workspace, served under both names.
            let workspace = run.agent?.name.flatMap { $0.isEmpty ? nil : " · \($0)" } ?? ""
            out.append("- \(runLabel(run.resolvedRunState)) · \(time(run.createdAt))\(workspace)")
        }
        if runs.count > listedRuns { out.append("- …and \(runs.count - listedRuns) earlier") }
        return out.joined(separator: "\n") + "\n"
    }

    /// How a task ended, in web `taskOutcomeChip`'s words: a replaced or dropped attempt says so
    /// rather than its bare status. An unrecognised status reads as itself.
    public static func outcomeLabel(status: String?, terminalReason: String? = nil) -> String {
        if terminalReason == "SUPERSEDED" { return "Superseded" }
        if terminalReason == "ABANDONED" { return "Abandoned" }
        switch status ?? "" {
        case "OPEN": return "Open"
        case "IN_PROGRESS": return "In progress"
        case "DONE": return "Done"
        case "FAILED": return "Failed"
        case "CANCELLED": return "Cancelled"
        case let other: return other
        }
    }

    /// What replaced this task, or what it replaced (web `supersessionNote`); nil when neither.
    public static func supersessionNote(_ task: TaskItem) -> String? {
        if task.terminalReason == "SUPERSEDED" {
            if task.supersededByTaskIdAbsentReason == "SUCCESSOR_DELETED" {
                return "Superseded — the task that replaced it has been deleted"
            }
            let chain = task.successorChain ?? []
            guard let head = chain.last else { return "Superseded by a later attempt" }
            return chain.count == 1
                ? "Superseded by \(head.title ?? "")"
                : "Superseded — \(head.title ?? "") is the live attempt, \(chain.count) replacements on"
        }
        let replaced = task.supersedes ?? []
        if replaced.count == 1 { return "Replaces \(replaced[0].title ?? "")" }
        if replaced.count > 1 { return "Replaces \(replaced.count) earlier attempts" }
        return nil
    }

    /// A run's state in the task panel's words (web `SESSION_STATE_META`).
    public static func runLabel(_ state: SessionRunState?) -> String {
        switch state {
        case .queued: return "Queued"
        case .running: return "Running"
        case .succeeded: return "Succeeded"
        case .failed: return "Failed"
        case .awaitingInput: return "Awaiting reply"
        case .interrupted: return "Interrupted"
        case .ended: return "Ended"
        case .unknown, nil: return "—"
        }
    }

    /// When a run started, as the panel writes it: month, day and time in this device's locale.
    public static func runTime(_ iso: String?) -> String {
        guard let iso, let date = RelativeTime.parse(iso) else { return "—" }
        return runTimeFormatter.string(from: date)
    }

    private static let runTimeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.setLocalizedDateFormatFromTemplate("MMMdjmm")
        return f
    }()

    /// "Judged by · submitted evidence" → "Judged by submitted evidence": the chip's words as a
    /// phrase after the outcome.
    private static func firstSeparatorAsSpace(_ chip: String) -> String {
        guard let separator = chip.range(of: " · ") else { return chip }
        return chip.replacingCharacters(in: separator, with: " ")
    }

    // MARK: a project

    /// The project: its title, where it stands and how far its work has got, its goal, each stated
    /// criterion with what its work has done, its tasks, and the link back to it — in the words the
    /// project page uses. `buckets` and `tasks` are what the page's Work overview and Tasks blocks
    /// have read, when they have.
    public static func project(_ project: ProjectDocument, link: String,
                               buckets: ProjectPanoramaBuckets? = nil,
                               tasks: [ProjectTaskRow]? = nil) -> String {
        let count = project.taskCount
        var status = [projectStatusWord(project.status), "\(count) task\(count == 1 ? "" : "s")"]
        if let buckets {
            let lanes = [(buckets.done, "done"), (buckets.running, "running"), (buckets.ready, "ready"),
                         (buckets.blocked, "waiting"), (buckets.awaitingVerification, "awaiting verification"),
                         (buckets.failed, "failed"), (buckets.cancelled, "cancelled")]
            let progress = lanes.filter { $0.0 > 0 }.map { "\($0.0) \($0.1)" }.joined(separator: ", ")
            if !progress.isEmpty { status.append(progress) }
        }
        var out = ["# \(project.title)", "", "**Status:** \(status.joined(separator: " · "))", "**Link:** \(link)"]
        let goal = project.goal?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        out += ["", "## Goal", "", goal.isEmpty ? "No goal set" : goal]

        out += ["", "## Acceptance criteria", ""]
        if project.acceptanceCriteriaItems.isEmpty { out.append("No criteria are stated for this project.") }
        for criterion in project.acceptanceCriteriaItems {
            var answer = ""
            if criterion.satisfied == true {
                answer = " — Met by its work"
                if let landing = criterion.landing, !landing.isEmpty {
                    answer += " · \(landingWords[landing] ?? landing)"
                }
            } else if criterion.satisfied == false {
                answer = " — Not met by its work"
            }
            let text = criterion.text.trimmingCharacters(in: .whitespacesAndNewlines)
            out.append("\(criterion.ordinal). \(text)\(answer)")
        }

        if let tasks {
            out += ["", "## Tasks", ""]
            if tasks.isEmpty { out.append("No top-level tasks yet") }
            for task in tasks {
                out.append("- \(task.title) — \(taskStatusLabel(task.status, running: task.workState == "RUNNING"))")
            }
        }
        return out.joined(separator: "\n") + "\n"
    }

    /// A project's status as its Markdown says it (web `PROJECT_STATUS_WORD`).
    public static func projectStatusWord(_ status: ProjectStatus) -> String {
        switch status {
        case .open: return "Open"
        case .done: return "Completed"
        case .cancelled: return "Cancelled"
        case .unknown: return status.rawValue
        }
    }

    /// Where a criterion's met work is, in the acceptance card's words (web `LANDING_WORDS`).
    public static let landingWords: [String: String] = [
        "LANDED": "on main",
        "ON_INTEGRATION_LINE": "on the project branch · not on main yet",
        "UNKNOWN": "no merge receipt either way",
    ]

    /// A task row's status in the task pill's words (web `taskStatusLabel`): a running task says
    /// Running whatever its stored status.
    public static func taskStatusLabel(_ status: String, running: Bool) -> String {
        if running { return "Running" }
        switch status {
        case "DONE": return "Done"
        case "IN_PROGRESS": return "In progress"
        case "OPEN": return "Open"
        case "FAILED": return "Failed"
        case "CANCELLED": return "Cancelled"
        default: return status
        }
    }
}
