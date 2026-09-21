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

public extension Approvals {

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

    /// The single create card's header: the count, exactly as the batch card's header is a count —
    /// "Create 1 task?" beside "Create 3 tasks?". The web half composes the same sentence into its
    /// own `Confirm: …` line and the native card draws an icon chip beside it, so it is the words
    /// that are shared and `CreateCardCopyParityTests` is what keeps them shared.
    static let createHeading = "Create 1 task?"

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
    /// reads these lines too, and "1 wait on a prerequisite" is not a sentence anybody wrote.
    static func batchImpactLines(_ p: BatchApprovalPreview) -> [String] {
        var lines: [String] = []
        if p.startingNow > 0 {
            lines.append("\(p.startingNow) start\(p.startingNow == 1 ? "s" : "") running within the minute")
        }
        if p.blocked > 0 {
            lines.append("\(p.blocked) wait\(p.blocked == 1 ? "s" : "") on a prerequisite")
        }
        if p.needsManualStart > 0 {
            lines.append("\(p.needsManualStart) need\(p.needsManualStart == 1 ? "s" : "") a manual start — nothing will trigger \(p.needsManualStart == 1 ? "it" : "them")")
        }
        if p.notDispatchable > 0 {
            lines.append("\(p.notDispatchable) cannot run — unassigned, no runner, auto-run off, or the list is paused")
        }
        return lines
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
