#if os(iOS)
import OrbitKit

extension SessionProjectEntry {
    /// Only the existing recency grouper reads these records. A project's row is drawn from its
    /// SessionProjectRow, never from this date/pin projection, so member statuses stay intact.
    var timeGroupingSession: Session {
        switch self {
        case .session(let session): return session
        case .project(let row):
            return Session(id: row.id, title: row.title, status: .awaitingInput,
                           agentId: nil, assignedRunnerId: nil, pendingApprovals: nil,
                           branch: nil, updatedAt: nil, pinnedAt: row.pinnedAt,
                           createdAt: row.createdAt, lastTurnAt: row.lastTurnAt)
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
#endif
