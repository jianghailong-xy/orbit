import Foundation

/// Workspace-level activity derived from the Open session snapshot.
///
/// The API still names the owning relation `agent`, while the product calls it a Workspace. Keeping
/// this mapping here lets navigation surfaces use the exact same definition of "running" as a
/// Session row: only a session whose shared status glyph is the animated spinner counts.
public enum WorkspaceActivityLogic {
    /// Workspace ids that currently contain at least one Session-row spinner.
    public static func runningWorkspaceIDs(_ sessions: [Session]) -> Set<String> {
        var ids: Set<String> = []
        for session in sessions {
            guard case .spinner = SessionStatusGlyph.make(for: session).shape,
                  let id = session.agent?.id ?? session.agentId
            else { continue }
            ids.insert(id)
        }
        return ids
    }
}

/// Tri-state Runner availability for Workspace navigation. Absence means unknown, not offline:
/// the clients load Workspaces and Runners independently, so treating a missing map entry as false
/// would flash a disconnect badge while the Runner snapshot is still in flight.
public enum WorkspaceRunnerAvailabilityLogic {
    /// Resolve one Runner row without collapsing an older/partial payload's missing fields into
    /// offline. The explicit server boolean wins; draining is still connected, merely refusing new
    /// work, so it remains online for availability presentation.
    public static func onlineValue(explicit: Bool?, status: RunnerStatus?) -> Bool? {
        if let explicit { return explicit }
        switch status {
        case .online, .draining: return true
        case .offline: return false
        case nil: return nil
        }
    }

    public static func isOffline(runnerID: String?, onlineByRunnerID: [String: Bool]) -> Bool {
        guard let runnerID, let online = onlineByRunnerID[runnerID] else { return false }
        return !online
    }
}
