import Foundation

/// The Open view's three live-work buckets: sessions that need a
/// human (pending approvals) float first, then live/running, then still-queued.
public struct SessionGroups: Equatable, Sendable {
    public var needsYou: [Session]
    public var running: [Session]
    public var queued: [Session]
    public init(needsYou: [Session] = [], running: [Session] = [], queued: [Session] = []) {
        self.needsYou = needsYou
        self.running = running
        self.queued = queued
    }
    public static let empty = SessionGroups()
    public var isEmpty: Bool { needsYou.isEmpty && running.isEmpty && queued.isEmpty }
}

public enum SessionGrouping {
    /// Bucket the Open snapshot's actionable sessions, preserving input order within each bucket.
    /// `needsYou` = has pending approvals, or carries one of the four owner items (§7.6 V13) — but
    /// not when all it counts is a project ready to start (`countsOnlyAStart`);
    /// `running` = otherwise live (running / awaiting / interrupted); `queued` = QUEUED.
    /// Terminal/dormant sessions are excluded from these buckets.
    /// All live sessions are grouped here because the separate System list has been removed.
    public static func group(_ sessions: [Session]) -> SessionGroups {
        var needsYou: [Session] = []
        var running: [Session] = []
        var queued: [Session] = []
        for s in sessions {
            // The count is the server's, and it already includes the owner items on the row
            // (`owner-decision-signal.ts`). The second clause is not a second opinion of it: a row
            // that carries one of the four is in this bucket even if the number arrived stale from
            // an older snapshot, because the item itself is the evidence that somebody is waiting.
            if ((s.pendingApprovals ?? 0) > 0 && !countsOnlyAStart(s)) || !(s.ownerItems ?? []).isEmpty {
                needsYou.append(s)
            } else if s.effectiveRunState == .queued {
                queued.append(s)
            } else if s.effectiveRunState.isLive {
                running.append(s)
            }
        }
        return SessionGroups(needsYou: needsYou, running: running, queued: queued)
    }

    /// Whether everything a row's `pendingApprovals` counts is its project waiting to be started
    /// (`waitingKind == .startRequest`). The row still says "Ready to start", but it is not one of
    /// the sessions that need you: nothing is blocked on the start, and the owner makes it when
    /// they choose — so the bar, the badge and the drawer's count leave it out, as the server's
    /// per-workspace tally and the APNs badge do. The server names the kind only when the start is
    /// the one thing counted, so a row with a blocked tool call or a question beside it stays in.
    static func countsOnlyAStart(_ s: Session) -> Bool {
        s.waitingKind == .startRequest
    }
}
