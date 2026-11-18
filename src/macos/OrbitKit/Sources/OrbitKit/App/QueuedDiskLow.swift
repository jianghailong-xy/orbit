import Foundation

/// A new session held by Keep Free (queuedReason `disk_below_floor`): its workspace's disk has less
/// free than its runner's floor, so the server does not start it until the runner reports space above
/// it. Said where a full runner is (`QueuedCapacity`): the list's and header's word, and the foot-row
/// tag `Queued · low disk space` opening to why. Every word is web `runnerSlots.ts`'s
/// (`DISK_LOW_TITLE`, `DISK_LOW_WAIT`).
public enum QueuedDiskLow {
    public static let reason = "disk_below_floor"
    public static let title = "Low disk space"
    public static let tag = "low disk space"
    public static let wait = "This runner has less free disk space than its Keep Free setting. This session starts once space is freed."

    /// Whether Keep Free holds this session: queued, and the server named that gate.
    public static func holds(_ s: Session) -> Bool {
        s.effectiveRunState == .queued && s.queuedReason == reason
    }
}
