import Foundation

/// The words and numbers a background agent's or workflow's progress is drawn with — the card badge,
/// the per-phase agent list, the footer, the tray's one-line summary. A line-for-line port of
/// @orbit/shared `taskProgressCopy.ts`; both are held to the same golden table
/// (`src/shared/src/taskProgressCopy.golden.json`, read by `TaskProgressCopyParityTests`).
public enum TaskProgressCopy {
    /// Where one agent of a workflow stands, reduced to the four states a row draws.
    public enum Lane: String, Sendable { case done, running, queued, failed }

    public static func lane(_ a: TaskProgress.Agent) -> Lane {
        if a.error != nil || a.state == "error" || a.state == "failed" { return .failed }
        if a.state == "done" || a.cached { return .done }
        if a.state == nil || a.state == "start" || a.state == "queued" || a.state == "pending" { return .queued }
        return .running
    }

    public struct PhaseGroup: Equatable, Sendable {
        public var title: String
        public var done: Int
        public var total: Int
        public var agents: [TaskProgress.Agent]
    }

    /// The agents grouped by the phase the script put them in, phases in their own order.
    public static func phaseGroups(_ p: TaskProgress) -> [PhaseGroup] {
        var byPhase: [Int: [TaskProgress.Agent]] = [:]
        for a in p.agents { byPhase[a.phaseIndex ?? -1, default: []].append(a) }
        return byPhase.keys.sorted().map { index in
            let agents = (byPhase[index] ?? []).sorted { $0.index < $1.index }
            let declared = p.phases.first(where: { $0.index == index })?.title ?? ""
            let title = !declared.isEmpty ? declared
                : (agents.first(where: { ($0.phaseTitle ?? "").isEmpty == false })?.phaseTitle ?? "")
            return PhaseGroup(title: title, done: agents.filter { lane($0) == .done }.count,
                              total: agents.count, agents: agents)
        }
    }

    /// The badge on the card: a workflow's agents done out of all, an agent's tool calls.
    public static func badge(_ p: TaskProgress) -> String? {
        if !p.agents.isEmpty {
            return "\(p.agents.filter { lane($0) == .done }.count)/\(p.agents.count)"
        }
        let calls = p.usage?.toolUses ?? 0
        return calls > 0 ? String(calls) : nil
    }

    private static func tools(_ n: Int) -> String { n == 1 ? "1 tool" : "\(n) tools" }
    private static func toolCalls(_ n: Int) -> String { n == 1 ? "1 tool call" : "\(n) tool calls" }

    /// The right-hand word of an agent's row.
    public static func detail(_ a: TaskProgress.Agent) -> String {
        let l = lane(a)
        if l == .failed { return "failed" }
        if a.cached { return "cached" }
        if l == .queued { return "queued" }
        return a.toolCalls.map(tools) ?? ""
    }

    /// What a running agent is doing right now: its current tool and what it is doing with it.
    public static func now(_ a: TaskProgress.Agent) -> String {
        guard lane(a) == .running else { return "" }
        return [a.lastToolName, a.lastToolSummary].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// 45s · 17m · 1h 5m
    public static func duration(ms: Int) -> String {
        let s = ms / 1000
        if s < 60 { return "\(s)s" }
        let m = s / 60
        if m < 60 { return "\(m)m" }
        let h = m / 60
        return m % 60 == 0 ? "\(h)h" : "\(h)h \(m % 60)m"
    }

    private static func totalToolCalls(_ p: TaskProgress) -> Int {
        p.usage?.toolUses ?? p.agents.reduce(0) { $0 + ($1.toolCalls ?? 0) }
    }

    /// The footer under the list: "113 tool calls · 17m".
    public static func footer(_ p: TaskProgress) -> String {
        var parts: [String] = []
        let n = totalToolCalls(p)
        if n > 0 { parts.append(toolCalls(n)) }
        if let usage = p.usage, usage.durationMs > 0 { parts.append(duration(ms: usage.durationMs)) }
        return parts.joined(separator: " · ")
    }

    /// The tray row's second line while the work runs: where a workflow is ("Design 2/3 ·
    /// design:entity-graph running · 113 tool calls"), what an agent is doing ("Bash · 46 tool calls").
    public static func trayLine(_ p: TaskProgress) -> String? {
        var parts: [String] = []
        if !p.agents.isEmpty {
            let groups = phaseGroups(p)
            if let current = groups.first(where: { $0.done < $0.total }) ?? groups.last {
                parts.append("\(current.title.isEmpty ? "" : "\(current.title) ")\(current.done)/\(current.total)")
            }
            let running = p.agents.filter { lane($0) == .running }
            if running.count == 1 { parts.append("\(running[0].label) running") }
            else if running.count > 1 { parts.append("\(running.count) agents running") }
        } else if let tool = p.lastToolName, !tool.isEmpty {
            parts.append(tool)
        }
        let n = totalToolCalls(p)
        if n > 0 { parts.append(toolCalls(n)) }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// What a Workflow call is called: its launch receipt's summary, else the progress's description,
    /// else the `description` in the script's own `meta`. A resumed run carries no script at all, so
    /// the receipt is what names it.
    public static func workflowTitle(input: JSONValue, result: String?, progress: TaskProgress?) -> String? {
        if let result, let summary = BackgroundSummary.workflow(result)?.summary { return summary }
        if let d = progress?.description, !d.isEmpty { return d }
        if let script = input["script"]?.stringValue { return scriptMetaDescription(script) }
        return nil
    }

    /// The first `description: '…'` in a workflow script — its `meta` block opens every script.
    public static func scriptMetaDescription(_ script: String) -> String? {
        let chars = Array(script)
        guard let range = script.range(of: "description") else { return nil }
        var i = script.distance(from: script.startIndex, to: range.upperBound)
        while i < chars.count, chars[i].isWhitespace { i += 1 }
        guard i < chars.count, chars[i] == ":" else { return nil }
        i += 1
        while i < chars.count, chars[i].isWhitespace { i += 1 }
        guard i < chars.count, ["'", "\"", "`"].contains(chars[i]) else { return nil }
        let quote = chars[i]
        var out = ""
        i += 1
        while i < chars.count {
            let ch = chars[i]
            if ch == "\\", i + 1 < chars.count {
                out.append(chars[i + 1])
                i += 2
                continue
            }
            if ch == quote { return out.isEmpty ? nil : out }
            out.append(ch)
            i += 1
        }
        return nil
    }
}
