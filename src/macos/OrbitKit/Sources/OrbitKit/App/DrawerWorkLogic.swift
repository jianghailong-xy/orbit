import Foundation

/// One row of the compact shell's drawer rail, in the order the drawer draws it: the work, the
/// owner's inbox, then the Workspaces header and its rows, the open projects and Shared with me.
/// The rail's List draws one row per case through one ForEach — no `if` and no second ForEach in
/// that ForEach.
public enum DrawerWorkRow: Equatable, Sendable, Identifiable {
    case projects
    case wiki
    /// Scheduled, with the number of schedules that need the owner (failing or held), right under Tasks.
    case scheduled
    case section(AppSection)
    /// What agents have asked the owner to do.
    case waitingOnYou
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
        case .waitingOnYou: "waiting-on-you"
        case .workspacesHeader: "workspaces-header"
        case .agents: "agents"
        case .openProjects: "open-projects"
        case .sharedWithMe: "shared-with-me"
        }
    }
}

public enum DrawerWorkLogic {
    /// The rail's rows: the work sections `sections` names — the Wiki dropped here when the server
    /// has it off (`wiki`), as data — then the inbox only while the server serves it, then the
    /// Workspaces header and the rows under it. New wiki… has no row here: the drawer has no Wiki group
    /// to put it in, so it lives in the Wiki's head picker.
    ///
    /// Scheduled (`scheduled`) goes right under Tasks: the phone's drawer is where it lives (board 01 ①).
    public static func rows(_ sections: [AppSection], wiki: Bool, scheduled: Bool = false,
                            waitingOnYou: Bool) -> [DrawerWorkRow] {
        let work: [DrawerWorkRow] = sections.filter { $0 != .wiki || wiki }.flatMap { section -> [DrawerWorkRow] in
            switch section {
            case .projects: [.projects]
            case .tasks: scheduled ? [.section(.tasks), .scheduled] : [.section(.tasks)]
            case .wiki: [.wiki]
            default: [.section(section)]
            }
        }
        return work
            + (waitingOnYou ? [.waitingOnYou] : [])
            + [.workspacesHeader, .agents, .openProjects, .sharedWithMe]
    }
}
