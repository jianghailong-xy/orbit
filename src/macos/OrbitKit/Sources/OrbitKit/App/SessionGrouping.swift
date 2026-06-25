import Foundation

/// The Active view's three ordered buckets (mirrors the web grouping): sessions that need a
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
    /// Bucket sessions for the Active sidebar, preserving input order within each bucket.
    /// `needsYou` = has pending approvals; `running` = otherwise live (running / awaiting /
    /// interrupted); `queued` = PENDING. Terminal/dormant sessions are excluded from Active.
    public static func group(_ sessions: [Session]) -> SessionGroups {
        var needsYou: [Session] = []
        var running: [Session] = []
        var queued: [Session] = []
        for s in sessions {
            if (s.pendingApprovals ?? 0) > 0 {
                needsYou.append(s)
            } else if s.status.isLive {
                running.append(s)
            } else if s.status == .pending {
                queued.append(s)
            }
        }
        return SessionGroups(needsYou: needsYou, running: running, queued: queued)
    }
}
