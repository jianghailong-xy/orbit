import Foundation

// Pure logic for the Agents page's runner grouping. UI-free so it is unit-tested; the SwiftUI
// list renders `grouped` and gets new-session model defaults from the owning runner instead.

public struct AgentGroup: Equatable, Sendable, Identifiable {
    public let runnerId: String?
    public let agents: [Agent]
    public var id: String { runnerId ?? "host" }
}

public enum AgentListLogic {
    /// Group agents by their runner; host-level agents (no runnerId) sink to the bottom — like the
    /// web's "Shared" group.
    ///
    /// `runnerOrder` is the runner ids in their persisted display order (`GET /runners`, which the
    /// server sorts by the user's runner `position`). Groups follow it so the drawer lists machines
    /// in the same order as the web sidebar; runners missing from it (a stale agent pointing at a
    /// runner the list no longer carries) keep their first-seen position behind the known ones.
    /// Mirrors the web `orderWorkspaceGroupsByRunners`.
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

    /// Agents flattened in sidebar display order — runner groups (in `runnerOrder`) then host
    /// "Shared". This is the order ⌘1…⌘9 index into, so it stays in lockstep with what `grouped`
    /// renders.
    public static func ordered(_ agents: [Agent], runnerOrder: [String] = []) -> [Agent] {
        grouped(agents, runnerOrder: runnerOrder).flatMap(\.agents)
    }
}
