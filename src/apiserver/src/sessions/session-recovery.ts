import { BadRequestException, ConflictException, ForbiddenException, HttpException, HttpStatus } from '@nestjs/common';
import type { SessionResumeBlockedReason } from '@orbit/shared';

/**
 * Session lifecycle and spawn backpressure refusals, as stable codes with a recovery block
 * (docs/recovery-contract.md §2, §11).
 *
 * Every refusal here keeps its status and its message exactly as before, and adds the fields a
 * client branches on: `code`, the legacy `owner` and `requiredAction`, `retryable`,
 * `retryAfterSeconds` where there is a wait, and the `recovery` block the contract parsers read
 * first. The action codes say which of these the caller is looking at — never a tool name:
 *
 *   WAIT_FOR_SESSIONS   wait for the named sessions to settle, then ask once more (backpressure)
 *   POLL_STATE          the state ends by itself: read it again after afterSeconds
 *   RETURN_TO_PARENT    start nothing further down; do the work here or hand it back up
 *   CREATE_REPLACEMENT  this session can never take it: start a new one instead
 *   AWAIT_USER_FIX      a person has to change something the caller may not (Trash, sign-in, a setting)
 *   AWAIT_SYSTEM_FIX    the platform recovers by itself (a runner coming back)
 *   STOP_LOOP           repeating without progress: stop
 *   RETRY / FIX_REQUEST the contract's own: resend as is, or change the request
 *
 * None of the backpressure codes is `retryable` or carries an automatic-retry action, so no
 * client resends one on a timer; the depth limit says RETURN_TO_PARENT under policy NEVER, so the
 * same spawn is never offered again; and the Trash and permission boundaries name a person
 * (actor USER, AWAIT_USER_FIX), which a client renders as "ask the user", never as a call to make.
 */

export type SessionRecoveryCode =
  | 'ORCHESTRATION_DISABLED'
  | 'CALLER_SESSION_NOT_LIVE'
  | 'SPAWN_DEPTH_LIMIT'
  | 'SPAWN_TREE_OUTSTANDING_LIMIT'
  | 'SPAWN_TREE_RATE_LIMIT'
  | 'WORKSPACE_NAME_AMBIGUOUS'
  | 'WORKSPACE_NAME_NOT_FOUND'
  | 'ENGINE_SIGNED_OUT'
  | 'MANAGED_RUNNER_FAILED'
  | 'RUNNER_DISK_BELOW_FLOOR'
  | `SESSION_${SessionResumeBlockedReason}`
  | 'SESSION_ENDED'
  | 'SESSION_NEXT_TURN_STARTING';

type Actor = 'CALLER' | 'USER' | 'SYSTEM';
type Policy = 'SAFE' | 'AFTER_STATE_CHANGE' | 'NEVER';
/** The contract's disposition (docs/recovery-contract.md §3.2): what the agent does with the answer. */
type Disposition = 'AUTOMATIC' | 'WAIT' | 'HUMAN' | 'STOP';

interface Rule {
  status: HttpStatus;
  actor: Actor;
  retryPolicy: Policy;
  actionCode: string;
  disposition: Disposition;
  /** A wait the code always carries, in whole seconds; a refusal may state its own instead. */
  retryAfterSeconds?: number;
}

/** The one table: what each code means for whoever reads it. Pinned by session-recovery.spec.ts. */
export const SESSION_RECOVERY_RULES: Record<SessionRecoveryCode, Rule> = {
  ORCHESTRATION_DISABLED: { status: HttpStatus.FORBIDDEN, actor: 'USER', retryPolicy: 'AFTER_STATE_CHANGE', actionCode: 'AWAIT_USER_FIX', disposition: 'HUMAN' },
  CALLER_SESSION_NOT_LIVE: { status: HttpStatus.FORBIDDEN, actor: 'CALLER', retryPolicy: 'NEVER', actionCode: 'STOP_LOOP', disposition: 'STOP' },
  SPAWN_DEPTH_LIMIT: { status: HttpStatus.FORBIDDEN, actor: 'CALLER', retryPolicy: 'NEVER', actionCode: 'RETURN_TO_PARENT', disposition: 'STOP' },
  SPAWN_TREE_OUTSTANDING_LIMIT: { status: HttpStatus.TOO_MANY_REQUESTS, actor: 'CALLER', retryPolicy: 'AFTER_STATE_CHANGE', actionCode: 'WAIT_FOR_SESSIONS', disposition: 'WAIT' },
  SPAWN_TREE_RATE_LIMIT: { status: HttpStatus.TOO_MANY_REQUESTS, actor: 'CALLER', retryPolicy: 'AFTER_STATE_CHANGE', actionCode: 'STOP_LOOP', disposition: 'STOP' },
  WORKSPACE_NAME_AMBIGUOUS: { status: HttpStatus.BAD_REQUEST, actor: 'CALLER', retryPolicy: 'NEVER', actionCode: 'FIX_REQUEST', disposition: 'AUTOMATIC' },
  WORKSPACE_NAME_NOT_FOUND: { status: HttpStatus.BAD_REQUEST, actor: 'CALLER', retryPolicy: 'NEVER', actionCode: 'FIX_REQUEST', disposition: 'AUTOMATIC' },
  ENGINE_SIGNED_OUT: { status: HttpStatus.CONFLICT, actor: 'USER', retryPolicy: 'AFTER_STATE_CHANGE', actionCode: 'AWAIT_USER_FIX', disposition: 'HUMAN' },
  // The workspace's managed runner is FAILED, FENCING or being deleted: it does not come back by itself.
  MANAGED_RUNNER_FAILED: { status: HttpStatus.CONFLICT, actor: 'USER', retryPolicy: 'AFTER_STATE_CHANGE', actionCode: 'AWAIT_USER_FIX', disposition: 'HUMAN' },
  // The workspace's runner has less free disk than its Keep Free: it starts no new session until a person frees space
  // there or lowers Keep Free.
  RUNNER_DISK_BELOW_FLOOR: { status: HttpStatus.CONFLICT, actor: 'USER', retryPolicy: 'AFTER_STATE_CHANGE', actionCode: 'AWAIT_USER_FIX', disposition: 'HUMAN' },
  SESSION_TRASHED: { status: HttpStatus.CONFLICT, actor: 'USER', retryPolicy: 'AFTER_STATE_CHANGE', actionCode: 'AWAIT_USER_FIX', disposition: 'HUMAN' },
  SESSION_ENDING: { status: HttpStatus.CONFLICT, actor: 'SYSTEM', retryPolicy: 'AFTER_STATE_CHANGE', actionCode: 'POLL_STATE', disposition: 'WAIT', retryAfterSeconds: 5 },
  SESSION_NOT_TERMINAL: { status: HttpStatus.CONFLICT, actor: 'SYSTEM', retryPolicy: 'AFTER_STATE_CHANGE', actionCode: 'POLL_STATE', disposition: 'WAIT', retryAfterSeconds: 5 },
  SESSION_NOT_STARTED: { status: HttpStatus.CONFLICT, actor: 'CALLER', retryPolicy: 'NEVER', actionCode: 'CREATE_REPLACEMENT', disposition: 'AUTOMATIC' },
  SESSION_MISSING_CONTEXT: { status: HttpStatus.CONFLICT, actor: 'CALLER', retryPolicy: 'NEVER', actionCode: 'CREATE_REPLACEMENT', disposition: 'AUTOMATIC' },
  SESSION_NO_RUNNER: { status: HttpStatus.CONFLICT, actor: 'CALLER', retryPolicy: 'NEVER', actionCode: 'CREATE_REPLACEMENT', disposition: 'AUTOMATIC' },
  SESSION_RUNNER_OFFLINE: { status: HttpStatus.CONFLICT, actor: 'SYSTEM', retryPolicy: 'AFTER_STATE_CHANGE', actionCode: 'AWAIT_SYSTEM_FIX', disposition: 'WAIT', retryAfterSeconds: 60 },
  // Sent without resumeIfEnded: as sent it is never accepted. Sent again with it, or to a new session.
  SESSION_ENDED: { status: HttpStatus.CONFLICT, actor: 'CALLER', retryPolicy: 'NEVER', actionCode: 'FIX_REQUEST', disposition: 'AUTOMATIC' },
  // The interrupt rolled back whole while turnComplete hands the slot on: gone in a moment.
  SESSION_NEXT_TURN_STARTING: { status: HttpStatus.CONFLICT, actor: 'SYSTEM', retryPolicy: 'SAFE', actionCode: 'RETRY', disposition: 'AUTOMATIC', retryAfterSeconds: 2 },
};

export interface RecoveryResourceRef {
  type: 'SESSION' | 'WORKSPACE' | 'RUNNER';
  id: string;
}

/** The body of a refusal: legacy flat fields first, the recovery block beside them. */
export function sessionRecoveryBody(
  code: SessionRecoveryCode,
  message: string,
  opts: {
    resources?: RecoveryResourceRef[];
    retryAfterSeconds?: number;
    /** More flat fields for the people and older clients reading the body (ids, limits). */
    extra?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  const rule = SESSION_RECOVERY_RULES[code];
  const retryAfterSeconds =
    rule.retryPolicy === 'NEVER' ? null : (opts.retryAfterSeconds ?? rule.retryAfterSeconds ?? null);
  const resources = opts.resources ?? [];
  return {
    statusCode: rule.status,
    error: HTTP_ERROR_NAME[rule.status] ?? 'Error',
    code,
    message,
    owner: rule.actor,
    requiredAction: rule.actionCode,
    retryable: rule.retryPolicy === 'SAFE',
    ...(retryAfterSeconds !== null ? { retryAfterSeconds } : {}),
    ...(opts.extra ?? {}),
    recovery: {
      effect: 'NONE',
      retryPolicy: rule.retryPolicy,
      retryAfterSeconds,
      actionCode: rule.actionCode,
      actor: rule.actor,
      userConfirmation: 'NOT_REQUIRED',
      disposition: rule.disposition,
      resources,
    },
  };
}

const HTTP_ERROR_NAME: Partial<Record<HttpStatus, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.FORBIDDEN]: 'Forbidden',
  [HttpStatus.CONFLICT]: 'Conflict',
  [HttpStatus.TOO_MANY_REQUESTS]: 'Too Many Requests',
};

/**
 * A refusal of `code`, at the code's own status. The Nest class of that status where there is one, so a
 * caller that tells refusals apart by class (`instanceof ConflictException`) reads them as before.
 */
export function sessionRefusal(
  code: SessionRecoveryCode,
  message: string,
  opts?: Parameters<typeof sessionRecoveryBody>[2],
): HttpException {
  const body = sessionRecoveryBody(code, message, opts);
  switch (SESSION_RECOVERY_RULES[code].status) {
    case HttpStatus.CONFLICT: return new ConflictException(body);
    case HttpStatus.FORBIDDEN: return new ForbiddenException(body);
    case HttpStatus.BAD_REQUEST: return new BadRequestException(body);
    default: return new HttpException(body, SESSION_RECOVERY_RULES[code].status);
  }
}

/** The read an asynchronous merge answers with, beside its `ok: true`: still pending, and where to look. */
export function mergePendingNext(sessionId: string): {
  actionCode: 'POLL_STATE';
  afterSeconds: number;
  resources: RecoveryResourceRef[];
} {
  // A runner picks a queued merge up on its next heartbeat, every 30 seconds.
  return { actionCode: 'POLL_STATE', afterSeconds: 30, resources: [{ type: 'SESSION', id: sessionId }] };
}

/** The words each resume refusal has always said; the code beside them is what a client reads. */
const RESUME_BLOCKED_MESSAGE: Record<SessionResumeBlockedReason, string> = {
  TRASHED: 'the session is in Trash; restore it before sending a message',
  ENDING: 'the session is ending',
  NOT_TERMINAL: 'the session has not started yet',
  NOT_STARTED: 'this session never ran and cannot be resumed',
  MISSING_CONTEXT: 'this session never ran and cannot be resumed',
  NO_RUNNER: 'the session has no runner to resume on',
  RUNNER_OFFLINE: 'the runner is offline; it must be online to resume this session',
};

/**
 * A resume refused for one of deriveSessionCapabilities' reasons (session-state.ts): the reason is the
 * code (`SESSION_<reason>`) and stays on the body as `resumeBlockedReason`. RUNNER_OFFLINE names the
 * runner as well, the blocker it waits on.
 */
export function resumeBlockedRefusal(
  reason: SessionResumeBlockedReason,
  sessionId: string,
  runnerId?: string | null,
): HttpException {
  return sessionRefusal(`SESSION_${reason}`, RESUME_BLOCKED_MESSAGE[reason], {
    resources: [
      { type: 'SESSION', id: sessionId },
      ...(runnerId && reason === 'RUNNER_OFFLINE' ? [{ type: 'RUNNER' as const, id: runnerId }] : []),
    ],
    extra: { sessionId, resumeBlockedReason: reason },
  });
}

/** An interrupt that met turnComplete handing the slot to the next turn: rolled back whole, gone in a moment. */
export function nextTurnStartingRefusal(sessionId: string): HttpException {
  return sessionRefusal('SESSION_NEXT_TURN_STARTING', 'the next turn is already starting', {
    resources: [{ type: 'SESSION', id: sessionId }],
    extra: { sessionId },
  });
}

/** What the managed-runner demand hook answered about a runner (managed-runner-demand.ts demandAnswer). */
export interface ManagedRunnerSnapshot {
  state?: string;
  reason?: { code: string; message: string; retryable: boolean } | null;
  retryAfter?: Date | null;
}

/**
 * The workspace's managed runner will not come back by itself (FAILED, FENCING, deleting): the
 * production state behind "the workspace failed to come up". A person — the owner from the machine's
 * page, or an operator — has to act; the caller cannot. `about` is what would have run there: the
 * session being resumed, or the workspace a spawn named.
 */
export function managedRunnerFailedRefusal(
  runnerId: string,
  about: RecoveryResourceRef,
  managed: ManagedRunnerSnapshot,
): HttpException {
  const state = managed.state ?? 'FAILED';
  const reason = managed.reason ?? null;
  return sessionRefusal(
    'MANAGED_RUNNER_FAILED',
    `this workspace's managed runner is ${state}${reason ? ` (${reason.code}: ${reason.message})` : ''} ` +
      'and will not come back by itself; it has to be repaired from its machine page before work can run there',
    {
      resources: [about, { type: 'RUNNER', id: runnerId }],
      extra: {
        runnerId,
        ...(about.type === 'SESSION' ? { sessionId: about.id } : { workspaceId: about.id }),
        managementState: state,
        managedReason: reason,
      },
    },
  );
}

/** The runner a spawn would start on, as its refusals name it. */
export interface SpawnTargetRunner {
  id: string;
  name: string;
  displayName: string | null;
}

/**
 * A spawn onto a workspace whose runner is offline: refused before anything is written, because the agent that asked
 * would wait on a child that never starts. The resume refusal's code, as the wait is the same: the runner comes back.
 */
export function spawnRunnerOfflineRefusal(runner: SpawnTargetRunner, workspaceId: string): HttpException {
  return sessionRefusal(
    'SESSION_RUNNER_OFFLINE',
    `runner "${runner.displayName || runner.name}" is offline, so it starts no new sessions; nothing was created. ` +
      'Try again once it is back online, or use an agent on another runner',
    {
      resources: [{ type: 'WORKSPACE', id: workspaceId }, { type: 'RUNNER', id: runner.id }],
      extra: { runnerId: runner.id, workspaceId },
    },
  );
}

/** A spawn onto a workspace whose runner is below its Keep Free (runner-disk-gate.ts): refused, as above. */
export function spawnDiskBelowFloorRefusal(runner: SpawnTargetRunner, workspaceId: string): HttpException {
  return sessionRefusal(
    'RUNNER_DISK_BELOW_FLOOR',
    `runner "${runner.displayName || runner.name}" has less free disk space than its Keep Free setting, so it starts ` +
      'no new sessions; nothing was created. Try again once space is freed there, or use an agent on another runner',
    {
      resources: [{ type: 'WORKSPACE', id: workspaceId }, { type: 'RUNNER', id: runner.id }],
      extra: { runnerId: runner.id, workspaceId },
    },
  );
}

/**
 * A spawn accepted onto a managed runner that is still coming up (REQUESTED, WAITING_CAPACITY,
 * PROVISIONING, STARTING): the child exists and waits for its machine. Not a refusal; said beside the
 * answer so it does not read as "running". The platform brings the runner up; the caller polls the child.
 */
export function managedRunnerStartingNote(
  childSessionId: string,
  runnerId: string,
  managed: ManagedRunnerSnapshot,
  nowMs: number = Date.now(),
): {
  runnerState: { code: 'MANAGED_RUNNER_STARTING'; owner: 'SYSTEM'; runnerId: string; managementState: string; retryAfterSeconds: number };
  next: { actionCode: 'POLL_STATE'; afterSeconds: number; resources: RecoveryResourceRef[] };
} {
  const until = managed.retryAfter ? Math.ceil((managed.retryAfter.getTime() - nowMs) / 1000) : 0;
  // A runner coming up takes a manager pass and a boot: 30 s is the floor a read is worth waiting.
  const afterSeconds = Math.max(30, until);
  return {
    runnerState: {
      code: 'MANAGED_RUNNER_STARTING',
      owner: 'SYSTEM',
      runnerId,
      managementState: managed.state ?? 'REQUESTED',
      retryAfterSeconds: afterSeconds,
    },
    next: {
      actionCode: 'POLL_STATE',
      afterSeconds,
      resources: [{ type: 'SESSION', id: childSessionId }, { type: 'RUNNER', id: runnerId }],
    },
  };
}
