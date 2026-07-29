import Foundation

// String values are kept 1:1 with src/shared/src/enums.ts (which is itself kept in sync
// by string with the Prisma schema). Changing a value means updating all three.

/// Lifecycle of an interactive session (and its run on a runner).
public enum RunStatus: String, Codable, Sendable {
    case pending = "PENDING"
    case running = "RUNNING"
    case succeeded = "SUCCEEDED"
    case failed = "FAILED"
    case cancelled = "CANCELLED"
    /// Process alive, parked waiting for the next user turn.
    case awaitingInput = "AWAITING_INPUT"
    /// A turn was interrupted by the user; the session stays alive.
    case interrupted = "INTERRUPTED"

    /// Statuses where the session is live / resumable (composer should allow sending).
    public var isLive: Bool {
        switch self {
        case .running, .awaitingInput, .interrupted: return true
        default: return false
        }
    }
}

/// Health of a registered runner machine.
public enum RunnerStatus: String, Codable, Sendable {
    case online = "ONLINE"
    case offline = "OFFLINE"
    case draining = "DRAINING"
}

/// Claude Code permission modes (map 1:1 to `--permission-mode`).
public enum PermissionMode: String, Codable, Sendable, CaseIterable {
    case `default` = "default"
    case acceptEdits = "acceptEdits"
    case plan = "plan"
    case auto = "auto"
    case dontAsk = "dontAsk"
    case bypass = "bypassPermissions"
}

/// Lifecycle of a human-facing work item (Task).
public enum TaskStatus: String, Codable, Sendable {
    case open = "OPEN"
    case inProgress = "IN_PROGRESS"
    case done = "DONE"
    case cancelled = "CANCELLED"
    case failed = "FAILED"
}

/// Normalized run-event types streamed runner → control plane → client.
///
/// Decodes unknown strings to `.unknown` so a newer server event never breaks the stream.
public enum RunEventType: String, Codable, Sendable {
    case system
    case assistant
    case textDelta = "text_delta"
    case thinking
    case thinkingDelta = "thinking_delta"
    case toolUse = "tool_use"
    case toolResult = "tool_result"
    case status
    case error
    case result
    case user
    case turnEnd = "turn_end"
    case interrupt
    case approvalRequest = "approval_request"
    case approvalResolved = "approval_resolved"
    case backgroundTask = "background_task"
    case backgroundOutput = "background_output"
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = RunEventType(rawValue: raw) ?? .unknown
    }

    /// Durable events carry a real per-session `seq`: they are persisted, replayed on
    /// reconnect, and deduped by seq. The animation/live-only types below never are —
    /// deltas are broadcast-only, and approvals/background-output ride seq 0.
    public var isDurable: Bool {
        switch self {
        case .textDelta, .thinkingDelta, .approvalRequest, .approvalResolved, .backgroundOutput:
            return false
        default:
            return true
        }
    }
}
