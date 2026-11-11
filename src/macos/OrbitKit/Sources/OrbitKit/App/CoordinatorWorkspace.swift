import Foundation

/// Starting a project's next coordinator in a workspace the owner picks
/// (docs/mocks/coordinator-move-workspace/03-final ④–⑥): the picker's rows and the confirmation's
/// words — the Swift twin of the web's `lib/coordinatorWorkspace.ts`. The server's
/// `POST /projects/:id/coordinator/replace` with `{ workspaceId }` does the work; a workspace it would
/// refuse (disabled, or on no runner) is greyed here with the same reason, so the press is not
/// offered where it cannot succeed.
public enum StartCoordinatorCopy {
    public static let menuTitle = "Start a new coordinator in…"
    public static let menuDetail = "The same, in a workspace you pick. This project is coordinated from there afterwards."
    public static let pickerTitle = "Start a new coordinator in…"
    public static let current = "Current"
    public static let runnerOffline = "Runner offline"
    public static let pickerFoot = "The new coordinator starts empty, on the workspace’s own engine and account."
    public static let disabled = "This workspace is disabled."
    public static let noRunner = "This workspace has no runner."
    public static let keep = "Keep this coordinator"
    /// The Move panel's way out for a row whose conversation cannot come along.
    public static let startNewHere = "Start new here…"
    /// The project page's Move…, which opens the coordinator conversation's own Move panel.
    public static let move = "Move…"
    /// The alert over a replacement that didn't go through.
    public static let couldNotStart = "Couldn't start a new coordinator"

    public static func title(_ workspace: String) -> String { "Start a new coordinator in \(workspace)?" }

    /// The confirmation's paragraphs: where the old conversation stays, and what moves with the new one.
    public static func paragraphs(project: String, to: String, from: String?,
                                  outgoing: OutgoingCoordinator) -> [String] {
        let place = from.map { " in \($0)" } ?? ""
        var paragraphs: [String] = []
        switch outgoing {
        case .open:
            paragraphs.append("The current conversation is completed — a turn in flight finishes first — and stays readable\(place).")
        case .completed:
            paragraphs.append("The current conversation stays completed and readable\(place).")
        case .none:
            break
        }
        paragraphs.append("\(project) is coordinated from a new, empty conversation in \(to), and its row moves to \(to)’s list. Its tasks keep running where they are.")
        return paragraphs
    }

    /// The confirmation's button: it completes an open conversation, and says so.
    public static func action(_ workspace: String, outgoing: OutgoingCoordinator) -> String {
        outgoing == .open ? "Complete and start in \(workspace)" : "Start in \(workspace)"
    }
}

/// What the conversation being left behind is, for the confirmation's first paragraph.
public enum OutgoingCoordinator: Equatable, Sendable {
    case open
    case completed
    /// None, or in Trash: nothing is said about it.
    case none

    /// Read off the coordinator card's status, as the web's `ProjectCoordinatorSection` reads it.
    public init(_ status: ProjectCoordinatorStatus?) {
        guard let session = status?.coordination.session, status?.state != .trashed,
              session.lifecycleState != .trash else {
            self = .none
            return
        }
        self = session.lifecycleState == .completed ? .completed : .open
    }
}

/// One workspace in the Start a new coordinator in… picker.
public struct CoordinatorWorkspaceRow: Identifiable, Equatable, Sendable {
    public let workspaceId: String
    public let name: String
    public let provider: String
    /// `<Provider> · <runner>`, or why a new coordinator cannot open there.
    public let detail: String
    /// Nil when a new coordinator can open here.
    public let reason: String?
    public let isCurrent: Bool
    public let runnerOffline: Bool

    public var id: String { workspaceId }
}

public enum CoordinatorWorkspaceLogic {
    /// The picker's rows, in the order the workspaces are handed in (the sidebar's). `runnerOnline`
    /// answers nil for a runner whose liveness isn't known yet, which draws no Runner offline.
    public static func rows(_ workspaces: [Agent], currentWorkspaceID: String?,
                            runnerName: (String) -> String?, runnerOnline: (String) -> Bool?,
                            providerName: (String) -> String) -> [CoordinatorWorkspaceRow] {
        workspaces.map { w in
            let reason = w.enabled == false ? StartCoordinatorCopy.disabled
                : w.runnerId == nil ? StartCoordinatorCopy.noRunner : nil
            let provider = w.defaultProvider
            let detail = reason ?? [providerName(provider), w.runnerId.flatMap(runnerName)]
                .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
            return CoordinatorWorkspaceRow(
                workspaceId: w.id, name: w.name, provider: provider, detail: detail, reason: reason,
                isCurrent: w.id == currentWorkspaceID,
                runnerOffline: reason == nil && w.runnerId.flatMap(runnerOnline) == false)
        }
    }
}
