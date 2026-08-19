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

    /// The run is over: nothing more can be delivered to it without a resume. Not the inverse of
    /// `isLive` — `pending` is neither (the session is queued, waiting for a runner).
    public var isTerminal: Bool {
        switch self {
        case .succeeded, .failed, .cancelled: return true
        default: return false
        }
    }
}

/// Product-facing execution state. Unlike ``SessionState``, this dimension says only what the
/// run is doing or how it ended; moving a session between Open, Completed and Trash never changes
/// it. New control planes send this as `runState`; older ones use raw ``RunStatus`` plus end reason,
/// with ``SessionState`` used only by slim payloads that omit raw status entirely.
/// There is exactly one neutral terminal state. The earlier cancelled/dormant/ended trio was a
/// permutation of (status, endReason) that no behaviour distinguished — resume eligibility never
/// consults endReason — so three glyphs implied a difference the server did not have. Which
/// deliberate act ended a run is not a run outcome: a session the user filed is already identified
/// by ``SessionLifecycleState/completed``, and the rest belongs in prose.
public enum SessionRunState: String, Codable, Sendable {
    case queued = "QUEUED"
    case running = "RUNNING"
    case awaitingInput = "AWAITING_INPUT"
    /// A turn was interrupted; the session itself is alive and schedulable. Not terminal.
    case interrupted = "INTERRUPTED"
    case succeeded = "SUCCEEDED"
    case failed = "FAILED"
    /// The single neutral terminal state: the run stopped without a success/failure verdict.
    case ended = "ENDED"
    /// Forward compatibility: an unknown future value falls through to the legacy fields.
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SessionRunState(rawValue: raw) ?? .unknown
    }

    /// Whether work is currently in flight or waiting inside a live runner process.
    public var isLive: Bool {
        switch self {
        case .queued, .running, .awaitingInput, .interrupted: return true
        default: return false
        }
    }

    /// Resolve the new field first, then raw runner status + end reason. The legacy mixed
    /// `sessionState` is intentionally not allowed to override a raw state: an old completed row
    /// commonly says `sessionState=COMPLETED` while its actual run status is CANCELLED.
    public static func resolve(_ runState: SessionRunState?,
                               legacy _: SessionState?,
                               status: RunStatus,
                               endReason: String? = nil) -> SessionRunState {
        if let runState, runState != .unknown { return runState }
        switch status {
        case .pending:       return .queued
        case .running:       return .running
        case .awaitingInput: return .awaitingInput
        case .succeeded:     return .succeeded
        case .failed:        return .failed
        case .interrupted:
            // A bare INTERRUPTED means a turn was stopped, not the session; it stays live.
            // Any recorded reason means the session itself was ended.
            return (endReason ?? "").isEmpty ? .interrupted : .ended
        case .cancelled:
            // Every deliberate end — filed, ended, stopped, deleted, task-driven — plus the
            // retired PARKED-era 'idle'/'orphaned' reasons settle here. None of them differ in
            // what the user can do next.
            return .ended
        }
    }

    /// Optional-status variant for deliberately slim detail payloads. Only when both new and raw
    /// execution fields are absent may the old mixed state stand in for an execution state.
    public static func resolveOptional(_ runState: SessionRunState?,
                                       legacy sessionState: SessionState?,
                                       status: RunStatus?,
                                       endReason: String? = nil) -> SessionRunState? {
        if let runState, runState != .unknown { return runState }
        if let status {
            return resolve(nil, legacy: nil, status: status, endReason: endReason)
        }
        guard let sessionState else { return nil }
        switch sessionState {
        case .queued:        return .queued
        case .running:       return .running
        case .awaitingInput: return .awaitingInput
        case .completed:     return .succeeded
        case .failed:        return .failed
        case .interrupted:   return .interrupted
        // The legacy vocabulary still splits the neutral terminals; the run states no longer do.
        case .dormant, .cancelled, .ended: return .ended
        case .deleted, .unknown: return nil
        }
    }
}

/// The session's lifecycle membership. This dimension is independent from ``SessionRunState``: a failed
/// run may be Completed and a succeeded run may remain Open.
public enum SessionLifecycleState: String, Codable, Sendable {
    case open = "OPEN"
    case completed = "COMPLETED"
    case trash = "TRASH"
    /// Forward compatibility: callers should use their endpoint/scope fallback for this value.
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        // `ARCHIVED` is the pre-Completed transport spelling. Keep accepting it throughout the
        // rolling migration, but normalize immediately so no archive semantics escape decoding.
        self = raw == "ARCHIVED" ? .completed : (SessionLifecycleState(rawValue: raw) ?? .unknown)
    }
}

/// Legacy mixed lifecycle/filing state. Kept only as a compatibility fallback while old control
/// planes are still in use; new presentation reads ``SessionRunState`` and ``SessionLifecycleState``.
public enum SessionState: String, Codable, Sendable, CaseIterable {
    case queued = "QUEUED"
    case running = "RUNNING"
    case awaitingInput = "AWAITING_INPUT"
    case dormant = "DORMANT"
    case completed = "COMPLETED"
    case failed = "FAILED"
    case cancelled = "CANCELLED"
    case interrupted = "INTERRUPTED"
    case ended = "ENDED"
    case deleted = "DELETED"
    /// Forward-compatibility floor. Presentation treats it exactly like a missing state and falls
    /// back to the low-level run status rather than failing the containing payload.
    case unknown = "UNKNOWN"

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = SessionState(rawValue: raw) ?? .unknown
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
    /// A queued turn was added or withdrawn on another client. Live-only nudge; the focused
    /// console re-fetches GET /sessions/:id/turns, the durable source of truth.
    case queuedTurnsChanged = "queued_turns_changed"
    case backgroundTask = "background_task"
    case backgroundOutput = "background_output"
    /// The server refusing to replay this connection's gap: the cursor is further behind than
    /// `SSE_GAP_CAP` (1000 renderable events), so instead of history it sends this one order —
    /// throw the loaded window away and re-seed from a tail page. Rides seq 0 like the other
    /// live-only control events. Handled in `ConsoleModel.run()`; web parity (`reseed`).
    case resync
    case unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = RunEventType(rawValue: raw) ?? .unknown
    }

    /// Durable events carry a real per-session `seq`: they are persisted, replayed on
    /// reconnect, and deduped by seq. The animation/live-only types below never are —
    /// deltas are broadcast-only, and approvals/background-output/resync ride seq 0.
    public var isDurable: Bool {
        switch self {
        case .textDelta, .thinkingDelta, .approvalRequest, .approvalResolved, .queuedTurnsChanged,
             .backgroundOutput, .resync:
            return false
        default:
            return true
        }
    }
}
