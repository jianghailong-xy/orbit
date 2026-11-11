import Foundation

// The two asks Orbit raises for itself — a batch of new tasks, and a restructure of a list's
// dependency graph — carry a server-computed `preview` describing what would happen. Web renders
// it as a typed card; without this the native clients fell back to the generic "Approve tool call"
// chrome, which shows the tool's name and nothing about the change. A person was being asked to
// approve fifty tasks they could not see.
//
// Parsing lives here rather than in the view so both clients share it and it can be tested on
// Linux, where the SwiftUI layer cannot be built.

/// One edge a restructure would write.
public struct DagOpSummary: Equatable, Sendable, Identifiable {
    public let op: String            // "add" | "remove"
    public let taskTitle: String
    public let dependsOnTitle: String
    public let noop: Bool
    public var id: String { "\(op) \(taskTitle) \(dependsOnTitle)" }

    /// "A waits on B" / "A no longer waits on B" — the edge in the direction the graph is read.
    public var sentence: String {
        "\(taskTitle) \(op == "add" ? "waits on" : "no longer waits on") \(dependsOnTitle)"
    }
}

public struct DagApprovalPreview: Equatable, Sendable {
    public let listTitle: String
    public let note: String
    /// Tasks whose prerequisites are now all finished — the sweep collects these within the minute.
    public let becomingRunnable: Int
    /// Freed from waiting, but with no prerequisite left nothing will trigger them.
    public let becomingManual: Int
    public let becomingBlocked: Int
    public let ops: [DagOpSummary]
    /// Non-empty when the batch would close a loop; it is rejected rather than applied.
    public let cycle: [String]
    public let edgesBefore: Int
    public let edgesAfter: Int
}

/// One task in the window the card was given, with the wiring needed to show the batch's shape.
public struct BatchPreviewTask: Equatable, Sendable {
    public let title: String
    /// Label other items in this batch use to depend on it; nil when nothing does.
    public let ref: String?
    /// Refs of earlier items in this same batch.
    public let dependsOnRefs: [String]?
    /// Ids of tasks that already exist — not drawn, so a task carrying one is a root in this
    /// picture without being one overall, and the row says so.
    public let dependsOnTaskIds: [String]?
}

public struct BatchApprovalPreview: Equatable, Sendable {
    public let taskCount: Int
    /// Has a prerequisite, and it is finished. Auto-run triggers on that, not on being unblocked.
    public let startingNow: Int
    public let blocked: Int
    /// No prerequisite at all, so nothing will ever trigger it — every root of a fresh DAG.
    public let needsManualStart: Int
    public let notDispatchable: Int
    public let edges: Int
    public let lists: [String]
    public let tasks: [BatchPreviewTask]
    public let titlesTruncated: Int
}

/// What a single create would write, read straight off the body the runner is about to send.
public struct CreateApprovalPreview: Equatable, Sendable {
    public let isProject: Bool
    public let title: String
    /// The task's description, or the project's goal.
    public let prose: String
    /// The task's acceptance criteria, or each of the project's stated criteria.
    public let criteria: [String]
    /// The consequence of the write, in the same shape the batch card reads: how many run within
    /// the minute, how many wait, how many nothing will ever trigger. A task create is a batch of
    /// one and the server computes it the same way, when it files the card — so this is the same
    /// report, and nil when that read failed, which must not cost a human their card.
    public let preview: BatchApprovalPreview?
    /// The completion criterion the caller declared (`EXECUTABLE`, `OWNER_CONFIRMED`, …). Empty on
    /// a project, which states acceptance criteria instead of declaring how the work settles.
    public let criterion: String

    /// The consequence lines, first and largest — the batch card's own, which is the point: one
    /// task is a batch of one and the two cards should say the same kind of thing first.
    public var impact: [String] {
        preview.map(Approvals.batchImpactLines) ?? []
    }

    /// The same lines with their kinds, which is what the card draws: a mark per kind, the count in
    /// bold, the reason under it.
    public var impactRows: [BatchImpactRow] {
        preview.map(Approvals.batchImpactRows) ?? []
    }

    /// Where it lands and how it settles, under the pill. The assignee is deliberately not named:
    /// the create defaults it to the calling agent, so "unassigned" is a claim this card cannot
    /// make from the input — and when nothing can run it, the pill already says so.
    public var detail: String {
        var parts: [String] = []
        if let list = preview?.lists.first, !list.isEmpty { parts.append("into \(list)") }
        if !criterion.isEmpty { parts.append(criterion) }
        return parts.joined(separator: " · ")
    }

    /// The row the batch card puts its titles in. A project keeps its name in the header — it has no
    /// count to lead with — so this is empty for one.
    public var titleLine: String { isProject ? "" : title }

    /// The long-form field, folded: the task's description or the project's goal. Written for the
    /// agent that will execute it, which is why it is the one field that does not get to sit
    /// unfolded on a phone.
    public var descriptionText: String { prose }

    /// The project's criteria arrive one per item; a task's arrive as one Markdown block.
    public var criteriaText: String {
        isProject ? criteria.map { "- \($0)" }.joined(separator: "\n") : criteria.joined(separator: "\n")
    }

    /// The noun the fold's label names, so a project's goal is never called a description.
    public var foldNoun: String { isProject ? "goal" : "description" }
}

/// What ending a blocker would write, read off the ask the runner raised. The one ask here that is
/// not about creating something: a blocker is the project saying it needs a person, and
/// `requiredAction` is addressed to whoever is reading the card — so the two sentences it carries
/// are the decision itself: what it asked for, and why the agent says that no longer applies.
public struct BlockerResolvePreview: Equatable, Sendable {
    public let projectTitle: String
    /// What the blocker asks for — the sentence written for a person to act on.
    public let requiredAction: String
    /// Why the agent says it no longer blocks.
    public let reason: String
    /// What kind of wait this is ("provider", "owner"…), for a blocker with nothing to name.
    public let kind: String
    /// The task (or other named subject) it is about, when it is about one.
    public let subjectTitle: String

    /// The line above the two sentences: what this wait is about. A blocker about the project
    /// itself names no task, and then the kind stands in — and with neither, no line at all.
    public var about: String {
        subjectTitle.isEmpty ? kind : "About \(subjectTitle)"
    }

    /// What a refusal names, ahead of the reason to be typed: the subject, else the kind, else the
    /// word for the thing itself. Web computes the same name (`declineSubject`).
    public var declineName: String {
        if !subjectTitle.isEmpty { return subjectTitle }
        if !kind.isEmpty { return kind }
        return "this blocker"
    }
}

/// What a merge-check change would write, read off the `orbit_project_update_integration` ask. The
/// runner reads the CURRENT check from the project and puts the proposal beside it
/// (`runner-go/mcp.go`, `projectMergeCheckCard`), and the server writes only what this card carried —
/// so the two commands are the whole decision. Web draws the same pair (`MergeCheckChangeBody`).
public struct MergeCheckChangePreview: Equatable, Sendable {
    public let snapshot: JSONValue
    public let projectTitle: String
    /// The check as the project stands, or nil when it has none.
    public let current: String?
    /// What it would become; nil clears it.
    public let next: String?
    /// False when the proposal names only a timeout: the command stays as it is.
    public let changesCommand: Bool
    /// The budget the proposal names, in seconds; nil leaves it as it is.
    public let timeoutSeconds: Int?

    public func value(_ key: String, after: Bool) -> JSONValue? {
        if after, let proposed = snapshot[key] { return proposed }
        return snapshot["current" + key.prefix(1).uppercased() + key.dropFirst()]
    }
    public func commandLine(_ layer: String, after: Bool) -> String {
        if let command = value(layer + "CheckCommand", after: after)?.stringValue { return command }
        return layer == "landing" ? LandingCheckCopy.inheritedCommand(value("mergeCheckCommand", after: after)?.stringValue)
            : "no check configured"
    }
    public func budgetLine(_ layer: String, after: Bool) -> String {
        if let seconds = value(layer + "CheckTimeoutSeconds", after: after)?.intValue { return "\(seconds) seconds" }
        return layer == "landing" ? LandingCheckCopy.inheritedTimeout(value("mergeCheckTimeoutSeconds", after: after)?.intValue)
            : "3600 seconds"
    }

    /// The header holds one line beside its badge, so the project's name takes the row under it.
    public static let heading = LandingCheckCopy.confirmTitle
    public var projectLine: String { projectTitle.isEmpty ? "This project" : projectTitle }
    public static let note = "Run on the combined tree before this project's work lands. "
        + "Nothing else about the project's integration line changes."
    public static let action = LandingCheckCopy.confirmAction
    /// An empty line reads as a loading state, so a missing check is said in words.
    public var currentLine: String { current ?? "no check configured" }
    public var nextLine: String {
        guard changesCommand else { return "\(currentLine) (unchanged)" }
        return next ?? "no check — nothing runs on the combined tree"
    }
    public var timeoutLine: String? { timeoutSeconds.map { "killed after \($0)s" } }
    /// What a refusal names, ahead of the reason to be typed. Web computes the same name.
    public var declineName: String { "\(projectTitle.isEmpty ? "this project" : projectTitle)'s merge check" }
}

/// What a skip would let through, read off the `orbit_integration_skip_merge_check` ask. The runner
/// reads it from the project and the landing before it files the card (`runner-go/mcp.go`,
/// `skipMergeCheckFacts`): the command that would NOT run, verbatim, what it said last time, and the
/// agent's reason. Web draws the same fields (`SkipMergeCheckBody`).
public struct SkipMergeCheckPreview: Equatable, Sendable {
    public let projectTitle: String
    /// The DONE task whose landing this is.
    public let taskTitle: String
    /// The check command that will not run, as the project has it configured.
    public let checkCommand: String
    /// What that check said the last time, in the landing read's own words; empty when none.
    public let failure: String
    /// Why the agent says this red is the check's rather than the delivery's.
    public let reason: String
    /// The project's main branch by name; `main` where the card names none.
    public let mainBranch: String

    /// The header holds one line beside its "merge check" badge, so the task's name takes the row
    /// under it, and the heading leaves "merge" to the badge: at .body bold on a phone the longer
    /// "Land without the merge check?" was cut short.
    public static let heading = "Land without the check?"
    public var taskLine: String { taskTitle.isEmpty ? "This task" : taskTitle }
    public var projectLine: String? { projectTitle.isEmpty ? nil : "In \(projectTitle)" }
    public static let commandCaption = "This landing runs without the merge check"
    public static let reasonCaption = "The agent says this red is the check’s, not the work’s"
    public var note: String {
        "Once, and only this landing: the project’s check command is unchanged, and the next "
            + "landing and every merge into \(mainBranch) are checked as before."
    }
    public static let action = "Land it without the check"
    /// What a refusal names, ahead of the reason to be typed. Web computes the same name.
    public var declineName: String { taskTitle.isEmpty ? "this landing" : taskTitle }
}

/// What a delete would take away, read off the card the server filed for it. The asker sends only
/// an id: the name, where it stands and what goes with it are the server's own reading
/// (`runner-api/runner-delete-approval.ts`), so a card cannot name one machine and delete another.
public struct DeleteApprovalPreview: Equatable, Sendable {
    /// One workspace deleted with a runner: what the owner may not have had in mind.
    public struct Workspace: Equatable, Sendable, Identifiable {
        public let id: String
        public let name: String
        public let workDir: String?
    }

    public let isRunner: Bool
    public let name: String
    /// Where it stands: a runner online or last seen, the runner a workspace is on.
    public let status: String
    /// A workspace's folder.
    public let workDir: String?
    /// The workspaces that go with a runner.
    public let workspaces: [Workspace]

    public var noun: String { isRunner ? "runner" : "workspace" }

    /// The card's header. The name is the next row rather than part of this line: the header stays
    /// on one line, and a delete is the last place a name may be cut short.
    public var heading: String { "Delete this \(noun)?" }

    /// What a refusal names, ahead of the reason to be typed. Web computes the same name
    /// (`declineSubject`).
    public var declineName: String { name.isEmpty ? "this \(noun)" : name }

    /// What deleting means, under the facts.
    public var note: String { isRunner ? Approvals.deleteRunnerNote : Approvals.deleteWorkspaceNote }
}

/// What a workspace write would do, read off the card the server filed for it
/// (`runner-api/runner-workspace-approval.ts`): which workspace, each variable by name and whole
/// value, and what else it changes. The owner decides by reading the values, and the server erases
/// them from the card once it is answered.
public struct WorkspaceWritePreview: Equatable, Sendable {
    public struct Variable: Equatable, Sendable, Identifiable {
        public let name: String
        public let value: String
        public var id: String { name }
        /// The way the engine will see it, on one block however long the value is.
        public var line: String { "\(name)=\(value)" }
    }

    /// One more thing the write changes, in the card's own words.
    public struct Field: Equatable, Sendable, Identifiable {
        public let caption: String
        public let value: String
        public var id: String { caption }
    }

    public let isCreate: Bool
    public let name: String
    /// The runner it is on, or a new one goes on.
    public let status: String
    /// Its folder as it stands.
    public let workDir: String?
    /// The variables it would hold, by name: nil when the write leaves them alone.
    public let env: [Variable]?
    /// The variables on it now that the write takes away, since it replaces the whole map.
    public let envRemoved: [String]
    public let fields: [Field]

    /// The card's header. The name is the next row rather than part of this line, as on a delete.
    public var heading: String { isCreate ? "Create this workspace?" : "Change this workspace?" }
    public var badge: String { "workspace" }
    public var action: String { isCreate ? Approvals.workspaceCreateAction : Approvals.workspaceSaveAction }
    /// What a refusal names, ahead of the reason to be typed. Web computes the same name (`declineSubject`).
    public var declineName: String { name.isEmpty ? "this workspace" : name }
}

public extension Approvals {

    /// The yes on a workspace write's card and the words on it. Web's card says the same
    /// (`WorkspaceWriteCardCopyParityTests`).
    static let workspaceSaveAction = "Save changes"
    static let workspaceCreateAction = "Create it"
    static let workspaceVariables = "Environment variables"
    static let workspaceNoVariables = "No variables"
    static let workspaceVariablesRemoved = "Variables removed"
    static let workspaceWriteNote = "Every later session in this workspace starts with this, in any permission mode. "
        + "A variable can run code as soon as the engine starts."

    /// All a card holds, as text, when a server that predates this card filed what the asker sent: nil
    /// for any other approval, and for a card `workspaceWritePreview` reads. Without it such a card would
    /// ask for a yes with nothing on it.
    static func workspaceWriteRawInput(toolName: String, from input: JSONValue) -> String? {
        guard isWorkspaceCreate(toolName: toolName) || isWorkspaceUpdate(toolName: toolName),
              workspaceWritePreview(toolName: toolName, from: input) == nil else { return nil }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(input)).flatMap { String(data: $0, encoding: .utf8) }
    }

    /// The facts the server filed on an `orbit_agent_create` / `orbit_agent_update` card, or nil for any
    /// other approval.
    static func workspaceWritePreview(toolName: String, from input: JSONValue) -> WorkspaceWritePreview? {
        let isCreate = isWorkspaceCreate(toolName: toolName)
        guard isCreate || isWorkspaceUpdate(toolName: toolName), case .object? = input["changes"] else { return nil }
        func text(_ value: JSONValue?) -> String? {
            guard let string = value?.stringValue, !string.isEmpty else { return nil }
            return string
        }
        func runnerName(_ value: JSONValue?) -> String? { text(value?["displayName"]) ?? text(value?["name"]) }
        let changes = input["changes"]
        var fields: [WorkspaceWritePreview.Field] = []
        /// An empty string is a field being cleared, which a blank row on a card would not say.
        func written(_ key: String, _ caption: String) {
            if let value = changes?[key]?.stringValue {
                fields.append(.init(caption: caption, value: value.isEmpty ? "Cleared" : value))
            }
        }
        written("workDir", "Working directory")
        written("systemPrompt", "System prompt")
        written("appendSystemPrompt", "Appended system prompt")
        if let runner = runnerName(changes?["runner"]) { fields.append(.init(caption: "Runner", value: runner)) }
        if let worktree = changes?["enableWorktree"]?.boolValue {
            fields.append(.init(caption: "Worktree", value: worktree
                ? "Each session gets its own git worktree" : "Sessions run in the shared folder"))
        }
        if !isCreate { written("name", "Name") }
        written("description", "Description")
        written("defaultMergeTarget", "Merge target")
        var env: [WorkspaceWritePreview.Variable]?
        if case .object(let variables)? = changes?["env"] {
            env = variables
                .map { .init(name: $0.key, value: $0.value.stringValue ?? "") }
                .sorted { $0.name < $1.name }
        }
        var removed: [String] = []
        if case .array(let names)? = input["envRemoved"] { removed = names.compactMap(\.stringValue) }
        return WorkspaceWritePreview(isCreate: isCreate, name: text(input["name"]) ?? "",
                                     status: runnerName(input["runner"]).map { "On \($0)" } ?? "On no runner",
                                     workDir: text(input["workDir"]), env: env, envRemoved: removed, fields: fields)
    }

    /// The yes on a delete card, and the words around what goes. Web's card says the same
    /// (`DeleteCardCopyParityTests`); the two notes are the words the runner page's own Delete uses.
    static let deleteAction = "Delete it"
    static let deleteGoesWith = "Deleted with it"
    static let deleteNoWorkspaces = "No workspaces are bound to it."
    static let deleteRunnerNote = "This removes the runner and its workspaces from your account. "
        + "Re-register the machine to add it back."
    static let deleteWorkspaceNote = "The workspace leaves your list but is not erased — its sessions "
        + "and tasks are kept and stay linked to it."

    /// The facts the server filed on an `orbit_runner_delete` / `orbit_agent_delete` card, or nil for
    /// any other approval. A runner's status is the runner list's own line, so a machine reads the
    /// same on its card as on its row.
    static func deletePreview(toolName: String, from input: JSONValue,
                              nowMs: Int64) -> DeleteApprovalPreview? {
        let isRunner = isRunnerDelete(toolName: toolName)
        guard isRunner || isWorkspaceDelete(toolName: toolName) else { return nil }
        func text(_ value: JSONValue?) -> String? {
            guard let string = value?.stringValue, !string.isEmpty else { return nil }
            return string
        }
        guard isRunner else {
            let runner = input["runner"]
            let host = text(runner?["displayName"]) ?? text(runner?["name"])
            return DeleteApprovalPreview(isRunner: false, name: text(input["name"]) ?? "",
                                         status: host.map { "On \($0)" } ?? "On no runner",
                                         workDir: text(input["workDir"]), workspaces: [])
        }
        var workspaces: [DeleteApprovalPreview.Workspace] = []
        if case .array(let raw)? = input["workspaces"] {
            workspaces = raw.map {
                .init(id: $0["id"]?.stringValue ?? "", name: $0["name"]?.stringValue ?? "",
                      workDir: text($0["workDir"]))
            }
        }
        let status: String
        if input["online"]?.boolValue == true {
            status = RunnerPageCopy.RUNNER_ONLINE
        } else if let seen = text(input["lastHeartbeatAt"]) {
            status = RunnerPageCopy.runnerOfflineLastSeen(when: RunnerAttention.ago(seen, nowMs: nowMs))
        } else {
            status = RunnerPageCopy.RUNNER_OFFLINE
        }
        return DeleteApprovalPreview(isRunner: true,
                                     name: text(input["displayName"]) ?? text(input["name"]) ?? "",
                                     status: status, workDir: nil, workspaces: workspaces)
    }

    /// The body carried on an `orbit_task_create` / `orbit_project_create` approval, or nil for any
    /// other approval.
    static func createPreview(toolName: String, from input: JSONValue) -> CreateApprovalPreview? {
        let isProject = isProjectCreate(toolName: toolName)
        guard isProject || isTaskCreate(toolName: toolName) else { return nil }
        var criteria: [String] = []
        if isProject {
            if case .array(let raw)? = input["acceptanceCriteriaItems"] {
                criteria = raw.compactMap { $0["text"]?.stringValue }.filter { !$0.isEmpty }
            }
        } else if let text = input["acceptanceCriteria"]?.stringValue, !text.isEmpty {
            criteria = [text]
        }
        return CreateApprovalPreview(
            isProject: isProject,
            title: input["title"]?.stringValue ?? "",
            prose: input[isProject ? "goal" : "description"]?.stringValue ?? "",
            criteria: criteria,
            // The same key the batch card reads, for the same reason: the counts are the decision
            // and the body is not. Absent on an older runner, which costs the card its pill and
            // nothing else.
            preview: batchPreview(from: input),
            criterion: input["completionCriterion"]?.stringValue ?? "")
    }

    /// The caption over the field the owner is agreeing to. The same two words web puts over it.
    static let createDoneWhen = "Done when"

    /// Under a new project's criteria: approving the create is not confirming them — the project's
    /// start card asks that, once its coordinator has a plan to start. Web's
    /// `CREATE_CRITERIA_CONFIRMED_AT_START`.
    static let createCriteriaConfirmedAtStart = "You’ll confirm these when the project starts."

    /// The single create card's header: the count, exactly as the batch card's header is a count —
    /// "Create 1 task?" beside "Create 3 tasks?". The web half composes the same sentence into its
    /// own `Confirm: …` line and the native card draws an icon chip beside it, so it is the words
    /// that are shared and `CreateCardCopyParityTests` is what keeps them shared.
    static let createHeading = "Create 1 task?"

    /// The single-task card's second yes: create the task and start its run in the same press, so
    /// the owner is not asked again to start it. Web's `CREATE_AND_START`; Android's
    /// `CardVerb.CREATE_AND_START`.
    static let createAndStartAction = "Create and start"

    /// Whether the single-task card offers Create and start: only when the server's forecast says
    /// nothing would start the task by itself (`needsManualStart` is 1). A task that starts on its
    /// own (now or at its runAt), waits on a prerequisite, cannot run, or waits for its project to
    /// start has nothing for the press to add, and a card whose forecast could not be read says
    /// nothing either way. Nor a card the server did not mark `acceptsStartAfterCreate`: its runner,
    /// or the server itself, predates the choice and would only create the task. Web's
    /// `offersCreateAndStart`.
    static func offersCreateAndStart(toolName: String, input: JSONValue?) -> Bool {
        guard isTaskCreate(toolName: toolName), let input,
              input["acceptsStartAfterCreate"]?.boolValue == true else { return false }
        return batchPreview(from: input)?.needsManualStart == 1
    }

    /// What Create and start sends: the yes and the start, and nothing else — no message, answers or
    /// remember rules, none of which a create card carries.
    static let createAndStartRequest = ApprovalDecisionRequest(behavior: .allow, startAfterCreate: true)

    /// The fold's own line, carrying its length the way the evidence card's claim fold does: this is
    /// the longest field on the card and the least decisive, and how much of it there is is exactly
    /// what decides whether to open it.
    static func createFold(_ noun: String, _ chars: Int) -> String {
        "the \(noun) (\(chars) characters)"
    }

    /// What the fold's control says once it is open.
    static func createFoldHide(_ noun: String) -> String { "hide the \(noun)" }

    /// The blocker facts carried on an `orbit_blocker_resolve` ask, or nil for any other approval.
    /// The runner resolves the blocker against the project read before it asks, so the card carries
    /// what it is about rather than an id nobody can answer.
    static func blockerResolvePreview(toolName: String,
                                      from input: JSONValue) -> BlockerResolvePreview? {
        guard isBlockerResolve(toolName: toolName) else { return nil }
        let blocker = input["blocker"]
        return BlockerResolvePreview(
            projectTitle: input["projectTitle"]?.stringValue ?? "",
            requiredAction: blocker?["requiredAction"]?.stringValue ?? "",
            reason: input["reason"]?.stringValue ?? "",
            kind: blocker?["kind"]?.stringValue ?? "",
            subjectTitle: blocker?["subjectTitle"]?.stringValue ?? "")
    }

    /// The merge-check change carried on an `orbit_project_update_integration` ask, or nil for any
    /// other approval. A blank command counts as none, the way web reads it.
    static func mergeCheckChangePreview(toolName: String,
                                        from input: JSONValue) -> MergeCheckChangePreview? {
        guard isMergeCheckChange(toolName: toolName) else { return nil }
        func command(_ key: String) -> String? {
            guard let s = input[key]?.stringValue,
                  !s.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            return s
        }
        return MergeCheckChangePreview(
            snapshot: input,
            projectTitle: input["projectTitle"]?.stringValue ?? "",
            current: command("currentMergeCheckCommand"),
            next: command("mergeCheckCommand"),
            changesCommand: input["mergeCheckCommand"] != nil,
            timeoutSeconds: input["mergeCheckTimeoutSeconds"]?.intValue)
    }

    /// The skip carried on an `orbit_integration_skip_merge_check` ask, or nil for any other
    /// approval. A missing field reads as empty, the way web reads it.
    static func skipMergeCheckPreview(toolName: String,
                                      from input: JSONValue) -> SkipMergeCheckPreview? {
        guard isSkipMergeCheck(toolName: toolName) else { return nil }
        func text(_ key: String) -> String { input[key]?.stringValue ?? "" }
        return SkipMergeCheckPreview(
            projectTitle: text("projectTitle"),
            taskTitle: text("taskTitle"),
            checkCommand: text("checkCommand"),
            failure: text("failure"),
            reason: text("reason"),
            mainBranch: RunSettings.mainBranchName(input["mainBranch"]?.stringValue))
    }

    /// The restructure preview carried on an `orbit_dag_change` approval, or nil when absent.
    static func dagPreview(from input: JSONValue) -> DagApprovalPreview? {
        guard let p = input["preview"] else { return nil }
        var ops: [DagOpSummary] = []
        if case .array(let raw)? = p["ops"] {
            ops = raw.map {
                DagOpSummary(op: $0["op"]?.stringValue ?? "add",
                             taskTitle: $0["taskTitle"]?.stringValue ?? "",
                             dependsOnTitle: $0["dependsOnTitle"]?.stringValue ?? "",
                             noop: $0["noop"]?.boolValue ?? false)
            }
        }
        var cycle: [String] = []
        if case .array(let raw)? = p["cycle"] {
            cycle = raw.compactMap { $0["title"]?.stringValue }
        }
        return DagApprovalPreview(
            listTitle: p["listTitle"]?.stringValue ?? "this list",
            note: input["note"]?.stringValue ?? "",
            becomingRunnable: p["becomingRunnable"]?.intValue ?? 0,
            becomingManual: p["becomingManual"]?.intValue ?? 0,
            becomingBlocked: p["becomingBlocked"]?.intValue ?? 0,
            ops: ops,
            cycle: cycle,
            edgesBefore: p["edgesBefore"]?.intValue ?? 0,
            edgesAfter: p["edgesAfter"]?.intValue ?? 0)
    }

    /// The `tasks` array of a batch, from wherever it appears.
    ///
    /// One parser for two readers on purpose: the approval card reads it from the server's
    /// `preview`, and the transcript reads it straight off the tool call's own input, which
    /// carries the same shape. A record rendered by a second copy of these rules would eventually
    /// disagree with the card it is the history of.
    static func batchTasks(from container: JSONValue) -> [BatchPreviewTask] {
        guard case .array(let raw)? = container["tasks"] else { return [] }
        return raw.compactMap { t in
            guard let title = t["title"]?.stringValue else { return nil }
            func strings(_ key: String) -> [String]? {
                guard case .array(let a)? = t[key] else { return nil }
                return a.compactMap { $0.stringValue }
            }
            return BatchPreviewTask(title: title, ref: t["ref"]?.stringValue,
                                    dependsOnRefs: strings("dependsOnRefs"),
                                    dependsOnTaskIds: strings("dependsOnTaskIds"))
        }
    }

    /// The batch preview carried on an `orbit_task_batch` approval, or nil when absent.
    static func batchPreview(from input: JSONValue) -> BatchApprovalPreview? {
        guard let p = input["preview"] else { return nil }
        var lists: [String] = []
        if case .array(let raw)? = p["lists"] {
            lists = raw.compactMap { $0["title"]?.stringValue }
        }
        let tasks = batchTasks(from: p)
        return BatchApprovalPreview(
            taskCount: p["taskCount"]?.intValue ?? 0,
            startingNow: p["startingNow"]?.intValue ?? 0,
            blocked: p["blocked"]?.intValue ?? 0,
            needsManualStart: p["needsManualStart"]?.intValue ?? 0,
            notDispatchable: p["notDispatchable"]?.intValue ?? 0,
            edges: (p["internalEdges"]?.intValue ?? 0) + (p["externalEdges"]?.intValue ?? 0),
            lists: lists,
            tasks: tasks,
            titlesTruncated: p["titlesTruncated"]?.intValue ?? 0)
    }

    /// The consequence lines a card leads with, in the order a person decides in.
    ///
    /// Counts first and titles last, because the titles are the eye-catching part and the least
    /// useful one: fifty tasks that wait on each other cost one run and fifty independent ones
    /// cost none at all, and both look the same as a list of names.
    ///
    /// Written to survive n = 1, which is what a single create is: the card that shows one task
    /// reads these lines too, and "1 wait on a prerequisite" is not a sentence anybody wrote. The
    /// sentences themselves live in `batchImpactRows`, which also says which kind each one is.
    static func batchImpactLines(_ p: BatchApprovalPreview) -> [String] {
        batchImpactRows(p).map(\.text)
    }

    /// Same, for a restructure.
    static func dagImpactLines(_ p: DagApprovalPreview) -> [String] {
        if !p.cycle.isEmpty { return ["Rejected: these changes would create a cycle — \(p.cycle.joined(separator: " → "))"] }
        var lines: [String] = []
        if p.becomingRunnable > 0 {
            lines.append("\(p.becomingRunnable) task\(p.becomingRunnable == 1 ? "" : "s") become\(p.becomingRunnable == 1 ? "s" : "") runnable — these start on the next sweep")
        }
        if p.becomingManual > 0 {
            lines.append("\(p.becomingManual) stop\(p.becomingManual == 1 ? "s" : "") waiting, but now need\(p.becomingManual == 1 ? "s" : "") a manual start")
        }
        if p.becomingBlocked > 0 {
            lines.append("\(p.becomingBlocked) task\(p.becomingBlocked == 1 ? " stops" : "s stop") being runnable")
        }
        if lines.isEmpty { lines.append("No task changes state — this only rewrites edges") }
        return lines
    }
}
