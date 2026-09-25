import Foundation

/// How far a background sub-agent or workflow has got: the runner's relay of Claude Code's
/// `task_started` / `task_progress` frames (runner-go `claude_task_progress.go`), keyed by the
/// launching Agent or Workflow call's tool_use id.
///
/// It arrives two ways. Live, as `task_progress` events — frequent, never stored, each one the whole
/// picture so far. And once more at the end, as the `progress` of the durable `background_task`
/// that says the task finished, which is what a transcript loaded after the fact still has.
public struct TaskProgress: Equatable, Sendable, Codable {
    public struct Usage: Equatable, Sendable, Codable {
        public var totalTokens: Int
        public var toolUses: Int
        public var durationMs: Int
    }

    /// One phase a workflow script declared, in its own order.
    public struct Phase: Equatable, Sendable, Codable {
        public var index: Int
        public var title: String
    }

    /// One agent a workflow started.
    public struct Agent: Equatable, Sendable, Codable, Identifiable {
        public var index: Int
        public var label: String
        public var phaseIndex: Int?
        public var phaseTitle: String?
        /// The CLI's own word: `start` (queued), `running`, `done`, `error`, …
        public var state: String?
        public var model: String?
        public var tokens: Int?
        public var toolCalls: Int?
        public var lastToolName: String?
        public var lastToolSummary: String?
        public var error: String?
        /// Answered from the workflow's journal on a resume rather than run again.
        public var cached: Bool = false

        public var id: Int { index }
        public var isDone: Bool { state == "done" }
        public var isFailed: Bool { state == "error" || error != nil }
    }

    public var toolUseId: String
    public var taskId: String?
    /// `local_agent`, `local_workflow`, … — said only by the frame that starts the task.
    public var taskType: String?
    public var description: String?
    public var workflowName: String?
    public var lastToolName: String?
    public var summary: String?
    public var usage: Usage?
    public var phases: [Phase] = []
    public var agents: [Agent] = []
    public var logs: [String] = []

    public var isWorkflow: Bool { taskType == "local_workflow" || !agents.isEmpty || !phases.isEmpty }

    public init(toolUseId: String) { self.toolUseId = toolUseId }

    /// Read a `task_progress` event's payload, or a `background_task`'s `progress`. Nil when it names
    /// no call to hang on — every other field is optional, because each runner release may send less.
    public static func from(_ payload: JSONValue?) -> TaskProgress? {
        guard let payload, let id = payload["toolUseId"]?.stringValue, !id.isEmpty else { return nil }
        var p = TaskProgress(toolUseId: id)
        p.taskId = payload["taskId"]?.stringValue
        p.taskType = payload["taskType"]?.stringValue
        p.description = payload["description"]?.stringValue
        p.workflowName = payload["workflowName"]?.stringValue
        p.lastToolName = payload["lastToolName"]?.stringValue
        p.summary = payload["summary"]?.stringValue
        if let u = payload["usage"], case .object = u {
            p.usage = Usage(totalTokens: u["totalTokens"]?.intValue ?? 0,
                            toolUses: u["toolUses"]?.intValue ?? 0,
                            durationMs: u["durationMs"]?.intValue ?? 0)
        }
        if case .array(let phases)? = payload["phases"] {
            p.phases = phases.compactMap { ph in
                guard let index = ph["index"]?.intValue else { return nil }
                return Phase(index: index, title: ph["title"]?.stringValue ?? "")
            }
        }
        if case .array(let agents)? = payload["agents"] {
            p.agents = agents.compactMap { a in
                guard let index = a["index"]?.intValue else { return nil }
                return Agent(index: index, label: a["label"]?.stringValue ?? "",
                             phaseIndex: a["phaseIndex"]?.intValue,
                             phaseTitle: a["phaseTitle"]?.stringValue,
                             state: a["state"]?.stringValue, model: a["model"]?.stringValue,
                             tokens: a["tokens"]?.intValue, toolCalls: a["toolCalls"]?.intValue,
                             lastToolName: a["lastToolName"]?.stringValue,
                             lastToolSummary: a["lastToolSummary"]?.stringValue,
                             error: a["error"]?.stringValue,
                             cached: a["cached"]?.boolValue ?? false)
            }
        }
        if case .array(let logs)? = payload["logs"] {
            p.logs = logs.compactMap(\.stringValue)
        }
        return p
    }

    // Tolerant decode: a snapshot written by an older build still rehydrates.
    enum CodingKeys: String, CodingKey {
        case toolUseId, taskId, taskType, description, workflowName, lastToolName, summary, usage,
             phases, agents, logs
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        toolUseId = try c.decode(String.self, forKey: .toolUseId)
        taskId = try? c.decodeIfPresent(String.self, forKey: .taskId)
        taskType = try? c.decodeIfPresent(String.self, forKey: .taskType)
        description = try? c.decodeIfPresent(String.self, forKey: .description)
        workflowName = try? c.decodeIfPresent(String.self, forKey: .workflowName)
        lastToolName = try? c.decodeIfPresent(String.self, forKey: .lastToolName)
        summary = try? c.decodeIfPresent(String.self, forKey: .summary)
        usage = try? c.decodeIfPresent(Usage.self, forKey: .usage)
        phases = (try? c.decodeIfPresent([Phase].self, forKey: .phases)) ?? []
        agents = (try? c.decodeIfPresent([Agent].self, forKey: .agents)) ?? []
        logs = (try? c.decodeIfPresent([String].self, forKey: .logs)) ?? []
    }
}
