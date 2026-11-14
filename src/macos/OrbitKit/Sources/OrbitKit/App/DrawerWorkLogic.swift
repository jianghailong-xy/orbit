import Foundation

/// One row of the compact shell's drawer rail, in the order the drawer draws it: the work, the
/// owner's inbox, then the Workspaces header and its rows, the open projects and Shared with me.
/// The rail's List draws one row per case through one ForEach — no `if` and no second ForEach in
/// that ForEach.
public enum DrawerWorkRow: Equatable, Sendable, Identifiable {
    case projects
    case wiki
    /// New wiki…, right under the Wiki row once there is a wiki.
    case newWiki
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
        case .newWiki: "new-wiki"
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
    /// has it off (`wiki`), as data, and New wiki… under it once there is a wiki (`newWiki`) — then
    /// the inbox only while the server serves it, then the Workspaces header and the rows under it.
    public static func rows(_ sections: [AppSection], wiki: Bool, newWiki: Bool = false,
                            waitingOnYou: Bool) -> [DrawerWorkRow] {
        let work: [DrawerWorkRow] = sections.filter { $0 != .wiki || wiki }.flatMap { section -> [DrawerWorkRow] in
            switch section {
            case .projects: [.projects]
            case .wiki: newWiki ? [.wiki, .newWiki] : [.wiki]
            default: [.section(section)]
            }
        }
        return work
            + (waitingOnYou ? [.waitingOnYou] : [])
            + [.workspacesHeader, .agents, .openProjects, .sharedWithMe]
    }
}
