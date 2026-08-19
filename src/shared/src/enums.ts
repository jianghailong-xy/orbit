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

/**
 * Why a session reached a terminal state. Orthogonal to RunStatus, which collapses
 * every graceful end into CANCELLED — so "the task finished" and "the user cancelled"
 * look identical without this. Set by whoever requests the end (endLive / the reaper).
 * null = a natural agent finish (read RunStatus) or a pre-migration row. The column is
 * a plain string, not a Prisma enum; the web reads the same values as string literals.
 *
 * Every value here is written by a deliberate user or task-lifecycle decision. Runtime
 * recycling is NOT one of them: the runner keeps its engines warm/cold on its own and
 * the control-plane status stays AWAITING_INPUT throughout (see runner-go/session_pool.go),
 * so no reason is ever recorded for it. The retired 'idle'/'orphaned' values date from the
 * PARKED era and have no writer left; {@link LEGACY_END_REASONS} keeps them decodable.
 */
export enum SessionEndReason {
  TASK_DONE = 'task_done', // task finished successfully; execution Session moves to Completed
  TASK_CANCELLED = 'task_cancelled', // reaper recycled it because its task was cancelled
  ENDED = 'ended', // user ended the session — resumable
  COMPLETED = 'completed', // user moved it to Completed
  DELETED = 'deleted', // user deleted it (trash)
  CANCELLED = 'cancelled', // user stopped the run (batch-stop)
}

/**
 * End reasons no code writes any more, retained only so stored rows stay readable.
 * Both settle into the same neutral terminal state as every other graceful end, so
 * they need no branch of their own — this exists to document the values, not to
 * decode them.
 */
export const LEGACY_END_REASONS = ['idle', 'orphaned'] as const;

/**
 * Legacy combined lifecycle state. Retained for wire compatibility; new consumers
 * should use {@link SessionRunState} and {@link SessionLifecycleState} instead.
 */
export enum SessionState {
  QUEUED = 'QUEUED',
  RUNNING = 'RUNNING',
  AWAITING_INPUT = 'AWAITING_INPUT',
  DORMANT = 'DORMANT',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  INTERRUPTED = 'INTERRUPTED',
  ENDED = 'ENDED',
  DELETED = 'DELETED',
}

/**
 * User-facing execution state. Unlike the legacy {@link SessionState}, this describes
 * only what happened to the run and never changes when the session is completed,
 * restored, or moved to Trash.
 *
 * There is exactly ONE neutral terminal state. The earlier CANCELLED/DORMANT/ENDED trio
 * was a permutation of (RunStatus, endReason) that no behaviour distinguished: resume
 * eligibility is decided by deriveSessionCapabilities, which never reads endReason, so
 * three glyphs and three tooltips implied a difference the server did not have. Which
 * deliberate act ended the run is not a run outcome — a session the user filed is already
 * identified by {@link SessionLifecycleState}.COMPLETED, and the rest belongs in prose,
 * not in a status vocabulary.
 */
export enum SessionRunState {
  QUEUED = 'QUEUED',
  RUNNING = 'RUNNING',
  AWAITING_INPUT = 'AWAITING_INPUT',
  /** A turn was interrupted; the session itself is alive and schedulable. Not terminal. */
  INTERRUPTED = 'INTERRUPTED',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
  /** The single neutral terminal state: the run stopped without a success/failure verdict. */
  ENDED = 'ENDED',
}

/**
 * Where a session lives in the product lifecycle. Orthogonal to
 * {@link SessionRunState}: a successful run can still be Open, and a failed run can
 * be moved to Completed.
 */
export enum SessionLifecycleState {
  OPEN = 'OPEN',
  COMPLETED = 'COMPLETED',
  TRASH = 'TRASH',
}

/**
 * @deprecated Wire compatibility for clients deployed before Completed became the
 * canonical lifecycle term. New code must use {@link SessionLifecycleState}.
 */
export enum SessionFilingState {
  OPEN = 'OPEN',
  ARCHIVED = 'ARCHIVED',
  TRASH = 'TRASH',
}

type SessionStateSource = {
  endReason?: SessionEndReason | string | null;
  completedAt?: Date | string | null;
  /** @deprecated Read compatibility for pre-Completed rows and clients. */
  archivedAt?: Date | string | null;
  deletedAt?: Date | string | null;
};

const completionTimestamp = (input: SessionStateSource): Date | string | null | undefined =>
  input.completedAt ?? input.archivedAt;

/** Input accepted by {@link deriveSessionState}. New code can pass `runStatus`; the
 * legacy/raw `status` spelling remains accepted for existing Prisma/API objects. */
export type SessionStateInput = SessionStateSource &
  (
    | { runStatus: RunStatus | string; status?: RunStatus | string | null }
    | { status: RunStatus | string; runStatus?: RunStatus | string | null }
  );

/** Derive execution state without consulting lifecycle timestamps. */
export function deriveSessionRunState(input: SessionStateInput): SessionRunState {
  const rawStatus = String(input.runStatus ?? input.status ?? '').toUpperCase();
  const reason = String(input.endReason ?? '').toLowerCase();

  switch (rawStatus) {
    case RunStatus.PENDING:
      return SessionRunState.QUEUED;
    case RunStatus.RUNNING:
      return SessionRunState.RUNNING;
    case RunStatus.AWAITING_INPUT:
      return SessionRunState.AWAITING_INPUT;
    case RunStatus.SUCCEEDED:
      return SessionRunState.SUCCEEDED;
    case RunStatus.FAILED:
      return SessionRunState.FAILED;
    case RunStatus.CANCELLED:
    case RunStatus.INTERRUPTED:
      // A bare INTERRUPTED means the user stopped a turn, not the session: it stays live
      // and schedulable. Any recorded endReason means the session itself was ended.
      if (rawStatus === RunStatus.INTERRUPTED && reason === '') {
        return SessionRunState.INTERRUPTED;
      }
      // Every deliberate end — filed, ended, stopped, deleted, task-driven — plus legacy
      // and unknown reasons settle here. None of them differ in what the user can do next.
      return SessionRunState.ENDED;
    default:
      return SessionRunState.ENDED;
  }
}

/** Derive canonical lifecycle membership without consulting run status or end reason. */
export function deriveSessionLifecycleState(input: SessionStateSource): SessionLifecycleState {
  if (input.deletedAt != null) return SessionLifecycleState.TRASH;
  if (completionTimestamp(input) != null) return SessionLifecycleState.COMPLETED;
  return SessionLifecycleState.OPEN;
}

/**
 * @deprecated Derive the legacy filing-state representation for old wire consumers.
 * New code should call {@link deriveSessionLifecycleState}.
 */
export function deriveSessionFilingState(input: SessionStateSource): SessionFilingState {
  switch (deriveSessionLifecycleState(input)) {
    case SessionLifecycleState.COMPLETED:
      return SessionFilingState.ARCHIVED;
    case SessionLifecycleState.TRASH:
      return SessionFilingState.TRASH;
    default:
      return SessionFilingState.OPEN;
  }
}

/**
 * Derive the stable, user-facing state without changing the stored runner status.
 * Filing state wins first, except that a real FAILED outcome remains visible after
 * archiving. CANCELLED is intentionally fail-to-dormant for missing/unknown legacy
 * reasons; a bare INTERRUPTED remains explicitly interrupted.
 */
export function deriveSessionState(input: SessionStateInput): SessionState {
  const rawStatus = String(input.runStatus ?? input.status ?? '').toUpperCase();
  const reason = String(input.endReason ?? '').toLowerCase();

  if (input.deletedAt != null) return SessionState.DELETED;
  if (completionTimestamp(input) != null && rawStatus !== RunStatus.FAILED) {
    return SessionState.COMPLETED;
  }

  switch (rawStatus) {
    case RunStatus.RUNNING:
      return SessionState.RUNNING;
    case RunStatus.AWAITING_INPUT:
      return SessionState.AWAITING_INPUT;
    case RunStatus.SUCCEEDED:
      return SessionState.COMPLETED;
    case RunStatus.FAILED:
      return SessionState.FAILED;
    case RunStatus.PENDING:
      return SessionState.QUEUED;
    case RunStatus.CANCELLED:
    case RunStatus.INTERRUPTED:
      // Frozen legacy mapping: old clients still decode this vocabulary, so it keeps the
      // CANCELLED/DORMANT split (and the retired 'orphaned' reason, spelled literally
      // because SessionEndReason no longer carries it) that SessionRunState has dropped.
      if (reason === 'orphaned') return SessionState.ENDED;
      if (
        reason === SessionEndReason.COMPLETED ||
        reason === SessionEndReason.DELETED ||
        reason === SessionEndReason.CANCELLED ||
        reason === SessionEndReason.TASK_CANCELLED
      ) {
        return SessionState.CANCELLED;
      }
      if (rawStatus === RunStatus.INTERRUPTED && reason === '') return SessionState.INTERRUPTED;
      return SessionState.DORMANT;
    default:
      // Unknown future/legacy raw values must not look live or queued.
      return SessionState.ENDED;
  }
}

/**
 * Terminal RunStatus for a session whose end was a *graceful* recycle, or null when it
 * wasn't one (a hard complete/delete/batch-stop, or no reason recorded). TASK_DONE settles
 * SUCCEEDED; TASK_CANCELLED/ENDED settle CANCELLED. Returning an explicit status is
 * load-bearing for the reaper: its forceFinalize defaults to FAILED, so null would
 * resurface an unacknowledged graceful recycle as a run failure. Shared so the runner's
 * /finalize and the reaper's backstop cannot drift apart.
 */
export function gracefulEndStatus(endReason: string | null | undefined): RunStatus | null {
  switch (endReason) {
    case SessionEndReason.TASK_DONE:
      return RunStatus.SUCCEEDED;
    case SessionEndReason.TASK_CANCELLED:
    case SessionEndReason.ENDED:
      return RunStatus.CANCELLED;
    default:
      return null;
  }
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
  // A queued turn was added or withdrawn on another client. Live-only nudge: the durable source
  // of truth is GET /sessions/:id/turns, which focused clients re-fetch on receipt. Keeping the
  // payload empty avoids maintaining a second queued-turn wire shape on the event stream.
  QUEUED_TURNS_CHANGED = 'queued_turns_changed',
  // "Your cursor is too far behind to catch up in place — drop your cached window and re-seed
  // from a tail page." Synthesized by the SSE endpoint alone (never persisted, never published
  // to the hub) when a resuming client's gap exceeds SSE_GAP_CAP. Like the approval nudges it
  // rides seq 0, so a client must handle it before its seq dedup. A client that doesn't know it
  // falls through its reducer's default and simply keeps the transcript it has.
  RESYNC = 'resync',
  // Background shells the agent launched with Bash(run_in_background). The runner derives
  // these from Claude's stream: BACKGROUND_TASK is the durable lifecycle signal (parsed
  // from the `<task-notification>` user message — status completed/failed/killed); it's the
  // reliable "this background process finished" event. BACKGROUND_OUTPUT is the live tail of
  // the process's output file (broadcast-only animation, like *_DELTA — not persisted).
  BACKGROUND_TASK = 'background_task',
  BACKGROUND_OUTPUT = 'background_output',
  // Control-plane-internal lifecycle signals (a session entered / left the Open list).
  // They ride the same realtime hub as run events — buying the cross-replica NOTIFY bridge for
  // free — but are NEVER persisted to run_events (the `type` column is a plain String, so no
  // migration) and NEVER enter a per-session transcript stream (streamForRun filters them via
  // isLifecycleType). streamForUser maps them to ControlEventType.SESSION_CREATED / SESSION_ENDED.
  SESSION_CREATED = 'session_created',
  SESSION_ENDED = 'session_ended',
  // A task (work item) the owner can see was created or updated — almost always via an agent's
  // MCP task_create/task_update. Like the session_* signals above it rides the realtime hub for
  // the free cross-replica NOTIFY bridge, is NEVER persisted, and NEVER enters a per-session
  // transcript stream (isLifecycleType). streamForUser maps it to ControlEventType.TASK_CHANGED
  // so the owner's task list/board refreshes live instead of waiting for its poll.
  TASK_CHANGED = 'task_changed',
  // An agent the owner can see was created or updated via an orchestrator's MCP
  // agent_create/agent_update. Same deal as TASK_CHANGED: rides the hub for the NOTIFY bridge,
  // never persisted, never in a transcript stream; streamForUser maps it to
  // ControlEventType.AGENT_CHANGED so the owner's agent list refreshes without a manual reload.
  AGENT_CHANGED = 'agent_changed',
  // A session's list-visible fields changed outside a turn — today only a rename, which no
  // STATUS/TURN_END accompanies. Maps to ControlEventType.SESSION_UPDATED, so the client gets the
  // same full summary it upserts for a status change.
  SESSION_UPDATED = 'session_updated',
  // Owner-level libraries: task lists, session tags, model providers. These have no session to
  // hang off, so they're published USER-SCOPED (RealtimeService.publishForUser) — same hub, same
  // NOTIFY bridge, but routed by owner id instead of by session.
  TASK_LIST_CHANGED = 'task_list_changed',
  TAG_CHANGED = 'tag_changed',
  PROVIDER_CHANGED = 'provider_changed',
}

/** Control-plane-internal lifecycle signals (see RunEventType): published through the realtime
 *  hub but filtered OUT of every per-session transcript stream and never persisted. */
export function isLifecycleType(t: RunEventType): boolean {
  return (
    t === RunEventType.SESSION_CREATED ||
    t === RunEventType.SESSION_ENDED ||
    t === RunEventType.SESSION_UPDATED ||
    t === RunEventType.TASK_CHANGED ||
    t === RunEventType.AGENT_CHANGED ||
    t === RunEventType.TASK_LIST_CHANGED ||
    t === RunEventType.TAG_CHANGED ||
    t === RunEventType.PROVIDER_CHANGED
  );
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
  KIMI = 'kimi',
  OPENCODE = 'opencode',
}
