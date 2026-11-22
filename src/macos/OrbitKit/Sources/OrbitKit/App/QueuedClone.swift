import Foundation

/// A session held by its GitHub workspace's clone (queuedReason `WORKSPACE_CLONING` / `WORKSPACE_CLONE_FAILED`): the
/// port of web's `CloneWaitNotice` and the clone words of `runnerSlots.ts` (board docs/mocks/clone-progress-wait-card,
/// option A). The waiting card names the repository, draws git's percentage once the stream has relayed one, and says
/// where; the list row reads `Cloning · 42%`. Every sentence is the web's.
public enum QueuedClone {
    public static let cloning = "WORKSPACE_CLONING"
    public static let failed = "WORKSPACE_CLONE_FAILED"
    /// Web `CLONE_WAIT_TITLE` and `CLONE_FAILED_TITLE`: the row's word before a percentage, and the plain titles.
    public static let WAIT_TITLE = "Waiting for the clone"
    public static let FAILED_TITLE = "Clone failed"
    /// Web `CLONE_FAILED_WAIT`: no mention of the conversation's first line, which a session may not have.
    public static let FAILED_WAIT = "This session starts once the repository is cloned."
    /// Web `CLONE_WAIT_STARTS`.
    public static let STARTS = "This session starts when the clone is done."

    /// Whether the clone holds this session: queued, and the server named that gate.
    public static func holds(_ s: Session) -> Bool {
        s.effectiveRunState == .queued && s.queuedReason == cloning
    }

    /// Web `cloneWaitTitle`: `Waiting to clone owner/name` or `Cloning owner/name`.
    public static func title(state: CloneState, repository: String) -> String {
        "\(state == .cloning ? MachineSetupCopy.CLONE_CLONING : MachineSetupCopy.CLONE_WAITING) \(repository)"
    }

    /// Web `cloneRowLabel`: a held session's list line once git has reported a percentage.
    public static func rowLabel(progress: Int) -> String { "Cloning · \(progress)%" }

    /// The sentence under the title: where, and when this session starts. Web `CloneWaitNotice`.
    /// With no machine named, only when it starts.
    public static func sentence(machine: String?) -> String {
        guard let machine, !machine.isEmpty else { return STARTS }
        return "On \(machine). \(STARTS)"
    }

    /// The list row's line for a session held by its clone, or nil when this is not one. The percentage is the one
    /// the stream relayed for a clone it says is under way.
    public static func rowLine(_ s: Session, heard: CloneHeard?) -> String? {
        switch s.queuedReason {
        case cloning:
            if let heard, heard.state == .cloning, let progress = heard.progress { return rowLabel(progress: progress) }
            return WAIT_TITLE
        case failed: return FAILED_TITLE
        default: return nil
        }
    }

    /// What the waiting card draws.
    public struct Card: Equatable, Sendable {
        public let state: CloneState
        public let progress: Int?
        public let repository: String
        public init(state: CloneState, progress: Int?, repository: String) {
            self.state = state
            self.progress = progress
            self.repository = repository
        }
        public var title: String { QueuedClone.title(state: state, repository: repository) }
    }

    /// Where a held session's clone stands, or nil when this is not a GitHub clone still under way (then the plain
    /// queued words stand). Failed is not drawn here: the failed-clone card says why, with Retry. Web `useCloneWait`.
    public static func card(session s: Session, workspace: SessionAgentRef?, heard: CloneHeard?,
                            storedAt: Date?) -> Card? {
        guard holds(s), let workspace, let stored = workspace.cloneState,
              let repository = WorkspaceClone.repositoryOf(workspace.repoUrl),
              let clone = WorkspaceClone.now(stored: stored, live: heard, storedAt: storedAt),
              clone.state == .pending || clone.state == .cloning else { return nil }
        return Card(state: clone.state, progress: clone.progress, repository: repository)
    }
}
