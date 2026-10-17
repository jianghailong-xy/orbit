import Foundation

/// One row of the Move panel's Move to Another Workspace group (docs/session-folders-move-design.md
/// §4, §5.2): a workspace the session could go to, and whether it can.
public struct SessionMoveTargetRow: Identifiable, Equatable, Sendable {
    public let target: SessionMoveTarget
    /// The row opens the workspace's page: the session can leave its workspace, and go to this one.
    public let isEnabled: Bool
    /// The grey line under the name: `<Provider> · <runner>`, `Runner offline`, or why the session
    /// can't go there, in the server's words.
    public let detail: String

    public var id: String { target.workspaceId }

    public init(target: SessionMoveTarget, isEnabled: Bool, detail: String) {
        self.target = target
        self.isEnabled = isEnabled
        self.detail = detail
    }
}

/// What the Move to Another Workspace group shows, and what its confirmation says. The server
/// decides whether the session can move and where (§5.4); this only puts its answer into rows and
/// sentences. Pure, so it is tested here rather than on a device.
public enum SessionWorkspaceMoveLogic {
    /// The group's rows, in the order the server lists the workspaces. A workspace the server gives
    /// a reason for is greyed with that reason; when the session itself can't move (`reason` on the
    /// whole answer) every row is greyed and the group says why under it (`groupReason`). An offline
    /// runner is no reason — the move only changes where the session belongs, and its next message
    /// waits for the runner — so that row stays open and says `Runner offline`.
    public static func rows(_ answer: SessionMoveTargets,
                            providerName: (String) -> String) -> [SessionMoveTargetRow] {
        answer.targets.map { target in
            let detail: String
            if let reason = target.reason {
                detail = reason
            } else if !target.runnerOnline {
                detail = SessionMoveCopy.runnerOffline
            } else {
                detail = [providerName(target.provider), target.runnerName]
                    .compactMap { $0 }
                    .joined(separator: " · ")
            }
            return SessionMoveTargetRow(target: target,
                                        isEnabled: answer.reason == nil && target.reason == nil,
                                        detail: detail)
        }
    }

    /// Why the whole group is greyed — the session itself can't leave its workspace — or nil.
    public static func groupReason(_ answer: SessionMoveTargets) -> String? {
        answer.reason
    }

    /// The folders the session can be filed in on a workspace's page: the ones the server listed,
    /// and any made from the page since (New Folder…), by name as the list orders folders
    /// (`SessionFolderGrouping.byName`).
    public static func folders(of target: SessionMoveTarget,
                               adding made: [SessionMoveFolder]) -> [SessionMoveFolder] {
        let listed = Set(target.folders.map(\.id))
        return (target.folders + made.filter { !listed.contains($0.id) }).sorted { a, b in
            switch a.name.localizedStandardCompare(b.name) {
            case .orderedAscending: return true
            case .orderedDescending: return false
            case .orderedSame: return a.id < b.id
            }
        }
    }
}

/// End and Move (§5.4): the client's own steps, since the move itself only takes an ended session.
/// Ending is when its runner commits what it left uncommitted, so the move waits for the session to
/// have ended rather than for the end request to be answered. Every step is handed in, so the order,
/// the wait and its timeout are tested here without a server.
public enum SessionWorkspaceMove {
    /// What the panel says while the move is under way.
    public enum Phase: Equatable, Sendable {
        /// End and Move's first step: asking the session to end, then waiting until it has.
        case ending
        /// The move itself.
        case moving
    }

    public enum Outcome: Equatable, Sendable {
        case moved
        /// Not moved, and why, as the sentence the panel shows.
        case failed(String)
    }

    /// How long End and Move waits for the session to end. Its runner commits what the session left
    /// uncommitted first, which can take a while on a large change.
    public static let endTimeout: TimeInterval = 60
    /// How often it looks while it waits.
    public static let pollInterval: TimeInterval = 1

    /// Move the session: end it first when `endingFirst` (End and Move), wait until its run is over,
    /// then move it. `status` reads the session's run status as the server has it now.
    ///
    /// An end the server refuses with a 409 is a session already ending or ended — the end request
    /// only takes a live one — so the wait goes on from there. Anything else stops the move with why.
    /// A status read that fails along the way is only a missed look; the wait goes on until the
    /// timeout, and a session still not ended by then is not moved.
    public static func run(endingFirst: Bool,
                           end: () async throws -> Void,
                           status: () async throws -> RunStatus,
                           move: () async throws -> Void,
                           phase: (Phase) async -> Void = { _ in },
                           sleep: (TimeInterval) async -> Void = SessionWorkspaceMove.sleep,
                           timeout: TimeInterval = SessionWorkspaceMove.endTimeout,
                           interval: TimeInterval = SessionWorkspaceMove.pollInterval) async -> Outcome {
        if endingFirst {
            await phase(.ending)
            do {
                try await end()
            } catch APIError.http(let code, _) where code == 409 {
                // Already ending or ended: wait for it below like any other.
            } catch {
                return .failed(SessionMoveCopy.endFailed(error))
            }
            var waited: TimeInterval = 0
            while (try? await status())?.isTerminal != true {
                guard waited < timeout else { return .failed(SessionMoveCopy.endTimedOut) }
                await sleep(interval)
                waited += interval
            }
        }
        await phase(.moving)
        do {
            try await move()
        } catch {
            return .failed(SessionMoveCopy.moveFailed(error))
        }
        return .moved
    }

    /// The wait between two looks at the session.
    public static func sleep(_ seconds: TimeInterval) async {
        try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    }
}

/// The words of the Move panel's second group, its workspace pages and its confirmation (§4, §5.3).
public extension SessionMoveCopy {
    /// The second group's header.
    static let anotherWorkspaceGroup = "Move to Another Workspace"
    /// A workspace whose runner is away: it can still be chosen.
    static let runnerOffline = "Runner offline"
    /// The group while the server is asked.
    static let loadingWorkspaces = "Loading workspaces…"

    /// Why the group couldn't be drawn.
    static func targetsFailed(_ error: Error) -> String {
        "Couldn’t load the other workspaces: \(APIClient.failureReason(error))."
    }

    /// The sentence under a workspace page's folders (mock 03 ①): the runner the session goes to and
    /// how the conversation comes along, the directory the agent works in, and an away runner.
    static func targetFooter(_ target: SessionMoveTarget) -> String {
        let runner = target.runnerName.map { " (\($0))" } ?? ""
        var sentences: [String] = []
        switch target.conversation {
        case .continues:
            sentences.append("Same runner\(runner). The conversation carries over as it is.")
        case .rebuilt:
            sentences.append("Another runner\(runner). The conversation is rebuilt from Orbit’s record, "
                             + "its earlier parts summarized for the agent.")
        case nil:
            if let name = target.runnerName { sentences.append("It runs on \(name).") }
        }
        if let workDir = target.workDir, !workDir.isEmpty {
            sentences.append("The agent works in \(workDir) from your next message.")
        }
        if !target.runnerOnline {
            sentences.append("\(target.runnerName ?? "The runner") is offline: your next message waits for it.")
        }
        return sentences.joined(separator: " ")
    }

    /// The confirmation's title.
    static func confirmTitle(_ target: SessionMoveTarget) -> String { "Move to \(target.name)?" }

    /// The confirmation's body, put together as §5.3 says: the conversation goes, the agent's memory
    /// of it is summarized when another runner rebuilds it, the changes stay on their branch in the
    /// old workspace — named with how many aren't merged yet when some aren't — and an idle session
    /// ends first.
    static func confirmMessage(_ answer: SessionMoveTargets, to target: SessionMoveTarget,
                               from workspace: String) -> String {
        var paragraphs = ["The conversation moves with it. Your next message continues it in \(target.name)."]
        if target.conversation == .rebuilt {
            paragraphs.append("Earlier parts of the conversation are summarized for the agent.")
        }
        if let branch = answer.branch, answer.changedFiles > 0 {
            let unmerged = answer.unmergedFiles
            if unmerged > 0 {
                let files = unmerged == 1 ? "1 changed file isn’t" : "\(unmerged) changed files aren’t"
                let they = unmerged == 1 ? "It stays" : "They stay"
                paragraphs.append("\(files) merged into \(answer.mergeTarget ?? "main") yet. "
                                  + "\(they) on branch \(branch) in \(workspace).")
            } else {
                paragraphs.append("Changes made so far stay on branch \(branch) in \(workspace).")
            }
        }
        if answer.needsEnd { paragraphs.append("The session ends first.") }
        return paragraphs.joined(separator: "\n\n")
    }

    /// The confirmation's button: End and Move for a session that has to be ended first.
    static func confirmAction(_ answer: SessionMoveTargets) -> String {
        answer.needsEnd ? "End and Move" : "Move"
    }

    /// What the panel says while the move is under way.
    static func progress(_ phase: SessionWorkspaceMove.Phase) -> String {
        switch phase {
        case .ending: return "Ending the session…"
        case .moving: return "Moving…"
        }
    }

    /// The toast once the session is in the other workspace.
    static func movedToWorkspace(_ name: String) -> String { "Moved to \(name)" }

    /// The alert when it isn't, over the reason.
    static let couldNotMove = "Couldn't move the session"

    /// The end request failed for a reason other than the session already ending.
    static func endFailed(_ error: Error) -> String {
        "The session couldn’t be ended, so it wasn’t moved: \(APIClient.failureReason(error))."
    }

    /// The session was asked to end but hadn't by the time End and Move stopped waiting.
    static let endTimedOut = "The session hasn’t finished ending, so it wasn’t moved. "
        + "Try again once it has ended."

    /// The move's reason goes below the failed-action title. A refusal (409) is the server's own
    /// sentence, shown as it is; other failures also show only their reason.
    static func moveFailed(_ error: Error) -> String {
        APIClient.failureReason(error)
    }
}
