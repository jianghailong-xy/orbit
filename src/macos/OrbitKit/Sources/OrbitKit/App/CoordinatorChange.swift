import Foundation

/// Change: where a project is coordinated from (docs/mocks/coordinator-move-workspace/04-change) —
/// the Swift twin of the web's `lib/coordinatorWorkspace.ts`. One door for both ways of getting
/// there: the coordinator conversation moves along when it can (`POST /sessions/:id/move`), or a new,
/// empty one opens there (`POST /projects/:id/coordinator/replace` with `{ workspaceId }`). Which way
/// each workspace allows is the server's answer: `move-targets` for a conversation that exists, and
/// for one that does not (in Trash, never opened) the two refusals `sessions.create` gives a
/// workspace — disabled, or on no runner — read off the workspace list.
public enum CoordinatorChangeCopy {
    /// The coordinator menu's item, and the Unavailable and Trash cards' button.
    public static let button = "Change workspace…"
    public static let title = "Change workspace"
    public static func sub(_ project: String, from: String?) -> String {
        from.map { "\(project) · coordinated from \($0)" } ?? project
    }
    public static let current = "Current"
    public static let runnerOffline = "Runner offline"
    public static let comesAlong = "Conversation comes along"
    public static let newConversation = "New conversation"
    public static let foot = "Tasks keep running where they are. Only where the project is coordinated from changes."
    public static let disabled = "This workspace is disabled."
    public static let noRunner = "This workspace has no runner."
    public static let cancel = "Cancel"
    public static let move = "Move conversation"
    public static let startThere = "Start a new one there"

    /// The confirmation's title, either way.
    public static func title(project: String, to: String) -> String { "Coordinate \(project) from \(to)?" }

    /// The confirmation when the conversation can come along: both ways, the move first. `files` is
    /// the sentence about changes left on the branch (`SessionMoveCopy.filesSentence`), when there are any.
    public static func moveParagraphs(to: String, from: String, needsEnd: Bool, files: String?) -> [String] {
        var move = ["this conversation goes to \(to) and continues there."]
        if needsEnd { move.append("It ends first.") }
        if let files { move.append(files) }
        return [
            "Move conversation: \(move.joined(separator: " "))",
            "Start a new one there: this conversation is completed and stays readable in \(from), and a new, empty one opens in \(to).",
            "Either way, its tasks keep running where they are.",
        ]
    }

    /// The confirmation when only a new conversation can open there: why, first, when there is one.
    public static func newParagraphs(to: String, from: String?, outgoing: OutgoingCoordinator,
                                     reason: String?) -> [String] {
        let place = from.map { " in \($0)" } ?? ""
        var paragraphs: [String] = []
        if let reason, outgoing != .none {
            paragraphs.append("This conversation can’t come along: \(sentence(reason))")
        }
        switch outgoing {
        case .open:
            paragraphs.append("It is completed — a turn in flight finishes first — and stays readable\(place). A new, empty one opens in \(to).")
        case .completed:
            paragraphs.append("It stays completed and readable\(place). A new, empty one opens in \(to).")
        case .none:
            paragraphs.append("A new, empty one opens in \(to).")
        }
        paragraphs.append("Its tasks keep running where they are.")
        return paragraphs
    }

    /// The new start's button: it completes an open conversation, and says so.
    public static func newAction(_ to: String, outgoing: OutgoingCoordinator) -> String {
        outgoing == .open ? "Complete and start in \(to)" : "Start in \(to)"
    }

    private static func sentence(_ text: String) -> String {
        guard let last = text.last, ".!?".contains(last) else { return "\(text)." }
        return text
    }
}

/// What the conversation being left behind is.
public enum OutgoingCoordinator: Equatable, Sendable {
    case open
    case completed
    /// None, or in Trash: there is no conversation to bring or to complete.
    case none

    /// Read off the coordinator card's status, as the web's `ProjectCoordinatorSection` reads it.
    public init(_ status: ProjectCoordinatorStatus?) {
        guard CoordinatorChangeLogic.conversationID(status) != nil, let session = status?.coordination.session else {
            self = .none
            return
        }
        self = session.lifecycleState == .completed ? .completed : .open
    }
}

/// How a picked workspace can take the project: the conversation moves along, or a new one opens there.
public enum CoordinatorChangeWay: Equatable, Sendable {
    case move
    case new
}

/// One workspace in Change.
public struct CoordinatorChangeRow: Identifiable, Equatable, Sendable {
    public let workspaceId: String
    public let name: String
    public let provider: String
    /// `<Provider> · <runner>` (empty for the current workspace when its runner is not known), or why
    /// nothing can open there. The Current mark says which one is current.
    public let detail: String
    /// Nil for the current workspace and for one nothing can open in (greyed).
    public let way: CoordinatorChangeWay?
    /// Why the conversation cannot come along, for a `new` row (the server's sentence); why nothing
    /// can open there, for a greyed one.
    public let reason: String?
    public let isCurrent: Bool
    public let runnerOffline: Bool

    public var id: String { workspaceId }

    public init(workspaceId: String, name: String, provider: String, detail: String,
                way: CoordinatorChangeWay?, reason: String?, isCurrent: Bool, runnerOffline: Bool) {
        self.workspaceId = workspaceId
        self.name = name
        self.provider = provider
        self.detail = detail
        self.way = way
        self.reason = reason
        self.isCurrent = isCurrent
        self.runnerOffline = runnerOffline
    }

    /// The row's second line: its detail and, where it can be picked, which way the project goes.
    public var subtitle: String {
        let wayText = way.map { $0 == .move ? CoordinatorChangeCopy.comesAlong : CoordinatorChangeCopy.newConversation }
        return [detail, wayText].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

public enum CoordinatorChangeLogic {
    /// The conversation that can come along: one that exists and is not in Trash.
    public static func conversationID(_ status: ProjectCoordinatorStatus?) -> String? {
        guard let status, status.state != .trashed, let session = status.coordination.session,
              session.lifecycleState != .trash else { return nil }
        return session.id
    }

    /// The rows for a coordinator conversation that exists: its own workspace first, then the
    /// server's targets.
    public static func rows(_ answer: SessionMoveTargets, currentID: String, currentName: String,
                            currentProvider: String = "claude",
                            providerName: (String) -> String) -> [CoordinatorChangeRow] {
        let rows = answer.targets.map { t -> CoordinatorChangeRow in
            let comesAlong = answer.reason == nil && t.reason == nil
            let way: CoordinatorChangeWay? = comesAlong ? .move : t.startsCoordinator ? .new : nil
            let detail = way == nil ? (t.reason ?? "")
                : [providerName(t.provider), t.runnerName].compactMap { $0 }.filter { !$0.isEmpty }
                    .joined(separator: " · ")
            return CoordinatorChangeRow(
                workspaceId: t.workspaceId, name: t.name, provider: t.provider, detail: detail, way: way,
                reason: comesAlong ? nil : (answer.reason ?? t.reason), isCurrent: false,
                runnerOffline: way != nil && t.runnerId != nil && !t.runnerOnline)
        }
        let current = CoordinatorChangeRow(workspaceId: currentID, name: currentName, provider: currentProvider,
                                           detail: "", way: nil, reason: nil, isCurrent: true, runnerOffline: false)
        return [current] + rows
    }

    /// The rows when there is no conversation to bring (in Trash, or never opened): every usable
    /// workspace takes a new one. `runnerOnline` answers nil for a runner whose liveness isn't known
    /// yet, which draws no Runner offline.
    public static func rows(_ workspaces: [Agent], currentWorkspaceID: String?,
                            runnerName: (String) -> String?, runnerOnline: (String) -> Bool?,
                            providerName: (String) -> String) -> [CoordinatorChangeRow] {
        let rows = workspaces.map { w -> CoordinatorChangeRow in
            let provider = w.defaultProvider
            let usual = [providerName(provider), w.runnerId.flatMap(runnerName)]
                .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
            if w.id == currentWorkspaceID {
                return CoordinatorChangeRow(workspaceId: w.id, name: w.name, provider: provider, detail: usual,
                                            way: nil, reason: nil, isCurrent: true, runnerOffline: false)
            }
            let reason = w.enabled == false ? CoordinatorChangeCopy.disabled
                : w.runnerId == nil ? CoordinatorChangeCopy.noRunner : nil
            return CoordinatorChangeRow(
                workspaceId: w.id, name: w.name, provider: provider, detail: reason ?? usual,
                way: reason == nil ? .new : nil, reason: reason, isCurrent: false,
                runnerOffline: reason == nil && w.runnerId.flatMap(runnerOnline) == false)
        }
        // The current workspace leads, as it does when the server lists the targets.
        return rows.filter(\.isCurrent) + rows.filter { !$0.isCurrent }
    }
}
