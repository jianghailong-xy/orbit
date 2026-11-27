import Foundation

/// One row of the compact shell's drawer rail, in the order the drawer draws it: the work, then
/// the Workspaces header and its rows, the open projects and Shared with me.
/// The rail's List draws one row per case through one ForEach — no `if` and no second ForEach in
/// that ForEach.
public enum DrawerWorkRow: Equatable, Sendable, Identifiable {
    case projects
    case wiki
    /// Scheduled, with the number of schedules that need the owner (failing or held), right under Tasks.
    case scheduled
    case section(AppSection)
    case workspacesHeader
    case agents
    case openProjects
    case sharedWithMe

    public var id: String {
        switch self {
        case .projects: "projects"
        case .wiki: "wiki"
        case .scheduled: "scheduled"
        case .section(let section): "section:\(section.rawValue)"
        case .workspacesHeader: "workspaces-header"
        case .agents: "agents"
        case .openProjects: "open-projects"
        case .sharedWithMe: "shared-with-me"
        }
    }
}

public enum DrawerWorkLogic {
    /// The rail's rows: the work sections `sections` names — the Wiki dropped here when the server
    /// has it off (`wiki`), as data — then the Workspaces header and the rows under it. There is no
    /// Waiting on you row: a request is drawn in the session that asked, a scheduled task's item on
    /// Scheduled and in its run's session. New wiki… has no row here: the drawer has no Wiki group to
    /// put it in, so it lives in the Wiki's head picker.
    ///
    /// Scheduled (`scheduled`) goes right under Tasks: the phone's drawer is where it lives (board 01 ①).
    ///
    /// Documents (`documents`) goes right under the Wiki, with no count (docs/mocks/drive, 01-ios ①): the Wiki is
    /// what the work learned, Documents what it produced. It stays in that place when the Wiki is off.
    public static func rows(_ sections: [AppSection], wiki: Bool, scheduled: Bool = false,
                            drive: Bool = false) -> [DrawerWorkRow] {
        let work: [DrawerWorkRow] = sections.flatMap { section -> [DrawerWorkRow] in
            switch section {
            case .projects: [.projects]
            case .tasks: scheduled ? [.section(.tasks), .scheduled] : [.section(.tasks)]
            case .wiki: (wiki ? [.wiki] : []) + (drive ? [.section(.drive)] : [])
            default: [.section(section)]
            }
        }
        return work
            + [.workspacesHeader, .agents, .openProjects, .sharedWithMe]
    }
}
