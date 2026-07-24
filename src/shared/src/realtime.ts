import { RunStatus, SessionEndReason } from './enums';

/**
 * The user-scoped control-plane stream's wire protocol (`GET /api/events`).
 *
 * One always-on, per-user SSE connection multiplexes coarse lifecycle / status / approval /
 * background events across ALL of the user's sessions, so clients drive their lists, badges and
 * notifications from push instead of per-list polling. Transcript bodies (text/thinking deltas,
 * tool calls, ...) never ride this stream — the focused console keeps its own per-session
 * `GET /sessions/:id/events` data-plane stream. There is no `sinceSeq` replay here: on (re)connect
 * a client rebuilds its derived state from one REST list snapshot, then follows.
 * See docs/realtime-control-plane-stream.md.
 */

/** Control-plane event types — their own namespace, never mixed with `RunEventType`. */
export enum ControlEventType {
  /** A session entered the user's active list (created, or restored from archive/trash). */
  SESSION_CREATED = 'session.created',
  /** status / title / lastTurnAt / pendingApprovals changed — `data` is a full
   *  `ControlSessionSummary` the client upserts wholesale (decision Q2: no field deltas). */
  SESSION_UPDATED = 'session.updated',
  /** The session left the active list (archived → completed, or soft-deleted). */
  SESSION_ENDED = 'session.ended',
  /** A run error — its own event (decision Q3) so mid-turn recoverable errors, which status
   *  transitions can't express, still reach the client exactly once. */
  SESSION_ERROR = 'session.error',
  APPROVAL_REQUESTED = 'approval.requested',
  APPROVAL_RESOLVED = 'approval.resolved',
  /** A background shell the agent launched finished (completed/failed/killed). */
  BACKGROUND_TASK = 'background.task',
  /** A task (work item) the owner can see was created or updated — usually via an agent's MCP
   *  task_create/task_update. `data` is a `ControlTaskChanged`; it's only a nudge to refetch the
   *  task list/board. `sessionId` names the task's creator session (its scope on this stream). */
  TASK_CHANGED = 'task.changed',
  /** Reserved generic notification channel — future pushes ride this without a protocol bump. */
  NOTIFICATION = 'notification',
}

/** The envelope every control-plane event ships in. One connection carries many sessions, so
 *  each event names its scope; `agentId` lets per-agent lists filter client-side. */
export interface ControlEvent {
  type: ControlEventType;
  sessionId: string;
  agentId: string | null;
  /** ISO-8601. */
  ts: string;
  /** Typed per `type` — see the payload interfaces below. */
  data: Record<string, unknown>;
}

/** `data` for `session.created` / `session.updated`: the slim list-row summary, field-aligned
 *  with the `GET /sessions` list response so the client can upsert it verbatim. */
export interface ControlSessionSummary {
  id: string;
  title: string | null;
  status: RunStatus;
  agentId: string | null;
  agent: { id: string; name: string | null; model: string | null } | null;
  pendingApprovals: number;
  lastTurnAt: string | null;
}

/** `data` for `session.ended`. */
export interface ControlSessionEnded {
  status: RunStatus;
  endReason: SessionEndReason;
}

/** `data` for `session.error`. `recoverable=true` marks a mid-turn (non-fatal) error — e.g. a
 *  content filter — where the session may still sit AWAITING_INPUT; `false` usually accompanies
 *  a status→FAILED `session.updated` (clients must not notify twice — see the design doc §5.2). */
export interface ControlSessionError {
  message: string;
  recoverable: boolean;
}

/** `data` for `approval.requested` / `approval.resolved`. The count drives badges; approval
 *  detail still comes from the approvals REST endpoint. */
export interface ControlApproval {
  approvalId: string;
  pendingApprovals: number;
}

/** `data` for `background.task`. */
export interface ControlBackgroundTask {
  name: string;
  status: string;
  exitCode?: number;
}

/** `data` for `task.changed`. The client just refetches its task queries; the id is carried for
 *  future fine-grained cache updates and logging. */
export interface ControlTaskChanged {
  taskId: string;
}
