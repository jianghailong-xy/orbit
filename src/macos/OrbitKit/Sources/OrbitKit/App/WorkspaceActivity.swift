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
