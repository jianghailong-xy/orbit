import OrbitKit

extension SessionProjectEntry {
    /// Only the section grouper reads these records. A project's row is drawn from its
    /// SessionProjectRow, never from this projection, so member statuses stay intact; the
    /// projection carries just what picks its section: the pin, the list-order key, and whether
    /// it needs you or is working.
    var timeGroupingSession: Session {
        switch self {
        case .session(let session): return session
        case .project(let row):
            return Session(id: row.id, title: row.title, status: row.running ? .running : .awaitingInput,
                           agentId: nil, assignedRunnerId: nil, pendingApprovals: row.needsYou ? 1 : nil,
                           branch: nil, updatedAt: nil, pinnedAt: row.pinnedAt,
                           createdAt: row.createdAt, lastTurnAt: row.lastTurnAt, listedAt: row.listedAt)
        }
    }
}

/// One pass's grouping of a session list — what the workspace list and a folder page draw, kept
/// in a `SessionListingMemo` until its inputs change.
struct SessionListGrouping {
    let projectListing: SessionProjectListing
    /// The folder rows on top and the sessions left for the time sections (a folder page has no
    /// folder rows: its sessions are the folder's).
    let folderListing: SessionFolderListing
    let timeSections: [SessionTimeSection]
    let projectRows: [String: SessionProjectRow]
}
