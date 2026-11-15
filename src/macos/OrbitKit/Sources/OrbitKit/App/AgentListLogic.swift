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

/// One top-level work row of the macOS sidebar (Projects, Tasks, Wiki). The section draws one view
/// per row from this array, so the Wiki's visibility is data here rather than an `if` around the
/// row builder — the shape beta.242 crashed in. A count of 0 is drawn hidden, never removed.
public struct SidebarSectionRow: Equatable, Sendable, Identifiable {
    public let section: AppSection
    /// What waits on the reader there — the drawer's amber count.
    public let waiting: Int
    /// New wiki… under the Wiki row (docs/wiki-explicit-creation-design.md §3.4): it raises the Create wiki form and
    /// selects nothing. `section` is then `.wiki`, the section it belongs to.
    public let newWiki: Bool

    public var id: String { newWiki ? "new-wiki" : "section:\(section.rawValue)" }

    public init(_ section: AppSection, waiting: Int = 0, newWiki: Bool = false) {
        self.section = section
        self.waiting = waiting
        self.newWiki = newWiki
    }
}

/// One open project row, with the drawer's one trailing mark. Like the work rows, the Projects group
/// draws one view per row from this array.
public struct SidebarProjectRow: Equatable, Sendable, Identifiable {
    public let id: String
    public let title: String
    public let mark: ProjectDrawerMark

    public init(id: String, title: String, mark: ProjectDrawerMark) {
        self.id = id
        self.title = title
        self.mark = mark
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

    /// The work rows the Mac source list opens with, in `sections`' order. `wiki` is the server's
    /// answer (`WikiLogic.shown`): a false one drops the Wiki row here, as data, so the List body
    /// holds no branch. The waiting counts are the drawer's amber numbers, 0 when nothing waits.
    /// `newWiki` (there is a wiki already) adds the New wiki… row right under the Wiki row.
    public static func sidebarSections(_ sections: [AppSection], wiki: Bool,
                                       projectsWaiting: Int, wikiWaiting: Int,
                                       newWiki: Bool = false) -> [SidebarSectionRow] {
        sections.filter { $0 != .wiki || wiki }.flatMap { section -> [SidebarSectionRow] in
            let waiting: Int
            switch section {
            case .projects: waiting = projectsWaiting
            case .wiki:     waiting = wikiWaiting
            default:        waiting = 0
            }
            let row = SidebarSectionRow(section, waiting: waiting)
            return section == .wiki && newWiki ? [row, SidebarSectionRow(.wiki, newWiki: true)] : [row]
        }
    }

    /// The open projects, each with the one trailing mark the drawer gives it: what waits on you,
    /// or its work in flight, or nothing. Duplicate ids keep their first row, as `sidebarRows` does.
    public static func sidebarProjects(_ projects: [ProjectSummary],
                                       coordinators: [String: ProjectCoordinatorPulse]) -> [SidebarProjectRow] {
        var seen = Set<String>()
        return projects.map { project in
            SidebarProjectRow(
                id: project.id,
                title: project.title,
                mark: ProjectAttention.drawerMark(
                    project, coordinator: coordinators[PublicID.storageKey(project.id)]))
        }.filter { seen.insert($0.id).inserted }
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
