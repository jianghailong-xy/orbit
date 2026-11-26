import Foundation

/// The macOS source list's one selection: a section, a Workspace, a machine's Set up row, or one open
/// project. It lives in OrbitKit so the mapping between the stored value and the navigation state is
/// testable without SwiftUI — and so the view has one value to hold, rather than a Binding that
/// derives from four model fields while the List updates.
public enum SidebarSelection: Hashable, Sendable {
    case section(AppSection)
    case agent(String)
    /// A machine with no workspace: its Set up row, and the new session page it opens.
    case machine(String)
    /// An open project in the Projects group: its sessions page in the session column.
    case project(String)
    /// A session someone shared with this account, in the Shared with me group: its guest view.
    case guestSession(String)
    /// Trash or Storage, the rows under Drive (`.section(.drive)` is the drive itself).
    case drive(DrivePlace)
}

/// Which of Drive' pages is showing: the drive's folders, Trash or Storage (docs/mocks/drive, 03-mac ③).
public enum DrivePlace: String, Hashable, Sendable, CaseIterable {
    case drive, trash, storage

    public var title: String {
        switch self {
        case .drive: return DriveLogic.title
        case .trash: return DriveLogic.trash
        case .storage: return DriveLogic.storage
        }
    }

    public var systemImage: String {
        switch self {
        case .drive: return "folder"
        case .trash: return "trash"
        case .storage: return "chart.bar"
        }
    }
}

/// What a stored selection asks the navigation model to do. Kept as its own value so the view can run
/// it AFTER the List has applied the update, never inside the selection binding's setter.
public enum SidebarTarget: Equatable, Sendable {
    case section(AppSection)
    case agent(String)
    case machine(String)
    case project(String)
    case guestSession(String)
    case drive(DrivePlace)
    /// Nothing is selected (a cleared selection): nothing to do.
    case none
}

public enum SidebarLogic {
    /// The stored selection the navigation state stands for. A machine draft page on top wins over the
    /// open project's sessions column, which wins over the Workspace, which wins over the plain
    /// section — the same precedence the old computed binding had.
    public static func selection(section: AppSection, agentID: String?,
                                 machineDraftRunnerID: String?, projectID: String?,
                                 guestSessionID: String? = nil,
                                 drivePlace: DrivePlace = .drive) -> SidebarSelection {
        if section == .drive, drivePlace != .drive { return .drive(drivePlace) }
        if section == .agents, let guestSessionID { return .guestSession(guestSessionID) }
        if let runnerID = machineDraftRunnerID { return .machine(runnerID) }
        if section == .agents, let projectID { return .project(projectID) }
        if section == .agents, let id = agentID { return .agent(id) }
        return .section(section)
    }

    /// What a stored selection does when the List has finished its update.
    public static func target(_ selection: SidebarSelection?) -> SidebarTarget {
        switch selection {
        case .section(let section)?: return .section(section)
        case .agent(let id)?: return .agent(id)
        case .machine(let runnerID)?: return .machine(runnerID)
        case .project(let id)?: return .project(id)
        case .guestSession(let id)?: return .guestSession(id)
        case .drive(let place)?: return .drive(place)
        case nil: return .none
        }
    }
}
