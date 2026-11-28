import Foundation

/// Workspace-level activity derived from the Open session snapshot.
///
/// The API still names the owning relation `agent`, while the product calls it a Workspace. Keeping
/// this mapping here lets navigation surfaces use the exact same definition of "running" as a
/// Session row: only a session whose row draws the animated spinner counts — `phase` RUNNING with the
/// session facts, else the shared status glyph's spinner.
public enum WorkspaceActivityLogic {
    /// Workspace ids that currently contain at least one Session-row spinner.
    public static func runningWorkspaceIDs(_ sessions: [Session]) -> Set<String> {
        var ids: Set<String> = []
        for session in sessions {
            guard isRunning(session),
                  let id = session.agent?.id ?? session.agentId
            else { continue }
            ids.insert(id)
        }
        return ids
    }

    /// One session's half of `runningWorkspaceIDs`: its row draws the spinner. A folder row reads
    /// the same answer for the sessions filed in it (`SessionFolderGrouping`).
    static func isRunning(_ session: Session) -> Bool {
        isRunning(session, watching: nil)
    }

    static func isRunning(_ session: Session, watching: WatchSessionSummary?) -> Bool {
        // With the session facts, the row's spinner is `phase` alone (`SessionLiveIndicator`): a
        // background job or sub-agent between turns turns it too, quiet job or not. Read the same
        // here, or a folder or workspace sits idle over a row that spins.
        if let state = SessionDisplay.state(session.displayFacts) { return state == .running }
        // An older server's row: the spinner, or the terminal breathing for a background job in flight.
        let glyph = SessionStatusGlyph.make(for: session, watching: watching)
        if case .spinner = glyph.shape { return true }
        return glyph.pulse
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
        case .unknown: return nil
        case nil: return nil
        }
    }

    public static func isOffline(runnerID: String?, onlineByRunnerID: [String: Bool]) -> Bool {
        guard let runnerID, let online = onlineByRunnerID[runnerID] else { return false }
        return !online
    }
}

/// The one trailing state slot on a first-level Workspace navigation row. User attention wins over
/// background activity, while an explicitly-offline Runner suppresses a stale spinner without
/// hiding work that still needs the user's response.
public enum WorkspaceNavigationStatus: Equatable, Sendable {
    case needsYou(Int)
    case running
    case idle
}

public enum WorkspaceNavigationStatusLogic {
    public static func resolve(waiting: Int, running: Bool,
                               runnerOffline: Bool) -> WorkspaceNavigationStatus {
        if waiting > 0 { return .needsYou(waiting) }
        // Offline suppresses the activity mark: it can't be described from a snapshot of a machine
        // that is not answering.
        if running && !runnerOffline { return .running }
        return .idle
    }
}
