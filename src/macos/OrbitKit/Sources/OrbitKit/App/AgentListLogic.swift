import Foundation

// Pure logic for workspace navigation order. Every client's rail uses the flat workspace order shared
// with the web.

public struct AgentGroup: Equatable, Sendable, Identifiable {
    public let runnerId: String?
    public let agents: [Agent]
    public var id: String { runnerId ?? "host" }
}

/// One row of the macOS sidebar's Workspaces section. The section draws exactly one view per row, so the
/// outline list sees one flat, stable-id row set: an `if`/`else` swapping the placeholder for the rows,
/// or a `ForEach` element yielding a varying number of rows, is the shape whose row reload
/// NSOutlineView aborted on (beta.196, `-[NSLayoutConstraint setActive:]` under
/// `reloadItem:reloadChildren:`).
public enum SidebarWorkspaceRow: Equatable, Sendable, Identifiable {
    case agent(Agent)
    case setUp(MachineToSetUp)
    /// Stands in for the rows while there are none: loading, failed, or empty.
    case placeholder

    public var id: String {
        switch self {
        case .agent(let a): return "agent:\(a.id)"
        case .setUp(let m): return "setup:\(m.id)"
        case .placeholder: return "placeholder"
        }
    }
}

/// Where New session goes (rule 11, board 03): the workspace in view, else the first machine that can
/// start one, else Machines & models. Nothing while the workspace list hasn't answered.
public enum NewSessionTarget: Equatable, Sendable {
    case workspace(String)
    case machine(String)
    case machines
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

    /// The Mac sidebar's Workspaces rows: the workspaces in `ordered` order, then a Set up row per machine
    /// with no workspace; the placeholder alone when there is neither. A row id seen twice keeps its first
    /// row only, since a duplicate id is itself a row set the outline list can't reconcile.
    public static func sidebarRows(_ ordered: [Agent], machines: [MachineToSetUp]) -> [SidebarWorkspaceRow] {
        var seen = Set<String>()
        let rows = (ordered.map(SidebarWorkspaceRow.agent) + machines.map(SidebarWorkspaceRow.setUp))
            .filter { seen.insert($0.id).inserted }
        return rows.isEmpty ? [.placeholder] : rows
    }

    /// Rule 9: the machines that get a Set up row, in the runner list's order. Online, with no
    /// workspace of this account on them: an offline one is already what Machines & models says needs
    /// you. A runner the server hasn't said is online is not one.
    public static func machinesToSetUp(runners: [Runner], agents: [Agent]) -> [MachineToSetUp] {
        let taken = Set(agents.compactMap(\.runnerId))
        return runners.filter { !taken.contains($0.id) && isOnline($0) }
            .map { MachineToSetUp(id: $0.id, name: RunnerPageFormat.displayName($0)) }
    }

    /// `GET /runners`' answer for this machine, read the way the rest of the rail reads it.
    public static func isOnline(_ runner: Runner) -> Bool {
        WorkspaceRunnerAvailabilityLogic.onlineValue(explicit: runner.online, status: runner.status) == true
    }

    /// Where New session goes. `list` is the workspace list's state, `currentAgentID` the workspace ⌘N
    /// draws a draft for (nil with none), and `firstOnlineMachine` the first runner online. An account
    /// with no workspace has no other machine to pick: every one online is bare.
    public static func newSessionTarget(currentAgentID: String?, list: ListLoadPresentation?,
                                        firstOnlineMachine: String?) -> NewSessionTarget? {
        if let currentAgentID { return .workspace(currentAgentID) }
        guard list == .empty else { return nil }
        return firstOnlineMachine.map(NewSessionTarget.machine) ?? .machines
    }
}
