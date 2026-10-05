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
#endif
