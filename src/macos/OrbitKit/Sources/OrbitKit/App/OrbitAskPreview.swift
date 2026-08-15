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

public extension Approvals {

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
    static func batchImpactLines(_ p: BatchApprovalPreview) -> [String] {
        var lines: [String] = []
        if p.startingNow > 0 {
            lines.append("\(p.startingNow) start\(p.startingNow == 1 ? "s" : "") running within the minute")
        }
        if p.blocked > 0 { lines.append("\(p.blocked) wait on a prerequisite") }
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
