import Foundation

// Pure logic for workspace navigation order. macOS renders runner groups; iOS uses the flat
// workspace order shared with the web.

public struct AgentGroup: Equatable, Sendable, Identifiable {
    public let runnerId: String?
    public let agents: [Agent]
    public var id: String { runnerId ?? "host" }
}

public enum AgentListLogic {
    /// Group agents by their runner for the macOS sidebar; host-level agents (no runnerId) sink
    /// to the bottom in the "Shared" group.
    ///
    /// `runnerOrder` is the runner ids in their persisted display order (`GET /runners`, which the
    /// server sorts by the user's runner `position`). Runners missing from it (a stale agent
    /// pointing at a runner the list no longer carries) keep their first-seen position behind
    /// the known ones.
    public static func grouped(_ agents: [Agent], runnerOrder: [String] = []) -> [AgentGroup] {
        var order: [String] = []
        var map: [String: [Agent]] = [:]
        var host: [Agent] = []
        for a in agents {
            if let rid = a.runnerId {
                if map[rid] == nil { order.append(rid); map[rid] = [] }
                map[rid]?.append(a)
            } else {
                host.append(a)
            }
        }
        var rank: [String: Int] = [:]
        for (i, rid) in runnerOrder.enumerated() where rank[rid] == nil { rank[rid] = i }
        let sortedRunnerIds = order.enumerated()
            .sorted { l, r in
                switch (rank[l.element], rank[r.element]) {
                case let (a?, b?): return a < b
                case (_?, nil): return true
                case (nil, _?): return false
                case (nil, nil): return l.offset < r.offset
                }
            }
            .map(\.element)
        var groups = sortedRunnerIds.map { AgentGroup(runnerId: $0, agents: map[$0] ?? []) }
        if !host.isEmpty { groups.append(AgentGroup(runnerId: nil, agents: host)) }
        return groups
    }

    /// Sidebar order, also used by workspace switching and the default launch landing. macOS
    /// keeps its runner groups. iOS keeps the API's global workspace order (position, then
    /// createdAt), moving only runner-less workspaces to the bottom like the web.
    public static func ordered(_ agents: [Agent], runnerOrder: [String] = []) -> [Agent] {
        #if os(macOS)
        grouped(agents, runnerOrder: runnerOrder).flatMap(\.agents)
        #else
        agents.filter { $0.runnerId != nil } + agents.filter { $0.runnerId == nil }
        #endif
    }
}
