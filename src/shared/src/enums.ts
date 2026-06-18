// Enum values are kept in sync (by string) with the Prisma schema enums in
// src/apiserver/prisma/schema.prisma. Changing a value here means updating both.

/** Lifecycle of an interactive session (and its run on a runner). */
export enum RunStatus {
  PENDING = 'PENDING',
  RUNNING = 'RUNNING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  /** Interactive session is alive and waiting for the next user turn (Route B). */
  AWAITING_INPUT = 'AWAITING_INPUT',
  /** A turn was interrupted by the user; the session stays alive (Route B). */
  INTERRUPTED = 'INTERRUPTED',
}

/** Health of a registered runner machine. */
export enum RunnerStatus {
  ONLINE = 'ONLINE',
  OFFLINE = 'OFFLINE',
  DRAINING = 'DRAINING',
}

/**
 * Claude Code permission modes. Values map 1:1 to the Agent SDK `permissionMode`
 * option / the `--permission-mode` CLI flag.
 */
export enum PermissionMode {
  DEFAULT = 'default',
  ACCEPT_EDITS = 'acceptEdits',
  PLAN = 'plan',
  DONT_ASK = 'dontAsk',
  BYPASS = 'bypassPermissions',
}

/** Normalized run-event types streamed from runner → control plane → UI. */
export enum RunEventType {
  SYSTEM = 'system',
  ASSISTANT = 'assistant',
  TEXT_DELTA = 'text_delta',
  /** Extended-thinking block (durable) + its streaming increment (animation only). */
  THINKING = 'thinking',
  THINKING_DELTA = 'thinking_delta',
  TOOL_USE = 'tool_use',
  TOOL_RESULT = 'tool_result',
  STATUS = 'status',
  ERROR = 'error',
  RESULT = 'result',
  /** Interactive sessions (Route B). */
  USER = 'user', // a user turn entered the transcript
  TURN_END = 'turn_end', // one turn finished; session parks for the next input
  INTERRUPT = 'interrupt', // a turn was interrupted by the user
  // Tool-permission approvals (live-only SSE nudges; the durable record is the
  // Approval row, not a RunEvent — so they never collide with the runner's seq).
  APPROVAL_REQUEST = 'approval_request', // a tool call is awaiting a human allow/deny
  APPROVAL_RESOLVED = 'approval_resolved', // a pending approval was decided
}

/** Lifecycle of a human-facing work item (Task). */
export enum TaskStatus {
  OPEN = 'OPEN',
  IN_PROGRESS = 'IN_PROGRESS',
  DONE = 'DONE',
  CANCELLED = 'CANCELLED',
}

/** Who/what authored a Task (polymorphic creator). */
export enum CreatorType {
  USER = 'USER',
  AGENT = 'AGENT',
}
