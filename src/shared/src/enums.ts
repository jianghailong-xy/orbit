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
  /**
   * Terminal but resumable: the session's claude process was gracefully torn down — the
   * runner recycled it (idle / its task finished) or the user ended it — yet sending a
   * message revives it (--resume keeps full context). Split out of CANCELLED so the UI
   * reads it as dormant, not cancelled; `endReason` records which graceful end it was.
   * Appended last to match ALTER TYPE ADD VALUE.
   */
  PARKED = 'PARKED',
}

/**
 * Why a session reached a terminal state. Orthogonal to RunStatus, which collapses
 * every graceful end into CANCELLED — so "the runner recycled an idle session" and
 * "the user cancelled" look identical without this. Set by whoever requests the end
 * (endLive / the reaper). null = a natural agent finish (read RunStatus) or a
 * pre-migration row. The column is a plain string, not a Prisma enum; the web reads
 * the same values as string literals.
 */
export enum SessionEndReason {
  IDLE = 'idle', // reaper recycled it after inactivity — resumable
  TASK_DONE = 'task_done', // reaper recycled it because its task finished — resumable
  ENDED = 'ended', // user ended the session — resumable
  COMPLETED = 'completed', // user marked it complete (archived)
  DELETED = 'deleted', // user deleted it (trash)
  ORPHANED = 'orphaned', // never-claimed run for an already-finished task
  CANCELLED = 'cancelled', // user stopped the run (batch-stop) — settles CANCELLED, not PARKED
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
  AUTO = 'auto',
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
  // Background shells the agent launched with Bash(run_in_background). The runner derives
  // these from Claude's stream: BACKGROUND_TASK is the durable lifecycle signal (parsed
  // from the `<task-notification>` user message — status completed/failed/killed); it's the
  // reliable "this background process finished" event. BACKGROUND_OUTPUT is the live tail of
  // the process's output file (broadcast-only animation, like *_DELTA — not persisted).
  BACKGROUND_TASK = 'background_task',
  BACKGROUND_OUTPUT = 'background_output',
  // Control-plane-internal lifecycle signals (a session was created / left the active list).
  // They ride the same realtime hub as run events — buying the cross-replica NOTIFY bridge for
  // free — but are NEVER persisted to run_events (the `type` column is a plain String, so no
  // migration) and NEVER enter a per-session transcript stream (streamForRun filters them via
  // isLifecycleType). streamForUser maps them to ControlEventType.SESSION_CREATED / SESSION_ENDED.
  SESSION_CREATED = 'session_created',
  SESSION_ENDED = 'session_ended',
}

/** Control-plane-internal lifecycle signals (see RunEventType): published through the realtime
 *  hub but filtered OUT of every per-session transcript stream and never persisted. */
export function isLifecycleType(t: RunEventType): boolean {
  return t === RunEventType.SESSION_CREATED || t === RunEventType.SESSION_ENDED;
}

/** Lifecycle of a human-facing work item (Task). */
export enum TaskStatus {
  OPEN = 'OPEN',
  IN_PROGRESS = 'IN_PROGRESS',
  DONE = 'DONE',
  CANCELLED = 'CANCELLED',
  /** A run ended in a genuine failure (e.g. an API/content-filter error the agent
   *  couldn't recover from) and the work needs a human — distinct from OPEN, which the
   *  reclaim backstop uses for retryable infra hiccups / user cancels. */
  FAILED = 'FAILED',
}

/** Who/what authored a Task (polymorphic creator). */
export enum CreatorType {
  USER = 'USER',
  AGENT = 'AGENT',
}

/** Local coding runtime used by an Orbit agent/session. */
export enum AgentProvider {
  CLAUDE = 'claude',
  CODEX = 'codex',
}
