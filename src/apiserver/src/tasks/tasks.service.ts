import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  CreatorType,
  Prisma,
  RunStatus,
  SessionDispatchOrigin,
  SessionRunSource,
  Task,
  TaskComment,
} from '@prisma/client';
import {
  AgentProvider,
  planUsageBlockedUntil,
  planUsageReported,
  RunEventType,
  SessionEndReason,
  TaskStatus,
  USAGE_LIMIT_ERROR_MARKERS,
  uuidToBase62,
  type PlanUsage,
} from '@orbit/shared';
import { createHash, randomUUID } from 'crypto';
import {
  creatorSessionsOf,
  lockCreatorSessions,
  lockOwnerTaskGraph,
  lockTaskLists,
  orderedIds,
} from '../common/lock-order';
import {
  loggedRetry,
  withTransactionRetry,
  type TransactionRetryOptions,
} from '../common/transaction-retry';
import {
  DEFAULT_AGENT_PROVIDER,
  agentProviderSeed,
  lastProviderByWorkspace,
} from '../workspaces/workspace-provider';
import {
  foremanPolicyConflict,
  isAggregateParent,
  planTaskAggregation,
} from '../projects/task-aggregation';
import {
  AGGREGATION_SCOPE_MAX_TASKS,
  applyTaskAggregations,
  collectAggregationScope,
} from '../projects/task-aggregation-writer';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionNotSendable, SessionsService } from '../sessions/sessions.service';
import { isEngineSignedOut } from '../sessions/engine-signin-preflight';
import { withSessionState } from '../sessions/session-state';
import type { HandoffApproval } from '../projects/project-scope-decision';
import {
  dependencyCrossingRefusal,
  handoffPayloadDigest,
  type HandoffRequestIdentity,
} from '../projects/project-handoff';
import {
  ProjectHandoffService,
  type HandoffAuthority,
  type HandoffDeclaration,
} from '../projects/project-handoff.service';
import {
  planPreflightRefusalBody,
  planPreflightRefusals,
  preflightPlan,
  type PlanFacts,
  type PlanPreflightFinding,
  type PlanTaskFacts,
} from './task-plan-preflight';
import {
  CreateTaskBatchItemDto,
  CreateTaskCommentDto,
  CreateTaskDto,
  CreateTasksBatchDto,
  DAG_PREVIEW_TITLES,
  MAX_DAG_OPS,
  TASK_BATCH_CREATE_MAX,
  UpdateTaskDto,
} from './dto';
import {
  TASK_SUPERSEDABLE_STATUSES,
  TASK_SUPERSESSION_MAX_HOPS,
  successorChain,
  supersededByAbsentReason,
  supersessionRefusal,
  taskOutcome,
  isLockNotAvailable,
  isRetryableTaskFence,
  taskFenceConflictMessage,
  taskNotObsoleteSql,
  taskRetirement,
  taskWorkRefusal,
} from './task-supersession';
import {
  assertAcceptanceScopeUnmoved,
  cascadedTaskClosure,
  touchesAcceptanceFact,
} from './task-lock-order';
import { PROJECT_LIVE_SESSION_STATUS_SQL } from '../projects/project-coordinator-session';
import {
  admitProjectScopeWrite,
  type ScopeAdmission,
  derivedScopeToken,
  projectScopeMode,
  scopeObservationLine,
  scopeRefusalBody,
  scopeWriteRefused,
  type DerivedScope,
  type ScopeAdmissionRequest,
  type ScopeOperation,
  type ScopePrincipal,
} from '../projects/project-scope-admission';
import type { ScopeProjectStatus } from '../projects/project-scope-contract';
import {
  AUTO_RUN_RETRY_BACKOFF_MS,
  MAX_AUTO_RUN_FAILURES,
  QUOTA_BLIND_RETRY_BACKOFF_MS,
} from './task-retry-policy';

export {
  AUTO_RUN_RETRY_BACKOFF_MS,
  MAX_AUTO_RUN_FAILURES,
  QUOTA_BLIND_RETRY_BACKOFF_MS,
} from './task-retry-policy';
import { TASK_OCCUPYING } from './reclaim-stalled-task';
import {
  TASK_RUN_ACTION,
  TASK_RUN_LEASE_MS,
  taskAlreadyRunning,
  taskRunFingerprint,
  taskRunInProgress,
  taskRunPinConflict,
  taskRunUnsettled,
  TaskRunFenceLost,
  type TaskRunEffectFence,
  taskRunTokenMismatch,
  taskRunUnreadableTarget,
  type TaskRunBatchItemPlan,
  type TaskRunExecuteTarget,
  type TaskRunClaim,
  type TaskRunLease,
  type TaskRunTargetRecord,
  type TaskRunBatchPlan,
  type TaskRunPlan,
  type TaskRunReceipt,
  type TaskRunStandDownTarget,
} from './task-run-receipt';
import {
  TASK_RUN_TRIGGER,
  taskRunBatchId,
  taskRunDesiredSessionId,
  taskRunManualTriggerId,
  taskRunRequestKey,
  taskRunResumeTurnId,
} from './task-run-identity';
import {
  canRun,
  computeDependencyState,
  dependenciesSatisfiedSql,
  dependencyEpochGate,
  dependencyEpochStalled,
  statusPrerequisites,
  verificationGateMessage,
  type DependencyPrerequisiteFact,
  wouldCreateCycle,
  wouldReplacementCreateCycle,
  type DependencyState,
} from './task-dependencies';
import { loadVerificationEpochGates } from './verification-epoch-read';
import { DagOp, effectiveOps, findCycle, resultingEdges, stateChanges } from './task-dag';

/** A polymorphic actor (user or workspace) that authored a task or comment. */
export type Creator = { type: CreatorType; id: string };

/**
 * What the session a task is being filed FROM says about where the work was noticed — the four
 * provenance columns of migration 0150, resolved server-side and never from a request body.
 *
 * `sessionId` is the session itself (also written to `creatorSessionId`, which is a different
 * claim: who authored the row, not where the work came from). The other three are the scope the
 * write happened under. All of them are evidence: no gate, dispatcher or acceptance read consults
 * them, and the scope contract states that as an invariant (§3 SC7).
 */
export type CreationOrigin = {
  sessionId: string;
  discoveredFromProjectId: string | null;
  triggerEvent: string;
  sourceTaskId: string | null;
};

/**
 * Unit L3: one task write, as `docs/project-coordinator-scope-contract.md` §4 reads it.
 *
 * `requestedProjectId` is three-state and every state means something different: `undefined` is a
 * write that did not mention the project at all — the silence the server fills — while `null` is a
 * caller explicitly asking for no project, which IS an ownership claim and is decided like one.
 */
type ScopeWriteInput = {
  operation: ScopeOperation;
  taskId: string | null;
  requestedProjectId: string | null | undefined;
  currentProjectId: string | null;
  scopeToken?: string | null;
  /**
   * Unit L4: the user's answer about this crossing, when the write declared one. Read by R9–R14,
   * and by nothing else — a write that declares no crossing never reaches them.
   */
  approval?: HandoffApproval | null;
};

/** Unit L4: what a write that was allowed under an approval must spend inside its transaction. */
type HandoffSpend = {
  authority: HandoffAuthority;
  handoffId: string;
};

/**
 * Unit L4: the cross-project prerequisite edges a plan asks for.
 *
 * `answers` is what the preflight judges; `edges` is what the transaction re-judges under a lock,
 * because a prerequisite can move between the two and `project_id` is not a key column.
 */
/**
 * Unit L4: the authority facts a plan was admitted against, as captured before the transaction and
 * compared inside it. Only fields that decide REFUSE or ALLOW are here — a warning that drifts is
 * still only a warning, and locking rows to keep one stable would be paying for nothing.
 */
type PlanAuthoritySnapshot = {
  projects: Record<string, {
    status: string;
    acceptanceEpoch: string;
    maxConcurrentTasks: number;
    sessionBudgetPerDay: number | null;
    /**
     * WHO the plan was judged against: the coordinating session and the team, as one digest.
     *
     * A team change is not cosmetic on this path — membership is what decides whether an assignee
     * can ever be dispatched, and the coordinator pointer is who may write here at all. Both are
     * read by the preflight without a lock, so both are compared under one. Fail-closed on purpose:
     * a plan judged against one team and written against another is a plan nobody judged.
     */
    identityDigest: string;
  }>;
  workspaceIds: string[];
  providerSlugs: string[];
  taskProjects: Record<string, string | null>;
};

/** Unit L4: what a preflight concluded, and what the transaction has to re-check before writing. */
type PlanAdmission = {
  findings: PlanPreflightFinding[];
  workspaceIds: string[];
  providerSlugs: string[];
  snapshot: PlanAuthoritySnapshot;
};

type DependencyCrossings = {
  answers: Record<string, HandoffApproval | null>;
  edges: Array<{
    index: number;
    from: string | null;
    prerequisiteId: string;
    authority: HandoffAuthority;
    /** The recorded answer, when one exists — what the transaction spends. */
    handoffId: string | null;
  }>;
};

/**
 * One idempotent task write, as its key and its winner validator both read it.
 *
 * `operation` is a discriminator and not a comment: `idempotency_key` is one unique column shared
 * by every subsystem that writes a task (§13.2's defect filer and §7.3's verification filing both
 * key rows in it under their own templates), so what makes a row THIS request's earlier attempt is
 * that the whole tuple below reproduces the key it is filed under — not that something was found.
 */
type IdempotentTaskWrite = {
  operation: IdempotentTaskOperation;
  sessionId: string;
  turnId: string;
  title: string;
  description?: string | null;
};

export type IdempotentTaskOperation = 'CREATE_TASK';

/**
 * The operation's byte in the key preimage — FROZEN, and not the same string as the descriptor.
 *
 * `idempotency_key` is persisted, and every key already in the table was hashed over `task-create`.
 * Renaming the literal to match the TypeScript spelling would recompute every key: a turn that
 * committed its tasks before an upgrade and is redelivered after it would compute a key that
 * matches nothing, find no winner and create the duplicates the whole mechanism exists to prevent
 * — silently, once per in-flight turn, at every deploy. So the descriptor is free to be named for
 * readers and the byte is not free to change at all.
 *
 * `task-idempotency-winner.spec.ts` pins the digest of a known input, so this table cannot be
 * edited without a test saying so.
 */
const IDEMPOTENCY_OPERATION_TAG: Readonly<Record<IdempotentTaskOperation, string>> = {
  CREATE_TASK: 'task-create',
};

/** Just the reads the scope derivation makes, so a transaction client is equally acceptable. */
type ScopeReadClient = Pick<Prisma.TransactionClient, 'session' | 'project'>;

/** Everything §4 needs that is not the write itself, read once per call. */
type ScopeWorld = {
  principal: ScopePrincipal;
  scope: DerivedScope | null;
  projectStatus: Readonly<Record<string, ScopeProjectStatus>>;
  mode: ReturnType<typeof projectScopeMode>;
};

/** What a planned run needs off a task to dispatch it: its identity, and the provider/model pin
 *  that overrides the assignee workspace's own (null on both = inherit from the workspace). */
type TaskRunTarget = {
  id: string;
  title: string;
  provider?: string | null;
  model?: string | null;
};

export function buildTaskExecutionPrompt(task: {
  title: string;
  description?: string | null;
  isForeman?: boolean;
  verifiesTaskId?: string | null;
  list?: { instructions?: string | null } | null;
}): string {
  const systemRun = task.isForeman === true || task.verifiesTaskId != null;
  const instructions = systemRun ? undefined : task.list?.instructions?.trim();
  return (
    `请开始执行任务「${task.title}」。\n\n` +
    (task.description ? `任务描述：\n${task.description}\n\n` : '') +
    (instructions ? `作业指导（本任务列表通用）：\n${instructions}\n\n` : '') +
    `请按以下步骤进行：\n` +
    `1. 先用 task_get 查看该任务的完整信息与历史评论。\n` +
    `2. 执行任务。\n` +
    `3. 完成后，用 task_comment 在该任务下评论一段本次执行的总结（做了什么、结果如何、有无遗留），` +
    `再用 task_update 将该任务状态（status）置为 DONE。\n` +
    `4. 如果执行失败或未能完成，绝不要将状态置为 DONE；请先用 task_comment 在该任务下明确说明失败/未完成的原因，再将状态置为 IN_PROGRESS。`
  );
}

// Version-agnostic (UUIDv7-safe) shape check. A non-UUID id would otherwise reach
// Postgres and surface as a 500; we treat it like any unknown task instead.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Single-run dedup (开始执行 / @-mention): only a PENDING (queued) or RUNNING (a turn is
// actively executing) session means the task is already mid-flight, so re-triggering it
// must be a no-op. A session parked at AWAITING_INPUT/INTERRUPTED is idle — it is NOT in
// this set so it falls through to the resume path, where the trigger delivers its prompt
// as a new turn instead of silently returning the parked session and doing nothing.
const SINGLE_RUN_DEDUP: RunStatus[] = [RunStatus.PENDING, RunStatus.RUNNING];

/**
 * What one run request answers with, and what its receipt stores verbatim.
 *
 * Spelled out rather than inferred because it is a WIRE shape now: a repeat of a request reads it
 * back off the receipt, so the two branches have to be discriminable by a reader that did not
 * watch the call — and every caller can ask for `sessionId` without first proving which branch it
 * got, which is what the callers have always done.
 */
export type TaskRunAnswer =
  | { ok: true; sessionId: string | undefined; skipped?: undefined }
  | {
      ok: false;
      skipped:
        | 'superseded'
        | 'aggregate-parent'
        | 'coordinator-authority'
        /**
         * The moment this request names has passed: `task_dispatch_epoch` has moved since the scan
         * that produced this delivery. Terminal, and the one automatic stand-down that is — the
         * epoch only goes up, so the moment this token names can never come back, and every later
         * delivery of it is answering the same gone moment.
         */
        | 'stale-epoch'
        /**
         * The task this request was planned against was deleted before its Session could be
         * written. Terminal by construction — the plan names a row that no longer exists and every
         * later delivery would fail on the same foreign key — so it is frozen rather than released.
         */
        | 'target-tombstoned';
      sessionId?: undefined;
    };

/**
 * What one press of the bulk Run answers with, and what its receipt stores verbatim.
 *
 * `results` is the per-item half: the tally says how many started, and a repeat of the press has to
 * be able to say WHICH — both because that is what a client refreshing the rows it just started
 * needs, and because "the same answer" is only checkable if the answer names its parts.
 */
export interface TaskBatchRunResult {
  dispatched: number;
  failed: Array<{ id: string; ok: false; error: string; sessionId?: undefined }>;
  skipped: Array<{ id: string; title: string; reason: string }>;
  runnerIds: string[];
  batchId: string | null;
  maxConcurrent: number | null;
  results: Array<
    | { id: string; ok: true; sessionId: string | undefined }
    | { id: string; ok: false; error: string; sessionId?: undefined }
  >;
}

/** How many times a task run re-attempts its insert behind a NOWAIT fence that said "retry". */
const TASK_RUN_FENCE_RETRIES = 3;
/** First backoff, doubled per attempt: 20ms, 40ms, 80ms — a lock somebody is holding, not a queue. */
const TASK_RUN_FENCE_BACKOFF_MS = 20;

/**
 * §13.8: the delivery contract a comment written by THIS binary is under.
 *
 * Written explicitly on every comment create. The column defaults to 0 — the inline best-effort
 * loop a binary predating the ledger used — so a rolling deploy cannot have one comment delivered
 * by both mechanisms, or by neither.
 */
export const TASK_COMMENT_MENTION_DELIVERY_VERSION = 1;

/**
 * §13.8: a delivery that cannot land, with the shape a reader can act on.
 *
 * `availability` is the distinction that decides whether the attempt budget is spent. A runner that
 * is not bound, a provider that is down, a lease that was stolen — none of those is a property of
 * the message, and all of them clear without anybody touching the mention. Spending the budget on
 * them means a message is abandoned because a machine was rebooting.
 */
class MentionUndeliverable extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly availability = false,
    /** What would clear this, addressed to whoever can do it. Stored, not just logged. */
    readonly requiredAction: string | null = null,
  ) {
    super(message);
    this.name = 'MentionUndeliverable';
  }
}

/** How many delivery attempts a mention gets before it is DEAD and somebody has to look. Spent only
 *  by failures belonging to the delivery — availability refunds; see `MentionUndeliverable`. */
const MENTION_DELIVERY_MAX_ATTEMPTS = 8;

/**
 * How many times a delivery may be LEASED before it is DEAD regardless of why.
 *
 * The other loop: a row whose worker dies before it decides anything spends no attempt, so the
 * attempt budget alone can never end it. Generous relative to the attempt budget, because a lease
 * is also taken to poll a SESSION_CREATED row for its turn — this bounds a pathology, it is not a
 * second retry policy.
 */
const MENTION_DELIVERY_MAX_CLAIMS = 64;

/** How long to wait before looking again for the turn a created conversation has not seeded yet. */
const MENTION_DELIVERY_TURN_POLL_MS = 15_000;

/** How long a worker's claim on a delivery row is good for. A worker that dies frees it by expiry
 *  rather than by leaving it stranded. */
const MENTION_DELIVERY_LEASE_MS = 60_000;

/** Conditions that will not change by waiting: the row ends here rather than spending its budget
 *  on retries nobody expects to succeed. */
const MENTION_DELIVERY_TERMINAL_CODES = ['WORKSPACE_GONE', 'COMMENT_GONE'];

/** Codes that mean "this landing is spent, take the next one": the ledger drops its binding so the
 *  retry chooses again rather than coming back to a session that can no longer carry the message. */
const MENTION_DELIVERY_REBIND_CODES = ['TURN_STRANDED'];

/** A lock fence from migration 0130, which must keep its own meaning rather than being swallowed as
 *  "this landing is spent" — nothing is spent, the rows were simply busy. */
function isTaskWorkFence(error: unknown): boolean {
  return taskFenceConflictMessage(error) != null;
}

/** Backoff ceiling. Deliberately half an hour rather than longer: a runner that comes back after a
 *  day should deliver its messages within the half hour, not on the next deploy. */
const MENTION_DELIVERY_MAX_BACKOFF_MS = 30 * 60_000;

/** How many deliveries one sweep takes. Bounded so a burst of mentions cannot monopolise the tick
 *  the other three sweeps share. */
const MENTION_DELIVERY_PER_SWEEP = 20;

/**
 * How far `assertNoParentCycle` walks up a subtask chain before it refuses to judge.
 *
 * A bound, not a product rule: the walk is one query per level, and a decomposition fifty levels
 * deep is a mistake rather than a plan. It also guarantees the loop ends even if the stored tree
 * is somehow malformed.
 */
const MAX_TASK_PARENT_DEPTH = 50;

/**
 * What a task LIST row needs: every scalar column except `description`, plus the assignee
 * (with its runner, for the batch-run modal) and the comment tally. No client renders a
 * description in a list row — the detail panel fetches `GET /tasks/:id` for that — and it
 * averages ~500 bytes per task, so including it here inflated a 200-row page by ~46% and a
 * 701-task list view by ~440KB for bytes that were parsed and thrown away.
 *
 * `projectId`, `parentTaskId` and `acceptanceCriteria` are in for the same reason the rest of the
 * scalars are, and the same reason `description` stays out. They are what a row is filed under,
 * what it is part of, and what would settle it — a coordinator listing its project's tasks reads
 * all three off the page it already has, where without them the only way to learn that a row is a
 * subtask is one `GET /tasks/:id` per row, description included. They are three small columns, not
 * a relation: no join, no fan-out, and `children`/`comments` stay out for exactly that reason.
 */
export const TASK_LIST_SELECT = {
  id: true,
  title: true,
  status: true,
  ownerId: true,
  creatorType: true,
  creatorId: true,
  assigneeId: true,
  dueDate: true,
  runAt: true,
  createdAt: true,
  updatedAt: true,
  listId: true,
  projectId: true,
  parentTaskId: true,
  acceptanceCriteria: true,
  labels: true,
  creatorSessionId: true,
  autoRunWhenReady: true,
  provider: true,
  model: true,
  // Two enum columns and the relation they are about, in for the same reason parentTaskId is: a
  // reader looking at a project's tree needs to know which rows complete themselves, which rows
  // are checks and of what, and what those checks concluded — and the only alternative is one GET
  // per row. `verifiesTaskId` is spelled base62 on the way out, like every other id here.
  completionPolicy: true,
  verdict: true,
  verifiesTaskId: true,
  // §13.6's three supersession columns, in for the same reason: a reader looking at a project's
  // history needs "this one was replaced, and by that one" without one GET per cancelled row —
  // otherwise the only way to tell a replaced attempt from a dropped one is to read the comments.
  supersededByTaskId: true,
  supersededAt: true,
  terminalReason: true,
  assignee: {
    select: {
      id: true,
      name: true,
      model: true,
      runnerId: true,
      runner: { select: { id: true, name: true, displayName: true, maxConcurrent: true } },
    },
  },
  _count: { select: { comments: true } },
} satisfies Prisma.TaskSelect;

/**
 * Database-side mirror of the task row's Run/Retry visibility predicate, correlated to an
 * outer `task t`: not finished, assigned to a workspace that has a runner, no run already in
 * flight, and no prerequisite still outstanding.
 *
 * Spelled as `NOT EXISTS` rather than Prisma relation filters (`sessions: { none }`,
 * `dependsOn: { none }`) on purpose. Prisma compiles those into `id NOT IN (SELECT …)`,
 * which makes PostgreSQL hash *every* dependency edge in the account before it can return
 * a single row — on a 56k-task/55k-edge account that is ~200ms, paid on every list request
 * and every poll. `NOT EXISTS` is index-driven and short-circuits per row, so an ordered
 * page stops as soon as it has enough rows: measured 200ms -> 13ms for one 200-row page.
 *
 * Kept literally in step with the Run button's own gate (see `canRun` and the execute
 * path) — the Ready tab must never offer a run the API would reject.
 */
/**
 * Was this duplicate-key error one of the TWO unique keys a task run's Session insert can reach?
 *
 * Two are in range and no others: `session_task_execution_claim_idx` (`task_id`), and — since the
 * id is now derived from the request (`taskRunDesiredSessionId`) rather than drawn at random — the
 * PRIMARY KEY. `project_action_id` and `share_token` are the table's only other unique keys, and a
 * legacy task run leaves both NULL, which PostgreSQL treats as distinct.
 *
 * Still narrowed, for the reason it always was: a collision outside this pair is a different fact
 * entirely, and the recovery below would answer it with a sentence about running a task.
 *
 * WHICH of the two it was is deliberately NOT decided here. The error says enough to know it
 * belongs to this unit and not enough to name the row, and the row is the whole answer — so the
 * classification is a READ, exactly as §7.7 D5-b1 has the Coordinator door do it.
 */
function isTaskRunClaimConflict(error: unknown): boolean {
  const named = conflictingUniqueKey(error);
  return /task_id/.test(named) || /\bid\b/.test(named) || /session_pkey/.test(named);
}

/**
 * WHICH unique key a duplicate came from, wherever this stack happens to have put it.
 *
 * There are three shapes, and a predicate that knows fewer than all of them is a guard that works
 * in one place and silently does not in another — the same lesson `postgresSqlState` learned, at
 * the same cost. This classifier read `meta.target` and nothing else, and **Prisma 7 with
 * `@prisma/adapter-pg` — what this deployment runs — does not set it**. So every lost execution
 * claim failed the test and the raw `P2002` was rethrown: not only the terminal and paused winners
 * this unit set out to repair, but every one of them, arriving at the API as a 500 with a
 * PostgreSQL sentence in it. Only a real server can show that; the shape is invisible to a double.
 *
 *  - Prisma before the driver adapter: `meta.target`, the conflicting column list;
 *  - Prisma 7 with the pg adapter: `meta.driverAdapterError.cause.constraint.fields`, and the
 *    constraint's own name inside `originalMessage`.
 *
 * The rendered `error.message` is deliberately NOT consulted: Prisma renders a code frame into it,
 * so matching there would classify on whatever the surrounding source happens to say.
 */
function conflictingUniqueKey(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  const candidate = error as {
    meta?: {
      target?: unknown;
      driverAdapterError?: {
        cause?: { constraint?: { fields?: unknown; index?: unknown }; originalMessage?: unknown };
      };
    };
  };
  const adapter = candidate.meta?.driverAdapterError?.cause;
  const parts: string[] = [];
  for (const source of [candidate.meta?.target, adapter?.constraint?.fields]) {
    if (Array.isArray(source)) parts.push(source.join(','));
    else if (typeof source === 'string') parts.push(source);
  }
  for (const source of [adapter?.constraint?.index, adapter?.originalMessage]) {
    if (typeof source === 'string') parts.push(source);
  }
  return parts.join('|');
}

const RUNNABLE_TASK_SQL = Prisma.sql`
  t.status <> 'DONE'::task_status
  AND EXISTS (SELECT 1 FROM workspace a WHERE a.id = t.assignee_id AND a.runner_id IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM session s
    WHERE s.task_id = t.id AND s.status IN ('PENDING'::run_status, 'RUNNING'::run_status)
  )
  AND ${Prisma.raw(dependenciesSatisfiedSql('t'))}
  AND ${Prisma.raw(taskNotObsoleteSql('t'))}`;

/**
 * The auto-run sweep's candidate predicate (see reconcileReadyTasks), correlated to an outer
 * `task t`. Deliberately NOT the same predicate as RUNNABLE_TASK_SQL, and the two must not be
 * merged: this one is deployment-wide (no owner scope), requires status exactly OPEN rather
 * than "not DONE", only considers tasks opted into auto-run, requires the task to HAVE
 * prerequisites (a dependency-free task is never auto-run), and counts the wider
 * TASK_OCCUPYING set — which includes idle-but-live AWAITING_INPUT/INTERRUPTED sessions — as
 * "already being worked".
 *
 * The "has at least one DONE prerequisite" clause is logically implied by the two around it
 * (having prerequisites + none outstanding means they are all DONE), and is stated anyway
 * because it is the only *selective* entry point the planner has. Without it this predicate
 * is `status = OPEN AND auto_run_when_ready`, which on a real backlog is nearly every task in
 * the deployment, so PostgreSQL hash-joins all 55k dependency edges once a minute (measured
 * 264ms per sweep, and rewriting the anti-joins as NOT EXISTS alone only got it to 199ms —
 * with no LIMIT to stop at, the planner picks a hash anti-join either way). Anchored on DONE
 * prerequisites instead it seeks the few hundred finished tasks through
 * `task_dependency_depends_on_task_id_idx`: 264ms -> 32ms.
 */
const AUTO_RUN_READY_SQL = Prisma.sql`
  t.status = 'OPEN'::task_status
  AND t.dispatch_authority = 'LEGACY'::task_dispatch_authority
  AND t.auto_run_when_ready = true
  AND EXISTS (SELECT 1 FROM workspace a WHERE a.id = t.assignee_id AND a.runner_id IS NOT NULL)
  -- A held task is out of the sweep entirely: pausing a list is the stop for a campaign
  -- dispatching wrongly, so it has to work here, not only on the manual button. Filtered in SQL
  -- rather than by letting execute() throw per task, which would log one rejection per task per
  -- minute for as long as the pause lasts.
  --
  -- A column on the task, not NOT EXISTS (... task_list.paused). That spelling made the stop
  -- conditional on a row that could be deleted, and a veto that cannot be expressed reads as
  -- permission: deleting 112 paused-able lists released 55,513 tasks that then ran for a
  -- fortnight. Every clause here that permits must be positive and read off the task itself.
  AND t.dispatch_hold = false
  -- A schedule that has not come due yet is a veto, and it has to be one HERE as well as on the
  -- instant path (see triggerDependents): a task scheduled for Sunday whose last prerequisite
  -- lands on Friday is ready in every other sense, and without this clause the sweep would start
  -- it on Friday. "Earliest automatic start" has to hold against every automatic starter, not
  -- just the one that motivated it. NULL — no schedule at all — permits, which is what every
  -- task that predates the column is.
  AND (t.run_at IS NULL OR t.run_at <= now())
  -- The auto-run sweep is for tasks that have prerequisites AT ALL: it is the "a dependency just
  -- completed, start what it released" pass, not a general starter. So it anchors on the task
  -- HAVING an edge, and the satisfaction of those edges is the clause below.
  --
  -- It used to anchor on having a DONE prerequisite, which was the same thing only while an edge
  -- could be satisfied by nothing else. §13.6 SU9 makes a chain-tail satisfy one, so a task whose
  -- single prerequisite was replaced — chain tail DONE, the named row CANCELLED — passed the
  -- satisfaction clause and failed the anchor, and the sweep never selected it.
  AND EXISTS (SELECT 1 FROM task_dependency d WHERE d.task_id = t.id)
  -- §13.6 SU9, and the same answer the Coordinator's pass gives: an edge names an ATTEMPT, and a
  -- replaced attempt's work is held by its successor. Read as a plain DONE check this is a
  -- prerequisite nothing can ever complete, and everything downstream of it waits for good.
  AND ${Prisma.raw(dependenciesSatisfiedSql('t'))}
  -- ...and a retired task is not a candidate at all: enumerating one every minute only to have
  -- execute() refuse it is a sweep arguing with itself.
  AND ${Prisma.raw(taskNotObsoleteSql('t'))}
  AND NOT EXISTS (
    SELECT 1 FROM session s
    WHERE s.task_id = t.id
      AND s.status IN (${Prisma.join(
        TASK_OCCUPYING.map((status) => Prisma.sql`${status}::run_status`),
        ', ',
      )})
  )`;

/**
 * The scheduled sweep's candidate predicate (see dispatchDueScheduledTasks), correlated to an
 * outer `task t`. Anchored on `run_at`, which is the one selective thing about it: a schedule is
 * rare, the partial index (migration 0110) holds only the tasks that have one, and every other
 * clause here is a re-check over the handful that are actually due.
 *
 * Deliberately NOT AUTO_RUN_READY_SQL with a date bolted on, and the differences are the whole
 * point of the feature:
 *
 *   * `auto_run_when_ready` is not required. That flag answers "should finishing a prerequisite
 *     start this", which is a question about dependencies; a clock is a different trigger, and a
 *     task with no dependencies at all is the ordinary case for one.
 *   * Prerequisites are not required to EXIST, only to be finished. The auto-run sweep insists a
 *     candidate have them because "all zero prerequisites are done" is not a reason to start
 *     anything. Here the reason to start is the time, and the dependencies are only a veto.
 *
 * What it shares with the auto-run sweep it shares exactly, because these are the standing rules
 * about dispatching a task rather than anything to do with scheduling: OPEN, not held by a paused
 * list, an assignee bound to a runner, no prerequisite outstanding, and nothing already occupying
 * it (TASK_OCCUPYING, so an idle-but-live session counts — a scheduled run must not barge in on a
 * session that is merely waiting for a human).
 *
 * Every one of those is filtered here rather than left for execute() to reject, and not only for
 * speed: a schedule whose task is unassigned or paused is retained, not consumed, so letting it
 * reach execute() would log one rejection per task per minute for as long as the condition lasts.
 */
const SCHEDULED_DUE_SQL = Prisma.sql`
  t.run_at IS NOT NULL
  AND t.run_at <= now()
  AND t.status = 'OPEN'::task_status
  AND t.dispatch_authority = 'LEGACY'::task_dispatch_authority
  AND t.dispatch_hold = false
  AND EXISTS (SELECT 1 FROM workspace a WHERE a.id = t.assignee_id AND a.runner_id IS NOT NULL)
  -- §13.6 SU9, and the same answer the Coordinator's pass gives: an edge names an ATTEMPT, and a
  -- replaced attempt's work is held by its successor. Read as a plain DONE check this is a
  -- prerequisite nothing can ever complete, and everything downstream of it waits for good.
  AND ${Prisma.raw(dependenciesSatisfiedSql('t'))}
  -- ...and a retired task is not a candidate at all: enumerating one every minute only to have
  -- execute() refuse it is a sweep arguing with itself.
  AND ${Prisma.raw(taskNotObsoleteSql('t'))}
  AND NOT EXISTS (
    SELECT 1 FROM session s
    WHERE s.task_id = t.id
      AND s.status IN (${Prisma.join(
        TASK_OCCUPYING.map((status) => Prisma.sql`${status}::run_status`),
        ', ',
      )})
  )`;

/**
 * SQL mirror of the `{ ownerId, listId?, projectId?, assigneeId? }` scope the Prisma queries are
 * built from. Derived from that same object rather than re-read from the query string, so the two
 * spellings of the scope cannot drift.
 */
function taskScopeSql(scope: Prisma.TaskWhereInput): Prisma.Sql {
  const clauses: Prisma.Sql[] = [Prisma.sql`t.owner_id = ${scope.ownerId as string}::uuid`];
  if (scope.listId === null) clauses.push(Prisma.sql`t.list_id IS NULL`);
  else if (typeof scope.listId === 'string') {
    clauses.push(Prisma.sql`t.list_id = ${scope.listId}::uuid`);
  }
  if (typeof scope.projectId === 'string') {
    clauses.push(Prisma.sql`t.project_id = ${scope.projectId}::uuid`);
  }
  if (typeof scope.assigneeId === 'string') {
    clauses.push(Prisma.sql`t.assignee_id = ${scope.assigneeId}::uuid`);
  }
  // Mirror of the `labels.hasEvery` filter listPage puts on every other tab. The Ready tab is the
  // one scope that reaches the database as SQL rather than as a Prisma where, so a filter added
  // to the object form and not here is not a type error anywhere — it just silently stops
  // applying on one tab.
  const labels = scope.labels;
  if (labels && typeof labels === 'object' && 'hasEvery' in labels) {
    const wanted = labels.hasEvery as string[];
    if (wanted.length) clauses.push(Prisma.sql`t.labels @> ARRAY[${Prisma.join(wanted)}]::text[]`);
  }
  return Prisma.join(clauses, ' AND ');
}

/**
 * The stored form of a caller's label list: trimmed, blanks dropped, duplicates removed, first
 * occurrence's position kept.
 *
 * Case is deliberately preserved rather than folded. These record facts that arrive already
 * spelled — a snapshot id, a shard, an upstream commit — and folding `CC-MAIN-2017-34` to
 * lowercase would make the stored label differ from the thing it names for no gain, since a
 * writer consistent enough to be worth grouping by is consistent about case too.
 */
export function normalizeTaskLabels(labels: readonly string[]): string[] {
  return [...new Set(labels.map((label) => label.trim()).filter(Boolean))];
}

/**
 * The labels a request asked to filter on. Accepts both `?labels=a,b` and a repeated
 * `?labels=a&labels=b`, the latter being how a label containing a comma has to be sent.
 */
export function parseLabelsQuery(raw: string | string[] | undefined): string[] {
  if (raw === undefined) return [];
  return normalizeTaskLabels(Array.isArray(raw) ? raw : raw.split(','));
}

// How often the auto-run reconciler re-checks for ready-but-unstarted tasks (see
// reconcileReadyTasks). This is only a backstop — the instant path is triggerDependents,
// fired the moment a prerequisite reaches DONE — so a coarse cadence is enough.
const RECONCILE_INTERVAL_MS = 60_000;

// Brake on the reconciler's re-dispatch. A task it auto-runs can land straight back in
// the candidate set: when a run dies before its workspace ever moved the task to IN_PROGRESS,
// reclaimStalledTask leaves the task OPEN (it only rewrites IN_PROGRESS), and the sweep
// re-dispatches it a minute later. Nothing else stops that, so a failure the retry cannot
// clear — a provider usage limit, a missing input file — becomes a once-a-minute respawn
// loop that burns a session per attempt for as long as the failure lasts (days, for a
// usage limit). Hold the task off for progressively longer after each failed run, then
// stop auto-running it: past MAX_AUTO_RUN_FAILURES only an explicit trigger ("开始执行",
// an @-mention, a prerequisite reaching DONE) starts it again. Indexed by failure count,
// so entry [0] is the wait after the first failed run.
// Flat brake for runs killed by a provider usage limit that the quota gate could not put a
// resume time on. Those failures are excluded from the budget above on purpose (see
// autoRunHoldOff) — one quota outage must not permanently retire a fleet — and
// planUsageBlockedUntil deliberately declines to block without a reported `resetsAt`, leaving
// "the caller's normal failure backoff" to handle it. Between those two decisions nothing
// actually did: a blind gate plus an exempt failure is the once-a-minute respawn loop the
// backoff exists to stop. This is that missing brake, and it is flat rather than escalating
// because a quota is not evidence the task is broken — it recovers on its own schedule, and
// the only job here is to stop burning a session a minute while waiting for it.
// How many due tasks one scheduled sweep will look at (see dispatchDueScheduledTasks). A bound on
// the pass, not a quota on the schedule: what it does not take this minute it takes the next, in
// the same order, because the tasks it left keep their `run_at` and stay due. It exists so that
// somebody scheduling ten thousand tasks for one instant produces a series of ordinary sweeps
// rather than one that holds the timer for minutes and starves the two sweeps behind it.
export const SCHEDULED_DISPATCH_MAX_PER_SWEEP = 200;

/**
 * WHICH MOMENT an automatic trigger is acting on, carried into the dispatch so the dispatch can
 * tell whether that moment is still the current one.
 *
 * Every automatic path is a scan followed by a re-read: the sweep (or triggerDependents) selects
 * candidates, then `execute` loads each one again to dispatch it. A user editing the schedule in
 * that window is not an exotic race — it is somebody looking at the task and changing their mind,
 * which is most likely precisely when the task is about to run. Without this the automatic call is
 * indistinguishable from a person pressing Run, and `execute` treats a future `runAt` as something
 * a person may override: it would start the task early AND consume the schedule they had just set.
 *
 * This USED to carry the `runAt` the scan saw and compare instants. That answered "did the schedule
 * move", which is not the same question and is one a revertible value cannot answer: `run_at` going
 * 09:00 -> 10:00 -> 09:00 compares EQUAL to a pass that scanned the first 09:00, so a redelivered
 * old pass was allowed to start work for an appointment that had already been replaced twice — and
 * the current pass, whose own request derives a different name, was then refused because the task
 * was running. §7.7 D5-b4. It also said nothing at all about the dependency door, whose moment is
 * not a value on the row.
 *
 * So what is carried is the MOMENT's name: `task_dispatch_epoch.epoch`, monotone, advanced once per
 * statement that creates a moment at which an automatic door may legitimately start this task's
 * work (a new or consumed appointment, this task reopening, a prerequisite's status moving, the
 * waiting set changing). Equal epochs mean the world this pass selected under is the world the
 * dispatch is writing into; different ones mean this delivery is answering a moment that is gone.
 */
export interface AutoDispatch {
  /** `task_dispatch_epoch.epoch` as the candidate scan read it, and the epoch its token names. */
  observedEpoch: bigint;
}

/**
 * Whether an automatic trigger may still act, given what the dispatch's own read found.
 *
 * One comparison, because there is one question. What the previous spelling checked as a second
 * clause — "an automatic trigger never starts a task before its time" — is decided by the candidate
 * scans, and decided better there: all three evaluate `run_at <= now()` on the DATABASE's clock,
 * inside the statement that selects the row, and the epoch then proves the row has not moved since.
 * Re-deciding it here would have meant comparing a database instant against `Date.now()` in this
 * process, which is the clock dependency the receipt's lease was deliberately built without.
 */
export function autoDispatchStillValid(current: bigint, observed: bigint): boolean {
  return current === observed;
}

// Brake on repeat foremen for the same stall.
//
// Suppressing while one is unfinished only stops *concurrent* coordinators. The moment a foreman
// reaches DONE the suppression lifts, and a stall it could not fix is by definition still there —
// so the sweep files another one stall-window later, forever. At the 5-minute floor that is 12
// sessions an hour, indefinitely: nine times the rate of the runaway that motivated this whole
// area, arrived at by way of a comment promising not to repeat it.
//
// Indexed by how many foremen have already run without any real work happening in between, so a
// list that stalls, gets fixed, works, and stalls again months later starts from the first step.
// Past MAX_CONSECUTIVE_FOREMEN the list is left alone until something actually runs in it: a
// coordinator that has failed this many times is reporting a problem it cannot solve, and the
// next identical run is not what surfaces it.
// How many times one task may be sent back by verification before it is left for a human.
//
// A rejected verification puts the subject back to IN_PROGRESS, which lets it run again, reach
// DONE again, and be verified again — an unbounded loop unless something counts. Two rounds is
// enough for "the agent misread the task the first time" and short of "these two disagree about
// what done means", which is the case a third identical round does not settle.
export const MAX_VERIFICATIONS_PER_TASK = 2;

/** What the sweep is allowed to materialise, per runner and per capped list. */
export interface MaterialisationBudget {
  runner: Map<string, number>;
  list: Map<string, number>;
}

/**
 * Take one unit of budget for a task, or refuse.
 *
 * Both caps must allow it and both are then spent, so a task in a capped list also consumes its
 * runner's allowance — it is one session either way. An id absent from a map has no cap and is
 * unbounded, which is what a runner with no `max_concurrent` and a list with no cap both mean.
 *
 * Extracted rather than inlined because this is the whole of the decision: everything else in the
 * dispatch loop is a filter, and this is the only part that has to stay consistent with what the
 * claim will actually accept.
 */
export function takeBudget(
  budget: MaterialisationBudget,
  runnerId: string,
  listId: string | null,
): boolean {
  const runnerLeft = budget.runner.get(runnerId);
  const listLeft = listId ? budget.list.get(listId) : undefined;
  if (runnerLeft !== undefined && runnerLeft <= 0) return false;
  if (listLeft !== undefined && listLeft <= 0) return false;
  if (runnerLeft !== undefined) budget.runner.set(runnerId, runnerLeft - 1);
  if (listLeft !== undefined && listId) budget.list.set(listId, listLeft - 1);
  return true;
}


export const FOREMAN_RETRY_BACKOFF_MS = [30 * 60_000, 2 * 60 * 60_000, 8 * 60 * 60_000];
export const MAX_CONSECUTIVE_FOREMEN = FOREMAN_RETRY_BACKOFF_MS.length + 1;

/**
 * Is this workspace's filesystem below its runner's free-space floor, so no new work should be
 * dispatched onto it?
 *
 * Fail-open on every kind of missing information — no floor configured, or no reading from the
 * runner (too old to measure, work dir gone, a platform with no answer). A disk gate that fired
 * on absent telemetry would stop a fleet precisely because it knew nothing about it, and the
 * failure it is guarding against (a volume filling up) is one that its own silence cannot
 * evidence. The gate is only as good as the reading, and no reading means no gate.
 *
 * bigint throughout: a multi-terabyte volume's byte count is past Number.MAX_SAFE_INTEGER.
 */
export function diskBelowFloor(
  freeBytes: bigint | null | undefined,
  minFreeDiskMb: number | null | undefined,
): boolean {
  if (freeBytes == null) return false;
  if (minFreeDiskMb == null || !Number.isFinite(minFreeDiskMb) || minFreeDiskMb <= 0) return false;
  return freeBytes < BigInt(Math.floor(minFreeDiskMb)) * 1024n * 1024n;
}

// PostgreSQL accepts at most 32,767 bind parameters. Dependency lookups are also used
// by the legacy unpaged endpoint, so keep every generated IN (...) comfortably below
// that ceiling even when an owner has tens of thousands of tasks.
const TASK_ID_QUERY_CHUNK = 5_000;
export const DEFAULT_TASK_PAGE_SIZE = 100;
export const MAX_TASK_PAGE_SIZE = 200;
const DEFAULT_DEPENDENCY_GRAPH_MAX_DEPTH = 8;
const MAX_DEPENDENCY_GRAPH_MAX_DEPTH = 32;
const DEFAULT_DEPENDENCY_GRAPH_MAX_NODES = 100;
const MAX_DEPENDENCY_GRAPH_MAX_NODES = 500;
// Dense DAGs can have O(nodes²) edges. Keep both the database read and serialized/MCP
// response bounded as well as the node count; four edges per requested node is enough for
// normal workflow graphs, while `truncated` makes unusually dense snapshots explicit.
const DEPENDENCY_GRAPH_EDGES_PER_NODE = 4;
const MAX_DEPENDENCY_GRAPH_EDGES = 2_000;
const DEFAULT_DEPENDENCY_GRAPH_EXPANSION_BATCH_SIZE = 25;
const MAX_DEPENDENCY_GRAPH_EXPANSION_BATCH_SIZE = 100;
// A paged client can safely grow beyond one GET snapshot while remaining bounded. The
// real P250 -> W250 -> CHECK component has 501 nodes, so reusing the 500-node snapshot
// cap here would leave its final node permanently unreachable.
const MAX_DEPENDENCY_GRAPH_EXPANDED_NODES = 1_000;

// Creating/resuming every session at once can exhaust the API request deadline on large batches.
// This bounds control-plane initialization only; `batchMaxConcurrent` remains the authoritative,
// independent limit for how many of those sessions the runners may execute at the same time.
export const BATCH_EXECUTE_DISPATCH_CONCURRENCY = 12;

export interface ListTasksPageQuery {
  cursor?: string;
  limit?: string | number;
  status?: string;
  listId?: string;
  /**
   * Tasks filed under exactly this project. A scope like `listId`, not a lookup: it is applied
   * alongside the owner filter and never checked against the project table, so an id that does not
   * exist — or exists under another owner — narrows to nothing and answers as an empty list. That
   * is deliberate. Answering 404 here would make this endpoint report whether a project id exists
   * to a caller who is not allowed to read it, which is a question about somebody else's account.
   */
  projectId?: string;
  assigneeId?: string;
  /** Tasks carrying ALL of these labels. Comma-separated, or repeated. */
  labels?: string | string[];
  q?: string;
  /** `'none'` drops the aggregate block (and `total`) from the response. Omitted = include it. */
  counts?: string;
}

/** The scope-wide tallies: identical for every tab, because none of them reads a filter. */
export interface TaskCounts {
  total: number;
  open: number;
  inProgress: number;
  done: number;
  failed: number;
  cancelled: number;
  running: number;
  queued: number;
  runnable: number;
}

export interface LabelSummaryQuery {
  listId?: string;
  assigneeId?: string;
}

/** How many labels one summary reports. See labelSummary for why it is capped at all. */
export const TASK_LABEL_SUMMARY_MAX = 500;

/**
 * How many rows the active strip shows before it starts counting instead. Sized for reading, not
 * for completeness: past a screenful the strip has stopped being a glance and the Failed tab is
 * the better answer.
 */
export const ACTIVE_TASK_STRIP_MAX = 50;

export interface DependencyGraphQuery {
  direction?: string;
  maxDepth?: string | number;
  maxNodes?: string | number;
  /** Opt-in display sampling that keeps one-edge continuations with admitted nodes. */
  pairUnary?: string | boolean;
}

export type DependencyGraphDirection = 'upstream' | 'both';
export type DependencyGraphBranchDirection = 'prerequisites' | 'dependents';

export interface ExpandDependencyGraphQuery {
  anchorTaskId: string;
  direction: DependencyGraphBranchDirection | string;
  knownTaskIds: string[];
  loadedNeighborTaskIds: string[];
  limit?: string | number;
  cursor: string;
}

export interface DependencyGraphNode {
  id: string;
  title: string;
  status: TaskStatus;
  autoRunWhenReady: boolean;
  depth: number;
  prerequisiteCount?: number;
  dependentCount?: number;
}

export interface DependencyGraphCollapsedGroup {
  anchorTaskId: string;
  direction: DependencyGraphBranchDirection;
  /** Direct anchor-side relationships whose edge is not present in this snapshot. */
  hiddenCount: number;
  /** Null only when the bounded client snapshot has reached its absolute node cap. */
  cursor: string | null;
}

interface DependencyGraphBranchCursor {
  version: 1;
  ownerScope: string;
  focusTaskId: string;
  anchorTaskId: string;
  direction: DependencyGraphBranchDirection;
}

interface DependencyGraphTraversalRow {
  taskId: string;
  dependsOnTaskId: string;
  task: { id: string; title: string; status: unknown; autoRunWhenReady: boolean };
  dependsOnTask: { id: string; title: string; status: unknown; autoRunWhenReady: boolean };
}

interface DependencyGraphConnectionCounts {
  prerequisiteCount: number;
  dependentCount: number;
}

interface TaskPageCursor {
  createdAt: string;
  id: string;
}

/** Exported so a second paged task read cannot invent a second cursor format: a cursor is part of
 *  the wire contract, and two encodings of "where the last page stopped" would be one client
 *  upgrade away from being handed to the wrong decoder. */
export function encodeTaskPageCursor(task: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: task.createdAt.toISOString(), id: task.id } satisfies TaskPageCursor),
  ).toString('base64url');
}

export function decodeTaskPageCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as TaskPageCursor;
    const createdAt = new Date(parsed.createdAt);
    if (!UUID_RE.test(parsed.id) || Number.isNaN(createdAt.getTime())) throw new Error('invalid');
    return { createdAt, id: parsed.id };
  } catch {
    throw new BadRequestException('invalid task cursor');
  }
}

function dependencyGraphOwnerScope(ownerId: string): string {
  return createHash('sha256').update(`dependency-graph-owner:${ownerId}`).digest('base64url');
}

function encodeDependencyGraphBranchCursor(
  ownerId: string,
  focusTaskId: string,
  anchorTaskId: string,
  direction: DependencyGraphBranchDirection,
): string {
  const cursor: DependencyGraphBranchCursor = {
    version: 1,
    ownerScope: dependencyGraphOwnerScope(ownerId),
    focusTaskId,
    anchorTaskId,
    direction,
  };
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeDependencyGraphBranchCursor(cursor: string): DependencyGraphBranchCursor {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    ) as Partial<DependencyGraphBranchCursor>;
    if (
      parsed.version !== 1 ||
      typeof parsed.ownerScope !== 'string' ||
      !UUID_RE.test(parsed.focusTaskId ?? '') ||
      !UUID_RE.test(parsed.anchorTaskId ?? '') ||
      (parsed.direction !== 'prerequisites' && parsed.direction !== 'dependents')
    ) {
      throw new Error('invalid');
    }
    return parsed as DependencyGraphBranchCursor;
  } catch {
    throw new BadRequestException('invalid dependency graph expansion cursor');
  }
}

function dependencyGraphLimit(
  value: string | number | undefined,
  fallback: number,
  name: 'maxDepth' | 'maxNodes',
  maximum: number,
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new BadRequestException(`${name} must be an integer from 1 to ${maximum}`);
  }
  return parsed;
}

function dependencyGraphExpansionLimit(value: string | number | undefined): number {
  if (value === undefined) return DEFAULT_DEPENDENCY_GRAPH_EXPANSION_BATCH_SIZE;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_DEPENDENCY_GRAPH_EXPANSION_BATCH_SIZE) {
    throw new BadRequestException(
      `limit must be an integer from 1 to ${MAX_DEPENDENCY_GRAPH_EXPANSION_BATCH_SIZE}`,
    );
  }
  return parsed;
}

function dependencyGraphBoolean(value: string | boolean | undefined, name: string): boolean {
  if (value === undefined || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  throw new BadRequestException(`${name} must be true or false`);
}

@Injectable()
export class TasksService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TasksService.name);
  private reconcileTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    // @Global RealtimeModule, so no import needed here (nor in RunnerApiModule, which also
    // instantiates this service). Used to push task changes to the owner's control-plane stream.
    private readonly realtime: RealtimeService,
    /**
     * Unit L4: the only code that reads or writes a recorded cross-project answer. Injected rather
     * than reimplemented here, so the write path and the user's decide/list endpoints cannot end up
     * with two ideas of what an approval is.
     *
     * Optional in the signature and not in the wiring: Nest resolves it from `ProjectHandoffModule`,
     * which both modules that construct this service import. The fallback is for the ~40 places that
     * build this service directly — unit specs and the e2e harness — and it is a service over THIS
     * prisma, so a directly-built TasksService behaves exactly as the injected one does rather than
     * carrying a null that only explodes when a crossing is declared.
     */
    handoffs?: ProjectHandoffService,
  ) {
    this.handoffs = handoffs ?? new ProjectHandoffService(prisma);
  }

  private readonly handoffs: ProjectHandoffService;

  onModuleInit(): void {
    // Periodic backstop for auto-run edges triggerDependents can't catch (see
    // reconcileReadyTasks). Single-replica assumption, same as ReaperService.
    this.reconcileTimer = setInterval(() => {
      // All three sweeps ride this one timer. A second setInterval is how the reconciler once
      // ended up running twice a minute (TasksService was provided by two modules), and the
      // symptom — duplicate dispatch — took a production incident to spot. Sequential, not
      // concurrent, so the foreman sees the dispatch decisions this same tick already made.
      this.reconcileReadyTasks()
        .catch((e) =>
          this.logger.error(`reconcile sweep failed: ${e instanceof Error ? e.message : e}`),
        )
        // The clock trigger rides the same timer, for the reason above and one of its own: a task
        // can be both due and dependency-ready, and running the two sweeps sequentially means the
        // second sees what the first already dispatched. A schedule is therefore honoured within
        // one RECONCILE_INTERVAL_MS of coming due, which is the resolution the field promises —
        // `run_at` is the earliest start, not an alarm.
        .then(() => this.dispatchDueScheduledTasks())
        .catch((e) =>
          this.logger.error(`scheduled sweep failed: ${e instanceof Error ? e.message : e}`),
        )
        .then(() => this.dispatchStalledListForemen())
        .catch((e) =>
          this.logger.error(`foreman sweep failed: ${e instanceof Error ? e.message : e}`),
        )
        // §13.8: the @-mention delivery ledger. On this timer and not one of its own, for the
        // reason written above — a second `setInterval` is how this service once ran its sweeps
        // twice a minute. The comment write kicks this directly too; the kick is the latency and
        // the timer is the guarantee.
        .then(() => this.deliverMentions())
        .catch((e) =>
          this.logger.error(`mention delivery sweep failed: ${e instanceof Error ? e.message : e}`),
        );
    }, RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref(); // don't keep the process alive just for this timer
  }

  onModuleDestroy(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
  }

  /**
   * A task may only be assigned to a workspace the same user owns — otherwise a user
   * could point a task at another tenant's workspace (cross-tenant routing). Mirrors
   * WorkspacesService.assertOwnedRunner / SessionsService.assertOwnedRefs.
   */
  private async assertOwnedWorkspace(ownerId: string, workspaceId?: string | null): Promise<void> {
    if (!workspaceId) return;
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, ownerId, deletedAt: null },
      select: { id: true },
    });
    if (!workspace) throw new ForbiddenException('workspace not found');
  }

  /**
   * A task may only pin a provider this caller can actually dispatch with: a built-in engine
   * slug, or one of the configured providers visible to them. Rejected here rather than at run
   * time, so a typo surfaces on the edit instead of failing every future run of the task.
   * Mirrors the identical check SessionsService.create runs on an explicit provider.
   */
  private async assertUsableProvider(ownerId: string, provider?: string | null): Promise<void> {
    if (!provider) return;
    if (Object.values(AgentProvider).includes(provider as AgentProvider)) return;
    const configured = await this.prisma.modelProvider.findFirst({
      where: { slug: provider, enabled: true, OR: [{ ownerId: null }, { ownerId }] },
      select: { slug: true },
    });
    if (!configured) throw new BadRequestException('provider not available');
  }

  /** A task may only be filed under a list the same user owns (cf. assertOwnedWorkspace). */
  private async assertOwnedList(ownerId: string, listId?: string | null): Promise<void> {
    if (!listId) return;
    const list = await this.prisma.taskList.findFirst({
      where: { id: listId, ownerId },
      select: { id: true },
    });
    if (!list) throw new ForbiddenException('task list not found');
  }

  /** A task may only be filed under a project the same user owns (cf. assertOwnedList). */
  private async assertOwnedProject(ownerId: string, projectId?: string | null): Promise<void> {
    if (!projectId) return;
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, ownerId },
      select: { id: true },
    });
    if (!project) throw new ForbiddenException('project not found');
  }

  /**
   * The error to raise when a write that named a project failed on a foreign key.
   *
   * `assertOwnedProject` answers "is this project yours" before the write; a project deleted in the
   * moment between that answer and the write itself makes the database answer instead, in its own
   * language. The outcome is correct either way — `ON DELETE RESTRICT` and the delete's row lock
   * mean a task is never left holding a project that is gone — but "Foreign key constraint
   * violated: task_project_id_fkey" surfaces as a 500, and a 500 says the server is broken when in
   * fact the rule worked. The caller asked to file work into a project that no longer exists, and
   * that is a 403 whether they lost the race by a millisecond or by a day.
   *
   * Two codes, because the same race is caught by two different guards depending on when the
   * delete commits: PostgreSQL's constraint refuses the write with P2003, while a `connect:` that
   * Prisma resolves first fails earlier with P2025 ("No 'Project' record(s) ... for a nested
   * connect"). `create` writes the column directly and raises P2003; `update` connects the
   * relation and raised whichever won the millisecond, which is exactly how this surfaced as an
   * intermittent 500 in the concurrency test rather than a consistent one.
   *
   * Narrow on purpose, in three ways. It runs only when THIS request named a project, so a failure
   * on a task that merely happens to have one is untouched. It re-reads the named projects rather
   * than parsing the constraint out of the message, so a concurrent list, assignee or parent-task
   * deletion — which raises the identical codes — is not silently relabelled: if the projects are
   * all still there, the original error is returned unchanged for whatever it was really about.
   * That re-read is what makes P2025 safe to include, since P2025 on an update can equally mean
   * the task itself is gone. And it returns the error rather than throwing it, so every call site
   * stays an explicit `throw`.
   */
  private async translateProjectFk(
    e: unknown,
    ownerId: string,
    projectIds: Array<string | null | undefined>,
  ): Promise<unknown> {
    const raced =
      e instanceof Prisma.PrismaClientKnownRequestError &&
      (e.code === 'P2003' || e.code === 'P2025');
    if (!raced) return e;
    const named = [...new Set(projectIds.filter((id): id is string => !!id))];
    if (named.length === 0) return e;
    const live = await this.prisma.project.count({ where: { id: { in: named }, ownerId } });
    if (live === named.length) return e;
    // Deliberately the same status and wording as the pre-write check, so losing the race is
    // indistinguishable to a caller from having asked a moment later.
    return new ForbiddenException('project not found');
  }

  /**
   * The parent this task may be made part of: owned by the same user, and in the same project the
   * child will be in.
   *
   * The project rule is what keeps "part of" meaningful. A subtask belongs to the whole its parent
   * belongs to; if the two could sit in different projects, then "everything in project A" and
   * "everything under task P" would describe overlapping but disagreeing sets, and neither could
   * be used to decide whether A is finished.
   *
   * Both sides are compared as `?? null`, so "no project" is one value rather than two — a task
   * with no project may parent another task with no project, which is the shape every task in this
   * deployment has today.
   *
   * `db` is the transaction the caller is writing in, so the parent read here and the write that
   * follows see the same snapshot under the same lock. The preview path passes the plain client:
   * it writes nothing, so there is nothing to serialize.
   */
  private async assertParentEligible(
    db: Prisma.TransactionClient,
    ownerId: string,
    parentTaskId: string,
    projectId: string | null,
  ): Promise<void> {
    const parent = await db.task.findFirst({
      where: { id: parentTaskId, ownerId },
      select: { id: true, projectId: true },
    });
    if (!parent) throw new NotFoundException('parent task not found');
    if ((parent.projectId ?? null) !== projectId) {
      throw new BadRequestException(
        'A subtask must be in the same project as its parent task — file both under the same ' +
          'project (or neither) before linking them',
      );
    }
  }

  /**
   * Everything that must be true of the task a verification is being pointed AT (§13.2).
   *
   * Four refusals, and each of them is a silence somewhere else if it is skipped. A subject the
   * caller does not own is a cross-tenant read. A subject that is the verifier itself is a task
   * grading its own claim. A subject that is ITSELF a verification has nothing left to check —
   * the automatic path has declined that shape since it existed, and a deliberate door should not
   * be the one that allows it. And a subject in a different project is the quiet one: aggregation
   * plans over one project's tasks, so a check filed across that line is counted by nobody,
   * `VERIFICATION_PASSED` reads it as "zero checks" and the parent it was supposed to gate
   * completes without it.
   *
   * `db` is the caller's transaction under the owner lock, so what is read here is still true
   * when the row that relies on it is written.
   */
  private async assertVerificationEligible(
    db: Prisma.TransactionClient,
    ownerId: string,
    verifierTaskId: string | null,
    verifiesTaskId: string,
    projectId: string | null,
  ): Promise<void> {
    if (verifierTaskId && verifiesTaskId === verifierTaskId) {
      throw new BadRequestException('A task cannot verify itself');
    }
    const subject = await db.task.findFirst({
      where: { id: verifiesTaskId, ownerId },
      select: { id: true, projectId: true, verifiesTaskId: true },
    });
    if (!subject) throw new NotFoundException('verified task not found');
    if (subject.verifiesTaskId) {
      throw new BadRequestException(
        'That task is itself a verification — a check of a check has nothing left to verify',
      );
    }
    if ((subject.projectId ?? null) !== projectId) {
      throw new BadRequestException(
        'A verification must be in the same project as the task it verifies — file both under ' +
          'the same project (or neither) before linking them',
      );
    }
  }

  /**
   * Recompute §13.1's parent aggregation over everything the write just touched.
   *
   * Called after the writes that can change an input to it — a status, a parent link, a policy, a
   * verdict, a task appearing or disappearing — and never before: the plan is a recomputation
   * over CURRENT children, so reading them before the write would answer the previous question.
   *
   * Best-effort, like `triggerDependents` beside it and for the same reason. A parent that could
   * not be recomputed is a parent whose status is stale, which the next write over that tree
   * fixes; failing the caller's status update to protect a derived column would lose the fact to
   * protect the summary of it.
   */
  private async recomputeAggregates(ownerId: string, seedTaskIds: string[]): Promise<string[]> {
    const seeds = [...new Set(seedTaskIds.filter((id): id is string => !!id))];
    if (!seeds.length) return [];
    const scope = await collectAggregationScope(this.prisma, ownerId, seeds);
    if (scope.truncated) {
      this.logger.warn(
        `aggregation skipped for ${seeds.length} task(s): scope exceeded ` +
          `${AGGREGATION_SCOPE_MAX_TASKS} tasks`,
      );
      return [];
    }
    const plan = planTaskAggregation(scope.facts);
    if (plan.cycleTaskIds.length) {
      // AG2. A cycle has no bottom to recompute from, so the planner returns nothing rather than
      // guessing — this only says so out loud, since a silently skipped tree looks like one that
      // had nothing to do.
      this.logger.warn(
        `aggregation skipped: ${plan.cycleTaskIds.length} task(s) lie on a parentTaskId cycle`,
      );
      return [];
    }
    if (!plan.aggregations.length) return [];
    const moved = await applyTaskAggregations(this.prisma, ownerId, plan.aggregations, new Date());
    for (const taskId of moved) {
      this.realtime.publishForUser(ownerId, RunEventType.TASK_CHANGED, taskId);
    }
    return moved;
  }

  /**
   * Walk up from `parentTaskId` and refuse the link if it comes back to `taskId`.
   *
   * One indexed lookup per level rather than loading the owner's edges wholesale, which is what
   * the dependency cycle check does: dependencies are a graph that has to be examined as a whole,
   * while parents form a forest where the only path that can close a loop is the one directly
   * above the proposed parent. On an account with six figures of tasks the difference is a handful
   * of primary-key reads against a full scan.
   *
   * The walk is bounded twice over — by `seen` and by the depth cap — so a cycle already stored by
   * some other means cannot make this loop forever. A cycle it meets on the way up is not one this
   * write is creating, so it stops rather than blaming the caller for it.
   *
   * Every step reads through `db`, the caller's transaction, which is holding the owner lock
   * (`lockDependencyGraph`). That is what makes the answer still true when the write lands:
   * unlocked, two simultaneous requests — one making A a child of B, the other B a child of A —
   * each pass against a graph that does not yet contain the other, and commit a cycle between
   * them. It is the same write skew the dependency edges take the same lock to prevent.
   */
  private async assertNoParentCycle(
    db: Prisma.TransactionClient,
    taskId: string,
    parentTaskId: string,
  ): Promise<void> {
    const seen = new Set<string>();
    let cursor: string | null = parentTaskId;
    for (let depth = 0; depth < MAX_TASK_PARENT_DEPTH && cursor; depth += 1) {
      if (cursor === taskId) {
        throw new BadRequestException('That parent task is already one of this task’s subtasks');
      }
      if (seen.has(cursor)) return;
      seen.add(cursor);
      const above: { parentTaskId: string | null } | null = await db.task.findUnique({
        where: { id: cursor },
        select: { parentTaskId: true },
      });
      cursor = above?.parentTaskId ?? null;
    }
    if (cursor) {
      throw new BadRequestException(
        `Subtask chains are limited to ${MAX_TASK_PARENT_DEPTH} levels`,
      );
    }
  }

  /**
   * Everything that must still hold about where this task sits, once `dto` is applied.
   *
   * Both columns are checked together because either one can break the same rule: re-filing a task
   * under a different project can orphan it from its parent just as surely as pointing it at a
   * parent in another project can.
   *
   * Moving a task that has subtasks is refused rather than cascaded. Cascading would mean a single
   * PATCH silently rewriting an unbounded number of rows the caller never named, and there is no
   * reader of this column yet to make that convenience worth the surprise; the error says how to
   * do it explicitly instead.
   *
   * Runs inside the caller's transaction, under the owner lock, against `current` as re-read there
   * — never against a copy loaded before the lock was taken. Both halves need it and for the same
   * reason: moving a parent into another project and linking a child to that parent are the two
   * writes that break the shared-project rule together, and each is invisible to the other until
   * one of them commits. Serialized, whichever arrives second sees the first and is refused.
   */
  private async assertHierarchyConsistent(
    db: Prisma.TransactionClient,
    ownerId: string,
    taskId: string,
    current: { projectId: string | null; parentTaskId: string | null; verifiesTaskId: string | null },
    dto: UpdateTaskDto,
  ): Promise<void> {
    if (
      dto.projectId === undefined &&
      dto.parentTaskId === undefined &&
      dto.verifiesTaskId === undefined
    ) {
      return;
    }
    const projectId = dto.projectId === undefined ? current.projectId : (dto.projectId ?? null);
    const parentTaskId =
      dto.parentTaskId === undefined ? current.parentTaskId : (dto.parentTaskId ?? null);
    const verifiesTaskId =
      dto.verifiesTaskId === undefined ? current.verifiesTaskId : (dto.verifiesTaskId ?? null);

    if (parentTaskId) {
      if (parentTaskId === taskId) {
        throw new BadRequestException('A task cannot be its own parent');
      }
      await this.assertParentEligible(db, ownerId, parentTaskId, projectId);
      await this.assertNoParentCycle(db, taskId, parentTaskId);
    }

    // Re-asked on a project move as well as on a re-point, and that is the half that matters: a
    // check and its subject sharing a project is a fact this write can break from EITHER side, and
    // a verification that has drifted out of its subject's project is counted by nobody.
    if (verifiesTaskId) {
      await this.assertVerificationEligible(db, ownerId, taskId, verifiesTaskId, projectId);
    }

    if (projectId !== current.projectId) {
      const subtasks = await db.task.count({ where: { ownerId, parentTaskId: taskId } });
      if (subtasks > 0) {
        throw new BadRequestException(
          `This task has ${subtasks} subtask(s) that would be left in a different project — ` +
            'detach them (parentTaskId: null), move them, and link them again',
        );
      }
      // The same statement from the other side of the relation. Left unchecked, moving a subject
      // out from under its checks is the quietest way to make `VERIFICATION_PASSED` complete a
      // parent over verifications that no longer count towards it.
      const checks = await db.task.count({ where: { ownerId, verifiesTaskId: taskId } });
      if (checks > 0) {
        throw new BadRequestException(
          `This task has ${checks} verification(s) that would be left in a different project — ` +
            'move or detach them before moving it',
        );
      }
    }
  }

  /** Assert every id is a task this user owns (dependency endpoints both sides). */
  private async assertOwnedTasks(ownerId: string, ids: string[]): Promise<void> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return;
    if (unique.some((id) => !UUID_RE.test(id))) throw new NotFoundException('task not found');
    const count = await this.prisma.task.count({ where: { id: { in: unique }, ownerId } });
    if (count !== unique.length) throw new NotFoundException('task not found');
  }

  /**
   * Serialize dependency-graph mutations for one owner. Locking the owner's stable row
   * avoids the write-skew where concurrent A->B and B->A requests both inspect the old
   * graph, pass cycle detection, and then commit a cycle. Every endpoint that mutates
   * edges on existing tasks (replacement/add/remove) holds this lock through its write.
   *
   * It is also rank 10 of the canonical lock order (`common/lock-order.ts`, I1): every
   * transaction here that writes more than one `task` row takes it first, which is what makes
   * two Task-writing transactions unable to deadlock with each other whatever rows they go on
   * to touch. Delegated so the order has one definition rather than one per caller.
   */
  private async lockDependencyGraph(tx: Prisma.TransactionClient, ownerId: string): Promise<void> {
    await lockOwnerTaskGraph(tx, ownerId);
  }

  /**
   * I2 of the canonical lock order: the Session rows this Task write will foreign-key check,
   * locked ahead of the first Task/edge write in one ordered `FOR KEY SHARE` statement.
   *
   * `sessionIds` are the ones the caller already knows (a create's own creator Session);
   * `taskIds` are Tasks whose rows this transaction will write more than once, whose creator
   * Sessions are read here because the caller cannot know them. Both sets go into one sorted
   * statement, so a transaction touching several Sessions can never take them in a different
   * order from another that touches the same ones.
   */
  private async preLockCreatorSessions(
    tx: Prisma.TransactionClient,
    sessionIds: ReadonlyArray<string | null | undefined>,
    taskIds: ReadonlyArray<string | null | undefined> = [],
  ): Promise<void> {
    const fromTasks = await creatorSessionsOf(tx, taskIds);
    await lockCreatorSessions(tx, [...sessionIds, ...fromTasks]);
  }

  /**
   * Derive each task's DependencyState in one batched pass: load every dependency edge
   * whose dependent is in `taskIds`, joined to its prerequisite's status, group by
   * dependent and reduce. Tasks with no prerequisites are absent (caller reads absent as
   * 'NONE'). Mirrors withRunning's single-grouped-query approach to avoid N+1.
   */
  private async dependencyStatesFor(
    ownerId: string,
    taskIds: string[],
  ): Promise<Map<string, DependencyState>> {
    return new Map([...await this.dependencyFactsFor(ownerId, taskIds)]
      .map(([taskId, facts]) => [taskId, computeDependencyState(facts)]));
  }

  /**
   * Each task's prerequisites as §13.3 DEP reads them: the status, plus why a CHECK among them has
   * no current pass behind it.
   *
   * Split out of `dependencyStatesFor` so Run Now and the batch path can say WHICH clause refused
   * them. "Prerequisites are not all complete yet" on a check that concluded FAIL is the sentence
   * that let the incident run: it describes a wait, and what happened was a refusal.
   */
  private async dependencyFactsFor(
    ownerId: string,
    taskIds: string[],
  ): Promise<Map<string, DependencyPrerequisiteFact[]>> {
    const byTask = new Map<string, Array<{ id: string; status: TaskStatus }>>();
    if (taskIds.length === 0) return new Map();
    const uniqueIds = [...new Set(taskIds)];
    for (let offset = 0; offset < uniqueIds.length; offset += TASK_ID_QUERY_CHUNK) {
      const ids = uniqueIds.slice(offset, offset + TASK_ID_QUERY_CHUNK);
      const edges = await this.prisma.taskDependency.findMany({
        where: { taskId: { in: ids } },
        select: {
          taskId: true,
          dependsOnTaskId: true,
          dependsOnTask: { select: { status: true } },
        },
      });
      for (const e of edges) {
        const entry = {
          id: e.dependsOnTaskId,
          status: e.dependsOnTask.status as unknown as TaskStatus,
        };
        const arr = byTask.get(e.taskId);
        if (arr) arr.push(entry);
        else byTask.set(e.taskId, [entry]);
      }
    }
    const epochs = await loadVerificationEpochGates(
      this.prisma,
      ownerId,
      [...byTask.values()].flat().map((entry) => entry.id),
    );
    // §13.3 DEP's self-exemption: a check that depends on the subject it checks must not be made to
    // wait for its own conclusion. Read only when some prerequisite actually HAS an epoch, which on
    // an ordinary backlog is never — this is on the path of every task page and every Run.
    const dependents = epochs.size === 0 ? new Map<string, string | null>()
      : new Map((await this.prisma.task.findMany({
        where: { id: { in: [...byTask.keys()] }, verifiesTaskId: { not: null } },
        select: { id: true, verifiesTaskId: true },
      })).map((row) => [row.id, row.verifiesTaskId]));
    return new Map([...byTask].map(([taskId, entries]) => [taskId, entries.map((entry) => ({
      status: entry.status,
      verificationGate: dependencyEpochGate(entry.id, epochs, dependents.get(taskId)),
      verificationGateStalled: dependencyEpochStalled(entry.id, epochs, dependents.get(taskId)),
    }))]));
  }


  /**
   * Derive graph-node state without hydrating every prerequisite row. A dense task can have
   * far more stored edges than the display budget; these grouped counts each return at most
   * one row per bounded graph node, keeping application memory O(nodes).
   */
  private async dependencyStatesForGraph(
    ownerId: string,
    taskIds: string[],
  ): Promise<Map<string, DependencyState>> {
    if (taskIds.length === 0) return new Map();
    const scoped = {
      taskId: { in: taskIds },
      task: { ownerId },
      dependsOnTask: { ownerId },
    } satisfies Prisma.TaskDependencyWhereInput;
    const [totals, completed, failed] = await Promise.all([
      this.prisma.taskDependency.groupBy({
        by: ['taskId'],
        where: scoped,
        _count: { _all: true },
      }),
      this.prisma.taskDependency.groupBy({
        by: ['taskId'],
        where: { ...scoped, dependsOnTask: { ownerId, status: TaskStatus.DONE } },
        _count: { _all: true },
      }),
      this.prisma.taskDependency.groupBy({
        by: ['taskId'],
        where: {
          ...scoped,
          dependsOnTask: {
            ownerId,
            status: { in: [TaskStatus.FAILED, TaskStatus.CANCELLED] },
          },
        },
        _count: { _all: true },
      }),
    ]);
    const completedByTask = new Map(completed.map((row) => [row.taskId, row._count._all]));
    const failedByTask = new Map(failed.map((row) => [row.taskId, row._count._all]));
    // §13.3 DEP, as a fourth count rather than through `computeDependencyState`: this method
    // exists to keep memory O(nodes) on a dense DAG, so it must not hydrate every prerequisite the
    // pure predicate would want. A check that is DONE without a current pass stops counting as
    // completed here too — the graph may under-state WHY (`BLOCKED` rather than `BLOCKED_FAILED`,
    // which needs the verdict), but it can no longer offer a READY the API would refuse.
    const notPassedByTask = await this.verificationBlockedCounts(ownerId, taskIds);
    const states = new Map<string, DependencyState>();
    for (const row of totals) {
      const failedCount = failedByTask.get(row.taskId) ?? 0;
      const notPassed = notPassedByTask.get(row.taskId) ?? 0;
      const completedCount = (completedByTask.get(row.taskId) ?? 0) - notPassed;
      states.set(
        row.taskId,
        failedCount > 0
          ? 'BLOCKED_FAILED'
          : completedCount === row._count._all
            ? 'READY'
            : 'BLOCKED',
      );
    }
    return states;
  }

  /**
   * Per task, how many of its DONE prerequisites are CHECKS whose subject has no open PASS epoch.
   *
   * Raw because the predicate is a correlated EXISTS over three tables and Prisma's `where` cannot
   * express it — and raw against the SHARED fragment, so this count and the sweeps' own gate cannot
   * come to different conclusions about the same edge.
   */
  private async verificationBlockedCounts(
    ownerId: string,
    taskIds: string[],
  ): Promise<Map<string, number>> {
    if (taskIds.length === 0) return new Map();
    // Only the DONE prerequisites that are CHECKS are hydrated — the rest cannot have an epoch and
    // are already counted by the grouped queries above. That keeps the O(nodes) budget this method
    // exists for while still asking the shared predicate rather than a fourth spelling of it.
    const edges = await this.prisma.taskDependency.findMany({
      where: {
        taskId: { in: taskIds },
        task: { ownerId },
        dependsOnTask: {
          ownerId,
          status: TaskStatus.DONE,
          OR: [{ verifiesTaskId: { not: null } }, { verifiedBy: { some: {} } }],
        },
      },
      select: { taskId: true, dependsOnTaskId: true, task: { select: { verifiesTaskId: true } } },
    });
    if (edges.length === 0) return new Map();
    const epochs = await loadVerificationEpochGates(
      this.prisma,
      ownerId,
      edges.map((edge) => edge.dependsOnTaskId),
    );
    const counts = new Map<string, number>();
    for (const edge of edges) {
      const gate = dependencyEpochGate(
        edge.dependsOnTaskId, epochs, edge.task?.verifiesTaskId ?? null,
      );
      if (gate == null) continue;
      counts.set(edge.taskId, (counts.get(edge.taskId) ?? 0) + 1);
    }
    return counts;
  }

  /**
   * Count both sides of every requested node without hydrating its incident edges. These
   * exact counts let the client render a compact "+N" boundary even when the loaded
   * induced-edge snapshot is capped.
   */
  private async dependencyConnectionCounts(
    ownerId: string,
    taskIds: string[],
  ): Promise<Map<string, DependencyGraphConnectionCounts>> {
    if (taskIds.length === 0) return new Map();
    const ownerScope = {
      task: { ownerId },
      dependsOnTask: { ownerId },
    } satisfies Prisma.TaskDependencyWhereInput;
    const [prerequisites, dependents] = await Promise.all([
      this.prisma.taskDependency.groupBy({
        by: ['taskId'],
        where: { ...ownerScope, taskId: { in: taskIds } },
        _count: { _all: true },
      }),
      this.prisma.taskDependency.groupBy({
        by: ['dependsOnTaskId'],
        where: { ...ownerScope, dependsOnTaskId: { in: taskIds } },
        _count: { _all: true },
      }),
    ]);
    const counts = new Map<string, DependencyGraphConnectionCounts>(
      taskIds.map((id) => [id, { prerequisiteCount: 0, dependentCount: 0 }]),
    );
    for (const row of prerequisites) counts.get(row.taskId)!.prerequisiteCount = row._count._all;
    for (const row of dependents) {
      counts.get(row.dependsOnTaskId)!.dependentCount = row._count._all;
    }
    return counts;
  }

  /** Build exact per-anchor boundary groups from full degree counts minus loaded edges. */
  private dependencyGraphCollapsedGroups(
    ownerId: string,
    focusTaskId: string,
    graphDirection: DependencyGraphDirection,
    nodeIds: string[],
    edges: Iterable<{ sourceTaskId: string; targetTaskId: string }>,
    connectionCounts: ReadonlyMap<string, DependencyGraphConnectionCounts>,
  ): DependencyGraphCollapsedGroup[] {
    const known = new Set(nodeIds);
    const loadedPrerequisites = new Map<string, Set<string>>();
    const loadedDependents = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (!known.has(edge.sourceTaskId) || !known.has(edge.targetTaskId)) continue;
      const prerequisites = loadedPrerequisites.get(edge.targetTaskId) ?? new Set<string>();
      prerequisites.add(edge.sourceTaskId);
      loadedPrerequisites.set(edge.targetTaskId, prerequisites);
      const dependents = loadedDependents.get(edge.sourceTaskId) ?? new Set<string>();
      dependents.add(edge.targetTaskId);
      loadedDependents.set(edge.sourceTaskId, dependents);
    }

    const directions: DependencyGraphBranchDirection[] =
      graphDirection === 'both' ? ['prerequisites', 'dependents'] : ['prerequisites'];
    const hasCapacity = nodeIds.length < MAX_DEPENDENCY_GRAPH_EXPANDED_NODES;
    const groups: DependencyGraphCollapsedGroup[] = [];
    for (const anchorTaskId of nodeIds) {
      const counts = connectionCounts.get(anchorTaskId) ?? {
        prerequisiteCount: 0,
        dependentCount: 0,
      };
      for (const direction of directions) {
        const total =
          direction === 'prerequisites' ? counts.prerequisiteCount : counts.dependentCount;
        const loaded =
          direction === 'prerequisites'
            ? (loadedPrerequisites.get(anchorTaskId)?.size ?? 0)
            : (loadedDependents.get(anchorTaskId)?.size ?? 0);
        const hiddenCount = Math.max(0, total - loaded);
        if (hiddenCount === 0) continue;
        groups.push({
          anchorTaskId,
          direction,
          hiddenCount,
          cursor: hasCapacity
            ? encodeDependencyGraphBranchCursor(ownerId, focusTaskId, anchorTaskId, direction)
            : null,
        });
      }
    }
    return groups;
  }

  /**
   * Validate a workspace belongs to the owner and return it as a task/comment creator.
   * Used by the runner MCP path to attribute work to the acting workspace. Returns
   * undefined when no workspace id is supplied so callers fall back to USER attribution.
   */
  async resolveAgentCreator(ownerId: string, workspaceId?: string): Promise<Creator | undefined> {
    if (!workspaceId) return undefined;
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, ownerId },
      select: { id: true },
    });
    if (!workspace) throw new ForbiddenException('workspace not found');
    return { type: CreatorType.AGENT, id: workspace.id };
  }

  /**
   * §13.6 SU7: make THIS new task the successor of an attempt that already stopped, in the same
   * transaction that created it.
   *
   * Why this exists as a write and not as advice
   * -------------------------------------------
   * The relation SU1 froze has, until now, only had a two-step entrance: create the replacement,
   * then remember to go back and PATCH the attempt it replaced. This deployment's own incident is
   * what that costs. The fresh review 6R was created with "replacement for the earlier attempt"
   * written in its DESCRIPTION and nothing else; the old task kept a terminal status and an empty
   * `superseded_by_task_id`, because the second step is a thing a person or an agent has to
   * remember at a moment when the interesting work is already done. Nothing anywhere read the
   * description, so every gate downstream — the boot recovery scan, §7.8's pass, §9.2 — saw an
   * ordinary unfinished failure and eventually acted on it.
   *
   * A prompt cannot fix that, and neither can a docs line: they are both the same reminder, and
   * the failure mode is forgetting. One call that cannot create the successor WITHOUT recording
   * what it replaces is a different shape of thing.
   *
   * Concurrency (SU7-b)
   * -------------------
   * Two agents both deciding to redo the same attempt is the ordinary case, not the exotic one.
   * The link is written as a compare-and-set against "nothing has claimed this attempt yet", so
   * exactly one of them wins and the loser is told which task took over instead of quietly
   * overwriting a pointer — the fact being recorded is WHO replaced it, and last-write-wins would
   * make that answer depend on scheduling. The row is locked FOR UPDATE first so the two
   * transactions serialize on the predecessor rather than both reading it unlinked.
   *
   * Nothing here writes `status` (SU4): the predecessor keeps the CANCELLED or FAILED it already
   * had, which is the fact being preserved.
   */
  /**
   * §13.6 SU7-c: the replay contract. What "this create already happened" is allowed to mean when
   * the create also claimed to replace something.
   *
   * A task create is idempotent on `(session, turn, title, description)` — a redelivered turn
   * re-runs and must not write the task twice. That key deliberately does NOT carry
   * `supersedesTaskId`, and it must not start to: two creates with the same title in the same turn
   * ARE the same create, and letting a different predecessor mint a second key would turn one
   * redelivery into two tasks.
   *
   * But "the task already exists" is not the same claim as "the supersession already happened", and
   * the early return that answers the first was silently answering the second. Three ways in:
   *
   *  - a re-run whose first attempt did not pass `supersedesTaskId` and whose second does;
   *  - two creates with the same title and description in one turn naming DIFFERENT predecessors;
   *  - the duplicate-key race, where the loser reads back the winner's row.
   *
   * In each, the caller was told the create succeeded and no link exists. That is the exact failure
   * this whole unit is about — a replacement that nothing structured connects to what it replaced —
   * arriving through the door built to prevent it.
   *
   * So the existing row is CHECKED rather than assumed: the predecessor must already name this very
   * task and already be terminal-consistent. Anything else is a typed 409, never a quiet success.
   */
  private async assertSupersessionAlreadyRecorded(
    db: Prisma.TransactionClient,
    ownerId: string,
    predecessorId: string,
    successorId: string,
  ): Promise<void> {
    const predecessor = await db.task.findFirst({
      where: { id: predecessorId, ownerId },
      select: { id: true, supersededByTaskId: true, terminalReason: true },
    });
    if (!predecessor) throw new NotFoundException('the task being superseded was not found');
    if (predecessor.supersededByTaskId === successorId
        && predecessor.terminalReason === 'SUPERSEDED') {
      return;
    }
    throw new ConflictException(
      `task ${uuidToBase62(successorId)} already exists but does not supersede ` +
        `${uuidToBase62(predecessorId)}` +
        (predecessor.supersededByTaskId
          ? ` — that attempt was superseded by ${uuidToBase62(predecessor.supersededByTaskId)}`
          : ' — that attempt has no successor recorded') +
        '. Record the supersession explicitly with task_update rather than through a create that ' +
        'has already happened',
    );
  }

  /**
   * §13.6 SU8: an attempt somebody is RUNNING right now may not be retired.
   *
   * The other direction of the race 0130's Session guard closes, and it is reachable without any
   * mixed-version binary. A legacy execute commits its Session first and flips the task's status
   * second (`clearFailedForRetry`); a supersession that lands in that window takes the task row
   * while it still reads `FAILED`, sees no reason to refuse, and commits. What is left is a PENDING
   * Session executing a task the control plane has marked as replaced — the Session guard cannot
   * help, because the Session was inserted before the link existed.
   *
   * Read AFTER the predecessor's row is locked `FOR UPDATE` by the caller, which is what makes this
   * a fence rather than a check: `session_dispatch_authority_guard` and 0130's own guard both take
   * `FOR SHARE` on that same task row before inserting, so the two orders are the only two, and
   * each has a typed answer —
   *
   *   Session commits first → its `FOR SHARE` is released, this UPDATE proceeds, and the read below
   *     sees the live Session and refuses the link;
   *   link commits first → the insert's `FOR SHARE` waits on this UPDATE's row lock, then sees the
   *     retirement and refuses the Session.
   *
   * Neither can observe the other as absent, and neither outcome is a half-written world.
   *
   * All four live statuses (§4.2 guard 5), not the two the claim index used to carry: a run paused
   * at `AWAITING_INPUT` is a conversation somebody is in the middle of, and retiring its task out
   * from under it is the same accident with a person watching.
   */
  /**
   * §13.6 SU8's lock, taken NOWAIT — and why it is not an ordinary `FOR UPDATE`.
   *
   * There are two orders in which this pair of rows is taken, and they are opposite:
   *
   *   Project → Task   this path. The supersession columns are inputs to §13.4's acceptance, so
   *                    0130 puts them on `project_acceptance_task_fact_update`, which reaches
   *                    `project_acceptance_reopen` and takes the PROJECT row. The prelock above
   *                    takes it first so that AFTER trigger is not the thing that takes it.
   *   Task → Project   a Session INSERT. Its `BEFORE INSERT` triggers fire in NAME order:
   *                    `session_dispatch_authority_guard` takes the task `FOR SHARE`, and then
   *                    `session_project_capacity_serialize` updates the project row.
   *
   * Interleaved, that is a cycle: this transaction holds the project and wants the task, the insert
   * holds the task and wants the project. PostgreSQL resolves it — by killing whichever it likes,
   * with a 40P01 that reaches a caller as a 500 and reaches an operator as noise. "Deterministic"
   * is the whole property this unit is about, and a deadlock detector picking a victim is the
   * opposite of it.
   *
   * NOWAIT makes the outcome a function of who committed first rather than of who was scheduled:
   *
   *   the Session got there first → this fails IMMEDIATELY with 55P03, and the caller is told a run
   *     is starting on that attempt (the same sentence `assertNotRunningBeforeRetiring` gives when
   *     the run is already visible — one refusal, two ways of arriving at it);
   *   this got there first → the insert's `FOR SHARE` waits on this transaction, and when it wakes
   *     up `session_superseded_task_guard` sees the retirement and refuses the Session.
   *
   * Neither side ever waits on a lock the other side is waiting on, so no cycle can form and the
   * caller always receives a refusal it can act on. Reversing this path to Task → Project instead
   * would mean the acceptance reopen took the project from inside an AFTER trigger, which is the
   * inversion against the Coordinator's own project-lease-then-task order that the prelock exists
   * to remove — the cycle would move rather than close.
   */
  private async lockTaskForSupersessionWrite(
    tx: Prisma.TransactionClient,
    taskId: string,
  ): Promise<void> {
    try {
      await tx.$queryRaw`SELECT 1 FROM "task" WHERE "id" = ${taskId}::uuid FOR UPDATE NOWAIT`;
    } catch (error) {
      // 55P03 from either side of the fence: this statement's own NOWAIT, or 0130's
      // `task_supersession_project_lock_order` refusing because the project is being reconciled.
      // Both mean the same thing to a caller — nothing was written, and retrying is the answer.
      if (!isLockNotAvailable(error)) throw error;
      throw new ConflictException(
        `task ${uuidToBase62(taskId)} is being written by a run starting on it right now, so its ` +
          'supersession cannot be recorded in this request — nothing was written; retry once that ' +
          'run has been created, and record the supersession after it reaches a terminal status',
      );
    }
  }

  private async assertNotRunningBeforeRetiring(
    tx: Prisma.TransactionClient,
    ownerId: string,
    taskId: string,
  ): Promise<void> {
    const live = await tx.$queryRaw<Array<{ id: string; status: string }>>(Prisma.sql`
      SELECT s."id", s."status"::text AS "status" FROM "session" s
       WHERE s."task_id" = ${taskId}::uuid AND s."owner_id" = ${ownerId}::uuid
         AND s."deleted_at" IS NULL
         -- Every task-linked session this release creates starts the task's work, so "any live
         -- run" and "any live work run" are the same set today; the two diverge in the follow-up
         -- migration that also narrows the execution claim.
         AND s."status"::text IN (${Prisma.raw(PROJECT_LIVE_SESSION_STATUS_SQL)})
       ORDER BY s."id"
       LIMIT 1
    `);
    if (live[0]) {
      // The guidance has to be reachable from the predicate that produced it. INTERRUPTED is one
      // of the four statuses counted as live above, so "interrupt it" would name an action that
      // leaves this check refusing for the same reason — and cancelling or force-ending a run to
      // clear a bookkeeping refusal is the thing this project does not do: a session that is
      // stopped to make a write succeed loses whatever it was in the middle of. What actually
      // frees the task is the run REACHING a terminal status of its own.
      throw new ConflictException(
        `task ${uuidToBase62(taskId)} still has a live session (${uuidToBase62(live[0].id)}, ` +
          `${live[0].status}) — wait for it to reach a terminal status of its own (SUCCEEDED, ` +
          'FAILED or CANCELLED), or drive it there through the work itself, and then record the ' +
          'supersession. Interrupting it does not release the task: INTERRUPTED is still a live, ' +
          'resumable run',
      );
    }
  }

  private async linkSupersededBy(
    tx: Prisma.TransactionClient,
    ownerId: string,
    predecessorId: string,
    successor: { id: string; projectId: string | null },
    now: Date,
  ): Promise<void> {
    // NOWAIT, then read. See `lockTaskForSupersessionWrite` for the cycle this refuses to join.
    await this.lockTaskForSupersessionWrite(tx, predecessorId);
    const [predecessor] = await tx.$queryRaw<Array<{
      id: string; status: string; projectId: string | null;
      supersededByTaskId: string | null; terminalReason: string | null;
    }>>(Prisma.sql`
      SELECT t."id", t."status"::text AS "status", t."project_id" AS "projectId",
             t."superseded_by_task_id" AS "supersededByTaskId",
             t."terminal_reason" AS "terminalReason"
        FROM "task" t
       WHERE t."id" = ${predecessorId}::uuid AND t."owner_id" = ${ownerId}::uuid
    `);
    if (!predecessor) throw new NotFoundException('the task being superseded was not found');
    // The same sentences `update` answers with, from the same function, so one rule cannot be
    // phrased two ways depending on which door the caller came through.
    const refusal = supersessionRefusal({
      taskId: predecessorId,
      status: predecessor.status,
      successor: { id: successor.id, ownerId, projectId: successor.projectId ?? null },
      ownerId,
      projectId: predecessor.projectId ?? null,
    });
    if (refusal) throw new BadRequestException(refusal);
    const already = taskRetirement(predecessor);
    if (already) {
      throw new ConflictException(
        already === 'SUPERSEDED' && predecessor.supersededByTaskId
          ? `task ${uuidToBase62(predecessorId)} has already been superseded by ` +
            `${uuidToBase62(predecessor.supersededByTaskId)}`
          : `task ${uuidToBase62(predecessorId)} is already ${already} — unlink it first if this ` +
            'is genuinely the attempt that took over',
      );
    }
    await this.assertNotRunningBeforeRetiring(tx, ownerId, predecessorId);
    // One statement for all three columns: 0128's `task_superseded_link_check` is about the three
    // of them at once and PostgreSQL evaluates a CHECK per statement. The predicate repeats the
    // read above as a CAS, so the loser of a race writes nothing rather than overwriting.
    const linked = await tx.$executeRaw`
      UPDATE "task"
         SET "superseded_by_task_id" = ${successor.id}::uuid,
             "superseded_at"         = ${now},
             "terminal_reason"       = 'SUPERSEDED'
       WHERE "id" = ${predecessorId}::uuid AND "owner_id" = ${ownerId}::uuid
         AND "superseded_by_task_id" IS NULL AND "terminal_reason" IS NULL`;
    if (linked !== 1) {
      throw new ConflictException(
        `task ${uuidToBase62(predecessorId)} was superseded by another attempt while this one was ` +
          'being created',
      );
    }
  }

  /**
   * How a Task write asks for the shared whole-transaction retry.
   *
   * The loop, the classifier, the backoff and the log line are all `common/transaction-retry`'s —
   * a second local answer to "did the database abort this?" or "what does that look like in the
   * log" could only ever drift from the first. All this adds is which logger the line goes to and
   * what the operation is called.
   */
  private transientWriteRetry(
    operation: string,
    policy: Parameters<typeof loggedRetry>[2] = {},
  ): TransactionRetryOptions {
    return loggedRetry(this.logger, operation, policy);
  }

  async create(ownerId: string, dto: CreateTaskDto, creator?: Creator, creatorSessionId?: string) {
    if (!dto.title) throw new BadRequestException('title is required');
    await this.assertOwnedWorkspace(ownerId, dto.assigneeId);
    await this.assertOwnedList(ownerId, dto.listId);
    await this.assertOwnedProject(ownerId, dto.projectId);
    await this.assertUsableProvider(ownerId, dto.provider);
    // Link to the originating session only when it's one this owner has (the runner
    // injects its own session id, so this is a guard, not a trust boundary). A stale id
    // would otherwise fail the FK insert.
    const origin = await this.resolveOwnedSession(ownerId, creatorSessionId);
    const sessionId = origin?.sessionId;
    // Best-effort idempotency: a redelivered turn re-runs and re-creates the same tasks. A key is
    // only formed inside a live turn; without one this stays exactly the old create path. Checking
    // first lets the common (sequential) re-run return the original task without a write attempt.
    const turnId = sessionId ? await this.currentTurnId(sessionId) : undefined;
    const idempotentWrite: IdempotentTaskWrite | undefined =
      sessionId && turnId
        ? {
            operation: 'CREATE_TASK',
            sessionId,
            turnId,
            title: dto.title,
            description: dto.description,
          }
        : undefined;
    const idempotencyKey = idempotentWrite ? this.taskIdempotencyKey(idempotentWrite) : undefined;
    // WINNER FIRST, and unit L3's gate strictly after it (§3 SC4, §6's `FILED --SCOPE_LOST--> FILED`).
    //
    // The order is the whole of the contract's promise that a replay is the same write. Gate first
    // and a retry stops being idempotent in both directions: after a lost response and a rotation,
    // the retry is refused (R5/R2/R3) and can never reach the row it already committed, so the
    // caller has no way to learn it succeeded; and a retry whose session has since drifted to
    // another project is ADMITTED for that project and then handed the original row from the first
    // one — an admission whose answer contradicts its own result. Reading the winner first makes
    // both impossible: an already-committed unit of work is looked up, never re-decided, exactly as
    // §6 says a takeover must not undo what is already persisted.
    //
    // This grants nothing. The key is a hash over (session, turn, title, description) and the
    // session and turn are server-derived, so a caller cannot aim one at a row it did not write;
    // the winner is owner-checked below; and no row is written on this path at all.
    const winner = idempotentWrite
      ? await this.idempotencyWinner(this.prisma, ownerId, idempotentWrite)
      : null;
    if (winner) {
      // SU7-c: "already created" may not stand in for "already linked". See
      // `assertSupersessionAlreadyRecorded`.
      if (dto.supersedesTaskId) {
        await this.assertSupersessionAlreadyRecorded(
          this.prisma, ownerId, dto.supersedesTaskId, winner.id,
        );
      }
      this.auditReplayedProject(winner, dto.projectId);
      return winner;
    }
    // Unit L3 §4: which project this create actually lands in. Decided by the server from the
    // session's coordination scope, not from whatever the caller named — and decided before the
    // transaction, so a refusal is deterministic and leaves nothing behind (AC1).
    //
    // Keyed on `creatorSessionId`, not on the `sessionId` that survived the ownership check: a
    // session id that does not resolve must become an agent with NO scope (refused by R5), never
    // an absent one — which is the owner, whom §4 R1 exempts from all of this.
    const scopeWrite: ScopeWriteInput = {
      operation: 'CREATE_TASK',
      taskId: null,
      requestedProjectId: dto.projectId === undefined ? undefined : (dto.projectId ?? null),
      currentProjectId: null,
      scopeToken: dto.scopeToken,
    };
    const scopeWorld = await this.projectScopeWorld(
      this.prisma, ownerId, creatorSessionId, [scopeWrite],
    );
    // Unit L4: one moment for the whole write. Outside the retry closure on purpose — a second
    // attempt must spend the same approval under the same expiry, not a fresher one.
    const now = new Date();
    // Unit L4: does this write DECLARE that it crosses into another project (§4 SC5)? If it does,
    // the answer the user gave about that crossing is what R9–R14 read, and a crossing with no
    // answer yet files the question rather than failing silently.
    const crossing = this.declaredCrossing(
      ownerId,
      dto,
      this.handoffIdentityOf(dto as CreateTaskBatchItemDto, origin, new Map()),
      scopeWorld.scope,
      creatorSessionId,
    );
    const admitted = await this.admitDeclaredWrite(ownerId, scopeWorld, scopeWrite, crossing, now);
    const scopedProjectId = admitted.projectId;
    // The derived project needs no `assertOwnedProject`: it is the project the scope derivation
    // already read under this owner. A project the CALLER named was checked above.
    if ((dto.projectId ?? null) !== scopedProjectId) {
      dto = { ...dto, projectId: scopedProjectId ?? undefined };
    }
    // Validate prerequisites up front so we never create a task and then reject its deps.
    // No cycle check needed: a brand-new task has no dependents, so it can't close a loop.
    const dependsOnTaskIds = [...new Set(dto.dependsOnTaskIds ?? [])];
    if (dependsOnTaskIds.length) await this.assertOwnedTasks(ownerId, dependsOnTaskIds);
    // Unit L4: a single create is a plan of one, and every dimension a fifty-item plan is judged on
    // applies to it — the same function, the same facts, so the two can never answer differently.
    const singleItem = [dto as CreateTaskBatchItemDto];
    const noneFrozen = new Set<number>();
    const preflighting = this.planNeedsPreflight(scopeWorld, singleItem);
    const referencedTasks = preflighting
      ? await this.referencedTaskFacts(ownerId, singleItem)
      : {};
    const dependencyCrossings: DependencyCrossings = preflighting
      ? await this.resolveDependencyCrossings(
          ownerId, singleItem,
          [this.handoffIdentityOf(dto as CreateTaskBatchItemDto, origin, new Map())],
          referencedTasks, scopeWorld, creatorSessionId, now, noneFrozen,
        )
      : { answers: {}, edges: [] };
    const planAdmission = preflighting
      ? await this.assertPlanPreflight(
          ownerId, singleItem, scopeWorld, referencedTasks, dependencyCrossings.answers, noneFrozen,
        )
      : null;
    const data = this.taskCreateData(
      ownerId,
      dto,
      creator,
      origin,
      idempotencyKey,
      await this.pausedListIds(ownerId, [dto.listId]),
    );
    // Initial edges and their task must become visible atomically. Taking the same owner lock
    // used by add/replace prevents a concurrent reverse-edge write from observing the new task
    // before its prerequisites and closing a cycle. Any FK/write failure rolls the task back too.
    //
    // A parent link takes the same lock, and for the same shape of reason: the parent's project is
    // read here and relied on by the row written next, so a concurrent move of that parent into
    // another project has to be either wholly before or wholly after this. No cycle check is
    // needed, though — a task that does not exist yet has no subtasks, so nothing can close a loop
    // through it.
    //
    // A create that names no link goes through the same transaction, rather than the bare
    // `task.create` this used to fall back to. Two reasons, and the first is the canonical order:
    // the INSERT's own `task_creator_session_id_fkey` and `task_list_id_fkey` checks take FOR KEY
    // SHARE on the creator Session and the list anyway, so the pre-locks above take no lock the
    // statement was not going to take — they only take them in rank order, up front, which is what
    // stops a Session lock landing in the middle of a Task write (lock-order.ts, I2; the shape of
    // the 2026-08-21 05:53:11 cycle). The second is retrying: a deadlock victim has to re-run a
    // whole unit of work from a new snapshot, and a unit of work has to be a transaction to be
    // re-runnable at all.
    //
    // Which is what `withTransactionRetry` does here: every attempt calls `$transaction` afresh
    // with this same closure, so a 40P01/40001 victim retakes its locks in order and re-derives
    // everything it read. Nothing outside the closure moves between attempts — `data` and its
    // idempotency key are computed once above, so a retry re-inserts the same row rather than a
    // second one — and the realtime publish below is outside the loop, so it happens once, after
    // the attempt that actually committed. A conflict that outlives the attempts is rethrown
    // unchanged for the global boundary to answer 503 (common/transient-db-conflict.filter).
    let task: Task;
    try {
      task = await withTransactionRetry(
        this.prisma,
        async (tx) => {
          // Rank 10 only when this write actually restructures the graph. A plain create
          // must not queue behind another request's DAG rewrite just to be ordered.
          if (
            dependsOnTaskIds.length ||
            dto.parentTaskId ||
            dto.verifiesTaskId ||
            dto.supersedesTaskId
          ) {
            await this.lockDependencyGraph(tx, ownerId);
          }
          // Unit L4, rank 15: the workspaces and providers this plan was admitted against, before
          // the lists and sessions below and before anything is written.
          if (planAdmission) {
            await this.lockPlanExecutionIdentity(
              tx, ownerId, planAdmission.workspaceIds, planAdmission.providerSlugs,
            );
          }
          // Rank 20 and 30, before the first Task/FK write below. A supersession writes a SECOND
          // task row — the predecessor's retirement — so that row's creator Session goes into the
          // same ordered rank-30 statement (lock-order.ts, I2): a task row written twice in one
          // transaction re-runs `task_creator_session_id_fkey` and takes FOR KEY SHARE on it.
          await lockTaskLists(tx, [dto.listId]);
          await this.preLockCreatorSessions(tx, [sessionId], [dto.supersedesTaskId]);
          // §13.6 SU7 + AE6-a's lock order, stated rather than left to the triggers.
          //
          // Two things in this transaction reach `project_acceptance_reopen`, and both take the
          // PROJECT row: the task INSERT (0127's `task.created` fact) and the predecessor's
          // retirement (0130 adds the two supersession columns to the same trigger). The
          // Coordinator's dispatch takes project-then-task, so this has to as well or the two
          // wait on each other. Rank 40 — after the Session pre-lock, before any task row — so
          // the order through this path is always user → task_list → session → project → task,
          // and SU3 guarantees there is exactly ONE project involved: the successor must be in
          // the predecessor's.
          // Unit L3, rank 40: the scope this write was admitted under, re-locked and re-read here
          // so a rotation that commits between the admission and this INSERT refuses it instead of
          // being written straight past. It takes the supersession pre-lock's project too, so this
          // transaction's rank-40 locks are one sorted pass — the statement below then re-locks a
          // row it already holds, which costs nothing and cannot invert.
          await this.refenceProjectScope(
            tx, ownerId, creatorSessionId, scopeWorld,
            [{ ...scopeWrite, boundProjectId: scopedProjectId }],
            // Unit L4: every project this write's admission depended on, in ONE sorted rank-40
            // pass. The project it lands in is not enough — a declared crossing lands in B and
            // derives its authority from A, a dependency edge is decided by the project at the far
            // end of it, and a plan admitted against an acceptance epoch or a budget has to hold
            // that project's row before it re-reads them. This is also the whole of the lock an
            // owner's plan takes: §4 R1 exempts them from the SCOPE, not from the world moving.
            [
              scopedProjectId,
              scopeWorld.scope?.projectId,
              ...dependencyCrossings.edges.map((edge) => edge.authority.toProjectId),
              ...(dto.supersedesTaskId ? [dto.projectId] : []),
            ],
          );
          if (dto.supersedesTaskId && dto.projectId) {
            await tx.$queryRaw`
              SELECT 1 FROM "project" WHERE "id" = ${dto.projectId}::uuid FOR NO KEY UPDATE`;
          }
          if (dto.parentTaskId) {
            await this.assertParentEligible(tx, ownerId, dto.parentTaskId, dto.projectId ?? null);
          }
          // Same lock and the same reason as the parent above: the subject's project is read
          // here and relied on by the row written next, so a concurrent move of that subject
          // into another project has to be wholly before or wholly after this. No self-check
          // is possible — the verifier does not exist yet.
          if (dto.verifiesTaskId) {
            await this.assertVerificationEligible(
              tx,
              ownerId,
              null,
              dto.verifiesTaskId,
              dto.projectId ?? null,
            );
          }
          // Unit L4: everything the preflight decided on, re-read under the locks now held. A
          // reopen, a soft-deleted workspace, a disabled provider or a lowered budget between the
          // admission and here refuses the whole write rather than being written past.
          if (planAdmission) {
            if (planAdmission) await this.assertPlanAuthorityUnchanged(tx, ownerId, planAdmission.snapshot);
          }
          // And the crossings again, under a lock on the prerequisites this time (rank 50, sorted).
          // The preflight read their projects without one, and a move takes a mode that read does
          // not conflict with.
          await this.assertDependencyCrossingsAtEffect(
            tx, ownerId, dependencyCrossings.edges, now,
          );
          const created = await tx.task.create({ data });
          // Unit L4's `APPLY`: the yes is spent on this task, in the transaction that wrote it. A
          // second application updates no row, throws, and takes this task with it — which is what
          // makes "one approval, one task" a property of the row rather than of the call order.
          // Unit L4's `APPLY`, for every yes this write spends: the crossing that filed the task,
          // and one per cross-project edge it draws. Sorted by approval id inside `spendAll`, so
          // two batches naming the same approvals in opposite item orders cannot deadlock on them.
          await this.handoffs.spendAll(tx, [
            ...(admitted.spend
              ? [{ ...admitted.spend, taskId: created.id }]
              : []),
            ...dependencyCrossings.edges
              .filter((edge) => edge.handoffId)
              .map((edge) => ({
                authority: edge.authority,
                handoffId: edge.handoffId!,
                taskId: created.id,
              })),
          ], now, scopeWorld.scope?.generation);
          if (dependsOnTaskIds.length) {
            await tx.taskDependency.createMany({
              data: dependsOnTaskIds.map((dependsOnTaskId) => ({
                taskId: created.id,
                dependsOnTaskId,
              })),
            });
          }
          // §13.6 SU7, inside the transaction that created the successor: either both facts
          // land or neither does. A refusal here — the attempt is still OPEN, it belongs to
          // another project, somebody else already replaced it — rolls the new task back
          // rather than leaving a successor nothing points at, which is exactly the half-done
          // state the two-step entrance produced by accident. Safe under retry for the same
          // reason: the CAS below only fires against a predecessor still unlinked, and an
          // aborted attempt left it exactly that way.
          if (dto.supersedesTaskId) {
            await this.linkSupersededBy(
              tx, ownerId, dto.supersedesTaskId,
              { id: created.id, projectId: created.projectId }, new Date(),
            );
          }
          return created;
        },
        this.transientWriteRetry('tasks.create'),
      );
    } catch (e) {
      // §13.1 AG6's activation guard, FIRST, because it is the one refusal here that is not about
      // this write racing itself. 0132 refuses a child whose arrival would hand a RUNNING parent's
      // completion to its subtasks, and left untranslated that reaches the caller as a raw
      // `check_violation` — an unreadable 500 for a request the product deliberately refused.
      // Ahead of the idempotency branch on purpose: a refused write created no row, so there is no
      // winner to read back, and `isDuplicateKey` would not match this error anyway.
      const fenced = taskFenceConflictMessage(e);
      if (fenced) throw new ConflictException(fenced);
      // The unique index backstops a concurrent (not merely sequential) re-run that raced past the
      // pre-check above. Return the winner rather than surfacing a write conflict to the workspace.
      if (idempotentWrite && this.isDuplicateKey(e)) {
        // Through the SAME validator the pre-read uses. A read-back that trusted the index is a
        // validator the concurrent path skips — and the concurrent path is the one a fault or a
        // forged row is reached through on purpose.
        const existing = await this.idempotencyWinner(this.prisma, ownerId, idempotentWrite);
        if (existing) {
          // The concurrent half of the same rule: this transaction rolled back, so whatever link it
          // was going to write does not exist. The winner's row is the only authority on whether
          // the supersession happened, and it is read rather than assumed.
          if (dto.supersedesTaskId) {
            await this.assertSupersessionAlreadyRecorded(
              this.prisma, ownerId, dto.supersedesTaskId, existing.id,
            );
          }
          return existing;
        }
      }
      // And the project's own pre-check has the same shape of gap — see translateProjectFk.
      throw await this.translateProjectFk(e, ownerId, [dto.projectId]);
    }
    // Push the new task to the owner's control-plane stream (GET /api/events) so their task
    // list refreshes live instead of on the next poll — the fix for "MCP-created tasks only
    // show up after a manual refresh". Scoped via the creating session (the MCP path always
    // sends one); a task created without an owned session just falls back to the poll. Mirrors
    // SessionsService.create's publishSessionCreated.
    if (sessionId) this.realtime.publishTaskChanged(sessionId, task.id);
    // AG3 in the direction that is easy to forget: a task ARRIVING is as much a change to its
    // parent's children as one completing. Without this, filing a subtask under a parent that
    // ALL_CHILDREN_DONE had already completed leaves the parent DONE over work that has not
    // started, and a verification filed at a VERIFICATION_PASSED parent leaves it DONE over a
    // check that has not run.
    // The predecessor is seeded alongside the new task's own links because the link this create
    // just wrote RETIRED it, and §13.6 SU6 makes a retired child settle and a retired verifier stop
    // counting — so its parent and its subject both have a new answer as of this write. The closure
    // walks up from it; naming the predecessor itself is enough.
    if (task.parentTaskId || task.verifiesTaskId || dto.supersedesTaskId) {
      await this.recomputeAggregates(
        ownerId,
        [task.parentTaskId, task.verifiesTaskId, dto.supersedesTaskId].filter(
          (id): id is string => !!id,
        ),
      ).catch((e) =>
        this.logger.warn(`aggregation after create of ${task.id} failed: ${e?.message ?? e}`),
      );
    }
    return task;
  }

  /**
   * Which of these lists are paused. A task filed into a paused list has to be born held —
   * otherwise "pause the list" means "pause the tasks that happened to exist when I clicked",
   * and a campaign that is still being written keeps dispatching around its own stop.
   */
  private async pausedListIds(
    ownerId: string,
    listIds: Array<string | null | undefined>,
  ): Promise<Set<string>> {
    const ids = [...new Set(listIds.filter((v): v is string => !!v))];
    if (ids.length === 0) return new Set();
    const paused = await this.prisma.taskList.findMany({
      where: { id: { in: ids }, ownerId, paused: true },
      select: { id: true },
    });
    return new Set(paused.map((l) => l.id));
  }

  /** The Task row one create DTO turns into. Shared by create and createMany so the two
   *  write paths can never drift on a newly added field. */
  private taskCreateData(
    ownerId: string,
    dto: CreateTaskDto,
    creator: Creator | undefined,
    origin: CreationOrigin | undefined,
    idempotencyKey: string | undefined,
    heldListIds: ReadonlySet<string>,
  ): Prisma.TaskUncheckedCreateInput {
    const sessionId = origin?.sessionId;
    return {
      dispatchHold: !!dto.listId && heldListIds.has(dto.listId),
      title: dto.title,
      description: dto.description,
      ownerId,
      // Defaults to the human (user-facing API); the runner path passes the workspace.
      creatorType: creator?.type ?? CreatorType.USER,
      creatorId: creator?.id ?? ownerId,
      creatorSessionId: sessionId,
      idempotencyKey,
      assigneeId: dto.assigneeId,
      listId: dto.listId,
      projectId: dto.projectId,
      parentTaskId: dto.parentTaskId,
      // §13.2's relation, and the only column here that decides what another task's completion
      // means. Omitted leaves it NULL, which is every task that is not a check of something.
      verifiesTaskId: dto.verifiesTaskId,
      acceptanceCriteria: dto.acceptanceCriteria,
      dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      // Omitted means unscheduled. The `undefined` is what makes that true without a default:
      // Prisma leaves the column out of the INSERT, so the row is born NULL exactly as every task
      // created before this column was born NULL.
      runAt: dto.runAt ? new Date(dto.runAt) : undefined,
      labels: dto.labels ? normalizeTaskLabels(dto.labels) : undefined,
      provider: dto.provider,
      model: dto.model,
      autoRunWhenReady: dto.autoRunWhenReady,
      // Omitted leaves the column default, MANUAL — the behaviour every task created before
      // migration 0123 has, and the one that never completes anything on its own.
      completionPolicy: dto.completionPolicy,
      // Where this work was NOTICED (unit L2, migration 0150) — evidence beside `projectId`, never
      // instead of it. Written here and nowhere else: the columns are frozen against UPDATE by
      // `task_provenance_immutable_guard`, so this insert is the only moment they can be set, and
      // the values come from the session rather than from the request (see `resolveOwnedSession`).
      //
      // A create outside any session leaves all four out of the INSERT entirely. That is the user
      // API, and the user is the one principal the scope contract exempts (§4 R1): there is no
      // scope to compare theirs against, so recording one would be recording a fiction. A session
      // that HAS no scope writes an explicit null instead — both are NULL at rest, and the
      // difference is only in what the statement claims to know.
      discoveredFromProjectId: origin?.discoveredFromProjectId,
      triggerEvent: origin?.triggerEvent,
      sourceTaskId: origin?.sourceTaskId,
      sourceSessionId: sessionId,
    };
  }

  /**
   * Every check `createMany` makes before it writes anything, and nothing else.
   *
   * Shared with `previewCreateMany` on purpose. The preview exists to put a batch in front of a
   * human, and a batch that would have been rejected anyway is not a decision worth interrupting
   * someone for — it is a mistake to hand straight back. Two copies of these rules would drift,
   * and the direction they would drift is a card that promises something the write then refuses.
   */
  private async assertBatchValid(ownerId: string, dto: CreateTasksBatchDto) {
    const items = dto.tasks ?? [];
    if (!items.length) throw new BadRequestException('tasks is required');
    if (items.length > TASK_BATCH_CREATE_MAX)
      throw new BadRequestException(`at most ${TASK_BATCH_CREATE_MAX} tasks per batch`);

    const positionByRef = new Map<string, number>();
    items.forEach((item, index) => {
      if (!item.title) throw new BadRequestException(`tasks[${index}]: title is required`);
      if (item.ref === undefined) return;
      if (positionByRef.has(item.ref))
        throw new BadRequestException(`tasks[${index}]: duplicate ref "${item.ref}"`);
      positionByRef.set(item.ref, index);
    });
    // Backward-only refs keep the batch acyclic by construction, so — as in create — no cycle
    // check is needed: these tasks are brand new, nothing outside the batch can depend on them.
    items.forEach((item, index) => {
      for (const ref of item.dependsOnRefs ?? []) {
        const position = positionByRef.get(ref);
        if (position === undefined || position >= index)
          throw new BadRequestException(
            `tasks[${index}]: dependsOnRefs "${ref}" must name an earlier task in this batch`,
          );
      }
    });
    // A parent named inside the batch, judged here rather than in assertBatchHierarchy: both
    // sides of the pair are in this request, so the same rules the DB check asks of an existing
    // parent are answerable without a query — and answerable before any row is written, which is
    // what keeps a batch all-or-nothing.
    //
    // Backward-only again, for one more reason than dependsOnRefs has: items are created in
    // order, so an earlier ref is also the only one whose id exists by the time this row is
    // written. That ordering is what makes a cycle unconstructible here, so — unlike `update`,
    // where a parent can be any task in the account — no ancestor walk is needed.
    items.forEach((item, index) => {
      if (item.parentRef === undefined) return;
      if (item.parentTaskId)
        throw new BadRequestException(
          `tasks[${index}]: parentRef and parentTaskId name two different parents — pass one`,
        );
      const position = positionByRef.get(item.parentRef);
      if (position === undefined || position >= index)
        throw new BadRequestException(
          `tasks[${index}]: parentRef "${item.parentRef}" must name an earlier task in this batch`,
        );
      // The shared-project rule, same as assertParentEligible states it for a parent that already
      // exists: a subtask belongs to the whole its parent belongs to. Both sides `?? null`, so
      // "no project" is one value rather than two.
      if ((items[position].projectId ?? null) !== (item.projectId ?? null))
        throw new BadRequestException(
          `tasks[${index}]: a subtask must be in the same project as its parent task — file both ` +
            'under the same project (or neither) before linking them',
        );
    });
    // A subject named inside the batch, judged here for the same reasons parentRef is: both sides
    // are in the request, so every rule `assertVerificationEligible` asks of an existing subject
    // is answerable without a query and before any row is written. Backward-only makes "verifies
    // itself" unconstructible rather than something to check for, and an earlier item is also the
    // only one whose id exists by the time this row is written.
    items.forEach((item, index) => {
      if (item.verifiesRef === undefined) return;
      if (item.verifiesTaskId)
        throw new BadRequestException(
          `tasks[${index}]: verifiesRef and verifiesTaskId name two different subjects — pass one`,
        );
      const position = positionByRef.get(item.verifiesRef);
      if (position === undefined || position >= index)
        throw new BadRequestException(
          `tasks[${index}]: verifiesRef "${item.verifiesRef}" must name an earlier task in this batch`,
        );
      const subject = items[position];
      if (subject.verifiesTaskId || subject.verifiesRef)
        throw new BadRequestException(
          `tasks[${index}]: that task is itself a verification — a check of a check has nothing ` +
            'left to verify',
        );
      if ((subject.projectId ?? null) !== (item.projectId ?? null))
        throw new BadRequestException(
          `tasks[${index}]: a verification must be in the same project as the task it verifies — ` +
            'file both under the same project (or neither) before linking them',
        );
    });

    // Validate every referenced entity before writing anything, once per distinct value.
    const distinct = (values: Array<string | null | undefined>) => [
      ...new Set(values.filter((value): value is string => !!value)),
    ];
    for (const assigneeId of distinct(items.map((item) => item.assigneeId)))
      await this.assertOwnedWorkspace(ownerId, assigneeId);
    for (const listId of distinct(items.map((item) => item.listId)))
      await this.assertOwnedList(ownerId, listId);
    for (const projectId of distinct(items.map((item) => item.projectId)))
      await this.assertOwnedProject(ownerId, projectId);
    for (const provider of distinct(items.map((item) => item.provider)))
      await this.assertUsableProvider(ownerId, provider);
    const existingPrerequisites = distinct(items.flatMap((item) => item.dependsOnTaskIds ?? []));
    if (existingPrerequisites.length) await this.assertOwnedTasks(ownerId, existingPrerequisites);
    return items;
  }

  /**
   * Every item's parent, judged against the project that item will be in.
   *
   * Per item rather than per distinct value: eligibility is a fact about the pair (parent,
   * project), so two items naming the same parent from different projects are two questions. A
   * batch cannot name one of its own items as a parent — `ref` wires up dependencies only — so
   * every parent here already exists and no cycle can be formed.
   *
   * Kept out of `assertBatchValid` because the two callers need it at different moments: the write
   * runs it inside its transaction under the owner lock, where the answer stays true long enough
   * to be written, while the preview runs it on the plain client because it writes nothing. Both
   * still run it, so a card cannot promise a batch the write would refuse.
   */
  private async assertBatchHierarchy(
    db: Prisma.TransactionClient,
    ownerId: string,
    items: CreateTaskBatchItemDto[],
  ): Promise<void> {
    for (const item of items) {
      if (item.parentTaskId) {
        await this.assertParentEligible(db, ownerId, item.parentTaskId, item.projectId ?? null);
      }
      if (item.verifiesTaskId) {
        await this.assertVerificationEligible(
          db,
          ownerId,
          null,
          item.verifiesTaskId,
          item.projectId ?? null,
        );
      }
    }
  }

  /**
   * What a batch would create, without creating any of it.
   *
   * Building a DAG is the most consequential thing an agent does here and the least visible: the
   * ops are fifty titles, and what actually happens is some number of runs starting within the
   * minute. This deployment has the cautionary case — one session created 43 lists and ~21,500
   * tasks before anybody looked at it — so the number the card leads with is how many of these
   * begin immediately, not how many are written.
   *
   * "Immediately" is the auto-run sweep's own gate, applied here rather than approximated: the
   * task must be unblocked, opted into auto-run, and assigned to a workspace bound to a runner.
   * A task waiting on another item in the same batch is blocked by construction — its prerequisite
   * is brand new and therefore OPEN — so a chain of fifty starts exactly one.
   */
  async previewCreateMany(ownerId: string, dto: CreateTasksBatchDto) {
    const items = await this.assertBatchValid(ownerId, dto);
    // Unlocked: a preview writes nothing, so there is nothing for a lock to protect. It is asked
    // at all so the card cannot promise a batch the write would then refuse.
    await this.assertBatchHierarchy(this.prisma, ownerId, items);
    const assigneeIds = [...new Set(items.map((i) => i.assigneeId).filter((v): v is string => !!v))];
    const externalIds = [...new Set(items.flatMap((i) => i.dependsOnTaskIds ?? []))];
    const listIds = [...new Set(items.map((i) => i.listId).filter((v): v is string => !!v))];
    const [assignees, prerequisites, lists] = await Promise.all([
      this.prisma.workspace.findMany({
        where: { id: { in: assigneeIds }, ownerId },
        select: { id: true, name: true, runnerId: true },
      }),
      this.prisma.task.findMany({
        where: { id: { in: externalIds }, ownerId },
        select: { id: true, status: true },
      }),
      this.prisma.taskList.findMany({
        where: { id: { in: listIds }, ownerId },
        select: { id: true, title: true, paused: true },
      }),
    ]);
    // A paused list is out of the sweep entirely (AUTO_RUN_READY_SQL), so nothing landing in one
    // starts however runnable it looks. Without this the card announced runs for a campaign that
    // was explicitly stopped — and `paused` is precisely how someone builds a large campaign
    // before releasing it, so it is the case that matters most.
    const pausedLists = new Set(lists.filter((l) => l.paused).map((l) => l.id));
    const runnerOf = new Map(assignees.map((a) => [a.id, a.runnerId]));
    const nameOf = new Map(assignees.map((a) => [a.id, a.name]));
    const statusOf = new Map(prerequisites.map((t) => [t.id, t.status]));

    let startingNow = 0;
    let blocked = 0;
    let needsManualStart = 0;
    let notDispatchable = 0;
    let scheduled = 0;
    let internalEdges = 0;
    let externalEdges = 0;
    const now = Date.now();
    for (const item of items) {
      internalEdges += item.dependsOnRefs?.length ?? 0;
      externalEdges += item.dependsOnTaskIds?.length ?? 0;
      // `CreateTaskBatchItemDto` extends `CreateTaskDto`, so a batch item can carry a schedule,
      // and a schedule is a SECOND trigger with rules of its own (SCHEDULED_DUE_SQL).
      const runAt = item.runAt ? new Date(item.runAt) : null;
      // A prerequisite created by this same batch is OPEN the moment it exists, so anything
      // naming one waits — no need to consult the graph for it.
      const waitsOnBatch = (item.dependsOnRefs?.length ?? 0) > 0;
      const waitsOnExisting = (item.dependsOnTaskIds ?? []).some(
        (id) => statusOf.get(id) !== TaskStatus.DONE,
      );
      // What both sweeps require of a task before they will dispatch it at all.
      const runnable =
        !!item.assigneeId &&
        !!runnerOf.get(item.assigneeId) &&
        !(item.listId && pausedLists.has(item.listId));
      // A scheduled item is classified by what is ACTUALLY standing between it and a run, in the
      // order the sweep would hit them — not by its schedule alone. The clock is the last of the
      // conditions to be checked, never the first, because `scheduled` is the strongest claim on
      // this card: it says nobody has to do anything and nothing has to finish. An item that is
      // also unassigned, or in a paused list, or waiting on a prerequisite does not meet that
      // description, and filing it under `scheduled` would promise a run that never comes.
      //
      // `autoRunWhenReady` is deliberately not consulted here, and a prerequisite is not required
      // to exist: both are answers to the dependency question, and this trigger is the clock.
      if (runAt) {
        if (waitsOnBatch || waitsOnExisting) blocked += 1;
        else if (!runnable) notDispatchable += 1;
        // Everything is in place and the only thing left is the time.
        else if (runAt.getTime() > now) scheduled += 1;
        // Already due on arrival. Without this branch a batch scheduled for "now" reported fifty
        // tasks that "wait for a person" and then started all fifty within the minute — the same
        // class of wrong as the case below, in the direction the card exists to prevent.
        else startingNow += 1;
        continue;
      }
      // A task with no prerequisites is never auto-run, however runnable it looks: the sweep's
      // predicate requires a prerequisite that is DONE (AUTO_RUN_READY_SQL), because auto-run
      // means "start when what you were waiting for finishes" — not "start because nothing is in
      // the way". `autoRunWhenReady` says as much: ignored when there are no prerequisites.
      //
      // Getting this wrong is not a rounding error on the card. The roots of a fresh DAG have no
      // prerequisites, so a flat batch of fifty would have promised fifty runs within the minute
      // and started none of them.
      const hasPrerequisites =
        (item.dependsOnRefs?.length ?? 0) + (item.dependsOnTaskIds?.length ?? 0) > 0;
      if (!hasPrerequisites) {
        needsManualStart += 1;
        continue;
      }
      if (waitsOnBatch || waitsOnExisting) {
        blocked += 1;
        continue;
      }
      if (item.autoRunWhenReady !== false && runnable) startingNow += 1;
      else notDispatchable += 1;
    }
    return {
      taskCount: items.length,
      startingNow,
      blocked,
      // Written and idle: nothing is waiting on them and nothing will start them. Every root of a
      // new DAG lands here, which is why it is named rather than folded into a runnable count.
      needsManualStart,
      // Written but inert: no assignee, no runner behind the assignee, or auto-run switched off.
      // Worth separating from `blocked`, because these do not start when something finishes —
      // they wait for a person, and a batch that is silently all of these did nothing.
      notDispatchable,
      // Ready in every respect except the time: assigned, on a live runner, not held by a paused
      // list, nothing outstanding to wait for. Nobody has to do anything and nothing has to
      // finish — these start on their own, later. An item that is scheduled AND missing one of
      // those is counted by what is actually stopping it, above, because this bucket is a promise
      // that the run will arrive unattended. Named rather than folded into any of the four, all
      // of which would misdescribe it; a client that predates the field ignores it and simply
      // does not count these as starting now, which is the true statement.
      scheduled,
      internalEdges,
      externalEdges,
      lists: lists.map((l) => ({ id: l.id, title: l.title })),
      assignees: [...new Set(items.map((i) => i.assigneeId))]
        .filter((id): id is string => !!id)
        .map((id) => ({ id, name: nameOf.get(id) ?? id, hasRunner: !!runnerOf.get(id) })),
      tasks: items.slice(0, DAG_PREVIEW_TITLES).map((item) => ({
        title: item.title,
        listId: item.listId ?? null,
        dependsOnRefs: item.dependsOnRefs ?? [],
        dependsOnTaskIds: item.dependsOnTaskIds ?? [],
        ref: item.ref ?? null,
      })),
      // The card shows a window, not the whole batch: fifty rows is not something a person reads
      // before clicking, and the counts above are the decision.
      titlesTruncated: Math.max(0, items.length - DAG_PREVIEW_TITLES),
    };
  }

  /**
   * Create several tasks in one call, all-or-nothing. An item may carry a `ref` and later items
   * may list it in `dependsOnRefs`, so a whole dependency chain lands in a single round-trip
   * instead of one create per node (previously the only way to build one, since each edge needs
   * the id the previous call returned). Returns the created tasks in input order, echoing `ref`.
   */
  async createMany(
    ownerId: string,
    dto: CreateTasksBatchDto,
    creator?: Creator,
    creatorSessionId?: string,
  ) {
    const validated = await this.assertBatchValid(ownerId, dto);
    const origin = await this.resolveOwnedSession(ownerId, creatorSessionId);
    const sessionId = origin?.sessionId;
    // One turn for the whole batch (see create): the same key that collapses a re-run of a single
    // create collapses a re-run of a batch, item by item, without merging distinct items.
    const turnId = sessionId ? await this.currentTurnId(sessionId) : undefined;
    // WINNER FIRST, exactly as `create` is and for the same reason (§3 SC4): an item this turn
    // already committed is looked up, never re-decided. A batch re-run after a rotation would
    // otherwise be refused on the items it already wrote, leaving a caller that cannot find rows it
    // successfully created — and one whose session has drifted to another project would be admitted
    // for that project and then handed the rows from the first.
    //
    // Read outside the transaction, and read AGAIN inside it: this pass decides what still has to
    // be ADMITTED, and the find-or-create below decides what is actually written. A winner that
    // appears in between is simply found by the second read; the item was admitted, so nothing it
    // was allowed to do has been lost.
    // One descriptor per item, built once and used by every question asked about it: the pre-read
    // below, the find-or-create inside the transaction, and the P2002 reconstruction after it.
    const batchWriteOf = (item: CreateTaskBatchItemDto): IdempotentTaskWrite | undefined =>
      sessionId && turnId
        ? {
            operation: 'CREATE_TASK',
            sessionId,
            turnId,
            title: item.title,
            description: item.description,
          }
        : undefined;
    const replayed = await Promise.all(validated.map(async (item) => {
      const write = batchWriteOf(item);
      return write ? await this.idempotencyWinner(this.prisma, ownerId, write) : null;
    }));
    // Unit L3 §4, once for the whole batch and BEFORE the transaction: every item that is not a
    // replay is admitted and bound, or none is written. An item refused mid-transaction would be a
    // batch that took the owner lock and rolled back; admitted here, a refusal costs no row and no
    // lock (AC2).
    const scopeWrites: ScopeWriteInput[] = validated.map((item) => ({
      operation: 'CREATE_TASK',
      taskId: null,
      requestedProjectId: item.projectId === undefined ? undefined : (item.projectId ?? null),
      currentProjectId: null,
      scopeToken: item.scopeToken,
    }));
    const fresh = scopeWrites.filter((_, index) => !replayed[index]);
    const scopeWorld = await this.projectScopeWorld(this.prisma, ownerId, creatorSessionId, fresh);
    const scopeFences: Array<ScopeWriteInput & { boundProjectId: string | null }> = [];
    // Unit L4: one moment for the whole batch, outside the retry closure — a second attempt spends
    // the same approvals under the same expiry rather than fresher ones.
    const now = new Date();
    // Unit L4: every item's full identity, with each ref resolved to the identity of the item it
    // names. Computed over the batch as given, because the fields an approval binds — the plan, the
    // structure, the execution identity and the source evidence — are not what the scope binding
    // changes; that decides only WHICH project the write lands in, which the crossing states
    // separately as its two ends.
    const identities = this.handoffIdentities(validated, origin);
    const spends = new Map<number, HandoffSpend>();
    // Which items this call is NOT writing. A replayed winner is a frozen fact from here on: it is
    // returned, it can be named by a later item's ref, and it is judged by nothing — re-judging a
    // committed row against a world that has moved would turn a lost response into a refusal of
    // work that already exists (§3 SC4).
    const frozen = new Set<number>();
    const items: CreateTaskBatchItemDto[] = [];
    for (const [index, item] of validated.entries()) {
      const winner = replayed[index];
      if (winner) {
        this.auditReplayedProject(winner, item.projectId);
        frozen.add(index);
        // Pinned to the row that already exists, so the item this batch carries and the row the
        // transaction finds cannot describe two different projects.
        items.push((item.projectId ?? null) === (winner.projectId ?? null)
          ? item
          : { ...item, projectId: winner.projectId ?? undefined });
        continue;
      }
      const crossing = this.declaredCrossing(
        ownerId, item, identities[index], scopeWorld.scope, creatorSessionId,
      );
      const admitted = await this.admitDeclaredWrite(
        ownerId, scopeWorld, scopeWrites[index], crossing, now,
      );
      if (admitted.spend) spends.set(index, admitted.spend);
      // Copied AFTER the admission, so the fence carries the operation and the answer this item was
      // admitted under: re-deciding a declared crossing as an undeclared one would refuse at R7.
      scopeFences.push({ ...scopeWrites[index], boundProjectId: admitted.projectId });
      items.push((item.projectId ?? null) === admitted.projectId
        ? item
        : { ...item, projectId: admitted.projectId ?? undefined });
    }
    // Unit L4: the plan, judged whole and before the transaction. Every dimension, every item, all
    // findings at once — and nothing written if any of them refuses (AC5).
    const preflighting = this.planNeedsPreflight(scopeWorld, items);
    const referencedTasks = preflighting ? await this.referencedTaskFacts(ownerId, items) : {};
    const dependencyCrossings: DependencyCrossings = preflighting
      ? await this.resolveDependencyCrossings(
          ownerId, items, identities, referencedTasks, scopeWorld, creatorSessionId, now, frozen,
        )
      : { answers: {}, edges: [] };
    const planAdmission = preflighting
      ? await this.assertPlanPreflight(
          ownerId, items, scopeWorld, referencedTasks, dependencyCrossings.answers, frozen,
        )
      : null;

    // Only parents that already exist. A parentRef points at a row this very transaction writes,
    // which no other request can see — let alone move into another project — so there is nothing
    // for the lock or the DB check below to protect; its rules were settled in assertBatchValid,
    // where both sides of the pair were in the request.
    const hasParents = items.some((item) => !!item.parentTaskId || !!item.verifiesTaskId);
    // §13.6 SU7. A batch whose only cross-row work is a supersession took NO owner lock: each item
    // read `existing` on its own, two concurrent runs of one turn could both miss it, and the loser
    // surfaced a raw P2002 instead of the replay contract below. Several predecessors made it worse
    // — they were locked in item order, so two batches naming the same pair in opposite orders
    // deadlocked on the task rows. Folding it into the SAME owner lock the other two take gives one
    // serialization point and one order for all three.
    const hasSupersessions = items.some((item) => !!item.supersedesTaskId);
    const heldListIds = await this.pausedListIds(ownerId, items.map((item) => item.listId));
    // Retried whole, exactly as `create` is and for the same reason: PostgreSQL aborts a deadlock
    // victim's transaction entirely, so the only correct response is to run all of it again from a
    // new snapshot. Everything a retry must not re-derive is already outside the closure — the
    // validated `items`, the session, the turn the idempotency keys are built from, and the held
    // list ids — so a second attempt writes the same batch rather than a second one, and the
    // find-or-create by key inside makes an attempt that half-committed impossible to double up on
    // even in principle. `idByRef` and `rows` are rebuilt per attempt, because they name rows an
    // aborted attempt no longer has.
    const created = await withTransactionRetry(this.prisma, async (tx) => {
      // Same owner lock as create: the tasks and their edges must become visible together, or a
      // concurrent reverse-edge write could see a task before its prerequisites and close a cycle.
      // A batch naming parents takes it for the matching reason — each parent's project is read
      // here and relied on by the rows written next.
      //
      // Taken unconditionally, unlike `create`: a batch writes several `task` rows in item order,
      // which is not an order any other writer can be expected to share, and rank 10 of the
      // canonical order (lock-order.ts, I1) is what keeps two multi-row Task writes from taking
      // the same rows in opposite orders.
      await this.lockDependencyGraph(tx, ownerId);
      // Unit L4, rank 15: the workspaces and providers this plan was admitted against, taken before
      // the lists and sessions below and before anything is written.
      if (planAdmission) {
        await this.lockPlanExecutionIdentity(
          tx, ownerId, planAdmission.workspaceIds, planAdmission.providerSlugs,
        );
      }
      // Rank 20 and 30, in one ordered statement each and before the first Task/FK write: every
      // list this batch files into, the Session that created it, and — when items retire
      // predecessors — the creator Sessions of those predecessor rows, which this transaction
      // writes a second time. All are locks the row writes would otherwise take one at a time,
      // interleaved with the Task writes (I2).
      await lockTaskLists(tx, items.map((item) => item.listId));
      await this.preLockCreatorSessions(
        tx,
        [sessionId],
        items.map((item) => item.supersedesTaskId),
      );
      // Rank 40, and the project prelock `create` takes, for the same reason and in the same
      // order: the task INSERT and the predecessor's retirement both reach
      // `project_acceptance_reopen`, which takes the PROJECT row, and the Coordinator holds
      // project-then-task. Sorted by UUID (§8.6 LO2), so two batches touching the same two
      // projects in opposite item orders cannot make a cycle.
      const supersessionProjectIds = hasSupersessions
        ? [...new Set(items
            .filter((item) => item.supersedesTaskId)
            .map((item) => item.projectId)
            .filter((projectId): projectId is string => !!projectId))].sort()
        : [];
      // Unit L3, rank 40 and for the same reason the supersession pre-lock is: the scope every
      // fresh item was admitted under, re-locked and re-read, so a rotation that commits between
      // the admission and this transaction refuses the whole batch rather than being written past.
      // Both sets are taken here in ONE sorted pass, so the loop below re-locks rows this
      // transaction already holds instead of reaching backwards for a smaller id.
      await this.refenceProjectScope(
        tx, ownerId, creatorSessionId, scopeWorld, scopeFences,
        // As in `create`, and for the same three reasons: what each fresh item is bound to, the
        // scope a declared crossing derives its authority from, and the far end of every edge.
        // Frozen items are deliberately absent — they were written by an earlier attempt and this
        // transaction neither re-judges nor re-writes them.
        [
          ...items.filter((_, index) => !frozen.has(index)).map((item) => item.projectId),
          scopeWorld.scope?.projectId,
          ...dependencyCrossings.edges.map((edge) => edge.authority.toProjectId),
          ...supersessionProjectIds,
        ],
      );
      for (const projectId of supersessionProjectIds) {
        await tx.$queryRaw`
          SELECT 1 FROM "project" WHERE "id" = ${projectId}::uuid FOR NO KEY UPDATE`;
      }
      // Under the lock, and before the first row: a batch is all-or-nothing, so an ineligible
      // parent in item 40 must not leave items 1-39 written.
      if (hasParents) await this.assertBatchHierarchy(tx, ownerId, items);
      // Unit L4: everything the preflight decided on, re-read under the locks now held — a reopen,
      // a soft-deleted workspace, a disabled provider or a lowered budget between the admission and
      // here refuses the whole batch rather than being written past.
      if (planAdmission) await this.assertPlanAuthorityUnchanged(tx, ownerId, planAdmission.snapshot);
      // And the crossings again, under a lock on the prerequisites (rank 50, sorted). The preflight
      // read their projects without one, and a move takes a mode that read does not conflict with —
      // so an edge that was inside one project when the plan was judged can be a crossing by the
      // time it is written.
      await this.assertDependencyCrossingsAtEffect(tx, ownerId, dependencyCrossings.edges, now);
      // Unit L4: every yes this batch spends, collected as the rows are written and applied in one
      // sorted pass at the end (see `spendAll`).
      const handoffSpends: Array<{ authority: HandoffAuthority; handoffId: string; taskId: string }> = [];
      const idByRef = new Map<string, string>();
      const rows: Array<Task & { ref?: string }> = [];
      for (const [index, item] of items.entries()) {
        // find-or-create by the item's key: a re-run's items already exist (committed by the first
        // run), and a within-batch duplicate resolves to the row this same transaction just wrote.
        // A ref pointing at a collapsed item therefore resolves to the surviving task's id.
        const itemWrite = batchWriteOf(item);
        const idempotencyKey = itemWrite ? this.taskIdempotencyKey(itemWrite) : undefined;
        const existing = itemWrite
          ? await this.idempotencyWinner(tx, ownerId, itemWrite)
          : null;
        // A parentRef names an item of this same batch, so the id it stands for only exists now.
        // Resolved into the field an already-existing parent would have used, so one write path
        // serves both and nothing downstream has to know which spelling the caller used.
        // Non-null: every parentRef was proven to belong to an earlier, already-created item.
        // A parentRef or a verifiesRef names an item of this same batch, so the id it stands for
        // only exists now. Both are resolved into the field an already-existing link would have
        // used, so one write path serves either spelling and nothing downstream has to know which
        // the caller passed. Non-null: both were proven to belong to earlier, already-created
        // items.
        const row =
          item.parentRef === undefined && item.verifiesRef === undefined
            ? item
            : {
                ...item,
                ...(item.parentRef === undefined
                  ? {}
                  : { parentTaskId: idByRef.get(item.parentRef)! }),
                ...(item.verifiesRef === undefined
                  ? {}
                  : { verifiesTaskId: idByRef.get(item.verifiesRef)! }),
              };
        const task =
          existing ??
          (await tx.task.create({
            data: this.taskCreateData(
              ownerId,
              row,
              creator,
              origin,
              idempotencyKey,
              heldListIds,
            ),
          }));
        // Unit L4's `APPLY`, for an item this call actually created: a replay found the row the
        // first run wrote, and that run already spent the approval on it.
        const spend = spends.get(index);
        if (!existing && spend) handoffSpends.push({ ...spend, taskId: task.id });
        if (!existing) {
          for (const edge of dependencyCrossings.edges) {
            if (edge.index === index && edge.handoffId) {
              handoffSpends.push({
                authority: edge.authority,
                handoffId: edge.handoffId,
                taskId: task.id,
              });
            }
          }
        }
        if (item.ref !== undefined) idByRef.set(item.ref, task.id);
        const dependsOnTaskIds = [
          ...new Set([
            ...(item.dependsOnTaskIds ?? []),
            // Non-null: every ref was proven to belong to an earlier, already-created item above.
            ...(item.dependsOnRefs ?? []).map((ref) => idByRef.get(ref)!),
          ]),
        ];
        // Only a newly created task needs its edges; an existing one already carries them from the
        // first run, and re-inserting would collide on the (taskId, dependsOnTaskId) unique index.
        if (!existing && dependsOnTaskIds.length)
          await tx.taskDependency.createMany({
            data: dependsOnTaskIds.map((dependsOnTaskId) => ({
              taskId: task.id,
              dependsOnTaskId,
            })),
          });
        // §13.6 SU7 in a batch, and only for a task this call actually created: a re-delivered
        // turn resolved `existing` to the row the first run wrote, and that run already linked the
        // predecessor. Attempting it again would hit the CAS and turn an idempotent re-run into a
        // conflict about a link this very batch established.
        if (item.supersedesTaskId) {
          if (existing) {
            // SU7-c, and a batch is all-or-nothing: a refusal here rolls back every item, which is
            // the only honest answer when one of them claimed a replacement that is not recorded.
            await this.assertSupersessionAlreadyRecorded(
              tx, ownerId, item.supersedesTaskId, task.id,
            );
          } else {
            await this.linkSupersededBy(
              tx, ownerId, item.supersedesTaskId,
              { id: task.id, projectId: task.projectId }, new Date(),
            );
          }
        }
        rows.push(item.ref === undefined ? task : { ...task, ref: item.ref });
      }
      await this.handoffs.spendAll(tx, handoffSpends, now, scopeWorld.scope?.generation);
      return rows;
    }, this.transientWriteRetry('tasks.createMany')).catch(async (e) => {
      // §13.1 AG6's activation guard, FIRST and for the same reason `create` puts it first: 0132
      // refuses a child whose arrival would hand a RUNNING parent's completion to its subtasks, and
      // that refusal is about the request rather than about losing a race. Ahead of the idempotency
      // replay because a refused batch wrote nothing — there is no winner to reconstruct, and the
      // replay below would throw a misleading "cannot all be identified" over a plain 409.
      //
      // Outside the retry, not inside it: the guard raises `lock_not_available`, which
      // `classifyTransactionError` deliberately does not call transient — it is a control-flow
      // signal a path handles itself, and re-running the transaction would spend four attempts
      // re-earning the same correct refusal.
      const fenced = taskFenceConflictMessage(e);
      if (fenced) throw new ConflictException(fenced);
      // The concurrent half of SU7-c. Two runs of one turn can both miss `existing` and race to the
      // same idempotency key; the loser's whole transaction rolls back, so any link it was about to
      // write does not exist. Re-checking the winner's rows turns that into either a clean
      // idempotent answer or a typed 409 — never a batch that reports success over a supersession
      // nobody recorded. Read AFTER the rollback, deliberately: the winner is the only authority.
      //
      // EVERY shape of batch, not only one claiming a supersession. Gating this on
      // `hasSupersessions` left the ordinary batch's concurrent path with no winner authority at
      // all: it fell through to `translateProjectFk` and surfaced the index as an error, so the one
      // shape the caller could actually retry safely was the one that got told to give up. A single
      // create and a batch now answer a lost index the same way — with the winner, validated.
      if (this.isDuplicateKey(e)) {
        // Rebuilt in INPUT ORDER, with each item's `ref` echoed, because this returns in place of
        // the batch's own result and a caller wiring refs to ids cannot tell the two apart. Every
        // item is reconstructed, not only the ones claiming a supersession: a partial answer would
        // be a batch that reported some of what it was asked for.
        //
        // Resolved as a SET before anything is returned or asserted: all of them, or none. A batch
        // is all-or-nothing on the way in, and reporting it item by item on the way out would let a
        // half-identified batch answer half-successfully.
        const winners: Array<Task | null> = [];
        for (const item of items) {
          // Same validator as everywhere else. This is the batch's own concurrent path, and it read
          // rows back on the index alone — so a forged or foreign row under one item's key was
          // returned to the caller as that item's result. A mismatch throws from in here, which is
          // the typed 409 this whole branch owes the caller.
          const write = batchWriteOf(item);
          winners.push(write ? await this.idempotencyWinner(this.prisma, ownerId, write) : null);
        }
        // Nothing of this batch is under any of its keys, so the index that fired was not ours —
        // a project FK, a supersession guard, some other unique constraint. Say what it actually
        // was rather than inventing a replay that did not happen.
        if (winners.every((winner) => winner === null)) {
          throw await this.translateProjectFk(e, ownerId, items.map((item) => item.projectId));
        }
        if (winners.some((winner) => winner === null)) {
          // Some items are on disk under their keys and some are not. Whatever happened, it was not
          // this batch running twice — and this call's own transaction has already rolled back, so
          // nothing here is a claim about rows that exist.
          throw new ConflictException(
            'this batch lost a concurrent create and the winning tasks cannot all be identified — '
              + 'nothing from this call was written; retry',
          );
        }
        const replayed: Array<Task & { ref?: string }> = [];
        for (const [at, item] of items.entries()) {
          const winner = winners[at]!;
          if (item.supersedesTaskId) {
            // SU7-c: the winner's rows are the only authority on whether the link happened. A
            // mismatch throws, and since this whole batch has already rolled back, throwing leaves
            // the database exactly as the winner left it.
            await this.assertSupersessionAlreadyRecorded(
              this.prisma, ownerId, item.supersedesTaskId, winner.id,
            );
          }
          replayed.push(item.ref === undefined ? winner : { ...winner, ref: item.ref });
        }
        return replayed;
      }
      // A batch is all-or-nothing, so one item's project vanishing mid-write fails the whole call —
      // and it should say so in the language of the request, not as a 500 (see translateProjectFk).
      // Reached only once the retry loop is done with the error: a transient conflict never gets
      // here on an attempt that has another one coming.
      throw await this.translateProjectFk(e, ownerId, items.map((item) => item.projectId));
    });
    // One control-plane nudge per task, exactly as create does (see its comment).
    if (sessionId) for (const task of created) this.realtime.publishTaskChanged(sessionId, task.id);
    // Same as create: rows arriving under a parent, or pointed at one, are a change to what that
    // parent's status is allowed to claim. Seeded from the links rather than from the new rows —
    // the parents and subjects are what get recomputed, and half of them are in this batch.
    const touched = [
      ...created.flatMap((task) =>
        [task.parentTaskId, task.verifiesTaskId].filter((id): id is string => !!id),
      ),
      // Same reason as create: each predecessor this batch retired has a parent and a subject whose
      // answers moved.
      ...items.map((item) => item.supersedesTaskId).filter((id): id is string => !!id),
    ];
    if (touched.length) {
      await this.recomputeAggregates(ownerId, touched).catch((e) =>
        this.logger.warn(`aggregation after batch create failed: ${e?.message ?? e}`),
      );
    }
    return created;
  }

  /**
   * The originating session, if it exists under this owner, and what it says about where the work
   * being filed was NOTICED (unit L2, contract §2).
   *
   * One query, not two: the same row that answers "is this session yours" also carries the task it
   * was executing and the project it coordinates, and those are precisely the provenance columns.
   * Splitting it would add a round trip to every in-session create for facts already in hand.
   *
   * Everything here is SERVER-DERIVED, and that is the whole value of it. The incident these
   * columns exist for is a coordinator session filing work into a project it does not coordinate;
   * a `discoveredFromProjectId` the caller supplied would simply have said the target project, and
   * the row would be as indistinguishable from a deliberate one as it is today. Nothing in the
   * request can reach these columns.
   */
  private async resolveOwnedSession(
    ownerId: string,
    sessionId?: string,
  ): Promise<CreationOrigin | undefined> {
    if (!sessionId) return undefined;
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, ownerId },
      select: {
        id: true,
        taskId: true,
        task: { select: { projectId: true } },
        coordinatorForProject: { select: { id: true } },
      },
    });
    if (!session) return undefined;
    return {
      sessionId: session.id,
      sourceTaskId: session.taskId,
      // The scope the writer was acting under, in the order the contract derives it: the project
      // this session coordinates, or failing that the project of the task it is executing. A
      // session that is neither leaves it null rather than guessing — "I could not tell" and "it
      // came from nowhere" are the same fact here, and inventing one would be the beginning of
      // reading this column as authority.
      discoveredFromProjectId:
        session.coordinatorForProject?.id ?? session.task?.projectId ?? null,
      triggerEvent: session.coordinatorForProject
        ? 'coordinator.session_filed'
        : session.taskId
          ? 'task.session_filed'
          : 'agent.session_filed',
    };
  }

  /**
   * Unit L3: the coordination scope this write is being made UNDER, derived from the session row.
   *
   * `docs/project-coordinator-scope-contract.md` §2 defines it and §2 SC3 defines what it is not:
   * the client never names it. The reverse lookup through `project.coordinator_session_id` is the
   * whole derivation for a coordinator, and a task-bound run takes the project of the task it is
   * executing — both are columns the server owns, and both are re-read on EVERY write rather than
   * cached, which is what makes a rotation, a restart and a takeover produce the same answer
   * without anything having to notice that one happened (AC3).
   *
   * Not to be confused with the provenance `resolveOwnedSession` computes. That records where the
   * work was NOTICED and §3 SC7 forbids any gate from reading it; this is the authority, and it is
   * derived here a second time on purpose so that "evidence" and "authority" never share a value.
   *
   * The generation comes from `project_runtime.coordinator_generation` — the counter a rotation
   * advances — so a presented token can be compared against both halves of the pair at once.
   */
  private async deriveProjectScope(
    db: ScopeReadClient,
    ownerId: string,
    sessionId?: string,
  ): Promise<DerivedScope | null> {
    if (!sessionId) return null;
    const session = await db.session.findFirst({
      where: { id: sessionId, ownerId },
      select: {
        coordinatorForProject: { select: { id: true } },
        task: { select: { projectId: true } },
      },
    });
    if (!session) return null;
    const projectId = session.coordinatorForProject?.id ?? session.task?.projectId ?? null;
    if (!projectId) return null;
    // Scoped by owner as well as by id: a scope is a tenant fact before it is a project fact, and
    // a project row reached without the owner clause would be an authority derived across tenants.
    const project = await db.project.findFirst({
      where: { id: projectId, ownerId },
      select: { id: true, runtime: { select: { coordinatorGeneration: true } } },
    });
    if (!project) return null;
    // A project with no runtime row has never been rotated, which is generation 0 — the same
    // default the column carries. Reading it as "no generation" would make every token presented
    // against a freshly created project fail R3 for a rotation that never happened.
    return {
      projectId: project.id,
      generation: String(project.runtime?.coordinatorGeneration ?? 0n),
    };
  }

  /**
   * §4 R8's world, read fail closed: a project this owner does not have simply is not in the map,
   * and `decideProjectScopeWrite` reads an absent status as NOT open.
   */
  private async projectScopeStatuses(
    db: ScopeReadClient,
    ownerId: string,
    projectIds: Array<string | null | undefined>,
  ): Promise<Record<string, ScopeProjectStatus>> {
    const ids = [...new Set(projectIds.filter((id): id is string => !!id))];
    if (!ids.length) return {};
    const rows = await db.project.findMany({
      where: { id: { in: ids }, ownerId },
      select: { id: true, status: true },
    });
    return Object.fromEntries(
      rows.map((row) => [row.id, row.status as unknown as ScopeProjectStatus]),
    );
  }

  /**
   * §4's world for a set of writes: who is writing, under which scope, and which of the projects
   * they touch are still open.
   *
   * Built once for a whole call so a fifty-item batch costs the same two reads a single create
   * does. It is also the only place the principal is decided, and it is decided from the SHAPE of
   * the call rather than from anything the caller declares: a write with no acting session came
   * through the user-facing controller or a CLI acting for the owner, and §4 R1 puts the owner
   * outside this contract entirely (AC5 — the explicit user path is untouched and pays not one
   * extra query for a boundary that does not apply to it).
   *
   * Keyed on the RAW session id, not on one that survived an ownership check: a session id that
   * does not resolve must become an agent with NO scope (refused by R5), never an absent one.
   */
  private async projectScopeWorld(
    db: ScopeReadClient,
    ownerId: string,
    actingSessionId: string | undefined,
    writes: readonly ScopeWriteInput[],
  ): Promise<ScopeWorld> {
    const scope = await this.deriveProjectScope(db, ownerId, actingSessionId);
    const principal: ScopePrincipal = !actingSessionId
      ? 'USER'
      : scope
        ? 'COORDINATOR'
        : 'WORKER';
    const mode = projectScopeMode();
    if (principal === 'USER') return { principal, scope, projectStatus: {}, mode };
    // The target and the surface are settled before any rule runs, so this pass answers both
    // without a status read — and the binding rule stays written in exactly one place.
    const candidates = writes.flatMap((write) => [
      admitProjectScopeWrite(this.scopeRequest(principal, scope, write, {})).projectId,
      write.currentProjectId,
      scope?.projectId ?? null,
    ]);
    return {
      principal,
      scope,
      projectStatus: await this.projectScopeStatuses(db, ownerId, candidates),
      mode,
    };
  }

  /** One write, as §4 reads it. Server-derived throughout; `scopeToken` is compared, never trusted. */
  private scopeRequest(
    principal: ScopePrincipal,
    scope: DerivedScope | null,
    write: ScopeWriteInput,
    projectStatus: Readonly<Record<string, ScopeProjectStatus>>,
  ): ScopeAdmissionRequest {
    return {
      principal,
      operation: write.operation,
      taskId: write.taskId,
      requestedProjectId: write.requestedProjectId,
      currentProjectId: write.currentProjectId,
      scope,
      presentedScopeToken: write.scopeToken,
      projectStatus,
      // Unit L4. Carried on the write rather than looked up here, so the SAME answer the admission
      // decided on is the one the effect-time fence re-decides on — the fence's job is to catch a
      // scope that moved, and re-reading the approval there would silently change the question.
      // What catches an approval that moved is the spend itself: one compare-and-set inside the
      // transaction that writes the task, which fails and takes the task with it.
      approval: write.approval ?? null,
    };
  }

  /**
   * §4, applied to one real write: which project it lands in, and whether it happens at all.
   *
   * Returns the project id the caller must write — the server-derived binding this whole unit
   * exists for. A coordinator write that names no project is filed under the project the server
   * says that session coordinates; one that names another project does not happen.
   *
   * Synchronous and total, so a batch can admit every item BEFORE opening its transaction: a
   * refusal then costs no row, no lock and no partial batch (AC1, AC2).
   *
   * §8 CM2's two phases: in `observe` the decision is audited and the write proceeds EXACTLY as it
   * did before this unit — including the binding, which is a behaviour change like any other — so
   * that what enforcement would reject is countable before it is switched on.
   */
  /**
   * §4's decision over one write, WITHOUT the throw.
   *
   * Split out for unit L4: a declared crossing has to be able to read its own refusal — "there is
   * no answer yet" is the one refusal that is answered by filing a question rather than by giving
   * up — and an exception is not a value you can branch on without making control flow out of
   * failure. `admitScopedWrite` is this plus the throw, so the ordinary paths are unchanged.
   */
  private decideScopedWrite(world: ScopeWorld, write: ScopeWriteInput): ScopeAdmission {
    return admitProjectScopeWrite(
      this.scopeRequest(world.principal, world.scope, write, world.projectStatus),
    );
  }

  private admitScopedWrite(world: ScopeWorld, write: ScopeWriteInput): string | null {
    const request = this.scopeRequest(world.principal, world.scope, write, world.projectStatus);
    const admission = this.decideScopedWrite(world, write);
    if (scopeWriteRefused(admission, world.mode)) {
      throw new ForbiddenException(scopeRefusalBody(admission.outcome!, write.taskId));
    }
    if (world.mode === 'observe') {
      if (admission.outcome && admission.outcome.decision !== 'ALLOW') {
        this.logger.warn(scopeObservationLine(admission, request));
      }
      // Pre-L3 behaviour, to the letter: what the caller asked for, or what the row already says.
      return write.requestedProjectId !== undefined
        ? write.requestedProjectId
        : write.currentProjectId;
    }
    return admission.projectId;
  }


  // ---------------------------------------------------------------------------------------------
  // Unit L4: declared crossings, and the plan preflight.
  // ---------------------------------------------------------------------------------------------

  /**
   * The full identity of one write — everything an approval for it binds.
   *
   * Every field, not just the prose. An approval that bound only the title and description would be
   * a yes the writer could spend on a task with another assignee, another provider, another parent,
   * another set of prerequisites or auto-run switched on: the user would have answered a question
   * about words and authorised a change in WHO does the work, WITH WHAT, WHEN it starts and what it
   * gates. The four provenance values come from `origin` — server-derived (`resolveOwnedSession`),
   * never from the request — and `ProjectHandoffService` re-derives them again under its own locks,
   * because binding a value into a digest makes it tamper-evident, not true.
   */
  private handoffIdentityOf(
    item: CreateTaskBatchItemDto,
    origin: CreationOrigin | undefined,
    refDigests: ReadonlyMap<string, string>,
  ): HandoffRequestIdentity {
    return {
      plan: {
        title: item.title,
        description: item.description ?? null,
        acceptanceCriteria: item.acceptanceCriteria ?? null,
        labels: item.labels ? normalizeTaskLabels(item.labels) : [],
        assigneeId: item.assigneeId ?? null,
        listId: item.listId ?? null,
        provider: item.provider ?? null,
        model: item.model ?? null,
        autoRunWhenReady: item.autoRunWhenReady ?? null,
        runAt: item.runAt ?? null,
        dueDate: item.dueDate ?? null,
        completionPolicy: item.completionPolicy ?? null,
        parentTaskId: item.parentTaskId ?? null,
        // A ref is a name local to one batch; two batches spell the same link differently and
        // different links the same. So what is bound is the identity of the item it names.
        parentRefDigest: item.parentRef ? (refDigests.get(item.parentRef) ?? null) : null,
        verifiesTaskId: item.verifiesTaskId ?? null,
        verifiesRefDigest: item.verifiesRef ? (refDigests.get(item.verifiesRef) ?? null) : null,
        supersedesTaskId: item.supersedesTaskId ?? null,
        dependsOnTaskIds: item.dependsOnTaskIds ?? [],
        dependsOnRefDigests: (item.dependsOnRefs ?? []).map((ref) => refDigests.get(ref) ?? ref),
      },
      source: {
        projectId: origin?.discoveredFromProjectId ?? null,
        taskId: origin?.sourceTaskId ?? null,
        sessionId: origin?.sessionId ?? null,
        triggerEvent: origin?.triggerEvent ?? null,
      },
    };
  }

  /**
   * Every item's identity, in order, with each ref resolved to the identity of the item it names.
   *
   * Order is what makes this possible at all: refs are backward-only, so by the time an item is
   * reached every ref it can name has already been digested.
   */
  private handoffIdentities(
    items: readonly CreateTaskBatchItemDto[],
    origin: CreationOrigin | undefined,
  ): HandoffRequestIdentity[] {
    const refDigests = new Map<string, string>();
    return items.map((item) => {
      const identity = this.handoffIdentityOf(item, origin, refDigests);
      if (item.ref !== undefined && !refDigests.has(item.ref)) {
        refDigests.set(item.ref, handoffPayloadDigest(identity));
      }
      return identity;
    });
  }

  /**
   * The crossing a write DECLARES, or null when it declares none.
   *
   * Three of the four "no crossing here" answers are deliberate rather than lenient: a declaration
   * from a session with no scope is left to R5, and one that names the project the session already
   * coordinates is not a crossing at all — a redundant declaration is harmless and refusing it
   * would punish a client for being explicit. The one refusal is a declaration that names no
   * destination, because a crossing without an end is not a request anybody can answer.
   */
  private declaredCrossing(
    ownerId: string,
    item: CreateTaskDto,
    identity: HandoffRequestIdentity,
    scope: DerivedScope | null,
    sessionId: string | undefined,
  ): { declaration: HandoffDeclaration; authority: HandoffAuthority } | null {
    if (!item.handoff) return null;
    if (item.projectId === undefined || item.projectId === null) {
      throw new BadRequestException(
        'a declared crossing has to say where it is going — name the target project (projectId)',
      );
    }
    if (!sessionId || !scope) return null;
    if (item.projectId === scope.projectId) return null;
    const declaration: HandoffDeclaration = {
      fromProjectId: scope.projectId,
      toProjectId: item.projectId,
      kind: 'FILE_TASK',
      subjectTaskId: null,
      identity,
      title: item.title,
      reason: item.handoff.reason ?? null,
      requestedBySessionId: sessionId,
    };
    return { declaration, authority: this.handoffs.authorityOf(ownerId, declaration) };
  }

  /**
   * §4 for a write that may be a declared crossing: decide, ask if it has to, decide again.
   *
   * The order is the point. The decision runs FIRST against whatever answer already exists, so a
   * crossing refused for another reason — a rotated scope, a settled destination, an approval aimed
   * at something else — is refused without a question being filed. Only `CROSS_PROJECT_APPROVAL_REQUIRED`
   * (R10: there is no answer yet) files one, and then the decision is re-run against what came back,
   * because the answer may already BE yes: when the owner has put both projects on AUTO, filing the
   * question and answering it are the same instant, and the write proceeds under R14.
   *
   * Returns what the caller must spend inside its transaction. Nothing is spent here: the approval
   * is not consumed by being read, only by the task that was written under it.
   */
  private async admitDeclaredWrite(
    ownerId: string,
    world: ScopeWorld,
    write: ScopeWriteInput,
    crossing: { declaration: HandoffDeclaration; authority: HandoffAuthority } | null,
    now: Date,
  ): Promise<{ projectId: string | null; spend: HandoffSpend | null }> {
    if (!crossing) return { projectId: this.admitScopedWrite(world, write), spend: null };
    write.operation = 'HANDOFF_TASK';
    const answer = await this.handoffs.answerFor(this.prisma, crossing.authority, now);
    write.approval = answer?.approval ?? null;
    let row = answer?.row ?? null;
    let admission = this.decideScopedWrite(world, write);
    if (admission.outcome?.code === 'CROSS_PROJECT_APPROVAL_REQUIRED' && world.scope) {
      const filed = await this.handoffs.declare(ownerId, crossing.declaration, {
        projectId: world.scope.projectId,
        generation: world.scope.generation,
      }, now);
      write.approval = filed.approval;
      row = filed.row;
      admission = this.decideScopedWrite(world, write);
    }
    if (scopeWriteRefused(admission, world.mode)) {
      // The refusal names the question, so the caller has something to poll and a person has
      // something to open. `handoffId` is classified as a public id, so the exception filter
      // renders it base62 like every other address in an error body.
      throw new ForbiddenException({
        ...scopeRefusalBody(admission.outcome!, write.taskId),
        handoffId: row?.id ?? null,
        handoffState: row?.state ?? null,
      });
    }
    if (world.mode === 'observe') {
      return { projectId: this.admitScopedWrite(world, write), spend: null };
    }
    return {
      projectId: admission.projectId,
      spend: row && admission.outcome?.decision === 'ALLOW' && admission.outcome.rule === 'R14_HANDOFF_APPROVED'
        ? { authority: crossing.authority, handoffId: row.id }
        : null,
    };
  }

  /**
   * The cross-project prerequisite edges a plan asks for, and the answer that exists for each.
   *
   * An edge does not move a task between projects, so L1's write decision never sees it as a
   * crossing — and yet "my goal now waits on yours" is the same authority question about a
   * different row. It is asked here, filed under the same table and refused with the same codes.
   *
   * A question is only filed for an edge whose DEPENDENT is in the project this session actually
   * coordinates. A coordinator of A has no standing to ask B to wait on C, and the declaration
   * service would refuse it — so the plan is simply refused instead, which is the honest answer.
   */
  private async resolveDependencyCrossings(
    ownerId: string,
    items: readonly CreateTaskBatchItemDto[],
    identities: readonly HandoffRequestIdentity[],
    tasks: Readonly<Record<string, { projectId: string | null }>>,
    world: ScopeWorld,
    sessionId: string | undefined,
    now: Date,
    frozen: ReadonlySet<number>,
  ): Promise<DependencyCrossings> {
    const answers: Record<string, HandoffApproval | null> = {};
    const edges: DependencyCrossings['edges'] = [];
    if (world.principal === 'USER') return { answers, edges };
    for (const [index, item] of items.entries()) {
      // A replayed winner is a fact, not a plan: its edges were written and its crossings spent by
      // the attempt that committed them. Re-resolving them here would re-judge history against a
      // world that has moved (§3 SC4), and re-spending is what the spend's own compare-and-set
      // exists to refuse.
      if (frozen.has(index)) continue;
      const from = item.projectId ?? null;
      if (!from) continue;
      for (const prerequisiteId of item.dependsOnTaskIds ?? []) {
        const to = tasks[prerequisiteId]?.projectId ?? null;
        if (!to || to === from) continue;
        const declaration: HandoffDeclaration = {
          fromProjectId: from,
          toProjectId: to,
          kind: 'DEPEND_ON_TASK',
          subjectTaskId: prerequisiteId,
          dependentTaskId: null,
          identity: identities[index],
          title: item.title,
          reason: item.handoff?.reason ?? null,
          requestedBySessionId: sessionId ?? '',
        };
        const authority = this.handoffs.authorityOf(ownerId, declaration);
        const existing = await this.handoffs.answerFor(this.prisma, authority, now);
        if (existing) {
          answers[`${index}:${prerequisiteId}`] = existing.approval;
          edges.push({ index, from, prerequisiteId, authority, handoffId: existing.row.id });
          continue;
        }
        // Only a declared crossing files a question, and only from the scope that holds the
        // dependent end. Everything else is refused by the preflight with nothing written.
        if (item.handoff && sessionId && world.scope && world.scope.projectId === from) {
          const filed = await this.handoffs.declare(ownerId, declaration, {
            projectId: world.scope.projectId,
            generation: world.scope.generation,
          }, now);
          answers[`${index}:${prerequisiteId}`] = filed.approval;
          edges.push({ index, from, prerequisiteId, authority, handoffId: filed.row.id });
        } else {
          answers[`${index}:${prerequisiteId}`] = null;
          edges.push({ index, from, prerequisiteId, authority, handoffId: null });
        }
      }
    }
    return { answers, edges };
  }

  /**
   * Everything a plan has to satisfy before any of it is written — all of it, in one answer.
   *
   * Runs before the transaction, so a refused plan costs no row and no lock (AC5). The facts come
   * from bounded reads — one per kind of thing the plan names, not one per item — and the decision
   * itself is `preflightPlan`, which is pure, so the preview card and the write cannot disagree
   * about whether a plan is legal.
   */
  private async assertPlanPreflight(
    ownerId: string,
    items: readonly CreateTaskBatchItemDto[],
    world: ScopeWorld,
    referenced: Readonly<Record<string, PlanTaskFacts>>,
    dependencyAnswers: Readonly<Record<string, HandoffApproval | null>>,
    frozen: ReadonlySet<number>,
  ): Promise<PlanAdmission> {
    const fresh = items.filter((_, index) => !frozen.has(index));
    const projectIds = [...new Set(fresh.map((item) => item.projectId).filter((id): id is string => !!id))];
    const assigneeIds = [...new Set(fresh.map((item) => item.assigneeId).filter((id): id is string => !!id))];
    const providerSlugs = [...new Set(fresh
      .map((item) => item.provider)
      .filter((provider): provider is string => !!provider)
      .filter((provider) => !Object.values(AgentProvider).includes(provider as AgentProvider)))];
    const [projects, workspaces, providers] = await Promise.all([
      projectIds.length
        ? this.prisma.project.findMany({
            where: { id: { in: projectIds }, ownerId },
            select: {
              id: true,
              status: true,
              acceptanceEpoch: true,
              maxConcurrentTasks: true,
              sessionBudgetPerDay: true,
              coordinatorSessionId: true,
              members: { select: { agentId: true, role: true } },
            },
          })
        : Promise.resolve([]),
      assigneeIds.length
        ? this.prisma.workspace.findMany({
            where: { id: { in: assigneeIds }, ownerId, deletedAt: null },
            select: { id: true, runnerId: true },
          })
        : Promise.resolve([]),
      providerSlugs.length
        ? this.prisma.modelProvider.findMany({
            where: { slug: { in: providerSlugs }, enabled: true, OR: [{ ownerId: null }, { ownerId }] },
            select: { slug: true },
          })
        : Promise.resolve([]),
    ]);
    const facts: PlanFacts = {
      items: items.map((item, index) => ({
        index,
        frozen: frozen.has(index),
        ref: item.ref ?? null,
        projectId: item.projectId ?? null,
        parentTaskId: item.parentTaskId ?? null,
        parentRef: item.parentRef ?? null,
        verifiesTaskId: item.verifiesTaskId ?? null,
        verifiesRef: item.verifiesRef ?? null,
        dependsOnTaskIds: item.dependsOnTaskIds ?? [],
        dependsOnRefs: item.dependsOnRefs ?? [],
        assigneeId: item.assigneeId ?? null,
        listId: item.listId ?? null,
        autoRunWhenReady: item.autoRunWhenReady !== false,
        acceptanceEpoch: item.projectAcceptanceEpoch ?? null,
      })),
      world: {
        principal: world.principal,
        projects: Object.fromEntries(projects.map((project) => [project.id, {
          status: project.status as 'OPEN' | 'DONE' | 'CANCELLED',
          acceptanceEpoch: String(project.acceptanceEpoch),
          maxConcurrentTasks: project.maxConcurrentTasks,
          sessionBudgetPerDay: project.sessionBudgetPerDay,
          memberWorkspaceIds: new Set(project.members.map((member) => member.agentId)),
        }])),
        tasks: referenced,
        workspaces: Object.fromEntries(workspaces.map((row) => [row.id, { hasRunner: !!row.runnerId }])),
        dependencyAnswers,
      },
    };
    const findings = preflightPlan(facts);
    const refusals = planPreflightRefusals(findings);
    if (refusals.length) throw new BadRequestException(planPreflightRefusalBody(findings));
    for (const warning of findings) {
      this.logger.warn(
        `plan preflight: ${warning.code} on item ${warning.index} (${warning.dimension})`,
      );
    }
    return {
      findings,
      workspaceIds: assigneeIds,
      providerSlugs,
      // Only the facts that DECIDED something: the referenced tasks of fresh items, the projects
      // they land in, the workspaces and providers they name. A frozen item's world is not in here
      // — it is not being written, so nothing about it can drift into a refusal.
      snapshot: this.planAuthoritySnapshot(projects, workspaces, providers, Object.fromEntries(
        Object.entries(referenced).filter(([id]) => fresh.some((item) =>
          item.parentTaskId === id
          || item.verifiesTaskId === id
          || (item.dependsOnTaskIds ?? []).includes(id))),
      )),
    };
  }

  /**
   * Whether this plan has anything for the preflight to decide.
   *
   * §4 R1 puts the owner outside the scope contract, and AC5 is explicit that their path pays not
   * one extra query for a boundary that does not apply to it — a promise this unit keeps as
   * literally as L3 did. Every REFUSE the preflight can produce for a USER write is either already
   * answered inside the transaction (the hierarchy rules, under the owner lock, where the answer
   * still has to be true when the row is written) or is about a crossing the owner cannot make (§4
   * R1 again: their edge is an authorization in itself).
   *
   * The one exception is the claim only a caller can make: "I planned this against acceptance epoch
   * N". Nobody else can know it was made, so a plan that states it is judged on it whoever sent it.
   */
  private planNeedsPreflight(
    world: ScopeWorld,
    items: readonly CreateTaskBatchItemDto[],
  ): boolean {
    return world.principal !== 'USER'
      || items.some((item) => item.projectAcceptanceEpoch !== undefined);
  }

  /** Every existing task a plan names, by id — the world its structural checks are judged against. */
  private async referencedTaskFacts(
    ownerId: string,
    items: readonly CreateTaskBatchItemDto[],
  ): Promise<Record<string, PlanTaskFacts>> {
    const ids = [...new Set(items.flatMap((item) => [
      item.parentTaskId,
      item.verifiesTaskId,
      ...(item.dependsOnTaskIds ?? []),
    ]).filter((id): id is string => !!id))];
    if (!ids.length) return {};
    const rows = await this.prisma.task.findMany({
      where: { id: { in: ids }, ownerId },
      select: { id: true, projectId: true, verifiesTaskId: true },
    });
    return Object.fromEntries(rows.map((row) => [row.id, {
      projectId: row.projectId,
      verifiesTaskId: row.verifiesTaskId,
    }]));
  }


  /**
   * Unit L4: every fact that decided this plan, captured at preflight and re-read before the first
   * write.
   *
   * The rule it enforces is one sentence: a field that decided REFUSE or ALLOW has to still say the
   * same thing inside the transaction that acts on it. The preflight reads the world without locks —
   * that is what makes it cheap and what makes a refusal cost nothing — so between it and the first
   * INSERT a project can be reopened (a new acceptance epoch, still OPEN), a workspace can be
   * soft-deleted, a configured provider can be disabled, a budget can be lowered. Each of those
   * would leave a plan admitted on a world that no longer exists, and none of them is visible to
   * `refenceProjectScope`, which is about the coordination scope and answers a different question.
   *
   * So: snapshot at preflight, re-read under the locks, compare field by field, and refuse the
   * WHOLE plan on any drift — no task, no edge, no approval spent. One helper for a single create
   * and for a fifty-item batch, because two copies of this would be two answers to "was the plan
   * still legal", and the one that drifted would be the one nobody ran.
   */
  private planProjectIdentityDigest(project: {
    coordinatorSessionId: string | null;
    members: ReadonlyArray<{ agentId: string; role: string }>;
  }): string {
    return createHash('sha256')
      .update(JSON.stringify([
        'plan-identity:v1',
        project.coordinatorSessionId ?? null,
        [...project.members]
          .map((member) => [member.agentId, member.role] as const)
          .sort(([a, aRole], [b, bRole]) => (a === b ? (aRole < bRole ? -1 : 1) : a < b ? -1 : 1)),
      ]))
      .digest('hex');
  }

  private planAuthoritySnapshot(
    projects: ReadonlyArray<{
      id: string;
      status: string;
      acceptanceEpoch: bigint;
      maxConcurrentTasks: number;
      sessionBudgetPerDay: number | null;
      coordinatorSessionId: string | null;
      members: ReadonlyArray<{ agentId: string; role: string }>;
    }>,
    workspaces: ReadonlyArray<{ id: string }>,
    providers: ReadonlyArray<{ slug: string }>,
    tasks: Readonly<Record<string, PlanTaskFacts>>,
  ): PlanAuthoritySnapshot {
    return {
      projects: Object.fromEntries(projects.map((project) => [project.id, {
        status: project.status,
        acceptanceEpoch: String(project.acceptanceEpoch),
        maxConcurrentTasks: project.maxConcurrentTasks,
        sessionBudgetPerDay: project.sessionBudgetPerDay,
        identityDigest: this.planProjectIdentityDigest(project),
      }])),
      workspaceIds: workspaces.map((workspace) => workspace.id).sort(),
      providerSlugs: providers.map((provider) => provider.slug).sort(),
      taskProjects: Object.fromEntries(
        Object.entries(tasks).map(([id, facts]) => [id, facts.projectId]),
      ),
    };
  }

  /**
   * Rank 15: the execution identity a plan was admitted against, locked before anything is written.
   *
   * `workspace` and `model_provider` are the two relations a plan's REFUSALS depend on that no
   * other lock in this transaction covers. Both are taken `FOR SHARE` — the mode that conflicts
   * with the `FOR NO KEY UPDATE` an ordinary `UPDATE` takes, which is what a soft-delete and a
   * disable both are; `FOR KEY SHARE` would be a lock that does not conflict with the write it is
   * protecting against, which is a comment rather than a lock.
   *
   * Rank 15 — after the owner mutex, before the task lists — is where they belong in the canonical
   * order: a task write already takes both relations' rows through its own foreign keys at
   * `FOR KEY SHARE`, and neither relation's writers wait on anything this transaction holds
   * (`WorkspacesService.remove` takes its own row `FOR UPDATE` and then waits for nothing;
   * `ProvidersService.update` writes one row and commits), so this adds an ordering, not an edge.
   */
  private async lockPlanExecutionIdentity(
    tx: Prisma.TransactionClient,
    ownerId: string,
    workspaceIds: readonly string[],
    providerSlugs: readonly string[],
  ): Promise<void> {
    const ids = orderedIds(workspaceIds);
    const slugs = [...new Set(providerSlugs)].sort();
    if (!ids.length && !slugs.length) return;
    // Rank 10 FIRST, unconditionally, in the mode the INSERT's own foreign key takes anyway.
    // Without it this is an inversion: a plain create with an assignee takes no rank-10 lock of its
    // own (`lockDependencyGraph` is conditional on the write restructuring the graph), so it would
    // take `workspace` at 15 and then reach back to `user` at 10 when the row is written — exactly
    // the shape the canonical order exists to make impossible. Re-locking a row this transaction
    // already holds at FOR UPDATE costs nothing.
    await tx.$queryRaw`SELECT "id" FROM "user" WHERE "id" = ${ownerId}::uuid FOR KEY SHARE`;
    if (ids.length) {
      await tx.$queryRaw`
        SELECT "id" FROM "workspace"
        WHERE "id" = ANY(${ids}::uuid[]) AND "owner_id" = ${ownerId}::uuid
        ORDER BY "id"
        FOR SHARE`;
    }
    if (slugs.length) {
      await tx.$queryRaw`
        SELECT "id" FROM "model_provider"
        WHERE "slug" = ANY(${slugs}::text[])
          AND ("owner_id" IS NULL OR "owner_id" = ${ownerId}::uuid)
        ORDER BY "id"
        FOR SHARE`;
    }
  }

  /**
   * The same facts, read again under the locks this transaction now holds, and compared.
   *
   * Called after `refenceProjectScope` (rank 40) and before the first row is written. The project
   * rows are already held `FOR NO KEY UPDATE` by that fence, so a reopen — which writes `status`
   * and `acceptance_epoch` on the same row — is either wholly before this read or wholly after this
   * transaction. The workspaces and providers were taken at rank 15 above. The referenced tasks are
   * taken here at rank 50, `FOR SHARE`, in one sorted statement.
   */
  private async assertPlanAuthorityUnchanged(
    tx: Prisma.TransactionClient,
    ownerId: string,
    snapshot: PlanAuthoritySnapshot,
  ): Promise<void> {
    const drift = (what: string): never => {
      throw new ConflictException({
        code: 'PLAN_AUTHORITY_MOVED',
        message:
          `${what} changed while this plan was being admitted — nothing was written; re-read the `
          + 'world and submit the plan again',
        requiredAction: 'RE_DERIVE_SCOPE',
      });
    };
    const projectIds = orderedIds(Object.keys(snapshot.projects));
    if (projectIds.length) {
      const rows = await tx.project.findMany({
        where: { id: { in: projectIds }, ownerId },
        select: {
          id: true,
          status: true,
          acceptanceEpoch: true,
          maxConcurrentTasks: true,
          sessionBudgetPerDay: true,
          coordinatorSessionId: true,
          members: { select: { agentId: true, role: true } },
        },
      });
      if (rows.length !== projectIds.length) drift('a project this plan files into');
      for (const row of rows) {
        const before = snapshot.projects[row.id];
        if (before.status !== String(row.status)) drift('a project status');
        if (before.acceptanceEpoch !== String(row.acceptanceEpoch)) drift('a project acceptance epoch');
        if (before.maxConcurrentTasks !== row.maxConcurrentTasks) drift('a project concurrency budget');
        if (before.sessionBudgetPerDay !== row.sessionBudgetPerDay) drift('a project session budget');
        if (before.identityDigest !== this.planProjectIdentityDigest(row)) {
          drift('a project team or its coordinator');
        }
      }
    }
    if (snapshot.workspaceIds.length) {
      const rows = await tx.workspace.findMany({
        where: { id: { in: snapshot.workspaceIds }, ownerId, deletedAt: null },
        select: { id: true },
      });
      if (rows.length !== snapshot.workspaceIds.length) drift('an assignee workspace');
    }
    if (snapshot.providerSlugs.length) {
      const rows = await tx.modelProvider.findMany({
        where: {
          slug: { in: snapshot.providerSlugs },
          enabled: true,
          OR: [{ ownerId: null }, { ownerId }],
        },
        select: { slug: true },
      });
      if (new Set(rows.map((row) => row.slug)).size !== snapshot.providerSlugs.length) {
        drift('a configured provider');
      }
    }
    const taskIds = orderedIds(Object.keys(snapshot.taskProjects));
    if (taskIds.length) {
      const rows = await tx.$queryRaw<Array<{ id: string; project_id: string | null }>>(Prisma.sql`
        SELECT "id", "project_id" FROM "task"
         WHERE "id" = ANY(${taskIds}::uuid[]) AND "owner_id" = ${ownerId}::uuid
         ORDER BY "id"
         FOR SHARE
      `);
      if (rows.length !== taskIds.length) drift('a task this plan links to');
      for (const row of rows) {
        if ((snapshot.taskProjects[row.id] ?? null) !== (row.project_id ?? null)) {
          drift('the project of a task this plan links to');
        }
      }
    }
  }

  /**
   * The dependency crossings again, inside the transaction, under a lock on the prerequisites.
   *
   * The preflight reads a prerequisite's project without a lock, and `project_id` is not a key
   * column — an ordinary move takes `FOR NO KEY UPDATE`, which nothing in that read conflicts with.
   * So between the preflight and this transaction a prerequisite can move, turning an in-project
   * edge into a crossing nobody approved. Here the rows are taken `FOR SHARE` (rank 50, sorted,
   * the mode that DOES conflict with a move) and the question is asked again against what they say
   * now. A refusal aborts the whole batch, which is the only honest answer: an approval that was
   * about one shape of the graph is not an approval about another.
   */
  private async assertDependencyCrossingsAtEffect(
    tx: Prisma.TransactionClient,
    ownerId: string,
    edges: ReadonlyArray<{ from: string | null; prerequisiteId: string; authority: HandoffAuthority | null }>,
    now: Date,
  ): Promise<void> {
    const ids = orderedIds(edges.map((edge) => edge.prerequisiteId));
    if (!ids.length) return;
    const rows = await tx.$queryRaw<Array<{ id: string; project_id: string | null }>>(Prisma.sql`
      SELECT "id", "project_id" FROM "task"
       WHERE "id" = ANY(${ids}::uuid[]) AND "owner_id" = ${ownerId}::uuid
       ORDER BY "id"
       FOR SHARE
    `);
    const projectOf = new Map(rows.map((row) => [row.id, row.project_id]));
    for (const edge of edges) {
      const to = projectOf.get(edge.prerequisiteId) ?? null;
      if (!edge.from || !to || to === edge.from) continue;
      const answer = edge.authority
        ? await this.handoffs.answerFor(tx, edge.authority, now)
        : null;
      const refusal = dependencyCrossingRefusal(answer?.approval ?? null);
      if (refusal) {
        throw new ForbiddenException({
          code: refusal,
          message:
            'this edge would make one project wait on another project\'s work and no approval names '
            + 'it — nothing was written',
          requiredAction: 'AWAIT_HANDOFF_APPROVAL',
        });
      }
    }
  }

  /**
   * The conversation turn a task create belongs to, or undefined. The inbox delivers at most one
   * message/shell turn IN_FLIGHT per session at a time (the claim SQL only hands out a PENDING one
   * when none is in flight), so this is unambiguous. A redelivered turn keeps its row id, which is
   * precisely what lets the idempotency key below match between a turn's first run and its re-run.
   */
  private async currentTurnId(sessionId: string): Promise<string | undefined> {
    const turn = await this.prisma.conversationTurn.findFirst({
      where: { sessionId, status: 'IN_FLIGHT', kind: { in: ['message', 'shell'] } },
      orderBy: { seq: 'desc' },
      select: { id: true },
    });
    return turn?.id;
  }

  /**
   * The row already committed for an idempotent write, or null — the ONE place that question is
   * asked and the ONE place the answer is validated.
   *
   * Every path that can find a winner comes through here: the pre-read before the transaction, the
   * find-or-create inside the batch's transaction, and BOTH P2002 read-backs (the single create's
   * catch and the batch's supersession reconstruction). Those last two used to call `findUnique`
   * directly and return whatever came back, which meant the validator was a thing the happy path
   * did and the race path skipped — and the race path is the only one an attacker or a fault can
   * reach on purpose.
   *
   * `idempotency_key` is unique across the WHOLE table and is written by other subsystems under
   * their own templates, so "a row exists under this key" is not "this request already ran". Four
   * facts are checked, and a failure of any is a typed 409 with nothing written:
   *
   *   - **owner** — a key held by another tenant is neither a miss (that would send this write into
   *     an INSERT that can only fail on the index, surfacing a raw P2002) nor a hit (that would be
   *     a cross-tenant read of somebody else's task).
   *   - **operation and payload** — the key is REBUILT from the winner's own persisted title and
   *     description, this request's session and turn, and this operation's discriminator. A row
   *     that does not reproduce the key it is filed under was written by something other than this
   *     request: a raw fault, a repair script, another operation reusing the column.
   *   - **request identity** — the winner's `creator_session_id` must be the session asking. The
   *     rebuild above already binds the session (it is in the preimage), but the rebuild cannot see
   *     a row whose stored session was altered after the fact, and this can.
   *
   * `db` so the batch can ask inside its transaction, where the answer has to be the one its own
   * inserts will see.
   */
  private async idempotencyWinner(
    db: Pick<Prisma.TransactionClient, 'task'>,
    ownerId: string,
    write: IdempotentTaskWrite,
  ): Promise<Task | null> {
    const idempotencyKey = this.taskIdempotencyKey(write);
    const existing = await db.task.findUnique({ where: { idempotencyKey } });
    if (!existing) return null;
    const mismatch = (why: string): never => {
      // Deliberately says nothing about the row it refused: the caller has not been shown to own
      // it, so naming its id, its title or its account would be the leak this branch exists to
      // prevent. `why` is the SHAPE of the disagreement, which is all a retry needs.
      throw new ConflictException(
        `that idempotency key is already held by a different write (${why}) — `
          + 'nothing was written; retry with a new request',
      );
    };
    if (existing.ownerId !== ownerId) mismatch('different account');
    if ((existing.creatorSessionId ?? null) !== write.sessionId) mismatch('different session');
    // The winner rebuilt from what it actually holds. Same operation, same session, same turn, same
    // normalised payload — or it is not this write's earlier attempt.
    const rebuilt = this.taskIdempotencyKey({
      operation: write.operation,
      sessionId: write.sessionId,
      turnId: write.turnId,
      title: existing.title,
      description: existing.description,
    });
    if (rebuilt !== existing.idempotencyKey) mismatch('different operation or payload');
    return existing;
  }

  /**
   * A replay that asks for a different project than the row it is being handed.
   *
   * Not a refusal: the write already happened, under the scope that made it, and §6 says a later
   * takeover does not reach back into it. But it is worth a line — a retry that changed its mind
   * about where the work belongs is a coordinator whose plan moved between attempts, and the only
   * place that is visible is here.
   */
  private auditReplayedProject(winner: Task, requestedProjectId?: string | null): void {
    if (requestedProjectId === undefined) return;
    if ((requestedProjectId ?? null) === (winner.projectId ?? null)) return;
    this.logger.warn(
      `project scope replay: an idempotent retry asked for a different project than the row it `
      + `already committed; the committed project stands (task ${uuidToBase62(winner.id)})`,
    );
  }

  /**
   * §4 a second time, inside the transaction that writes the row, under the project's own lock.
   *
   * The admission before the transaction reads the world and decides. Between that read and the
   * INSERT there is a window, and a rotation is precisely the thing that can commit inside it: T1
   * derives scope (A, G) and is allowed; T2 atomically rotates the coordinator to a new session and
   * G+1 and commits; T1 then writes into A, authorized by a fact that is no longer true. Nothing
   * downstream would notice — the row is indistinguishable from one the CURRENT holder wrote, which
   * is §0's incident with a race in place of a mistake.
   *
   * Closing it needs two things, and one of them is not enough on its own:
   *
   *  1. **The lock.** `FOR NO KEY UPDATE` on the project row, which is what a rotation's own
   *     `UPDATE "project" SET "coordinator_session_id" = …` must take to commit. Whichever of the
   *     two gets it first is the one that happened first; there is no third outcome.
   *  2. **The re-read.** Holding a lock proves nothing about what was read before it. So the scope
   *     is derived AGAIN from the locked world, and the decision is re-run — with the scope the
   *     admission acted under presented as the claim. That is not a second, parallel rule: it is
   *     §4 R2/R3 doing exactly what they were written for, with the server's own earlier reading in
   *     the place a client's token would be. A rotation therefore refuses with
   *     `COORDINATOR_GENERATION_MOVED` and `YIELD_TO_CURRENT_SCOPE`, which is the same answer a
   *     stale client gets, because it is the same fact.
   *
   * Rank 40 in the canonical lock order (`common/lock-order.ts`) — after the owner mutex, the task
   * lists and the creator Sessions, before any task row — which is where this path ALREADY takes
   * the project row for `project_acceptance_reopen`. Same rank, same mode, same UUID ordering, so
   * it adds no edge to the lock graph and no new deadlock is reachable through it.
   *
   * Replays never reach here: the idempotency winner is returned before the transaction opens, so a
   * write that already committed is never re-decided by a scope that has moved since (§3 SC4).
   */
  private async refenceProjectScope(
    tx: Prisma.TransactionClient,
    ownerId: string,
    actingSessionId: string | undefined,
    admitted: ScopeWorld,
    writes: ReadonlyArray<ScopeWriteInput & { boundProjectId: string | null }>,
    /**
     * Projects the SAME transaction takes at rank 40 for another reason — the supersession
     * pre-lock. Folded into this one sorted pass and taken here, so the transaction's rank-40
     * acquisitions are one non-decreasing sequence rather than two overlapping ones: a later
     * statement re-locking a row already held is free, while a smaller id taken after a larger one
     * is the only shape at this rank that could make a cycle.
     */
    /**
     * Every project this plan touched at admission time: the project each fresh item is bound to,
     * the scope a declared crossing derives its authority FROM, the far end of every cross-project
     * edge, and any project another mechanism in this transaction pre-locks (the supersession).
     *
     * Required, and checked below rather than defaulted. It was a defaulted `alsoLock` before, and
     * that shape hid two holes at once: an ordinary USER plan passed nothing and locked NO project
     * at all — leaving the acceptance epoch, the status and the budget this plan was admitted
     * against free to move between the read and the INSERT — and a declared crossing passed only
     * the project it lands IN, while the generation authorising it is read from the project it
     * comes FROM. A parameter with a default is a parameter a call site can forget.
     */
    planProjects: ReadonlyArray<string | null | undefined>,
  ): Promise<void> {
    const fenced = admitted.principal === 'USER'
      // §4 R1: the owner is outside this contract, so there is no scope to re-decide for them.
      // The LOCKS below are still taken — unit L4 gave this transaction a second reason to hold
      // the project rows, and that reason applies to every principal: a plan admitted against an
      // acceptance epoch, a status or a budget read without a lock has to re-read them under one
      // before it writes, and the owner's plans are admitted the same way.
      ? []
      : writes.filter((write) => write.boundProjectId !== null || write.currentProjectId !== null);
    // Sorted by UUID (§8.6 LO2), one statement each, so two writers touching the same two projects
    // in opposite request orders cannot make a cycle.
    const projectIds = [...new Set([
      ...writes.flatMap((write) => [write.boundProjectId, write.currentProjectId]),
      ...planProjects,
    ].filter((id): id is string => !!id))].sort();
    // The invariant, asserted where it can actually be violated: every project the plan writes into
    // or authorises against is in the set this transaction is about to lock. A call site that
    // forgets one does not silently take fewer locks — it fails here, on every request, loudly.
    for (const write of writes) {
      for (const projectId of [write.boundProjectId, write.currentProjectId]) {
        if (projectId && !projectIds.includes(projectId)) {
          throw new Error(`plan project set is missing ${projectId} — the fence would not lock it`);
        }
      }
    }
    if (admitted.scope && writes.some((write) => write.operation === 'HANDOFF_TASK')
        && !projectIds.includes(admitted.scope.projectId)) {
      throw new Error(
        'plan project set is missing the scope a declared crossing derives its authority from',
      );
    }
    if (!projectIds.length) return;
    for (const projectId of projectIds) {
      await tx.$queryRaw`SELECT 1 FROM "project" WHERE "id" = ${projectId}::uuid FOR NO KEY UPDATE`;
    }
    // Nothing to re-decide: this call exists only to take the caller's rank-40 locks in one sorted
    // pass with the fence's — because the caller is the owner, or because it had none of its own.
    if (!fenced.length || admitted.principal === 'USER') return;
    const scope = await this.deriveProjectScope(tx, ownerId, actingSessionId);
    const projectStatus = await this.projectScopeStatuses(tx, ownerId, [
      ...projectIds,
      scope?.projectId,
    ]);
    // The claim being checked is the server's OWN earlier reading, expressed the way §2 spells a
    // scope on the wire. A caller-supplied token has already been compared against it before the
    // transaction, so substituting this one loses nothing and states more.
    const presented = admitted.scope ? derivedScopeToken(admitted.scope) : undefined;
    for (const write of fenced) {
      // The other half of the same window, for an edit: the TASK can be re-filed between the
      // admission and this transaction, and an edit authorised against the project it used to be
      // in is the same defect seen from the row's side. Re-read under the lock this transaction
      // now holds on that project — a move out of it has to take the same row (0127's reopen
      // reaches both ends), so what is read here cannot change before the write.
      const currentProjectId = write.operation === 'UPDATE_TASK' && write.taskId
        ? ((await tx.task.findFirst({
            where: { id: write.taskId, ownerId },
            select: { projectId: true },
          }))?.projectId ?? null)
        : write.currentProjectId;
      const outcome = admitProjectScopeWrite(this.scopeRequest(
        actingSessionId ? (scope ? 'COORDINATOR' : 'WORKER') : 'USER',
        scope,
        // The bound project, not what the caller asked for: what is fenced is the write that is
        // about to happen, including the project the server derived for it.
        { ...write, currentProjectId, requestedProjectId: write.boundProjectId, scopeToken: presented },
        projectStatus,
      ));
      if (!outcome.outcome || outcome.outcome.decision === 'ALLOW') continue;
      if (admitted.mode === 'observe') {
        this.logger.warn(
          `project scope observe (effect): ${outcome.outcome.code} at ${outcome.outcome.rule}`,
        );
        continue;
      }
      throw new ForbiddenException(scopeRefusalBody(outcome.outcome, write.taskId));
    }
  }

  /**
   * A best-effort key that collapses the SAME task created twice inside one turn — the shape of a
   * redelivered turn re-running its side effects (a lease expiry hands the turn back and the engine
   * re-creates the tasks it already created; see the runner's redelivery double-run). Scoped by
   * turnId so two DIFFERENT turns that each legitimately create an identically worded task are
   * never merged. The tradeoff — two byte-identical creates within ONE turn collapse to one — is
   * deliberate and far rarer than the duplicate it prevents.
   *
   * The preimage is (operation, session, turn, normalised payload), and every one of those four is
   * an INPUT rather than a literal spelled at the call site. That is what lets `idempotencyWinner`
   * verify a row instead of assuming one: it rebuilds this key from the winner's own persisted
   * columns and this request's identity, and a row that does not reproduce its own key is not this
   * request's earlier attempt whatever the column says.
   *
   * The operation reaches the preimage through `IDEMPOTENCY_OPERATION_TAG`, which is frozen: the
   * descriptor is for readers, the byte is for the rows already on disk.
   */
  private taskIdempotencyKey(write: IdempotentTaskWrite): string {
    return createHash('sha256')
      .update(JSON.stringify([
        IDEMPOTENCY_OPERATION_TAG[write.operation],
        write.sessionId,
        write.turnId,
        write.title.trim(),
        (write.description ?? '').trim(),
      ]))
      .digest('hex');
  }

  /** True for a unique-constraint violation — the idempotency index firing on a concurrent re-run
   *  that raced past the pre-check. */
  private isDuplicateKey(e: unknown): boolean {
    return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
  }

  async list(ownerId: string) {
    const tasks = await this.prisma.task.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
      include: {
        // runner is included so the batch-run modal can show which runners back the
        // selection and pre-fill the concurrency from their current cap.
        assignee: {
          select: {
            id: true,
            name: true,
            model: true,
            runnerId: true,
            runner: { select: { id: true, name: true, displayName: true, maxConcurrent: true } },
          },
        },
        _count: { select: { comments: true } },
      },
    });
    const withRun = await this.withRunning(ownerId, tasks);
    const states = await this.dependencyStatesFor(ownerId, tasks.map((t) => t.id));
    return withRun.map((t) => {
      const dependencyState = states.get(t.id) ?? 'NONE';
      // `blocked` drives the list's lock indicator; canRun is the single source of truth
      // shared with the execute/batch gates so the UI never offers a run the API rejects.
      return { ...t, dependencyState, blocked: !canRun(dependencyState) };
    });
  }

  /**
   * Cursor-paged task list for interactive clients. Filters run in PostgreSQL so the
   * browser never has to download an owner's entire task history just to search or open
   * one status tab. GET /tasks remains as a compatibility endpoint for existing runners.
   */
  async listPage(ownerId: string, query: ListTasksPageQuery = {}) {
    const limit = query.limit === undefined ? DEFAULT_TASK_PAGE_SIZE : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TASK_PAGE_SIZE) {
      throw new BadRequestException(`limit must be an integer from 1 to ${MAX_TASK_PAGE_SIZE}`);
    }

    const countsMode = query.counts?.trim().toLowerCase();
    if (countsMode !== undefined && countsMode !== 'none' && countsMode !== 'total') {
      throw new BadRequestException("counts must be 'none' or 'total' when set");
    }

    const status = query.status?.trim().toUpperCase();
    const runnableOnly = status === 'RUNNABLE';
    const runningOnly = status === 'RUNNING';
    let statuses: TaskStatus[] | undefined;
    if (status === 'ONGOING') statuses = [TaskStatus.OPEN, TaskStatus.IN_PROGRESS];
    else if (status && !runnableOnly && !runningOnly) {
      if (!Object.values(TaskStatus).includes(status as TaskStatus)) {
        throw new BadRequestException('invalid task status');
      }
      statuses = [status as TaskStatus];
    }

    const scopedWhere: Prisma.TaskWhereInput = { ownerId };
    if (query.listId === 'none') scopedWhere.listId = null;
    else if (query.listId) {
      if (!UUID_RE.test(query.listId)) throw new BadRequestException('invalid task list id');
      scopedWhere.listId = query.listId;
    }
    // Scope, not filter, for the same reason a label is: the tallies have to describe the project
    // being asked about, or a coordinator reads its own progress off the whole account's numbers.
    if (query.projectId) {
      if (!UUID_RE.test(query.projectId)) throw new BadRequestException('invalid project id');
      scopedWhere.projectId = query.projectId;
    }
    if (query.assigneeId) {
      if (!UUID_RE.test(query.assigneeId)) throw new BadRequestException('invalid assignee id');
      scopedWhere.assigneeId = query.assigneeId;
    }
    // Scope, not filter: unlike `q` below, a label narrows the tab badges too. The question a
    // label filter is asked is "how far along is this batch", and counts that answered it for the
    // whole owner instead would be answering a question nobody asked while looking like they had.
    // ALL rather than ANY because labels name different axes (a snapshot AND a shard); ANY would
    // make adding a second label widen the result, which reads backwards.
    const labelFilter = parseLabelsQuery(query.labels);
    if (labelFilter.length) scopedWhere.labels = { hasEvery: labelFilter };

    // The Ready tab is served by RUNNABLE_TASK_SQL, not a Prisma where — see that constant for
    // why. Every other tab keeps its Prisma filter.
    const filteredWhere: Prisma.TaskWhereInput = runningOnly
      ? { ...scopedWhere, sessions: { some: { status: RunStatus.RUNNING } } }
      : { ...scopedWhere };
    if (statuses) filteredWhere.status = { in: statuses };
    const search = query.q?.trim().slice(0, 200);
    if (search) filteredWhere.title = { contains: search, mode: 'insensitive' };

    const cursor = query.cursor ? decodeTaskPageCursor(query.cursor) : undefined;
    const pageWhere: Prisma.TaskWhereInput = cursor
      ? {
          AND: [
            filteredWhere,
            {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            },
          ],
        }
      : filteredWhere;

    // Three levels, because the response carries two different kinds of number.
    //
    // `counts` is scope-wide: no status filter, no search. It is the same for every tab, so a
    // client that keeps it never needs it again until the scope changes — `counts=total` says
    // so, and skips four aggregates over the whole task table.
    //
    // `total` is the filtered count, which does move with the tab and the search box, so it
    // stays available at `total` and above. `counts=none` drops both and is what paging uses.
    //
    // Opt-in rather than "skip when a cursor is set", because `counts` is a required field for
    // already-shipped native clients.
    const wantCounts = countsMode === undefined;
    const wantTotal = countsMode !== 'none';
    // On the Ready tab the filtered total IS the runnable count; count it once and share it.
    // A title search narrows the filtered total but deliberately not the tab badge, so that
    // case still needs its own count.
    const [rows, ownFilteredTotal, counts] = await Promise.all([
      runnableOnly
        ? this.runnableTaskPage(scopedWhere, { search, cursor, take: limit + 1 })
        : this.prisma.task.findMany({
            where: pageWhere,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            select: TASK_LIST_SELECT,
          }),
      // On the Ready tab the filtered total IS the runnable count, which the counts block
      // already has; a title search narrows the filtered total but deliberately not the tab
      // badge, so that case still needs its own count.
      !wantTotal || (runnableOnly && !search)
        ? undefined
        : runnableOnly
          ? this.runnableTaskCount(scopedWhere, search)
          : this.prisma.task.count({ where: filteredWhere }),
      wantCounts ? this.scopeCounts(scopedWhere) : undefined,
    ]);

    const hasMore = rows.length > limit;
    const pageTasks = hasMore ? rows.slice(0, limit) : rows;
    const [withRun, states] = await Promise.all([
      this.withRunning(ownerId, pageTasks),
      this.dependencyStatesFor(ownerId, pageTasks.map((task) => task.id)),
    ]);
    const items = withRun.map((task) => {
      const dependencyState = states.get(task.id) ?? 'NONE';
      return { ...task, dependencyState, blocked: !canRun(dependencyState) };
    });
    const nextCursor =
      hasMore && items.length ? encodeTaskPageCursor(items[items.length - 1]) : null;
    if (!wantTotal) return { items, nextCursor };
    // On Ready without a search the runnable count is the filtered total — but only the full
    // block carries it, so `counts=total` there falls back to what the page itself showed.
    const total = ownFilteredTotal ?? counts?.runnable ?? items.length;
    if (!wantCounts) return { items, nextCursor, total };
    return { items, nextCursor, total, counts };
  }

  /**
   * The scope-wide tallies behind the progress bar and the tab badges.
   *
   * Every one of these reads `scope` alone — no status filter, no search term — which is exactly
   * why they belong to the scope and not to whichever tab is open. Extracted so the paged list
   * and the standalone counts endpoint compute them from one definition rather than two that can
   * drift apart.
   */
  private async scopeCounts(scope: Prisma.TaskWhereInput): Promise<TaskCounts> {
    const [statusGroups, running, queued, runnable] = await Promise.all([
      this.prisma.task.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
      this.prisma.task.count({
        where: { ...scope, sessions: { some: { status: RunStatus.RUNNING } } },
      }),
      this.prisma.task.count({
        where: {
          ...scope,
          sessions: { some: { status: RunStatus.PENDING } },
          NOT: { sessions: { some: { status: RunStatus.RUNNING } } },
        },
      }),
      this.runnableTaskCount(scope),
    ]);
    const byStatus = new Map(statusGroups.map((group) => [group.status, group._count._all]));
    return {
      total: statusGroups.reduce((sum, group) => sum + group._count._all, 0),
      open: byStatus.get(TaskStatus.OPEN) ?? 0,
      inProgress: byStatus.get(TaskStatus.IN_PROGRESS) ?? 0,
      done: byStatus.get(TaskStatus.DONE) ?? 0,
      failed: byStatus.get(TaskStatus.FAILED) ?? 0,
      cancelled: byStatus.get(TaskStatus.CANCELLED) ?? 0,
      running,
      queued,
      runnable,
    };
  }

  /**
   * The tallies on their own, so a client can hold them across tab changes.
   *
   * They cost four aggregates over the owner's whole task table, and they are identical for
   * every tab — asking for them again with each tab's first page was recomputing a constant.
   * Given their own request they are fetched once per scope and read from cache thereafter.
   */
  async taskCounts(ownerId: string, query: LabelSummaryQuery & { labels?: string | string[] } = {}) {
    const scope: Prisma.TaskWhereInput = { ownerId };
    if (query.listId === 'none') scope.listId = null;
    else if (query.listId) {
      if (!UUID_RE.test(query.listId)) throw new BadRequestException('invalid task list id');
      scope.listId = query.listId;
    }
    if (query.assigneeId) {
      if (!UUID_RE.test(query.assigneeId)) throw new BadRequestException('invalid assignee id');
      scope.assigneeId = query.assigneeId;
    }
    const labelFilter = parseLabelsQuery(query.labels);
    if (labelFilter.length) scope.labels = { hasEvery: labelFilter };
    return this.scopeCounts(scope);
  }

  /**
   * The tasks that are happening or need somebody: running, queued, in progress, failed.
   *
   * This exists because a paged list ordered by creation time can never show them. Work is
   * executed oldest-first while the list is served newest-first, so the active tasks are
   * systematically the *last* rows an owner would ever page to — measured on this deployment,
   * the one running task sits at position 109,873 of 110,419, some 550 pages down. Client-side
   * sorting cannot fix that: it can only reorder rows already downloaded, so a status sort
   * promises "the important ones first" while the important ones are not in the set at all.
   *
   * Bounded rather than paged, and that bound is a property of the system rather than a guess:
   * running and queued are capped by the runners' own concurrency, so this answers with single
   * digits in normal operation. FAILED is the one that can arrive in bulk (one runner outage
   * fails a batch), which is why the cap exists and why the response reports the true total —
   * a pinned strip that silently truncates is the same lie in a smaller box.
   */
  async activeTasks(ownerId: string, query: LabelSummaryQuery = {}) {
    const scope: Prisma.TaskWhereInput = { ownerId };
    if (query.listId === 'none') scope.listId = null;
    else if (query.listId) {
      if (!UUID_RE.test(query.listId)) throw new BadRequestException('invalid task list id');
      scope.listId = query.listId;
    }

    // Live execution state comes off the session table, so "has a live run" cannot be a column
    // predicate — it is the same `sessions: { some: ... }` the counts above use.
    const where: Prisma.TaskWhereInput = {
      ...scope,
      OR: [
        { sessions: { some: { status: { in: [RunStatus.RUNNING, RunStatus.PENDING] } } } },
        { status: { in: [TaskStatus.IN_PROGRESS, TaskStatus.FAILED] } },
      ],
    };

    const [rows, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        // Newest first within the strip; the caller ranks by live state, which it must compute
        // from the run rows anyway.
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: ACTIVE_TASK_STRIP_MAX,
        select: TASK_LIST_SELECT,
      }),
      this.prisma.task.count({ where }),
    ]);

    const [withRun, states] = await Promise.all([
      this.withRunning(ownerId, rows, true),
      this.dependencyStatesFor(ownerId, rows.map((task) => task.id)),
    ]);
    const items = withRun.map((task) => {
      const dependencyState = states.get(task.id) ?? 'NONE';
      return { ...task, dependencyState, blocked: !canRun(dependencyState) };
    });
    return { items, total, truncated: total > items.length };
  }

  /**
   * Every label in scope with its own status breakdown — "how far along is each batch", asked
   * once.
   *
   * This is the question the labels column exists to answer, and the reason a label could not
   * just stay in the title. Filtering one batch at a time was always possible (the title has a
   * trigram index, so `q=CC-MAIN-2017-34` is not even slow); what was impossible was asking about
   * all of them without asking about each of them. Measured on this deployment's 110k tasks and
   * 110 snapshots: 198ms here against ~4.4s for 110 separate title searches, plus 110 round
   * trips — and that gap widens with every batch added, because the loop is the thing that grows.
   *
   * Scoped by list/assignee like listPage, so "the labels in this list" costs no extra endpoint.
   */
  async labelSummary(ownerId: string, query: LabelSummaryQuery = {}) {
    const scope: Prisma.TaskWhereInput = { ownerId };
    if (query.listId === 'none') scope.listId = null;
    else if (query.listId) {
      if (!UUID_RE.test(query.listId)) throw new BadRequestException('invalid task list id');
      scope.listId = query.listId;
    }
    if (query.assigneeId) {
      if (!UUID_RE.test(query.assigneeId)) throw new BadRequestException('invalid assignee id');
      scope.assigneeId = query.assigneeId;
    }

    // Ranked by size and capped rather than returned whole: a caller that has been writing a
    // label per task turns this into a second copy of the task table, and the answer to "how far
    // along is each batch" stops being readable long before it stops being large. `labelTotal`
    // reports the count the cap was applied to, so a truncated answer says so instead of looking
    // complete.
    const rows = await this.prisma.$queryRaw<
      Array<{ label: string; status: TaskStatus; n: number; labelTotal: number }>
    >`
      WITH pairs AS (
        SELECT unnest(t.labels) AS label, t.status
        FROM "task" t
        WHERE ${taskScopeSql(scope)}
      ),
      by_status AS (SELECT label, status, count(*)::int AS n FROM pairs GROUP BY 1, 2),
      totals AS (SELECT label, sum(n) AS n FROM by_status GROUP BY 1),
      top AS (SELECT label FROM totals ORDER BY n DESC, label LIMIT ${TASK_LABEL_SUMMARY_MAX})
      SELECT b.label AS label,
             b.status AS status,
             b.n AS n,
             (SELECT count(*) FROM totals)::int AS "labelTotal"
      -- Ranking joins against the aggregate, not against the rows. Applying the cap to pairs
      -- instead reads correctly and costs three times as much: pairs is one row per (task,
      -- label) — 110k here — and every one of them goes through the hash join before being
      -- collapsed. Aggregating first makes the join operate on one row per (label, status),
      -- which is 550. Measured on this deployment: 137ms against 440ms.
      FROM by_status b JOIN top ON top.label = b.label
    `;

    const byLabel = new Map<string, Record<TaskStatus, number>>();
    for (const row of rows) {
      let counts = byLabel.get(row.label);
      if (!counts) {
        counts = { OPEN: 0, IN_PROGRESS: 0, DONE: 0, FAILED: 0, CANCELLED: 0 };
        byLabel.set(row.label, counts);
      }
      counts[row.status] = row.n;
    }
    const items = [...byLabel.entries()]
      .map(([label, counts]) => ({
        label,
        total: Object.values(counts).reduce((sum, n) => sum + n, 0),
        open: counts.OPEN,
        inProgress: counts.IN_PROGRESS,
        done: counts.DONE,
        failed: counts.FAILED,
        cancelled: counts.CANCELLED,
      }))
      // Label order, not size order: these are read as a progress table, and a table whose rows
      // reorder as the work moves is one nobody can follow across two refreshes.
      .sort((a, b) => a.label.localeCompare(b.label));

    return { items, labelTotal: rows[0]?.labelTotal ?? 0, truncated: (rows[0]?.labelTotal ?? 0) > items.length };
  }

  /**
   * One page of Ready-tab rows, newest first. Ranks the ids with the index-driven runnable
   * predicate, then hydrates just those rows through Prisma so the payload shape stays
   * identical to every other tab's.
   */
  private async runnableTaskPage(
    scope: Prisma.TaskWhereInput,
    opts: { search?: string; cursor?: { createdAt: Date; id: string }; take: number },
  ) {
    const clauses: Prisma.Sql[] = [taskScopeSql(scope), RUNNABLE_TASK_SQL];
    if (opts.search) clauses.push(Prisma.sql`t.title ILIKE '%' || ${opts.search} || '%'`);
    if (opts.cursor) {
      // Bound as a naive timestamp to match the column's type: `created_at` is
      // `timestamp(3) without time zone` holding UTC, and an ISO string casts to exactly
      // the instant Prisma stored, whatever the server's timezone is.
      const at = opts.cursor.createdAt.toISOString();
      clauses.push(
        Prisma.sql`(t.created_at < ${at}::timestamp
          OR (t.created_at = ${at}::timestamp AND t.id < ${opts.cursor.id}::uuid))`,
      );
    }
    const ranked = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT t.id FROM task t
      WHERE ${Prisma.join(clauses, ' AND ')}
      ORDER BY t.created_at DESC, t.id DESC
      LIMIT ${opts.take}`;
    if (ranked.length === 0) return [];
    const rows = await this.prisma.task.findMany({
      where: { id: { in: ranked.map((row) => row.id) } },
      select: TASK_LIST_SELECT,
    });
    // findMany does not preserve the ranked order, and the cursor is cut from the last row.
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ranked
      .map((row) => byId.get(row.id))
      .filter((row): row is (typeof rows)[number] => row !== undefined);
  }

  /** How many tasks in this scope are ready to run — the Ready tab's badge. */
  private async runnableTaskCount(
    scope: Prisma.TaskWhereInput,
    search?: string,
  ): Promise<number> {
    const clauses: Prisma.Sql[] = [taskScopeSql(scope), RUNNABLE_TASK_SQL];
    if (search) clauses.push(Prisma.sql`t.title ILIKE '%' || ${search} || '%'`);
    const [row] = await this.prisma.$queryRaw<{ count: number }[]>`
      SELECT count(*)::int AS count FROM task t WHERE ${Prisma.join(clauses, ' AND ')}`;
    return row?.count ?? 0;
  }

  /**
   * Tag each task with `running` = it has a RUNNING session (actually executing right
   * now) and `queued` = it has a PENDING session waiting for a runner slot but nothing
   * running yet. Both are the live ground truth, distinct from Task.status (an
   * workspace-maintained label that can lag): the list breathes only for `running` and
   * shows a distinct queued indicator for `queued`. One grouped query covers the whole
   * page. The list-detail view (TaskListsService) computes the same flags inline.
   */
  private async withRunning<T extends { id: string }>(
    ownerId: string,
    tasks: T[],
    restrictToTaskIds = false,
  ): Promise<(T & { running: boolean; queued: boolean })[]> {
    if (tasks.length === 0) return [];
    const busy = await this.prisma.session.groupBy({
      by: ['taskId', 'status'],
      where: {
        ownerId,
        taskId: restrictToTaskIds ? { in: tasks.map((task) => task.id) } : { not: null },
        status: { in: [RunStatus.PENDING, RunStatus.RUNNING] },
      },
      _count: { _all: true },
    });
    const running = new Set(
      busy.filter((b) => b.status === RunStatus.RUNNING).map((b) => b.taskId),
    );
    const queued = new Set(
      busy.filter((b) => b.status === RunStatus.PENDING).map((b) => b.taskId),
    );
    return tasks.map((t) => ({
      ...t,
      running: running.has(t.id),
      // A task with both a RUNNING and a PENDING session is simply running; `queued`
      // is only meaningful when nothing is running yet.
      queued: queued.has(t.id) && !running.has(t.id),
    }));
  }

  /**
   * Return a bounded dependency DAG around the focus task. The backwards-compatible
   * default follows transitive prerequisites (`upstream`); `both` treats dependency
   * rows as undirected while discovering nodes, so any task in the bounded weakly
   * connected component can be used as the focus. Returned edges always retain their
   * execution direction (prerequisite -> dependent), the inverse of TaskDependency's
   * stored `taskId depends on dependsOnTaskId` representation.
   *
   * Each breadth-first layer is fetched in at most two bounded queries, so query count
   * grows with graph depth, never with node count. A final bounded induced-edge query
   * restores cross-edges between already discovered nodes without repeatedly loading
   * parent edges during bidirectional traversal.
   */
  async dependencyGraph(
    ownerId: string,
    focusTaskId: string,
    query: DependencyGraphQuery = {},
  ) {
    if (!UUID_RE.test(focusTaskId)) throw new NotFoundException('task not found');
    const rawDirection = query.direction ?? 'upstream';
    if (rawDirection !== 'upstream' && rawDirection !== 'both') {
      throw new BadRequestException('direction must be upstream or both');
    }
    const direction: DependencyGraphDirection = rawDirection;
    const pairUnary = dependencyGraphBoolean(query.pairUnary, 'pairUnary');
    const maxDepth = dependencyGraphLimit(
      query.maxDepth,
      DEFAULT_DEPENDENCY_GRAPH_MAX_DEPTH,
      'maxDepth',
      MAX_DEPENDENCY_GRAPH_MAX_DEPTH,
    );
    const maxNodes = dependencyGraphLimit(
      query.maxNodes,
      DEFAULT_DEPENDENCY_GRAPH_MAX_NODES,
      'maxNodes',
      MAX_DEPENDENCY_GRAPH_MAX_NODES,
    );
    const maxEdges = Math.min(
      maxNodes * DEPENDENCY_GRAPH_EDGES_PER_NODE,
      MAX_DEPENDENCY_GRAPH_EDGES,
    );

    const focus = await this.prisma.task.findFirst({
      where: { id: focusTaskId, ownerId },
      select: { id: true, title: true, status: true, autoRunWhenReady: true },
    });
    if (!focus) throw new NotFoundException('task not found');

    const nodes = new Map<string, DependencyGraphNode>([
      [
        focus.id,
        {
          ...focus,
          status: focus.status as unknown as TaskStatus,
          depth: 0,
        },
      ],
    ]);
    // One discovery edge per newly admitted node is retained so a dense graph truncated
    // by maxEdges never returns orphan nodes. The final induced-edge query below fills in
    // all other relationships up to the response budget.
    const discoveryEdges = new Map<string, { sourceTaskId: string; targetTaskId: string }>();
    // Unary companions are discovered one level ahead of the ordinary BFS frontier.
    // Queue them by their real depth so later descendants keep correct depths and bounds.
    const scheduledFrontiers = new Map<number, Set<string>>();
    let frontier = [focus.id];
    let traversedDepth = 0;
    let deepestDepth = 0;
    const truncationReasons = new Set<'maxDepth' | 'maxNodes' | 'maxEdges'>();

    while (frontier.length > 0 && traversedDepth < maxDepth) {
      const nextDepth = traversedDepth + 1;
      const frontierIds = new Set(frontier);
      const visitedIds = [...nodes.keys()];
      const ownerScope = {
        task: { ownerId },
        dependsOnTask: { ownerId },
      } satisfies Prisma.TaskDependencyWhereInput;
      // Excluding the already visited opposite endpoint makes these discovery queries:
      // no parent edge is re-read on the next layer. In `both` mode each direction gets
      // its own bounded query, then rows are interleaved. A single OR ordered by createdAt
      // could otherwise let a large fan-in consume the whole budget and hide even one
      // direct dependent (or vice versa).
      const prerequisiteWhere = {
        ...ownerScope,
        taskId: { in: frontier },
        dependsOnTaskId: { notIn: visitedIds },
      } satisfies Prisma.TaskDependencyWhereInput;
      const dependentWhere = {
        ...ownerScope,
        dependsOnTaskId: { in: frontier },
        taskId: { notIn: visitedIds },
      } satisfies Prisma.TaskDependencyWhereInput;
      const fetchAdjacent = async (
        where: Prisma.TaskDependencyWhereInput,
      ): Promise<DependencyGraphTraversalRow[]> =>
        this.prisma.taskDependency.findMany({
          where,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          // Fetch one sentinel row so exact-cap layers remain complete while oversized
          // adjacency lists are reported as truncated without unbounded materialization.
          take: maxEdges + 1,
          select: {
            taskId: true,
            dependsOnTaskId: true,
            task: {
              select: { id: true, title: true, status: true, autoRunWhenReady: true },
            },
            dependsOnTask: {
              select: { id: true, title: true, status: true, autoRunWhenReady: true },
            },
          },
        });
      const [prerequisiteRows, dependentRows] = await Promise.all([
        fetchAdjacent(prerequisiteWhere),
        direction === 'both' ? fetchAdjacent(dependentWhere) : Promise.resolve([]),
      ]);
      const edgeLimitReached = prerequisiteRows.length + dependentRows.length > maxEdges;
      const rows: DependencyGraphTraversalRow[] = [];
      for (
        let prerequisiteIndex = 0, dependentIndex = 0;
        rows.length < maxEdges &&
        (prerequisiteIndex < prerequisiteRows.length || dependentIndex < dependentRows.length);
      ) {
        if (prerequisiteIndex < prerequisiteRows.length) {
          rows.push(prerequisiteRows[prerequisiteIndex]);
          prerequisiteIndex += 1;
        }
        if (rows.length < maxEdges && dependentIndex < dependentRows.length) {
          rows.push(dependentRows[dependentIndex]);
          dependentIndex += 1;
        }
      }
      // Optional display-oriented sampling keeps an admitted node with its sole
      // continuation in the same snapshot. Candidate degree and endpoints are fetched
      // in batches, and admission still follows the already interleaved row order, so
      // upstream/downstream fairness and every node/edge limit remain intact.
      const directCandidateIds = new Set<string>();
      const upstreamCandidateIds = new Set<string>();
      const downstreamCandidateIds = new Set<string>();
      for (const row of rows) {
        const isUpstream = direction === 'upstream' || frontierIds.has(row.taskId);
        const candidate = isUpstream ? row.dependsOnTask : row.task;
        if (nodes.has(candidate.id)) continue;
        directCandidateIds.add(candidate.id);
        (isUpstream ? upstreamCandidateIds : downstreamCandidateIds).add(candidate.id);
      }
      const unaryByCandidate = new Map<string, DependencyGraphTraversalRow>();
      if (pairUnary && nextDepth < maxDepth && directCandidateIds.size > 0) {
        const candidateCounts = await this.dependencyConnectionCounts(
          ownerId,
          [...directCandidateIds],
        );
        const unaryUpstreamIds = [...upstreamCandidateIds].filter(
          (id) => candidateCounts.get(id)?.prerequisiteCount === 1,
        );
        const unaryDownstreamIds = [...downstreamCandidateIds].filter(
          (id) => candidateCounts.get(id)?.dependentCount === 1,
        );
        const [unaryUpstreamRows, unaryDownstreamRows] = await Promise.all([
          unaryUpstreamIds.length
            ? fetchAdjacent({
                taskId: { in: unaryUpstreamIds },
                task: { ownerId },
                dependsOnTask: { ownerId },
              })
            : Promise.resolve([]),
          unaryDownstreamIds.length
            ? fetchAdjacent({
                dependsOnTaskId: { in: unaryDownstreamIds },
                task: { ownerId },
                dependsOnTask: { ownerId },
              })
            : Promise.resolve([]),
        ]);
        for (const row of unaryUpstreamRows) unaryByCandidate.set(row.taskId, row);
        for (const row of unaryDownstreamRows) unaryByCandidate.set(row.dependsOnTaskId, row);
      }
      const next = new Set<string>();
      for (const row of rows) {
        const isUpstream = direction === 'upstream' || frontierIds.has(row.taskId);
        const candidate = isUpstream ? row.dependsOnTask : row.task;
        if (!nodes.has(candidate.id)) {
          const unaryRow = unaryByCandidate.get(candidate.id);
          const unaryCandidate = unaryRow
            ? isUpstream
              ? unaryRow.dependsOnTask
              : unaryRow.task
            : undefined;
          // A continuation that is itself a direct candidate must retain its shallower
          // BFS depth; its own direct row will admit it normally.
          const admitUnary =
            unaryCandidate !== undefined &&
            !nodes.has(unaryCandidate.id) &&
            !directCandidateIds.has(unaryCandidate.id);
          const requiredNodeSlots = 1 + (admitUnary ? 1 : 0);
          if (nodes.size + requiredNodeSlots > maxNodes) {
            truncationReasons.add('maxNodes');
            continue;
          }
          const discovered: DependencyGraphNode = {
            ...candidate,
            status: candidate.status as unknown as TaskStatus,
            depth: nextDepth,
          };
          nodes.set(discovered.id, discovered);
          next.add(discovered.id);
          deepestDepth = nextDepth;
          const discoveryEdge = {
            sourceTaskId: row.dependsOnTaskId,
            targetTaskId: row.taskId,
          };
          discoveryEdges.set(
            `${discoveryEdge.sourceTaskId}:${discoveryEdge.targetTaskId}`,
            discoveryEdge,
          );
          if (admitUnary && unaryRow && unaryCandidate) {
            const unaryNode: DependencyGraphNode = {
              ...unaryCandidate,
              status: unaryCandidate.status as unknown as TaskStatus,
              depth: nextDepth + 1,
            };
            nodes.set(unaryNode.id, unaryNode);
            deepestDepth = Math.max(deepestDepth, nextDepth + 1);
            const scheduled = scheduledFrontiers.get(nextDepth + 1) ?? new Set<string>();
            scheduled.add(unaryNode.id);
            scheduledFrontiers.set(nextDepth + 1, scheduled);
            const unaryEdge = {
              sourceTaskId: unaryRow.dependsOnTaskId,
              targetTaskId: unaryRow.taskId,
            };
            discoveryEdges.set(`${unaryEdge.sourceTaskId}:${unaryEdge.targetTaskId}`, unaryEdge);
          }
        }
      }
      for (const scheduledId of scheduledFrontiers.get(nextDepth) ?? []) next.add(scheduledId);
      scheduledFrontiers.delete(nextDepth);
      frontier = [...next];
      traversedDepth = nextDepth;
      if (edgeLimitReached) {
        truncationReasons.add('maxEdges');
        break;
      }
    }

    // Reaching the requested depth is only truncation when a boundary node has a
    // relationship to a task outside the visited set. In `both` mode simply counting
    // all incident rows would always see the edge back to the previous layer and falsely
    // report truncation, so the opposite endpoint explicitly excludes visited nodes.
    if (truncationReasons.size === 0 && frontier.length > 0 && traversedDepth === maxDepth) {
      const visitedIds = [...nodes.keys()];
      const ownerScope = {
        task: { ownerId },
        dependsOnTask: { ownerId },
      } satisfies Prisma.TaskDependencyWhereInput;
      const hiddenWhere =
        direction === 'upstream'
          ? ({
              ...ownerScope,
              taskId: { in: frontier },
              dependsOnTaskId: { notIn: visitedIds },
            } satisfies Prisma.TaskDependencyWhereInput)
          : ({
              ...ownerScope,
              OR: [
                { taskId: { in: frontier }, dependsOnTaskId: { notIn: visitedIds } },
                { dependsOnTaskId: { in: frontier }, taskId: { notIn: visitedIds } },
              ],
            } satisfies Prisma.TaskDependencyWhereInput);
      const hiddenEdgeCount = await this.prisma.taskDependency.count({
        where: hiddenWhere,
      });
      if (hiddenEdgeCount > 0) truncationReasons.add('maxDepth');
    }

    // Materialize the bounded induced DAG once node discovery is complete. Discovery
    // edges are guaranteed to survive truncation so every returned node remains linked
    // to the focus in the weakly connected response.
    const nodeIds = [...nodes.keys()];
    const fetchedEdgeRows = await this.prisma.taskDependency.findMany({
      where: {
        taskId: { in: nodeIds },
        dependsOnTaskId: { in: nodeIds },
        task: { ownerId },
        dependsOnTask: { ownerId },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: maxEdges + 1,
      select: { taskId: true, dependsOnTaskId: true },
    });
    if (fetchedEdgeRows.length > maxEdges) truncationReasons.add('maxEdges');
    const edges = new Map<string, { sourceTaskId: string; targetTaskId: string }>();
    for (const row of fetchedEdgeRows.slice(0, maxEdges)) {
      const edge = { sourceTaskId: row.dependsOnTaskId, targetTaskId: row.taskId };
      edges.set(`${edge.sourceTaskId}:${edge.targetTaskId}`, edge);
    }
    for (const [key, edge] of discoveryEdges) edges.set(key, edge);
    // A discovery edge can fall beyond the database-order prefix in a dense graph. Make
    // room for it by dropping non-discovery cross-edges from the end of the prefix.
    if (edges.size > maxEdges) {
      const removable = [...edges.keys()].reverse();
      for (const key of removable) {
        if (edges.size <= maxEdges) break;
        if (!discoveryEdges.has(key)) edges.delete(key);
      }
    }

    const baseNodes = [...nodes.values()];
    const [withRun, dependencyStates, connectionCounts] = await Promise.all([
      this.withRunning(ownerId, baseNodes, true),
      this.dependencyStatesForGraph(ownerId, baseNodes.map((node) => node.id)),
      this.dependencyConnectionCounts(ownerId, baseNodes.map((node) => node.id)),
    ]);
    const graphNodes = withRun.map((node) => {
      const nodeCounts = connectionCounts.get(node.id) ?? {
        prerequisiteCount: 0,
        dependentCount: 0,
      };
      return {
        ...node,
        ...nodeCounts,
        dependencyState: dependencyStates.get(node.id) ?? 'NONE',
      };
    });
    const incoming = new Map<string, string[]>();
    const outgoing = new Map<string, string[]>();
    for (const edge of edges.values()) {
      const incomingSources = incoming.get(edge.targetTaskId);
      if (incomingSources) incomingSources.push(edge.sourceTaskId);
      else incoming.set(edge.targetTaskId, [edge.sourceTaskId]);
      const outgoingTargets = outgoing.get(edge.sourceTaskId);
      if (outgoingTargets) outgoingTargets.push(edge.targetTaskId);
      else outgoing.set(edge.sourceTaskId, [edge.targetTaskId]);
    }
    const reachable = (adjacency: ReadonlyMap<string, string[]>): Set<string> => {
      const reached = new Set<string>();
      const pending = [...(adjacency.get(focusTaskId) ?? [])];
      while (pending.length > 0) {
        const id = pending.pop()!;
        if (id === focusTaskId || reached.has(id)) continue;
        reached.add(id);
        pending.push(...(adjacency.get(id) ?? []));
      }
      return reached;
    };
    const upstreamIds = reachable(incoming);
    const downstreamIds = reachable(outgoing);
    const upstreamNodes = graphNodes.filter((node) => upstreamIds.has(node.id));
    const done = upstreamNodes.filter((node) => node.status === TaskStatus.DONE).length;
    const failed = upstreamNodes.filter(
      (node) => node.status === TaskStatus.FAILED || node.status === TaskStatus.CANCELLED,
    ).length;
    const collapsedGroups = this.dependencyGraphCollapsedGroups(
      ownerId,
      focusTaskId,
      direction,
      nodeIds,
      edges.values(),
      connectionCounts,
    );

    return {
      focusTaskId,
      direction,
      pairUnary,
      nodes: graphNodes,
      edges: [...edges.values()],
      counts: {
        upstream: upstreamNodes.length,
        downstream: downstreamIds.size,
        connected: graphNodes.length - 1,
        lateral: graphNodes.length - 1 - upstreamNodes.length - downstreamIds.size,
        total: graphNodes.length,
        done,
        remaining: upstreamNodes.length - done - failed,
        failed,
      },
      maxDepth: deepestDepth,
      truncated: truncationReasons.size > 0,
      truncationReasons: [...truncationReasons],
      collapsedGroups,
      limits: { maxDepth, maxNodes, maxEdges },
    };
  }

  /**
   * Refresh mutable payloads for every node in a client-maintained graph snapshot.
   * Remote expansion can grow beyond the bounded base GET, so refetching only that base
   * response would otherwise leave expanded titles, statuses, run flags and degree badges
   * stale after a task.changed event.
   */
  async dependencyGraphNodes(ownerId: string, focusTaskId: string, taskIds: string[]) {
    if (!UUID_RE.test(focusTaskId)) throw new NotFoundException('task not found');
    if (!Array.isArray(taskIds) || taskIds.length < 1) {
      throw new BadRequestException('taskIds must contain at least one task');
    }
    if (taskIds.length > MAX_DEPENDENCY_GRAPH_EXPANDED_NODES) {
      throw new BadRequestException(
        `taskIds must contain at most ${MAX_DEPENDENCY_GRAPH_EXPANDED_NODES} tasks`,
      );
    }
    if (taskIds.some((id) => !UUID_RE.test(id))) {
      throw new BadRequestException('dependency graph task ids must be UUIDs');
    }
    const uniqueTaskIds = [...new Set(taskIds)];
    if (!uniqueTaskIds.includes(focusTaskId)) {
      throw new BadRequestException('taskIds must include the focus task');
    }

    const taskRows = await this.prisma.task.findMany({
      where: { ownerId, id: { in: uniqueTaskIds } },
      select: { id: true, title: true, status: true, autoRunWhenReady: true },
    });
    const taskById = new Map(taskRows.map((task) => [task.id, task]));
    // The focus remains the authorization boundary and must exist. Other deleted,
    // unknown and cross-tenant ids are intentionally indistinguishable and omitted.
    if (!taskById.has(focusTaskId)) throw new NotFoundException('task not found');
    const existingTaskIds = uniqueTaskIds.filter((id) => taskById.has(id));
    const missingTaskIds = uniqueTaskIds.filter((id) => !taskById.has(id));
    const orderedTasks = existingTaskIds.map((id) => {
      const task = taskById.get(id)!;
      return { ...task, status: task.status as unknown as TaskStatus };
    });
    const [withRun, dependencyStates, connectionCounts, fetchedEdgeRows] = await Promise.all([
      this.withRunning(ownerId, orderedTasks, true),
      this.dependencyStatesForGraph(ownerId, existingTaskIds),
      this.dependencyConnectionCounts(ownerId, existingTaskIds),
      this.prisma.taskDependency.findMany({
        where: {
          taskId: { in: existingTaskIds },
          dependsOnTaskId: { in: existingTaskIds },
          task: { ownerId },
          dependsOnTask: { ownerId },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: MAX_DEPENDENCY_GRAPH_EDGES + 1,
        select: { taskId: true, dependsOnTaskId: true },
      }),
    ]);
    const truncatedEdges = fetchedEdgeRows.length > MAX_DEPENDENCY_GRAPH_EDGES;
    const edges = fetchedEdgeRows.slice(0, MAX_DEPENDENCY_GRAPH_EDGES).map((row) => ({
      sourceTaskId: row.dependsOnTaskId,
      targetTaskId: row.taskId,
    }));
    const nodes = withRun.map((node) => ({
      ...node,
      ...(connectionCounts.get(node.id) ?? { prerequisiteCount: 0, dependentCount: 0 }),
      dependencyState: dependencyStates.get(node.id) ?? 'NONE',
    }));

    return {
      nodes,
      edges,
      collapsedGroups: this.dependencyGraphCollapsedGroups(
        ownerId,
        focusTaskId,
        'both',
        existingTaskIds,
        edges,
        connectionCounts,
      ),
      missingTaskIds,
      truncatedEdges,
    };
  }

  /**
   * Load one deterministic page of direct relationships for a collapsed branch.
   *
   * `knownTaskIds` controls which task payloads are returned, while
   * `loadedNeighborTaskIds` controls which direct edges are still missing. Keeping the
   * two sets separate is essential for diamonds: a neighbor can already be visible via
   * another parent while this anchor -> neighbor edge is still absent.
   */
  async expandDependencyGraph(
    ownerId: string,
    focusTaskId: string,
    query: ExpandDependencyGraphQuery,
  ) {
    if (!UUID_RE.test(focusTaskId) || !UUID_RE.test(query.anchorTaskId)) {
      throw new NotFoundException('task not found');
    }
    if (query.direction !== 'prerequisites' && query.direction !== 'dependents') {
      throw new BadRequestException('direction must be prerequisites or dependents');
    }
    const direction: DependencyGraphBranchDirection = query.direction;
    const limit = dependencyGraphExpansionLimit(query.limit);
    if (!Array.isArray(query.knownTaskIds) || query.knownTaskIds.length < 1) {
      throw new BadRequestException('knownTaskIds must contain at least one task');
    }
    if (query.knownTaskIds.length > MAX_DEPENDENCY_GRAPH_EXPANDED_NODES) {
      throw new BadRequestException(
        `knownTaskIds must contain at most ${MAX_DEPENDENCY_GRAPH_EXPANDED_NODES} tasks`,
      );
    }
    if (!Array.isArray(query.loadedNeighborTaskIds)) {
      throw new BadRequestException('loadedNeighborTaskIds must be an array');
    }
    const knownTaskIds = [...new Set(query.knownTaskIds)];
    const loadedNeighborTaskIds = [...new Set(query.loadedNeighborTaskIds)];
    if (knownTaskIds.length !== query.knownTaskIds.length) {
      throw new BadRequestException('knownTaskIds must not contain duplicates');
    }
    if (loadedNeighborTaskIds.length !== query.loadedNeighborTaskIds.length) {
      throw new BadRequestException('loadedNeighborTaskIds must not contain duplicates');
    }
    if (
      knownTaskIds.some((id) => !UUID_RE.test(id)) ||
      loadedNeighborTaskIds.some((id) => !UUID_RE.test(id))
    ) {
      throw new BadRequestException('dependency graph task ids must be UUIDs');
    }
    const knownTaskIdSet = new Set(knownTaskIds);
    if (!knownTaskIdSet.has(focusTaskId) || !knownTaskIdSet.has(query.anchorTaskId)) {
      throw new BadRequestException('knownTaskIds must include the focus and anchor tasks');
    }
    if (loadedNeighborTaskIds.some((id) => !knownTaskIdSet.has(id))) {
      throw new BadRequestException('loadedNeighborTaskIds must be present in knownTaskIds');
    }

    const cursor = decodeDependencyGraphBranchCursor(query.cursor);
    if (
      cursor.ownerScope !== dependencyGraphOwnerScope(ownerId) ||
      cursor.focusTaskId !== focusTaskId ||
      cursor.anchorTaskId !== query.anchorTaskId ||
      cursor.direction !== direction
    ) {
      throw new BadRequestException('dependency graph expansion cursor does not match request');
    }
    // Validate the entire client snapshot, not just the branch anchor. Besides preserving
    // tenant isolation, this prevents foreign ids from being used to distort pagination.
    await this.assertOwnedTasks(ownerId, knownTaskIds);

    const ownerScope = {
      task: { ownerId },
      dependsOnTask: { ownerId },
    } satisfies Prisma.TaskDependencyWhereInput;
    const fetchExpansionRows = async (
      where: Prisma.TaskDependencyWhereInput,
      take: number,
    ): Promise<DependencyGraphTraversalRow[]> =>
      this.prisma.taskDependency.findMany({
        where,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take,
        select: {
          taskId: true,
          dependsOnTaskId: true,
          task: {
            select: { id: true, title: true, status: true, autoRunWhenReady: true },
          },
          dependsOnTask: {
            select: { id: true, title: true, status: true, autoRunWhenReady: true },
          },
        },
      });

    // Missing edges to nodes already in the snapshot cost no node capacity. Fetch them
    // first and separately from unknown neighbors so hitting the 1000-node cap can never
    // strand a later diamond edge behind an earlier new-node row.
    const knownAdjacencyWhere =
      direction === 'prerequisites'
        ? ({
            ...ownerScope,
            taskId: query.anchorTaskId,
            dependsOnTaskId: { in: knownTaskIds, notIn: loadedNeighborTaskIds },
          } satisfies Prisma.TaskDependencyWhereInput)
        : ({
            ...ownerScope,
            dependsOnTaskId: query.anchorTaskId,
            taskId: { in: knownTaskIds, notIn: loadedNeighborTaskIds },
          } satisfies Prisma.TaskDependencyWhereInput);
    const knownNeighborRows = await fetchExpansionRows(knownAdjacencyWhere, limit);
    const remainingBatchSlots = limit - knownNeighborRows.length;
    const unknownAdjacencyWhere =
      direction === 'prerequisites'
        ? ({
            ...ownerScope,
            taskId: query.anchorTaskId,
            dependsOnTaskId: { notIn: [...loadedNeighborTaskIds, ...knownTaskIds] },
          } satisfies Prisma.TaskDependencyWhereInput)
        : ({
            ...ownerScope,
            dependsOnTaskId: query.anchorTaskId,
            taskId: { notIn: [...loadedNeighborTaskIds, ...knownTaskIds] },
          } satisfies Prisma.TaskDependencyWhereInput);
    const unknownNeighborRows =
      remainingBatchSlots > 0
        ? await fetchExpansionRows(unknownAdjacencyWhere, remainingBatchSlots)
        : [];

    // Preserve deterministic prefix pagination while enforcing the absolute node cap.
    // Existing-node edges cost no node capacity and are still returned.
    const availableNodeCapacity = MAX_DEPENDENCY_GRAPH_EXPANDED_NODES - knownTaskIds.length;
    const pageRows: DependencyGraphTraversalRow[] = [...knownNeighborRows];
    const newNodesById = new Map<
      string,
      { id: string; title: string; status: unknown; autoRunWhenReady: boolean }
    >();
    for (const row of unknownNeighborRows) {
      const neighbor = direction === 'prerequisites' ? row.dependsOnTask : row.task;
      if (
        !knownTaskIdSet.has(neighbor.id) &&
        !newNodesById.has(neighbor.id) &&
        newNodesById.size >= availableNodeCapacity
      ) {
        continue;
      }
      pageRows.push(row);
      if (!knownTaskIdSet.has(neighbor.id)) newNodesById.set(neighbor.id, neighbor);
    }

    const pageNeighborIds = pageRows.map((row) =>
      direction === 'prerequisites' ? row.dependsOnTaskId : row.taskId,
    );
    const updatedLoadedNeighborIds = [...loadedNeighborTaskIds, ...pageNeighborIds];
    const remainingWhere =
      direction === 'prerequisites'
        ? ({
            ...ownerScope,
            taskId: query.anchorTaskId,
            dependsOnTaskId: { notIn: updatedLoadedNeighborIds },
          } satisfies Prisma.TaskDependencyWhereInput)
        : ({
            ...ownerScope,
            dependsOnTaskId: query.anchorTaskId,
            taskId: { notIn: updatedLoadedNeighborIds },
          } satisfies Prisma.TaskDependencyWhereInput);
    const remainingCount = await this.prisma.taskDependency.count({ where: remainingWhere });

    // A very common wide-DAG shape is CHECK <- W <- P: the expanded CHECK branch
    // contains many W nodes and every W has exactly one prerequisite P. Batch-hydrate
    // that one unambiguous continuation so the UI gets a complete P -> W branch instead
    // of creating one "+1" placeholder per W. This follows only one extra hop and stays
    // under the same absolute node cap.
    const directNewTaskIds = [...newNodesById.keys()];
    const directConnectionCounts = await this.dependencyConnectionCounts(
      ownerId,
      directNewTaskIds,
    );
    const unaryAnchorIds = directNewTaskIds.filter((id) => {
      const counts = directConnectionCounts.get(id);
      return direction === 'prerequisites'
        ? counts?.prerequisiteCount === 1
        : counts?.dependentCount === 1;
    });
    const unaryCandidates: DependencyGraphTraversalRow[] =
      unaryAnchorIds.length === 0
        ? []
        : await this.prisma.taskDependency.findMany({
            where:
              direction === 'prerequisites'
                ? ({ ...ownerScope, taskId: { in: unaryAnchorIds } } satisfies Prisma.TaskDependencyWhereInput)
                : ({
                    ...ownerScope,
                    dependsOnTaskId: { in: unaryAnchorIds },
                  } satisfies Prisma.TaskDependencyWhereInput),
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: unaryAnchorIds.length,
            select: {
              taskId: true,
              dependsOnTaskId: true,
              task: {
                select: { id: true, title: true, status: true, autoRunWhenReady: true },
              },
              dependsOnTask: {
                select: { id: true, title: true, status: true, autoRunWhenReady: true },
              },
            },
          });
    const unaryRows: DependencyGraphTraversalRow[] = [];
    let autoExpandedNodeCount = 0;
    for (const row of unaryCandidates) {
      const neighbor = direction === 'prerequisites' ? row.dependsOnTask : row.task;
      if (
        !knownTaskIdSet.has(neighbor.id) &&
        !newNodesById.has(neighbor.id) &&
        newNodesById.size >= availableNodeCapacity
      ) {
        continue;
      }
      unaryRows.push(row);
      if (!knownTaskIdSet.has(neighbor.id) && !newNodesById.has(neighbor.id)) {
        newNodesById.set(neighbor.id, neighbor);
        autoExpandedNodeCount += 1;
      }
    }

    const newTaskIds = [...newNodesById.keys()];
    const augmentedKnownTaskIds = [...knownTaskIds, ...newTaskIds];
    const requiredEdges = new Map<string, { sourceTaskId: string; targetTaskId: string }>();
    for (const row of [...pageRows, ...unaryRows]) {
      const edge = { sourceTaskId: row.dependsOnTaskId, targetTaskId: row.taskId };
      requiredEdges.set(`${edge.sourceTaskId}:${edge.targetTaskId}`, edge);
    }

    // Return every induced relationship between a newly admitted node and the current
    // snapshot, not just the requested anchor edge. This fills diamonds immediately and
    // avoids visually duplicating a node under multiple parents.
    const inducedRows =
      newTaskIds.length === 0
        ? []
        : await this.prisma.taskDependency.findMany({
            where: {
              ...ownerScope,
              taskId: { in: augmentedKnownTaskIds },
              dependsOnTaskId: { in: augmentedKnownTaskIds },
              OR: [{ taskId: { in: newTaskIds } }, { dependsOnTaskId: { in: newTaskIds } }],
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: MAX_DEPENDENCY_GRAPH_EDGES + 1,
            select: { taskId: true, dependsOnTaskId: true },
          });
    const inducedEdgesTruncated = inducedRows.length > MAX_DEPENDENCY_GRAPH_EDGES;
    const edges = new Map<string, { sourceTaskId: string; targetTaskId: string }>();
    for (const row of inducedRows.slice(0, MAX_DEPENDENCY_GRAPH_EDGES)) {
      const edge = { sourceTaskId: row.dependsOnTaskId, targetTaskId: row.taskId };
      edges.set(`${edge.sourceTaskId}:${edge.targetTaskId}`, edge);
    }
    // Requested direct edges always survive a dense induced-edge cap.
    for (const [key, edge] of requiredEdges) edges.set(key, edge);
    if (edges.size > MAX_DEPENDENCY_GRAPH_EDGES) {
      for (const key of [...edges.keys()].reverse()) {
        if (edges.size <= MAX_DEPENDENCY_GRAPH_EDGES) break;
        if (!requiredEdges.has(key)) edges.delete(key);
      }
    }

    const baseNewNodes = [...newNodesById.values()].map((node) => ({
      ...node,
      status: node.status as unknown as TaskStatus,
    }));
    const [withRun, dependencyStates, connectionCounts] = await Promise.all([
      this.withRunning(ownerId, baseNewNodes, true),
      this.dependencyStatesForGraph(ownerId, newTaskIds),
      this.dependencyConnectionCounts(ownerId, newTaskIds),
    ]);
    const responseNodes = withRun.map((node) => ({
      ...node,
      ...(connectionCounts.get(node.id) ?? { prerequisiteCount: 0, dependentCount: 0 }),
      dependencyState: dependencyStates.get(node.id) ?? 'NONE',
    }));

    const atNodeCapacity = augmentedKnownTaskIds.length >= MAX_DEPENDENCY_GRAPH_EXPANDED_NODES;
    const remainingKnownNeighborCount =
      atNodeCapacity && remainingCount > 0
        ? await this.prisma.taskDependency.count({
            where:
              direction === 'prerequisites'
                ? ({
                    ...ownerScope,
                    taskId: query.anchorTaskId,
                    dependsOnTaskId: {
                      in: augmentedKnownTaskIds,
                      notIn: updatedLoadedNeighborIds,
                    },
                  } satisfies Prisma.TaskDependencyWhereInput)
                : ({
                    ...ownerScope,
                    dependsOnTaskId: query.anchorTaskId,
                    taskId: { in: augmentedKnownTaskIds, notIn: updatedLoadedNeighborIds },
                  } satisfies Prisma.TaskDependencyWhereInput),
          })
        : 0;
    const capacityReached = atNodeCapacity && remainingCount > remainingKnownNeighborCount;
    const nextCursor =
      remainingCount > 0 && (!atNodeCapacity || remainingKnownNeighborCount > 0)
        ? encodeDependencyGraphBranchCursor(
            ownerId,
            focusTaskId,
            query.anchorTaskId,
            direction,
          )
        : null;
    const collapsedGroups: DependencyGraphCollapsedGroup[] = [];
    if (remainingCount > 0) {
      collapsedGroups.push({
        anchorTaskId: query.anchorTaskId,
        direction,
        hiddenCount: remainingCount,
        cursor: nextCursor,
      });
    }
    // Exact degree metadata plus induced edges identifies the immediately expandable
    // boundaries on newly returned nodes. Existing groups remain client-owned; this list
    // is a delta, with the requested group replacing its previous value.
    const responseEdges = [...edges.values()];
    for (const node of responseNodes) {
      const loadedPrerequisites = new Set(
        responseEdges
          .filter((edge) => edge.targetTaskId === node.id)
          .map((edge) => edge.sourceTaskId),
      ).size;
      const loadedDependents = new Set(
        responseEdges
          .filter((edge) => edge.sourceTaskId === node.id)
          .map((edge) => edge.targetTaskId),
      ).size;
      const hiddenByDirection: Array<[DependencyGraphBranchDirection, number]> = [
        ['prerequisites', Math.max(0, node.prerequisiteCount - loadedPrerequisites)],
        ['dependents', Math.max(0, node.dependentCount - loadedDependents)],
      ];
      for (const [nodeDirection, hiddenCount] of hiddenByDirection) {
        if (hiddenCount === 0) continue;
        collapsedGroups.push({
          anchorTaskId: node.id,
          direction: nodeDirection,
          hiddenCount,
          cursor:
            augmentedKnownTaskIds.length < MAX_DEPENDENCY_GRAPH_EXPANDED_NODES
              ? encodeDependencyGraphBranchCursor(
                  ownerId,
                  focusTaskId,
                  node.id,
                  nodeDirection,
                )
              : null,
        });
      }
    }

    return {
      focusTaskId,
      anchorTaskId: query.anchorTaskId,
      direction,
      nodes: responseNodes,
      edges: responseEdges,
      remainingCount,
      nextCursor,
      collapsedGroups,
      autoExpandedNodeCount,
      capacityReached,
      truncatedEdges: inducedEdgesTruncated,
      limits: {
        batchSize: limit,
        maxBatchSize: MAX_DEPENDENCY_GRAPH_EXPANSION_BATCH_SIZE,
        maxNodes: MAX_DEPENDENCY_GRAPH_EXPANDED_NODES,
        maxEdges: MAX_DEPENDENCY_GRAPH_EDGES,
      },
    };
  }

  async get(ownerId: string, id: string) {
    if (!UUID_RE.test(id)) throw new NotFoundException('task not found');
    const task = await this.prisma.task.findFirst({
      where: { id, ownerId },
      include: {
        assignee: { select: { id: true, name: true, model: true } },
        // author is polymorphic (no FK), so names are resolved separately below.
        comments: {
          orderBy: { createdAt: 'asc' },
          include: {
            // §13.8: what happened to each @-mention this comment made. Included on the read
            // because the whole point of the ledger is that a stuck delivery is VISIBLE — a status
            // nobody can see is a `logger.warn` with a table behind it.
            //
            // `mentionDeliveryVersion` 0 means the comment predates the ledger and was delivered by
            // the inline loop, which recorded nothing: clients render that as LEGACY_UNTRACKED
            // rather than as delivered or failed, because neither was ever established.
            deliveries: {
              orderBy: { createdAt: 'asc' },
              select: {
                id: true,
                workspaceId: true,
                status: true,
                attempts: true,
                errorCode: true,
                requiredAction: true,
                lastError: true,
                nextAttemptAt: true,
                targetSessionId: true,
                turnId: true,
              },
            },
          },
        },
        sessions: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            title: true,
            status: true,
            // A graceful recycle and a hard stop both settle CANCELLED, so the panel's run
            // chip needs the reason to tell "dormant" from "cancelled" (see TaskDetailPanel).
            endReason: true,
            completedAt: true,
            archivedAt: true,
            deletedAt: true,
            createdAt: true,
            workspace: { select: { name: true } },
          },
        },
        creatorSession: {
          select: {
            id: true,
            title: true,
            status: true,
            endReason: true,
            completedAt: true,
            archivedAt: true,
            deletedAt: true,
          },
        },
        // Prerequisites this task waits on, and the tasks blocked until this one is DONE.
        dependsOn: {
          include: { dependsOnTask: { select: { id: true, title: true, status: true } } },
        },
        dependedOnBy: {
          include: { task: { select: { id: true, title: true, status: true } } },
        },
        // §13.6, the backward direction: the attempts this task replaced. Part of THIS query
        // rather than a second one — it is an indexed lookup either way, and `get` is on the path
        // of every task page.
        supersedes: {
          select: { id: true, title: true, status: true, terminalReason: true, supersededAt: true },
          orderBy: [{ supersededAt: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (!task) throw new NotFoundException('task not found');
    // §13.3 DEP: the same judgement the Run button and the Coordinator's pass make. A task page
    // that says READY while `execute` refuses is the disagreement `RUNNABLE_TASK_SQL` already
    // warns about, one clause further along. Built from the edges this query already hydrated, so
    // a task with no prerequisites costs no extra read at all.
    const prerequisiteEpochs = await loadVerificationEpochGates(
      this.prisma,
      ownerId,
      task.dependsOn.map((d) => d.dependsOnTaskId),
    );
    const dependencyState = computeDependencyState(task.dependsOn.map((d) => ({
      status: d.dependsOnTask.status as unknown as TaskStatus,
      verificationGate: dependencyEpochGate(
        d.dependsOnTaskId, prerequisiteEpochs, task.verifiesTaskId,
      ),
      verificationGateStalled: dependencyEpochStalled(
        d.dependsOnTaskId, prerequisiteEpochs, task.verifiesTaskId,
      ),
    })));
    const supersession = await this.supersession(ownerId, task);
    return {
      ...task,
      sessions: (task.sessions ?? []).map((session) => withSessionState(session)),
      creatorSession: task.creatorSession ? withSessionState(task.creatorSession) : null,
      comments: await this.resolveCommentAuthors(task.comments),
      dependencyState,
      ...supersession,
    };
  }

  /**
   * §13.6, both directions, for one task.
   *
   * `outcome` is the word a client shows — the one place "failed", "cancelled" and "superseded"
   * are told apart, derived rather than stored so three clients cannot each derive it differently.
   *
   * `supersedes` is what this task replaced (its direct predecessors) and `successorChain` is what
   * replaced it, followed to the attempt that is actually live. The chain is the read the audit
   * wants: a cancelled attempt three replacements deep still answers "so who ended up doing this",
   * and answers it with rows rather than with a comment somebody wrote.
   *
   * One recursive query rather than a loop of finds: the walk is bounded by the same 256 hops the
   * database refuses to exceed, and a per-hop round trip on a page of tasks is the shape that turns
   * an audit read into a timeout.
   */
  private async supersession(
    ownerId: string,
    task: {
      id: string;
      status: string;
      supersededByTaskId: string | null;
      terminalReason: string | null;
      supersedes?: Array<{ id: string; title: string; status: string; terminalReason: string | null }>;
    },
  ) {
    const predecessors = task.supersedes ?? [];
    const forward =
      task.supersededByTaskId == null
        ? []
        : await this.prisma.$queryRaw<Array<{
            id: string; title: string; status: string;
            supersededByTaskId: string | null; terminalReason: string | null; depth: number;
          }>>(Prisma.sql`
            WITH RECURSIVE walk AS (
              SELECT t."id", t."title", t."status"::text, t."superseded_by_task_id", t."terminal_reason", 1 AS depth
                FROM "task" t
               WHERE t."id" = ${task.supersededByTaskId}::uuid AND t."owner_id" = ${ownerId}::uuid
              UNION ALL
              SELECT n."id", n."title", n."status"::text, n."superseded_by_task_id", n."terminal_reason", w.depth + 1
                FROM walk w
                JOIN "task" n ON n."id" = w."superseded_by_task_id" AND n."owner_id" = ${ownerId}::uuid
               WHERE w.depth < ${TASK_SUPERSESSION_MAX_HOPS}
            )
            SELECT "id", "title", "status",
                   "superseded_by_task_id" AS "supersededByTaskId",
                   "terminal_reason" AS "terminalReason",
                   depth
              FROM walk ORDER BY depth`);
    // The chain the pure function would build from the same edges, used to bound what the query
    // returned: a cycle is unwritable (0128's trigger), so if one is ever read it is reported as a
    // truncation rather than followed.
    const edges = new Map<string, string | null>([[task.id, task.supersededByTaskId]]);
    for (const row of forward) edges.set(row.id, row.supersededByTaskId);
    const { chain, truncated } = successorChain(task.id, edges);
    const byId = new Map(forward.map((row) => [row.id, row]));
    return {
      outcome: taskOutcome(task),
      supersededByTaskIdAbsentReason: supersededByAbsentReason(task),
      supersedes: predecessors,
      supersedesEmptyReason: predecessors.length > 0 ? null : ('SUPERSEDES_NOTHING' as const),
      successorChain: chain
        .map((id) => byId.get(id))
        .filter((row): row is NonNullable<typeof row> => row !== undefined)
        .map((row) => ({
          id: row.id,
          title: row.title,
          status: row.status,
          terminalReason: row.terminalReason,
        })),
      successorChainTruncated: truncated,
    };
  }

  /**
   * Resolve each comment's polymorphic author (USER|AGENT) to a display name in one
   * batched pass (no FK to include). Returns the comments with an added authorName.
   */
  private async resolveCommentAuthors(comments: TaskComment[]) {
    if (comments.length === 0) return [];
    const userIds = comments.filter((c) => c.authorType === CreatorType.USER).map((c) => c.authorId);
    const workspaceIds = comments.filter((c) => c.authorType === CreatorType.AGENT).map((c) => c.authorId);
    const [users, workspaces] = await Promise.all([
      userIds.length
        ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
        : [],
      workspaceIds.length
        ? this.prisma.workspace.findMany({ where: { id: { in: workspaceIds } }, select: { id: true, name: true } })
        : [],
    ]);
    const names = new Map<string, string>();
    for (const u of users) names.set(u.id, u.name);
    for (const a of workspaces) names.set(a.id, a.name);
    return comments.map((c) => ({ ...c, authorName: names.get(c.authorId) ?? null }));
  }

  /**
   * `actingSessionId` is the run this edit is being made FROM, when there is one — the runner
   * sends it on every task write an agent makes. It is used for exactly one decision, §13.2's
   * independence rule below, and is otherwise ignored: a task edit is authorised by the owner,
   * not by which run happened to make it.
   */
  async update(ownerId: string, id: string, dto: UpdateTaskDto, actingSessionId?: string) {
    const before = await this.get(ownerId, id);
    if (dto.assigneeId) await this.assertOwnedWorkspace(ownerId, dto.assigneeId);
    if (dto.listId) await this.assertOwnedList(ownerId, dto.listId);
    if (dto.projectId) await this.assertOwnedProject(ownerId, dto.projectId);
    if (dto.provider) await this.assertUsableProvider(ownerId, dto.provider);
    // Unit L3 §4. An update never re-files a task on its own — a write that does not mention the
    // project leaves it exactly where it is — so this binds nothing and only refuses: it is what
    // stops a coordinator editing work inside another project's goal (R6), moving work across the
    // line without declaring it (R7), or emptying a task out of the project that counts it (R4).
    // Before the transaction, so a refusal writes nothing and takes no lock.
    let scopeWorld: ScopeWorld | undefined;
    let scopeFence: (ScopeWriteInput & { boundProjectId: string | null }) | undefined;
    {
      const scopeWrite: ScopeWriteInput = {
        operation: 'UPDATE_TASK',
        taskId: id,
        requestedProjectId: dto.projectId === undefined ? undefined : (dto.projectId ?? null),
        currentProjectId: before.projectId ?? null,
        scopeToken: dto.scopeToken,
      };
      scopeWorld = await this.projectScopeWorld(
        this.prisma, ownerId, actingSessionId, [scopeWrite],
      );
      const boundProjectId = this.admitScopedWrite(scopeWorld, scopeWrite);
      // Only a write that actually claims a goal is fenced. The owner's edits and edits to tasks
      // that belong to no project keep the one-statement path exactly as they had it.
      if (scopeWorld.principal !== 'USER'
        && (boundProjectId !== null || scopeWrite.currentProjectId !== null)) {
        scopeFence = { ...scopeWrite, boundProjectId };
      }
    }
    // Whether this write can move the task within the project/subtask structure. It decides both
    // that the hierarchy rules are checked at all and that the write takes the owner lock: the
    // check and the update it authorises have to be one serialized step, not two.
    const touchesHierarchy =
      dto.projectId !== undefined ||
      dto.parentTaskId !== undefined ||
      dto.verifiesTaskId !== undefined;
    const dependsOnTaskIds =
      dto.dependsOnTaskIds === undefined ? undefined : [...new Set(dto.dependsOnTaskIds)];
    if (dependsOnTaskIds?.includes(id)) {
      throw new BadRequestException('A task cannot depend on itself');
    }
    if (dependsOnTaskIds?.length) {
      await this.assertOwnedTasks(ownerId, dependsOnTaskIds);
    }
    // Set when this write touches §13.6's three supersession columns; applied as one statement
    // inside the transaction below (see where it is filled in for why it cannot go in `data`).
    let supersession: { successorId: string | null; at: Date | null; reason: string | null } | null =
      null;
    const data: Prisma.TaskUpdateInput = {
      title: dto.title,
      description: dto.description,
      status: dto.status,
      dueDate: dto.dueDate === null ? null : dto.dueDate ? new Date(dto.dueDate) : undefined,
      // Three-state, same as dueDate: omitted preserves the schedule, null cancels it, an instant
      // (re)schedules. Cancelling is a plain write with no dispatch consequence — nothing has been
      // consumed, so there is nothing to put back.
      runAt: dto.runAt === null ? null : dto.runAt ? new Date(dto.runAt) : undefined,
      // Whole-set replacement, not a merge: omitted keeps the current labels, [] clears them.
      // A merge would leave no way to remove one.
      labels: dto.labels === undefined ? undefined : normalizeTaskLabels(dto.labels),
      // Three-state like the FKs above, except these are plain columns: omitted keeps the current
      // pin, null goes back to inheriting the assignee's provider/model.
      provider: dto.provider === undefined ? undefined : (dto.provider ?? null),
      model: dto.model === undefined ? undefined : (dto.model ?? null),
      acceptanceCriteria:
        dto.acceptanceCriteria === undefined ? undefined : (dto.acceptanceCriteria ?? null),
      autoRunWhenReady: dto.autoRunWhenReady,
      completionPolicy: dto.completionPolicy,
      // Three-state like the pins above: omitted keeps the conclusion, null revokes it. Revoking is
      // a real operation rather than an undo — a subject completed by VERIFICATION_PASSED goes back
      // to OPEN on the next reconcile, which is the point of storing the verdict rather than
      // reading "the verification finished" as a pass.
      verdict: dto.verdict === undefined ? undefined : (dto.verdict ?? null),
    };
    // What this task verifies AFTER the write, not before it: one call may both point a task at a
    // subject and conclude about it, and judging the verdict against the old column would refuse
    // the second half of a write whose first half made it legal.
    const verifiesTaskId =
      dto.verifiesTaskId === undefined ? before.verifiesTaskId : (dto.verifiesTaskId ?? null);
    // The column is only meaningful on a row that names what it verifies, and the database says so
    // too (0123's task_verdict_requires_subject). Checked here as well so the caller gets the
    // reason rather than a constraint name.
    if (dto.verdict != null && !verifiesTaskId) {
      throw new BadRequestException(
        'Only a verification task can carry a verdict — this task does not verify anything',
      );
    }
    // `[K5]` criterion 6, and §13.2 V1 said as a refusal for the first time.
    //
    // "A check's carrier is its own TERMINAL state plus a structured result" has always been the
    // rule and has never been enforced on the way IN: `status: DONE` with no verdict is accepted,
    // and everything downstream then behaves correctly and uselessly — the subject can never reach
    // the PASS its policy waits for, every dependent stays blocked, `planVerificationVerdicts`
    // skips it as `NO_VERDICT`, and the whole of the loop's response is one WARN a minute. `[H0V2]`
    // found that shape by exhaustion and could not find anybody it was reported to.
    //
    // Judged on the row AFTER the write, so both legal spellings survive: conclude and finish in
    // one call, or write the verdict first and the status after. What stops being expressible is
    // finishing a check without saying what it found. Migration 0141 carries the same rule for
    // writers that never reach this method.
    const concludedStatus = dto.status === undefined ? before.status : dto.status;
    const concludedVerdict = dto.verdict === undefined ? before.verdict : (dto.verdict ?? null);
    if (
      verifiesTaskId && concludedStatus === TaskStatus.DONE && concludedVerdict == null
      && before.status !== TaskStatus.DONE
    ) {
      throw new BadRequestException(
        'A verification task cannot be DONE without a verdict — it would never conclude, and '
          + 'everything waiting on its subject would stay blocked with nothing to act on. Record '
          + 'PASS, FAIL or INCONCLUSIVE in this same call, or cancel the check instead',
      );
    }
    // §13.2 V7 is a monotonic counter, and everything it has already caused — a reverted subject,
    // a defect subtask, a downstream block — is recorded against the subject this task named at
    // the time. Re-pointing it afterwards would leave the ledger asserting conclusions about a
    // task this verifier no longer checks, and there is no write that repairs that, because the
    // consequences were correct when they were applied. A new check is one task create.
    if (
      dto.verifiesTaskId !== undefined &&
      (dto.verifiesTaskId ?? null) !== (before.verifiesTaskId ?? null) &&
      (before.verdict != null || BigInt(before.verdictRevision ?? 0) > 0n)
    ) {
      throw new BadRequestException(
        'This verification has already concluded — its subject can no longer be changed. File a ' +
          'new verification task for the other subject instead',
      );
    }
    // Does this write REACH a verdict? That is a narrower thing than "the verdict column was in
    // the request" — writing FAIL onto a row that already says FAIL concluded nothing — and it is
    // what §13.2 V7's revision counts.
    //
    // The counter itself, and the revocation that pairs with it, are migration 0124's triggers:
    // both rules have to hold for every write path including raw SQL, and a rule each writer is
    // trusted to remember is one the next writer forgets. What a trigger cannot do is the reason
    // this flag exists — take the project's acceptance-fact lock (§13.4 AE6-a) before the task
    // row is written, since by the time a trigger runs that row is already held and taking the
    // project lock there would reverse the loop's one lock order.
    const concludesVerdict = dto.verdict != null && dto.verdict !== before.verdict;
    // The independence rule, as a refusal rather than as a sentence in a brief.
    //
    // A verification is a SECOND opinion, and the run that produced the work is not a second
    // opinion about it. The project instructions have said so in prose for as long as there have
    // been verification tasks; prose is checked by whoever remembers to check it, and the case
    // that matters — a session finishing its own task and then writing PASS on the check filed
    // against it — is exactly the one where nobody is watching.
    //
    // Scoped to the one relation that makes it wrong: the acting session's own task IS the
    // subject. A person concluding from no session, a coordinator concluding from its own, and
    // the verifier's own run concluding about the subject are all left alone.
    if (concludesVerdict && actingSessionId && verifiesTaskId) {
      const actingSession = await this.prisma.session.findFirst({
        where: { id: actingSessionId, ownerId },
        select: { taskId: true },
      });
      if (actingSession?.taskId && actingSession.taskId === verifiesTaskId) {
        throw new BadRequestException(
          'A verification cannot be concluded from the session that ran the task it verifies — ' +
            'the check has to be an independent run',
        );
      }
    }
    // §13.1 AG6's other end, refused here so the API answers in a sentence rather than letting
    // `task_foreman_manual_policy` answer with a constraint name. `is_foreman` says "this task's
    // SESSION is the work"; a non-MANUAL policy says "the children decide when it is finished". A
    // row asserting both has two completion owners — a worker writing DONE and `planTaskAggregation`
    // writing DONE or dragging it back OPEN — and AG3's reopen makes whichever loses permanent.
    //
    // Read with its own query because `isForeman` is deliberately not in the list projection, and
    // only when this write actually asks for the combination: an update that leaves the policy
    // alone pays nothing.
    if (dto.completionPolicy != null) {
      const row = await this.prisma.task.findFirst({
        where: { id, ownerId },
        select: { isForeman: true },
      });
      // EFFECTIVE values, not "what this PATCH mentions": the conflict is a property of the row
      // this write LEAVES BEHIND, so each field is the one being set if the request names it and
      // the stored one otherwise. `isForeman` is not on the update DTO today, so its effective
      // value is always the stored one — written this way so that adding it to the DTO cannot
      // silently leave a half-checked guard behind. `task_foreman_manual_policy` is the backstop
      // for every writer that does not come through here.
      if (row && foremanPolicyConflict({
        isForeman: row.isForeman,
        completionPolicy: dto.completionPolicy,
      })) {
        throw new BadRequestException(
          'This task is a coordinating (foreman) task, so its own run is what finishes it — it ' +
            'cannot also be completed by aggregating subtasks. Clear the foreman role, or leave ' +
            'completionPolicy as MANUAL',
        );
      }
    }
    // §13.1's other half: a policy that decides a parent's completion decides it, and a status
    // write is not a way around it. Refused rather than written-then-recomputed, because a DONE
    // that survives for one reconcile is a DONE somebody can read, quote and act on.
    //
    // AG4's condition is checked as AG4 states it — the policy is inert on a childless task — so
    // this refuses only where the policy actually answers the question.
    if (dto.status === TaskStatus.DONE && before.status !== TaskStatus.DONE) {
      const policy = dto.completionPolicy ?? before.completionPolicy;
      if (policy && policy !== 'MANUAL') {
        const children = await this.prisma.task.count({ where: { ownerId, parentTaskId: id } });
        if (children > 0) {
          throw new BadRequestException(
            `This task completes by ${policy}, not by a status write — its ${children} subtask(s)` +
              (policy === 'VERIFICATION_PASSED' ? ' and its verifications' : '') +
              ' decide when it is DONE. Set completionPolicy to MANUAL if you mean to write it' +
              ' by hand',
          );
        }
      }
    }
    // §13.6 SU4, the direction only a status write can break.
    //
    // The supersession block below validates when the REQUEST mentions those fields. A PATCH that
    // mentions only `status` does not reach it, and 0128's trigger returns early whenever
    // `superseded_by_task_id IS NULL` — so on the two retirements that have no pointer (ABANDONED,
    // and SUPERSEDED whose successor was deleted) a plain reopen was accepted by both. Before this
    // release it produced an odd row; after it, every gate here reads that row as retired and never
    // dispatches it, while its status says OPEN. Nothing would move it again and nothing would say
    // why. 0130's `task_retirement_status_check` refuses it at the database; this exists so the
    // caller is told what to pass instead of being handed a constraint name.
    if (dto.status !== undefined
        && dto.supersededByTaskId === undefined && dto.terminalReason === undefined
        && !TASK_SUPERSEDABLE_STATUSES.has(dto.status)
        && taskRetirement(before) != null) {
      throw new BadRequestException(
        `task ${uuidToBase62(id)} is recorded as ${before.terminalReason ?? 'SUPERSEDED'}` +
          (before.supersededByTaskId
            ? ` by ${uuidToBase62(before.supersededByTaskId)}`
            : ' (its successor has since been deleted)') +
          `, so it cannot become ${dto.status} while that stands. Clear the retirement in the ` +
          'SAME request — supersededByTaskId: null with terminalReason: null — if this attempt is ' +
          'genuinely being picked up again',
      );
    }
    // §13.6: record that this attempt was replaced, without touching how it ended.
    //
    // The status this is judged against is the one AFTER the write, because the natural call is one
    // PATCH that cancels the attempt and names its successor — judging SU4 against the old status
    // would refuse the second half of a write whose first half made it legal. Migration 0128's
    // trigger checks every one of these again (and the acyclicity this cannot see); these refusals
    // exist so the caller is told which rule it broke instead of being handed a constraint name.
    if (dto.supersededByTaskId !== undefined || dto.terminalReason !== undefined) {
      const statusAfter = dto.status ?? before.status;
      const projectAfter =
        dto.projectId === undefined ? before.projectId : (dto.projectId ?? null);
      const successorId =
        dto.supersededByTaskId === undefined
          ? before.supersededByTaskId
          : (dto.supersededByTaskId ?? null);
      const successor = successorId
        ? await this.prisma.task.findFirst({
            where: { id: successorId },
            select: { id: true, ownerId: true, projectId: true },
          })
        : null;
      if (successorId && !successor) throw new NotFoundException('successor task not found');
      const refusal = supersessionRefusal({
        taskId: id,
        status: statusAfter,
        successor,
        ownerId,
        projectId: projectAfter,
      });
      if (refusal) throw new BadRequestException(refusal);
      // A successor IS the reason, so it never has to be spelled twice — and it may not be
      // contradicted: 'ABANDONED' means nothing replaced this, which is the opposite claim.
      if (successorId && dto.terminalReason != null && dto.terminalReason !== 'SUPERSEDED') {
        throw new BadRequestException(
          `A task with a successor is SUPERSEDED, not ${dto.terminalReason} — pass one or the other`,
        );
      }
      if (dto.terminalReason === 'SUPERSEDED' && !successorId) {
        throw new BadRequestException(
          'SUPERSEDED names the attempt that took over — pass supersededByTaskId, or use ' +
            'ABANDONED for a task nothing replaced',
        );
      }
      if (dto.terminalReason != null && !TASK_SUPERSEDABLE_STATUSES.has(statusAfter)) {
        throw new BadRequestException(
          `A terminal reason belongs to a task that has stopped — this one is ${statusAfter}`,
        );
      }
      // All THREE columns move together, in one statement, because 0128's link CHECK is about the
      // three of them at once and PostgreSQL evaluates a CHECK per statement. Prisma cannot write
      // them together: `supersededBy: { disconnect: true }` is issued as a SECOND statement after
      // the scalar update, so unlinking cleared the reason while the successor id was still set —
      // exactly the state the CHECK exists to refuse — and every unlink failed with a constraint
      // name. Raw SQL here is one statement, and it still goes through 0128's trigger, so the
      // tenant, project, terminal-status and acyclicity rules are unchanged.
      supersession = {
        successorId,
        // The instant it was replaced. Kept where it was on a re-statement of the same link, so
        // re-recording a supersession does not quietly move when it happened.
        at: successorId
          ? (before.supersededByTaskId === successorId && before.supersededAt
              ? before.supersededAt
              : new Date())
          : (dto.terminalReason ? (before.supersededAt ?? new Date()) : null),
        reason: successorId
          ? 'SUPERSEDED'
          : dto.terminalReason === undefined
            ? (before.terminalReason === 'SUPERSEDED' ? null : before.terminalReason)
            : dto.terminalReason,
      };
    }
    // assigneeId is a relation FK: connect to (re)assign, disconnect to clear.
    if (dto.assigneeId !== undefined) {
      data.assignee = dto.assigneeId ? { connect: { id: dto.assigneeId } } : { disconnect: true };
    }
    // listId is a relation FK: connect to (re)assign, disconnect to detach.
    if (dto.listId !== undefined) {
      data.list = dto.listId ? { connect: { id: dto.listId } } : { disconnect: true };
      // The hold belongs to the list the task is in, so it moves with it. Detaching releases:
      // a hold whose holder the task no longer belongs to can never be lifted, and a task that
      // can neither run nor be resumed is a wedge rather than a stop.
      data.dispatchHold = dto.listId
        ? (await this.pausedListIds(ownerId, [dto.listId])).has(dto.listId)
        : false;
    }
    // projectId and parentTaskId are relation FKs too, and unlike the list they carry nothing with
    // them: a project holds no dispatch policy, so re-filing a task cannot hold or release it.
    if (dto.projectId !== undefined) {
      data.project = dto.projectId ? { connect: { id: dto.projectId } } : { disconnect: true };
    }
    if (dto.parentTaskId !== undefined) {
      data.parent = dto.parentTaskId ? { connect: { id: dto.parentTaskId } } : { disconnect: true };
    }
    // The verification link is a relation FK like the two above: connect to point this task at a
    // subject, disconnect to make it an ordinary task again.
    if (dto.verifiesTaskId !== undefined) {
      data.verifies = dto.verifiesTaskId
        ? { connect: { id: dto.verifiesTaskId } }
        : { disconnect: true };
    }
    // One owner lock covers both structures a task can be moved within — its dependency edges and
    // its place in a project's subtask tree — because a single request can touch both and because
    // serializing each against itself but not against the other would leave exactly the gap the
    // lock exists to close. An update that touches neither still takes no lock at all: renaming a
    // task must not queue behind another owner's DAG rewrite.
    //
    // A write that only re-files the task into another list joins them, because
    // `TaskListsService` locks a list row and then writes every Task in it: without the ordered
    // pre-lock below, that pause and this move take `task_list` and `task` in opposite orders.
    //
    // `status` and `completionPolicy` join them for the OTHER endpoint. Both are in the column
    // list `project_acceptance_task_fact_update` is declared over, so writing either makes an
    // AFTER trigger take `FOR NO KEY UPDATE` on this task's project — measured, not inferred:
    // `lock-order.pg.spec.ts` holds that lock and watches a status write block on it while a
    // title write sails past. Left on the one-statement path, such a write holds the task row and
    // then asks for the project, which is the reverse of the order the Project authorization
    // adapter takes them in (project first, then the task FOR SHARE).
    //
    // ...and the set of columns is read from `ACCEPTANCE_FACT_TASK_COLUMNS`, not spelled again.
    //
    // Spelled here it was FIVE, and the trigger is declared over SEVEN: 0130 added
    // `terminal_reason` and `superseded_by_task_id` to it. Both happen to be covered anyway,
    // because a write to either sets `supersession` and that forces the transaction branch through
    // `restructures` — so the gap was real and invisible, held shut by a second condition that has
    // nothing to do with acceptance facts. `touchesAcceptanceFact` asks the closed set directly,
    // and `task-lock-order.spec.ts` checks that set against migration 0136's trigger text, so the
    // next column added to the trigger cannot be forgotten here.
    const touchesAcceptanceFacts = touchesAcceptanceFact(dto);
    // Restructuring is what rank 10 is for. A status write moves one row and no edge, so it must
    // not queue behind another request's DAG rewrite — the same reasoning that keeps a rename off
    // the lock entirely, applied to the writes that now need rank 40.
    const restructures =
      dependsOnTaskIds !== undefined ||
      touchesHierarchy ||
      concludesVerdict ||
      !!supersession ||
      dto.listId !== undefined;
    // The FK re-check only fires on a SECOND write of this task's row. A supersession is that
    // second write (its own statement, beside `task.update`). A dependency replacement no longer
    // is: since 0132 the edge write advances `task_dependency_revision` instead of re-writing the
    // dependent Task, so replacing prerequisites alone leaves the row written exactly once.
    const rewritesTaskRow = !!supersession;
    const updated = await (
      // `scopeFence` joins the two conditions that already force the transaction branch, and for
      // the same kind of reason: a scope re-check that runs outside the transaction it is meant to
      // fence is a check the rotation it exists for can simply commit past. An agent edit inside a
      // project therefore takes the transaction; nothing else changes shape.
      !restructures && !(touchesAcceptanceFacts && before.projectId) && !scopeFence
        ? this.prisma.task.update({ where: { id }, data })
        // Retried whole, on the transaction branch only. The one-statement branch is an
        // autocommit UPDATE with nothing to re-run: it has no transaction of its own, so a
        // conflict there leaves the global 503 boundary to answer it
        // (common/transient-db-conflict.filter). The closure below re-reads the task inside the
        // owner mutex on every attempt — `current`, the acceptance projects, the hierarchy check
        // and the edge set are all derived there — so a re-run judges the row the winner left
        // rather than replaying a decision made against a snapshot the server discarded.
        : withTransactionRetry(this.prisma, async (tx) => {
            if (restructures) await this.lockDependencyGraph(tx, ownerId);
            // Ranks 20 and 30 of the canonical order (common/lock-order.ts), both ahead of the
            // task write below. The list is the FK endpoint a concurrent pause holds FOR UPDATE;
            // the Session is the one `task_creator_session_id_fkey` re-checks — and it IS
            // re-checked here even though nothing about it changes, because this transaction
            // writes the task row and the supersession statement writes it a second time, which
            // re-runs every one of its foreign keys.
            await lockTaskLists(tx, [dto.listId]);
            if (rewritesTaskRow) await this.preLockCreatorSessions(tx, [], [id]);
            // §13.4 AE6-a. A verdict is one of the facts a project's acceptance is computed from,
            // so reaching one takes the project's own row before it writes — the same lock the
            // acceptance gate takes, which is what puts the two in an order instead of letting
            // both commit and leave a DONE project asserting a verdict it never saw. Taken after
            // the owner lock and before the task write, so the order here is always
            // user -> project -> task and two of these can never wait on each other backwards.
            //
            // §13.6 SU6 joins it, and had to: 0130 adds `terminal_reason` and
            // `superseded_by_task_id` to `project_acceptance_task_fact_update`, so a
            // supersession-only PATCH now reaches `project_acceptance_reopen` from an AFTER trigger
            // — which takes the PROJECT row while this transaction already holds the TASK row. The
            // Coordinator's own dispatch takes them the other way (project lease, then the task),
            // so without this prelock the two wait on each other. Same lock, same place, one order.
            //
            // And so does every OTHER write of an acceptance fact, not only a verdict or a
            // supersession: `project_acceptance_task_fact_update` is declared over five columns,
            // so a plain `status` or `completionPolicy` PATCH reaches the same AFTER trigger and
            // takes the same PROJECT row — measured, not inferred, in `lock-order.pg.spec.ts`,
            // which holds that lock and watches a status write block on it while a title write
            // sails past. Pre-locking changes nothing about WHICH locks this transaction ends up
            // holding, only when: rank 40, after the Session pre-lock (so it can never hold the
            // project while waiting for a Session a runner owns — session_project_capacity_serialize
            // comes at the project from that side) and before the task write (so it can never hold
            // the task while the Project authorization adapter, which takes the project first and
            // the task FOR SHARE second, waits for it).
            //
            // A PATCH that also MOVES the project touches two of them, and AE10 already fixed what
            // to do about that: both, in UUID order, so a concurrent A→B and B→A cannot make a
            // cycle out of each other. That ordering is the trigger's own (§8.6 LO2) and is
            // reproduced here rather than reinvented.
            //
            // Re-read INSIDE the owner lock, and prelock from THAT. `before` was loaded before the
            // lock was held, so by now another request may have moved this task into a different
            // project — and locking the project `before` named would leave the AFTER trigger to
            // take the real one, which is the task→project order this prelock exists to avoid.
            // The same stale copy is what `touchesHierarchy` has always re-read for, so one read
            // serves both rather than two reads disagreeing about one row.
            // `touchesAcceptanceFacts`, not `concludesVerdict`: the prelock below is taken for
            // EVERY project-filed update, because `project_acceptance_reopen` takes this exact
            // lock from an AFTER trigger on any status, policy, project or verification-link write
            // too — so pre-locking changes nothing about WHICH locks this transaction ends up
            // holding, only when. Rank 40, and after the rank-30 Session prelock above, so it can
            // never hold the project while waiting for a Session a runner owns.
            const needsCurrent = touchesHierarchy || touchesAcceptanceFacts || !!supersession;
            const current = needsCurrent
              ? await tx.task.findFirst({
                where: { id, ownerId },
                select: { projectId: true, parentTaskId: true, verifiesTaskId: true },
              })
              : null;
            if (needsCurrent && !current) throw new NotFoundException('task not found');
            // A pure project MOVE belongs here too, and the comment above already said why without
            // the code doing it: 0127's `project_acceptance_task_fact` reopens BOTH projects from
            // an AFTER trigger, so a move takes the task row first and the two projects second —
            // against every Coordinator path's project-then-task. The old condition
            // (`concludesVerdict || supersession`) left exactly that case with an empty list.
            const movesProject = dto.projectId !== undefined
              && (dto.projectId ?? null) !== current!.projectId;
            // Unit L3's fence takes rank 40 first and takes the acceptance projects with it, so
            // this transaction's project locks are one non-decreasing sequence; the loop below then
            // re-locks rows it already holds.
            const acceptanceProjects = touchesAcceptanceFacts || supersession
              ? [...new Set([
                current!.projectId,
                dto.projectId === undefined ? current!.projectId : (dto.projectId ?? null),
              ].filter((projectId): projectId is string => !!projectId))].sort()
              : [];
            if (scopeWorld && scopeFence) {
              await this.refenceProjectScope(
                tx, ownerId, actingSessionId, scopeWorld, [scopeFence], acceptanceProjects,
              );
            }
            for (const projectId of acceptanceProjects) {
              await tx.$queryRaw`
                SELECT 1 FROM "project" WHERE "id" = ${projectId}::uuid FOR NO KEY UPDATE`;
            }
            // ...and the read that chose them was taken before the first of them was held, so it
            // was a guess. Between it and the lock this task can be re-filed into another project
            // — nothing above serializes a single-row status write against a move — and this
            // transaction would then hold the OLD project while the AFTER trigger reaches for the
            // new one. Deadlocking would be the loud version; committing on the guess is the quiet
            // one. Checked here, after rank 40 and before the first task write, so a refusal costs
            // nothing that has been written.
            if (acceptanceProjects.length > 0) {
              await assertAcceptanceScopeUnmoved(
                tx, ownerId, [id],
                [...acceptanceProjects, ...(dto.projectId ? [dto.projectId] : [])],
              );
            }

            // ...and the task row IMMEDIATELY after, before anything else in this transaction
            // touches it. `tx.task.update` below takes the same row with an ordinary blocking lock,
            // so a NOWAIT taken only at `writeSupersession` would be reached AFTER the wait it was
            // meant to prevent — the cycle would already have formed. Every supersession PATCH runs
            // that Prisma UPDATE, including the common `{status: CANCELLED, terminalReason:
            // ABANDONED}`, so this is the first thing after the project.
            // ...and the task row NOWAIT after them, on either path. `tx.task.update` below takes
            // this row with an ordinary blocking lock, so a move that skipped this would hold two
            // projects and then WAIT for a task — the cycle, assembled out of the very locks taken
            // to avoid it.
            if (supersession || movesProject) await this.lockTaskForSupersessionWrite(tx, id);
            if (touchesHierarchy) {
              await this.assertHierarchyConsistent(tx, ownerId, id, current!, dto);
            }
            // §13.6 SU3, the direction nothing checked: this task may be somebody's SUCCESSOR, and
            // moving it out of their project would leave a supersession pointing across the line
            // SU3 draws — the predecessor's project would count its own failure as history while
            // the replacement had left that project's authority entirely. 0128's guard cannot see
            // this: it fires on the row that HOLDS the pointer, and that row is not the one moving.
            //
            // Read under the owner lock taken at the top of this transaction, which is also what
            // the link path takes — so a concurrent link and a concurrent move serialize there and
            // neither can read the other's rows as absent. `supersedes` is a set, not a single row:
            // several attempts can name one successor, and all of them have to still be legal.
            if (dto.projectId !== undefined && dto.projectId !== current!.projectId) {
              // §12.3 D3's claim guard, as a sentence rather than as a constraint name. A task
              // whose run is live belongs to the project that dispatched it: the action, the
              // authorization and both projects' concurrency counts are all scoped there. All four
              // live statuses, matching the trigger this mirrors — a conversation paused at
              // AWAITING_INPUT is as much a claim as a running one.
              await this.assertNotRunningBeforeRetiring(tx, ownerId, id).catch((error) => {
                if (!(error instanceof ConflictException)) throw error;
                throw new ConflictException(
                  `task ${uuidToBase62(id)} has a live run, so it cannot be moved to another ` +
                    'project — the run, the action that started it and both projects\' capacity ' +
                    'counts all belong to the project it is in. Move it once that run has reached ' +
                    'a terminal status of its own',
                );
              });
            }
            if (dto.projectId !== undefined) {
              const projectAfter = dto.projectId ?? null;
              const stranded = await tx.task.findMany({
                where: {
                  ownerId,
                  supersededByTaskId: id,
                  NOT: { projectId: projectAfter },
                },
                select: { id: true, projectId: true },
                orderBy: { id: 'asc' },
              });
              if (stranded.length > 0) {
                throw new BadRequestException(
                  `task ${uuidToBase62(id)} is the successor of ` +
                    `${stranded.map((row) => uuidToBase62(row.id)).join(', ')}, and a successor ` +
                    'must stay in the same project as the attempt it replaced — a replacement in ' +
                    'another project is work towards a different goal, which no acceptance read ' +
                    "could count. Unlink or re-point those attempts first (task_update " +
                    '--clear-superseded), then move this one',
                );
              }
            }
            if (dependsOnTaskIds?.length) {
              const edges = await tx.taskDependency.findMany({
                where: { task: { ownerId } },
                select: { taskId: true, dependsOnTaskId: true },
              });
              if (wouldReplacementCreateCycle(edges, id, dependsOnTaskIds)) {
                throw new BadRequestException('These dependencies would create a cycle');
              }
            }
            // WHICH SIDE of the status write this goes on is not a style choice: one PATCH
            // routinely does both, and 0128's trigger judges every statement on its own.
            //
            //   linking   → cancel first, then link. Linking a task that is still OPEN is refused,
            //               so the status has to have moved already.
            //   unlinking → unlink first, then reopen. Reopening a task that still names a
            //               successor is refused, so the link has to be gone already.
            //
            // Either order taken for both cases leaves one legal request failing on an
            // intermediate state that no committed row would ever have held.
            const writeSupersession = async () => {
              if (!supersession) return;
              // §13.6 SU8, the same fence `linkSupersededBy` takes and for the same reason: this is
              // the OTHER public door onto the link, and a rule enforced at one door is a rule with
              // a way round it.
              //
              // Scoped to the FIRST RETIREMENT TRANSITION, exactly as 0130's trigger is: a task
              // that was already retired is not being taken away from anybody by a re-point, a
              // restatement, or a successor the FK cleared — and since a person is deliberately
              // allowed to open a USER session on a retired attempt to read or salvage it, checking
              // those would let that session block the correction. Un-retiring is never checked
              // either; refusing it because a session is running would make a mistake permanent.
              //
              // The row lock is ALREADY held — taken NOWAIT right after the project prelock, before
              // the Prisma UPDATE above could wait on it. Re-taking it here would be a second
              // acquisition of a lock this transaction owns: harmless, and a place for the two
              // spellings to drift apart. The live-session CHECK below is the part scoped to a
              // first retirement.
              const retiredBefore = taskRetirement(before) != null;
              if (!retiredBefore && supersession.reason != null) {
                await this.assertNotRunningBeforeRetiring(tx, ownerId, id);
              }
              await tx.$executeRaw`
                UPDATE "task"
                   SET "superseded_by_task_id" = ${supersession.successorId}::uuid,
                       "superseded_at"         = ${supersession.at},
                       "terminal_reason"       = ${supersession.reason}
                 WHERE "id" = ${id}::uuid`;
            };
            // WHICH SIDE of the status write this goes on is decided by the retirement this PATCH
            // is LEAVING BEHIND, not by whether a successor is named. Keying it on the successor
            // was wrong for the shape that has a reason and no pointer: one legal PATCH saying
            // `{status: CANCELLED, terminalReason: ABANDONED}` has a null successor, so it took the
            // unlink order and wrote ABANDONED onto a row that was still OPEN — which 0130's
            // `task_retirement_status_check` refuses, per statement, before the status write that
            // would have made it legal arrives.
            //
            //   retiring   → status first, then the three columns. A retirement on a non-terminal
            //                row is refused, so the status has to have moved already.
            //   un-retiring→ the three columns first, then the status. Reopening a row that still
            //                claims to be retired is refused, so the claim has to be gone already.
            const retiresAfter = supersession != null
              && (supersession.reason != null || supersession.successorId != null);
            if (supersession && !retiresAfter) await writeSupersession();
            // Delete before re-inserting so a retained prerequisite cannot collide with the
            // (taskId, dependsOnTaskId) unique key. The transaction keeps the scalar update and
            // full dependency replacement atomic; [] intentionally stops after the delete.
            let task = await tx.task.update({ where: { id }, data });
            if (retiresAfter) {
              await writeSupersession();
              task = await tx.task.findUniqueOrThrow({ where: { id } });
            }
            if (dependsOnTaskIds !== undefined) {
              await tx.taskDependency.deleteMany({ where: { taskId: id } });
              if (dependsOnTaskIds.length) {
                await tx.taskDependency.createMany({
                  data: dependsOnTaskIds.map((dependsOnTaskId) => ({ taskId: id, dependsOnTaskId })),
                });
              }
            }
            return task;
          }, this.transientWriteRetry('tasks.update'))
    // Both branches share one translation: a project deleted between this request's check and its
    // write is the caller's race to hear about, not a server fault (see translateProjectFk). Only
    // an update that named a project can be relabelled, so every other FK failure is untouched.
    ).catch(async (e) => {
      // One of 0130's typed fences — a project being reconciled, a task being written, work that
      // has been replaced. Each has a name, a cause and a remedy, and each would otherwise reach
      // the caller as a 500. Anything this does not recognise is rethrown untouched.
      const fenced = taskFenceConflictMessage(e);
      if (fenced) throw new ConflictException(fenced);
      throw await this.translateProjectFk(e, ownerId, [dto.projectId]);
    });
    // A dependency replacement may target a web-created task, which has no creator session to
    // carry the refresh. Publish it on the owner's stream so Workspace/MCP and CLI replacements
    // refresh an already-open DAG immediately. Scalar-only updates keep their existing
    // session-scoped event (and its workspace context).
    if (dependsOnTaskIds !== undefined) {
      this.realtime.publishForUser(ownerId, RunEventType.TASK_CHANGED, id);
    } else if (before.creatorSessionId) {
      this.realtime.publishTaskChanged(before.creatorSessionId, id);
    }
    // This is the dependency trigger point: "A 完成" is anchored on Task.status === DONE
    // (both the user PATCH and the workspace's task_update MCP flow through here). On the
    // transition into DONE, release & auto-run any now-ready dependents. Best-effort: a
    // trigger failure must never fail the status write that caused it.
    if (dto.status === TaskStatus.DONE && before.status !== 'DONE') {
      await this.triggerDependents(ownerId, id).catch((e) =>
        this.logger.warn(`triggerDependents failed for task ${id}: ${e?.message ?? e}`),
      );
      // Second opinion on the claim just made. Best-effort for the same reason as above: a task
      // that reports itself done has done so, and failing that write because we could not file a
      // check would lose the report to protect the audit of it.
      await this.fileVerification(ownerId, id).catch((e) =>
        this.logger.warn(`verification dispatch for task ${id} failed: ${e?.message ?? e}`),
      );
    }
    // The other direction: something that reported itself finished has been put back. That is the
    // verifier's rejection path (it has no verdict API — it just moves the task, deliberately),
    // but a human does it the same way and `update` carries no actor, so the note states the
    // observation and lets the reader infer the cause from the verification count rather than
    // asserting one. Either way it is a campaign's most consequential silent change: this
    // deployment reverted six tasks in one afternoon and nothing anywhere said so.
    // Every input to §13.1 that this write could have moved: the task's own status, the policy
    // that reads its children, the verdict its subject's parent may be waiting on, and either end
    // of a re-parenting. Seeded with the task itself as well as its links, because the task can be
    // a parent, a child, a verifier and a subject at once and the closure starts from all of them.
    const movesAggregationInput =
      dto.status !== undefined ||
      dto.completionPolicy !== undefined ||
      dto.verdict !== undefined ||
      dto.parentTaskId !== undefined ||
      dto.verifiesTaskId !== undefined ||
      // §13.6 SU6 made these two inputs to §13.1: a retired child settles like a cancelled one and
      // a retired verifier stops being an outstanding check. So linking or unlinking a supersession
      // changes what its parent's status is allowed to claim, exactly as writing `status` does —
      // and a PATCH that ONLY links (the common shape: the successor already exists, somebody is
      // recording the relation afterwards) would otherwise leave the parent asserting the old
      // answer until some unrelated write happened to recompute it.
      dto.supersededByTaskId !== undefined ||
      dto.terminalReason !== undefined;
    if (movesAggregationInput) {
      await this.recomputeAggregates(
        ownerId,
        [
          id,
          before.parentTaskId,
          before.verifiesTaskId,
          dto.parentTaskId,
          verifiesTaskId,
          // §13.6 SU9: both ends of the supersession edge this write may have moved. The closure
          // walks the chain from a seed, so seeding the predecessor as well as the successor is
          // what makes a parent at the START of a chain recompute when a link at its END changes.
          before.supersededByTaskId,
          dto.supersededByTaskId ?? undefined,
        ].filter((taskId): taskId is string => !!taskId),
      ).catch((e) => this.logger.warn(`aggregation after update of ${id} failed: ${e?.message ?? e}`));
    }
    if (before.status === 'DONE' && dto.status !== undefined && dto.status !== TaskStatus.DONE && before.listId) {
      const checks = await this.prisma.task.count({ where: { verifiesTaskId: id } });
      // The id is encoded where it becomes prose. This detail is stored and replayed to agents,
      // and `PublicIdInterceptor` rewrites response *fields* only, so an id spelled here as the
      // raw uuid is one no reader can hand back to `task_get` / `task_update` — the id is the
      // only part of the note that says *which* completion was reverted. The count above and the
      // list this is filed under stay uuids: those are lookups, not text.
      await this.recordListEvent(
        before.listId,
        'completion_reverted',
        `任务「${before.title}」(${uuidToBase62(id)}) 从 DONE 被退回 ${dto.status}` +
          (checks > 0 ? `，此前有 ${checks} 次验收记录` : '，此前没有验收记录'),
      );
    }
    return updated;
  }

  /**
   * File a run that checks whether `taskId` actually did what it says it did.
   *
   * Asynchronous, and it does not gate the DONE it follows: the task genuinely reported itself
   * finished, and a verification is a second opinion, not a precondition. A rejected check puts
   * the subject back to IN_PROGRESS through the ordinary task_update the verifier already has —
   * no separate verdict API, and the rejection is a normal, readable task event.
   *
   * Skipped for the tasks that would make it recursive or pointless: a verification run itself, a
   * foreman, a task whose list has not opted in, and one that has already been checked
   * MAX_VERIFICATIONS_PER_TASK times.
   */
  private async fileVerification(ownerId: string, taskId: string): Promise<void> {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, ownerId },
      select: {
        id: true,
        title: true,
        listId: true,
        projectId: true,
        isForeman: true,
        verifiesTaskId: true,
        list: { select: { verifyOnDone: true } },
        assignee: { select: { id: true, runnerId: true, deletedAt: true } },
      },
    });
    // A verification of a verification has nothing left to check, and a foreman's output is a
    // diagnosis rather than a unit of work with an acceptance criterion.
    if (!task || task.isForeman || task.verifiesTaskId) return;
    // A runner-bound assignee that still exists. `deletedAt` matters as much as `runnerId`:
    // sessions.create refuses a soft-deleted workspace, so filing here would leave an OPEN task
    // that can never run and reads as pending work forever. Six of those were filed against a
    // workspace deleted in August before this check existed.
    if (!task.assignee?.runnerId || task.assignee.deletedAt) return;
    // Did anything actually run? `numTurns > 0` and not "has a SUCCEEDED session": at the moment
    // an agent writes DONE its own session is still RUNNING, so success is not yet recorded —
    // but its turns are. The task that motivated all of this had 18 sessions and numTurns 0 on
    // every one of them, and a comment claiming acceptance had passed.
    const executed = await this.prisma.session.count({
      where: {
        taskId,
        // A run in flight counts as evidence. `numTurns` is incremented when a turn *ends*, and a
        // task is almost always marked DONE by the agent from inside the turn doing the work — so
        // at this instant the run that just did it still reads zero, and a task that genuinely
        // executed is indistinguishable from one that never did.
        //
        // Without this, every task completing in its first turn earns a verification regardless of
        // the opt-in. Reproduced directly: a run with five turns behind it, in a list with
        // verifyOnDone off, still had one filed. It had not yet bitten in production only because
        // every DONE task here so far was genuinely unevidenced — all twenty verifications on
        // record correctly caught completions with no run behind them, which is the case this
        // branch deliberately checks without asking.
        OR: [{ numTurns: { gt: 0 } }, { status: RunStatus.RUNNING }],
      },
    });
    const unevidenced = executed === 0;
    // The opt-in governs checking work that demonstrably happened — that is the expensive case,
    // because it doubles a list's runs. A completion with no execution behind it is neither
    // expensive nor ambiguous: it is 1.3% of this deployment's DONE tasks (8 of 621), and there
    // is no run to double. Requiring opt-in for it would mean the one case nobody would decline
    // is the one that needs asking for.
    if (!unevidenced && !task.list?.verifyOnDone) return;
    // Cancelled checks don't count. The cap exists to stop verify → reject → re-DONE → verify
    // from looping, and a cancelled verification issued no verdict, so it rejected nothing and is
    // not part of any loop. Counting it spends a budget it never used — the same reason a
    // quota-killed run does not spend the auto-run budget. In-flight ones still count, which is
    // what keeps two from being filed for the same subject at once.
    const already = await this.prisma.task.count({
      where: { verifiesTaskId: taskId, status: { not: TaskStatus.CANCELLED } },
    });
    if (already >= MAX_VERIFICATIONS_PER_TASK) {
      this.logger.log(
        `verification skipped for task ${taskId} — already checked ${already} time(s)`,
      );
      return;
    }
    const verification = await this.prisma.task.create({
      data: {
        title: `[VERIFY] ${task.title}`.slice(0, 200),
        description: this.buildVerificationBrief(task.title, taskId, unevidenced),
        ownerId,
        listId: task.listId,
        // The subject's project, not none. A check filed outside its subject's project is one
        // `GET /projects/:id/verifications` cannot see (it filters on the column) and one
        // `VERIFICATION_PASSED` cannot count — the same rule the deliberate door enforces, which
        // this path was quietly breaking for every project task it ever checked.
        projectId: task.projectId,
        assigneeId: task.assignee.id,
        verifiesTaskId: taskId,
        // Dispatched by the DONE it follows, not by a prerequisite reaching DONE.
        autoRunWhenReady: false,
        creatorType: CreatorType.USER,
        creatorId: ownerId,
      },
      select: { id: true },
    });
    // The one run this check exists for. A retry of the filing above makes a DIFFERENT task, so
    // "the first run of this task, at the moment it was filed" names exactly one request for as
    // long as the row exists.
    await this.execute(
      ownerId,
      verification.id,
      undefined,
      TASK_RUN_TRIGGER.firstRun(verification.id, await this.dispatchEpochOf(verification.id)),
    );
    this.logger.log(`verification ${verification.id} filed for task ${taskId}`);
  }

  /**
   * The verifier's brief.
   *
   * It leads with the evidence check because that is the one that has actually caught something
   * here: a task in this deployment was marked done with a comment claiming acceptance had
   * passed, while all 18 of its runs had failed without executing a turn. Asking "is there any
   * trace of this work happening" is cheap, and it is a different question from "is the work
   * correct" — worth asking first, because a no makes the second question moot.
   *
   * It is told to reject by putting the subject back to IN_PROGRESS, which is the state a failed
   * run already lands on, so a rejected task rejoins the normal flow instead of needing one of
   * its own.
   *
   * The id it carries is spelled base62, the same as the `id` the verifier gets back from
   * `task_get` — and the same one it has to pass to `task_comment` and `task_update` to land its
   * verdict on the subject. Prose is the one boundary `PublicIdInterceptor` cannot reach, since
   * it rewrites response *fields* and a description is not one, so the encode happens here, where
   * the id becomes text.
   */
  private buildVerificationBrief(title: string, taskId: string, unevidenced = false): string {
    return (
      `任务「${title}」（id: ${uuidToBase62(taskId)}）刚刚被标记为 DONE。请独立核实它是否真的完成了，然后结束本次运行。\n\n` +
      (unevidenced
        ? `⚠️ 系统已先行检查：该任务**没有任何一次运行执行过哪怕一个 turn**。这说明"完成"背后没有执行记录支撑，` +
          `是很强的存疑信号——但它不是结论，请照下面的顺序查完再判。\n\n`
        : '') +
      `这是一次性的验收任务，不要替它把活干了，也不要长时间运行或轮询。\n\n` +
      `请按以下顺序核实：\n` +
      `1. 先看「有没有干过的证据」：用 task_get 读该任务的运行记录与评论。没有成功运行记录是重要的存疑信号，` +
      `它意味着**评论里的自述一律不可采信**，但它本身不构成结论——运行记录只是证据的一种，不是唯一一种。\n` +
      `2. 再看「产物在不在、对不对」：对照任务描述里的验收标准，亲自检查实际产物（文件是否存在、大小/校验和是否吻合、` +
      `命令输出、提交等）。**只要声称的完成是可以独立核验的（例如给了文件路径、字节数、SHA-256、命令），就必须亲自去验，** ` +
      `不要因为第 1 步存疑就跳过——确立事实往往只差一条命令，而这正是验收存在的意义。\n` +
      `3. 综合判断：产物齐备且符合验收标准 → 通过（即使没有运行记录，也要在结论里写明证据是你亲自核验的，` +
      `并指出运行记录缺失这一异常）；产物缺失、不符，或根本无从核验 → 不通过。\n\n` +
      `结论处理：\n` +
      `- 通过：用 task_comment 在**该任务**下写明你核实了什么、依据是什么，然后把**本验收任务**置为 DONE。\n` +
      `- 不通过：用 task_comment 在**该任务**下写清缺什么、证据是什么，用 task_update 把**该任务**状态改回 IN_PROGRESS，` +
      `再把**本验收任务**置为 DONE。\n\n` +
      `注意区分两个任务：核实结论写在被验收的任务上，状态回退也改它；本验收任务无论结论如何都应置为 DONE。`
    );
  }

  /**
   * WHICH MOMENT this task is at right now — `task_dispatch_epoch.epoch` (0137).
   *
   * The one-row read the doors that have no candidate scan need: the verification filer and the
   * foreman create a task in order to run it once, immediately, so there is no sweep query to ride
   * on. Both call it on a row they have just created, which is at the epoch its seed trigger gave
   * it; the read is what makes that a fact this code took from the database rather than a constant
   * it assumed, so a task ever filed for a first run at a later moment names a different request.
   *
   * The three sweeps do NOT call this — they join the epoch into the statement that selects their
   * candidates, so the epoch they carry is the one every clause of their predicate was evaluated
   * against. A second read would be a second snapshot, and the fence would then be comparing two
   * different instants rather than proving one.
   */
  private async dispatchEpochOf(taskId: string): Promise<bigint> {
    const [row] = await this.prisma.$queryRaw<Array<{ epoch: bigint }>>`
      SELECT "epoch" FROM "task_dispatch_epoch" WHERE "task_id" = ${taskId}::uuid`;
    return row?.epoch ?? 0n;
  }

  /**
   * A prerequisite (`doneTaskId`) just reached DONE: find every task that depends on it
   * and auto-run the ones this completion unblocked. A dependent fires only when it is
   * now fully READY (all its prerequisites DONE), still actionable (OPEN), opted into
   * auto-run, and has an assignee bound to a runner. Each run is best-effort and isolated
   * so one failure doesn't stop the others. Downstream chains flow naturally: the workspace
   * marking that dependent DONE re-enters update() and triggers the next layer.
   */
  private async triggerDependents(ownerId: string, doneTaskId: string): Promise<void> {
    const edges = await this.prisma.taskDependency.findMany({
      where: { dependsOnTaskId: doneTaskId },
      select: { taskId: true },
    });
    const dependentIds = [...new Set(edges.map((e) => e.taskId))];
    if (!dependentIds.length) return;
    const states = await this.dependencyStatesFor(ownerId, dependentIds);
    const dependents = await this.prisma.task.findMany({
      where: { id: { in: dependentIds }, ownerId },
      select: {
        id: true,
        status: true,
        autoRunWhenReady: true,
        runAt: true,
        assignee: { select: { id: true, runnerId: true } },
        // The moment this unlock IS (0137), read here because it is what NAMES this dispatch: two
        // passes — a second apiserver, or this one after a restart — over the same moment are one
        // request, and the Session they race for carries the id both of them derive. Read in the
        // same statement as `status` and `runAt`, so the epoch is the one those values are at: the
        // prerequisite's own DONE advanced it in the transaction that committed that status, and
        // whatever moves either of them next advances it again. It is always present (the row is
        // created with the task).
        dispatchEpoch: { select: { epoch: true } },
      },
    });
    const now = new Date();
    for (const dep of dependents) {
      if ((states.get(dep.id) ?? 'NONE') !== 'READY') continue;
      if (dep.status !== 'OPEN') continue; // already running/done/cancelled — leave it
      if (!dep.autoRunWhenReady) continue; // gate kept, manual trigger only
      // Scheduled for later: being ready is not permission to start early. The schedule is kept,
      // not consumed — dispatchDueScheduledTasks picks the task up once it comes due, and by then
      // this same READY state is one of the things it re-checks. Two independent triggers, and
      // the later of the two is the one that fires.
      if (dep.runAt && dep.runAt > now) continue;
      if (!dep.assignee?.runnerId) continue; // nothing to run it on — stays ready for later
      const epoch = dep.dispatchEpoch?.epoch ?? 0n;
      try {
        // Carrying WHICH MOMENT this scan read, so `execute` can prove it is still acting on it:
        // between here and its own re-read the user may have scheduled this task for later, or the
        // prerequisite may have reopened, and either replaces the reason this loop had for starting
        // it. Both advance the epoch, so both are one comparison rather than a value check per fact.
        await this.execute(
          ownerId,
          dep.id,
          { observedEpoch: epoch },
          TASK_RUN_TRIGGER.dependency(dep.id, epoch),
        );
      } catch (e) {
        this.logger.warn(
          `auto-run of dependent task ${dep.id} failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  }

  /**
   * Periodic backstop for the auto-run edge triggerDependents can miss. triggerDependents
   * fires only at the instant a prerequisite reaches DONE, so a dependent that is READY
   * then but not yet runnable — no assignee, its assignee's runner offline, or a transient
   * execute() failure — is left OPEN and never revisited. This pass re-dispatches any task
   * that has since become genuinely runnable: OPEN, opted into auto-run, all prerequisites
   * DONE (READY — it therefore HAS prerequisites; a task with none is never auto-run), its
   * assignee bound to a runner, and not already occupied by a live/queued session.
   *
   * Repeating the pass is only safe while something stops a *terminated* run from making its
   * task a candidate again: execute()'s session dedup covers a run still in flight, but the
   * moment one ends the task matches again a minute later. The quota gate and the failure
   * backoff below are what bound that — without them this is an unbounded respawn loop.
   */
  private async reconcileReadyTasks(): Promise<void> {
    // AUTO_RUN_READY_SQL resolves READY database-side — the task HAS prerequisites and none of
    // them is unfinished, the same predicate as computeDependencyState's READY, so BLOCKED and
    // BLOCKED_FAILED alike drop out. Filtering in SQL rather than in memory is what keeps this
    // sweep proportional to the work: a backlog is overwhelmingly BLOCKED tasks waiting their
    // turn, and loading all of them (plus every one of their dependency edges) once a minute
    // only to discard them dwarfs the dispatch it exists to do.
    // freeBytes/minFreeDiskMb ride along on the joins this scan already needs, so the disk gate
    // below costs no extra round trip. They arrive as bigint (BIGINT column) and number.
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        ownerId: string;
        workspaceId: string;
        runnerId: string | null;
        freeBytes: bigint | null;
        minFreeDiskMb: number | null;
        listId: string | null;
        dispatchEpoch: bigint | null;
      }[]
    >`
      SELECT t.id, t.owner_id AS "ownerId", a.id AS "workspaceId", a.runner_id AS "runnerId",
             a.work_dir_free_bytes AS "freeBytes", r.min_free_disk_mb AS "minFreeDiskMb",
             t.list_id AS "listId", e.epoch AS "dispatchEpoch"
      FROM task t
      LEFT JOIN workspace a ON a.id = t.assignee_id
      LEFT JOIN runner r ON r.id = a.runner_id
      -- 0137's dispatch epoch, joined here because it NAMES this sweep's dispatch and fences it:
      -- two passes over the same moment are one request and derive the same Session id, and a pass
      -- whose moment has been overtaken between this scan and the dispatch is told so rather than
      -- starting work for it. Read in the SAME statement as the predicate below, so the epoch is
      -- the one every clause of AUTO_RUN_READY_SQL was evaluated against — a snapshot, not two.
      -- Riding on this scan rather than a second round trip.
      LEFT JOIN task_dispatch_epoch e ON e.task_id = t.id
      WHERE ${AUTO_RUN_READY_SQL}`;
    if (rows.length === 0) return;
    // The provider is no longer a column on the workspace (migration 0088) — it is derived from the
    // project's last interactive session. One batched lookup for the whole sweep rather than a
    // correlated subquery per row, and going through the shared helper is what keeps this gate's
    // notion of "which provider will this run use" identical to the one dispatch itself applies.
    // Only the READY tasks reach here, so this stays proportional to the work, like the filter above.
    const seeds = await lastProviderByWorkspace(
      this.prisma,
      rows.map((row) => row.workspaceId),
    );
    // Re-nest into the shape the quota gate and the dispatch loop below read. The join above
    // can only match (the predicate requires an assignee with a runner), so assignee is never
    // null here — unlike the Prisma `select` this replaced, which typed it as nullable.
    const ready = rows.map((row) => ({
      id: row.id,
      ownerId: row.ownerId,
      assignee: {
        provider: (seeds.get(row.workspaceId) ?? DEFAULT_AGENT_PROVIDER).provider,
        runnerId: row.runnerId,
      },
      diskShort: diskBelowFloor(row.freeBytes, row.minFreeDiskMb),
      listId: row.listId,
      // Read here so the dispatch below can prove it is still acting on this row. Scheduling a
      // previously unscheduled task is the commonest way for this scan to be overtaken, and it is
      // one of the transitions that advances this counter — so is the task reopening, and so is any
      // prerequisite's status moving. One number, compared once, rather than a value per fact.
      dispatchEpoch: row.dispatchEpoch ?? 0n,
    }));
    // Two independent brakes. The quota gate comes first because it is the one that knows
    // *when* work can resume, and it prevents the doomed run rather than reacting to it.
    const { blocked: quotaBlocked, blind: quotaBlind } = await this.quotaGate(ready);
    // Don't re-dispatch a task whose runs keep failing (see AUTO_RUN_RETRY_BACKOFF_MS). Tasks
    // on a runner reporting no quota at all are named so the backoff can damp a usage limit
    // the gate above had no reset time to hold on.
    const blindTaskIds = new Set(
      ready
        .filter((t) => {
          const runnerId = t.assignee?.runnerId;
          return !!runnerId && quotaBlind.has(`${runnerId}:${t.assignee.provider}`);
        })
        .map((t) => t.id),
    );
    const heldOff = await this.autoRunHoldOff(
      ready.map((t) => t.id),
      blindTaskIds,
    );
    // How many more sessions it is worth materialising, per runner and per capped list.
    //
    // Deliberately a different question from the claim's `runnerActiveTurns`, and counted
    // differently: the claim asks "may this run now" and so counts only RUNNING, because an idle
    // resumable session holds no slot. This asks "is there any point creating another", and a
    // PENDING session is already queued for the next free slot — so it counts too. Materialising
    // past that produces rows that cannot be claimed and simply wait.
    //
    // Without this the sweep dispatched every ready task in one pass, and the cap only bit at
    // claim time: a released campaign turned into one PENDING session per task — ~10 KB each,
    // indistinguishable from real work in every session-scoped view — waiting on a cap that
    // permits one at a time.
    const budget = await this.materialisationBudget();
    let quotaHeld = 0;
    let diskHeld = 0;
    let atCapacity = 0;
    let overtaken = 0;
    let resumesAt: Date | undefined;
    // Per list as well as in total. The aggregate below answers "is the fleet moving"; a list's
    // own console needs "is MY campaign moving", and one spent provider quota holds back every
    // list assigned to that runner at once.
    const perList = new Map<string, { quota: number; disk: number; resumesAt?: Date }>();
    const holdFor = (listId: string | null) => {
      if (!listId) return null;
      let e = perList.get(listId);
      if (!e) perList.set(listId, (e = { quota: 0, disk: 0 }));
      return e;
    };
    for (const t of ready) {
      const blockedUntil = t.assignee?.runnerId
        ? quotaBlocked.get(`${t.assignee.runnerId}:${t.assignee.provider}`)
        : undefined;
      if (blockedUntil) {
        quotaHeld += 1;
        if (!resumesAt || blockedUntil < resumesAt) resumesAt = blockedUntil;
        const e = holdFor(t.listId);
        if (e) {
          e.quota += 1;
          if (!e.resumesAt || blockedUntil < e.resumesAt) e.resumesAt = blockedUntil;
        }
        continue;
      }
      // Disk is checked before the failure backoff for the same reason quota is: it prevents a
      // doomed run rather than reacting to one. Unlike quota it has no reset time to report —
      // space comes back when somebody frees it — so the hold simply lifts on the sweep after
      // the runner's next heartbeat reports headroom again.
      if (t.diskShort) {
        diskHeld += 1;
        const e = holdFor(t.listId);
        if (e) e.disk += 1;
        continue;
      }
      if (heldOff.has(t.id)) continue;
      // Nothing left to claim it: leave the task OPEN and pick it up on a later sweep. The task
      // table is already the durable queue — it carries the assignee, the provider and the
      // description — so a second copy of it in `session` buys nothing until a slot exists.
      if (!takeBudget(budget, t.assignee.runnerId!, t.listId)) {
        atCapacity += 1;
        continue;
      }
      try {
        const res = await this.execute(
          t.ownerId,
          t.id,
          { observedEpoch: t.dispatchEpoch },
          TASK_RUN_TRIGGER.dependency(t.id, t.dispatchEpoch),
        );
        // A task overtaken out from under this pass is not dispatched and must not be logged as
        // though it were; the budget it spent is returned by the next sweep reading capacity afresh.
        if (res.ok) this.logger.log(`reconciled ready task ${t.id} -> auto-run`);
        else overtaken += 1;
      } catch (e) {
        this.logger.warn(
          `reconcile auto-run of task ${t.id} failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    // One aggregate line per sweep, not one per task: a spent quota holds back whole fleets,
    // and "why is nothing running" needs an answer somewhere.
    if (quotaHeld > 0) {
      this.logger.log(
        `auto-run: ${quotaHeld} ready task(s) held — provider quota exhausted, earliest reset ${resumesAt?.toISOString()}`,
      );
    }
    if (diskHeld > 0) {
      this.logger.log(
        `auto-run: ${diskHeld} ready task(s) held — free disk below the runner's floor`,
      );
    }
    if (atCapacity > 0) {
      // Not a fault: the work is queued in the table it already lives in, and the next sweep
      // dispatches whatever finished in between.
      this.logger.log(
        `auto-run: ${atCapacity} ready task(s) left for a later sweep — no free slot to claim them`,
      );
    }
    if (overtaken > 0) {
      // The moment this pass selected them under is gone — rescheduled, reopened, a prerequisite
      // moved. Not a fault and not a retry: the pass that reads the NEW moment is the one that
      // decides what happens next, and each of these stood down without touching anything.
      this.logger.log(
        `auto-run: ${overtaken} ready task(s) were overtaken mid-sweep — the moment they were ` +
          'selected under has passed',
      );
    }
    for (const [listId, e] of perList) {
      if (e.quota > 0) {
        await this.recordListEvent(
          listId,
          'quota_hold',
          `${e.quota} 个就绪任务被配额挡住` +
            (e.resumesAt ? `，最早 ${e.resumesAt.toISOString()} 恢复` : '，没有拿到恢复时间'),
        );
      }
      if (e.disk > 0) {
        await this.recordListEvent(
          listId,
          'disk_hold',
          `${e.disk} 个就绪任务被磁盘下限挡住 —— 空间要由人来腾，不会自己恢复`,
        );
      }
    }
  }

  /**
   * Start the tasks whose scheduled time has arrived.
   *
   * The whole of the scheduling feature's runtime: a task carries an optional `run_at`, and this
   * is what reads it. Everything a run needs to be correct — which workspace, which
   * provider/model, whether its prerequisites are finished, whether its list is paused, whether
   * something is already running it, whether the runner has a slot — is decided by the code that
   * already decides it, because this dispatches through {@link execute} rather than creating a
   * session itself. A second way to start a task is a second set of rules to keep in step, and
   * the schedule is a trigger, not an execution model.
   *
   * At-least-once, and it has to be: a schedule that is due but cannot run right now — nothing
   * assigned, its list paused, a prerequisite still open — is skipped by the predicate WITHOUT
   * being consumed, so the next sweep reconsiders it. Missing the moment must not lose the
   * appointment; the appointment says "not before", not "then or never". What stops that from
   * becoming a repeat is the consumption on the other side: the first accepted run clears
   * `run_at`, and the task leaves the candidate set for good.
   *
   * The double-dispatch this leaves possible — this sweep and the auto-run sweep both finding the
   * same due, ready task — is absorbed where every other duplicate trigger in this service already
   * is, by the run doors' own session dedup (`planWorkspaceRun`). Both sweeps also ride the same timer, sequentially,
   * so in practice the second one runs after the first has already taken the task out of scope.
   */
  private async dispatchDueScheduledTasks(): Promise<void> {
    // Ordered by when they came due, so a sweep that cannot dispatch everything takes the
    // longest-overdue work first rather than an arbitrary slice; `id` only breaks ties, so the
    // order is total and the same list twice in a row means the same decisions twice in a row.
    const due = await this.prisma.$queryRaw<
      {
        id: string; ownerId: string; runnerId: string; listId: string | null;
        dispatchEpoch: bigint | null;
      }[]
    >`
      SELECT t.id, t.owner_id AS "ownerId", a.runner_id AS "runnerId", t.list_id AS "listId",
             e.epoch AS "dispatchEpoch"
      FROM task t
      JOIN workspace a ON a.id = t.assignee_id
      -- 0137's dispatch epoch: WHICH appointment this pass is keeping. Not the run_at instant,
      -- which comes back — 09:00 -> 10:00 -> 09:00 is a second, legitimate appointment that would
      -- re-derive the first one's name and be answered with the first one's Session (§7.7 D5-b4).
      -- The epoch is advanced by every write to run_at, including the consumption a kept
      -- appointment performs, so each appointment is its own moment and no moment repeats.
      LEFT JOIN task_dispatch_epoch e ON e.task_id = t.id
      WHERE ${SCHEDULED_DUE_SQL}
      ORDER BY t.run_at ASC, t.id ASC
      LIMIT ${SCHEDULED_DISPATCH_MAX_PER_SWEEP}`;
    if (due.length === 0) return;
    // Only now — the query above is one partial-index scan that finds nothing on almost every
    // sweep, and a deployment with no schedules should pay for exactly that and no more.
    const budget = await this.materialisationBudget();
    let dispatched = 0;
    let atCapacity = 0;
    let overtaken = 0;
    for (const t of due) {
      // The same brake the auto-run sweep takes, for the same reason: materialising past what the
      // runner can claim produces sessions that sit PENDING and buy nothing. Here it is also what
      // makes "left for a later sweep" true rather than a hope — the task keeps its `run_at`, so
      // it is still due, and the sweep that finds a free slot is the one that starts it.
      if (!takeBudget(budget, t.runnerId, t.listId)) {
        atCapacity += 1;
        continue;
      }
      const epoch = t.dispatchEpoch ?? 0n;
      try {
        // The appointment this pass is keeping, carried so the dispatch can check it is still the
        // one on the row. A user who moves a due task to next week between the scan and here has
        // replaced the reason this loop had for starting it, and the sweep stands down: it starts
        // nothing, consumes nothing, and the new schedule is left to fire on its own.
        const res = await this.execute(
          t.ownerId,
          t.id,
          { observedEpoch: epoch },
          // The appointment being kept, and it names the request: two passes over the same moment
          // are one dispatch, and the run this pass keeps consumes `run_at` back to NULL — which
          // advances the epoch, so the next appointment is a different name that this one cannot be
          // replayed into, and an older pass's name is one no future appointment can re-derive.
          TASK_RUN_TRIGGER.scheduled(t.id, epoch),
        );
        if (res.ok) dispatched += 1;
        else overtaken += 1;
      } catch (e) {
        // The schedule is untouched on this path (execute consumes it only after a run is away),
        // so the next sweep tries again. Warn rather than error: a task whose runner went offline
        // between the scan and the dispatch is an ordinary race, not a fault.
        this.logger.warn(
          `scheduled run of task ${t.id} failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    if (dispatched > 0) this.logger.log(`scheduled: ${dispatched} due task(s) dispatched`);
    if (overtaken > 0) {
      // Worth a line of its own: "the schedule fired and nothing ran" is otherwise indistinguishable
      // from a bug, and this is the one case where it is the correct outcome.
      this.logger.log(
        `scheduled: ${overtaken} due task(s) were overtaken mid-sweep — the appointment they were ` +
          'selected under has been replaced',
      );
    }
    if (atCapacity > 0) {
      this.logger.log(
        `scheduled: ${atCapacity} due task(s) left for a later sweep — no free slot to claim them`,
      );
    }
  }

  /**
   * How many more sessions each runner and each capped list can usefully hold.
   *
   * Counts RUNNING and PENDING together — see the caller for why that differs from the claim's
   * own slot count. A runner or list absent from the returned map has no cap and is unbounded.
   *
   * One grouped query each rather than a count per task: a released campaign is tens of thousands
   * of rows, and the point of this is to stop doing work proportional to that.
   */
  private async materialisationBudget(): Promise<MaterialisationBudget> {
    const [runners, lists] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string; free: number }>>`
        SELECT r.id, r."max_concurrent" - count(s.id)::int AS free
        FROM "runner" r
        LEFT JOIN "session" s
          ON s."assigned_runner_id" = r.id AND s.status IN ('RUNNING', 'PENDING')
        GROUP BY r.id, r."max_concurrent"`,
      this.prisma.$queryRaw<Array<{ id: string; free: number }>>`
        SELECT tl.id, tl."max_concurrent" - count(s.id)::int AS free
        FROM "task_list" tl
        LEFT JOIN "session" s
          ON s."batch_id" = tl.id AND s.status IN ('RUNNING', 'PENDING')
        WHERE tl."max_concurrent" IS NOT NULL
        GROUP BY tl.id, tl."max_concurrent"`,
    ]);
    return {
      runner: new Map(runners.map((r) => [r.id, Number(r.free)])),
      list: new Map(lists.map((l) => [l.id, Number(l.free)])),
    };
  }

  /**
   * Note a condition about a list, or bump the one already noted.
   *
   * Upsert rather than insert: the sweep runs every 60s, so a four-hour quota outage is one
   * condition seen ~240 times. What a reader wants is the board — what is true now, since when,
   * how persistent — not 240 rows to page through.
   *
   * `deliveredAt` is deliberately left alone. Whether this needs re-reporting is decided by
   * comparing it against `lastSeenAt` at read time; clearing it here would re-announce a standing
   * outage on every single sweep.
   *
   * Best-effort by construction: this is a note for a human, and failing to write one must never
   * take down the sweep that was doing the actual work.
   */
  private async recordListEvent(listId: string, kind: string, detail: string): Promise<void> {
    try {
      await this.prisma.taskListEvent.upsert({
        where: { listId_kind: { listId, kind } },
        create: { listId, kind, detail },
        update: { detail, lastSeenAt: new Date(), occurrences: { increment: 1 } },
      });
    } catch (e) {
      this.logger.warn(
        `could not record ${kind} on list ${listId}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  /**
   * File a coordination task on every list that has gone quiet with work left in it.
   *
   * "Stalled" is deliberately the absence of activity rather than the presence of an error. A
   * wedged session still holding its task, a livelocked merge, a spent quota, a dependency that
   * will never complete — from outside they are indistinguishable, none of them raises anything,
   * and the auto-run sweep has nothing to say about any of them because none of their tasks is a
   * candidate. What they share is that work remained, nothing was running, and nothing had
   * started for a long time.
   *
   * The foreman is dispatched as an ordinary task, so it queues behind the same slots, obeys the
   * same quota and disk gates, and leaves the same audit trail as any other run. It is not a
   * process that watches the list; it is a run that happens once and ends, and if it dies the
   * condition simply still holds and the next sweep files another.
   */
  private async dispatchStalledListForemen(): Promise<void> {
    // Anchored on `foreman_workspace_id IS NOT NULL`, which is highly selective — the scan is
    // proportional to the lists that opted in, not to the task table.
    const stalled = await this.prisma.$queryRaw<
      { id: string; ownerId: string; title: string; workspaceId: string; minutes: number }[]
    >`
      SELECT tl.id, tl.owner_id AS "ownerId", tl.title,
             tl.foreman_workspace_id AS "workspaceId", tl.foreman_stall_minutes AS "minutes"
      FROM task_list tl
      WHERE tl.foreman_workspace_id IS NOT NULL
        AND tl.foreman_stall_minutes IS NOT NULL
        AND tl.paused = false
        -- Old enough to have been able to stall: a list created a minute ago whose tasks are all
        -- still blocked is starting up, not stuck.
        AND tl.created_at < now() - make_interval(mins => tl.foreman_stall_minutes)
        -- Work actually remains.
        AND EXISTS (
          SELECT 1 FROM task t
          WHERE t.list_id = tl.id AND t.status NOT IN ('DONE'::task_status, 'CANCELLED'::task_status)
        )
        -- Nothing is being worked. TASK_OCCUPYING, not just RUNNING: a session parked at
        -- AWAITING_INPUT is idle but alive, and calling that a stall would file a foreman over a
        -- run that is merely waiting for a human.
        AND NOT EXISTS (
          SELECT 1 FROM task t JOIN session s ON s.task_id = t.id
          WHERE t.list_id = tl.id
            AND s.status IN (${Prisma.join(
              TASK_OCCUPYING.map((status) => Prisma.sql`${status}::run_status`),
              ', ',
            )})
        )
        -- Nothing has started recently either, so this is quiet rather than merely between runs.
        AND NOT EXISTS (
          SELECT 1 FROM task t JOIN session s ON s.task_id = t.id
          WHERE t.list_id = tl.id
            AND s.created_at > now() - make_interval(mins => tl.foreman_stall_minutes)
        )
        -- One coordinator at a time. A stall persists by definition, so without this the sweep
        -- would file a fresh foreman every minute for as long as it lasted — the same unbounded
        -- respawn the auto-run reconciler had to be given a brake for.
        AND NOT EXISTS (
          SELECT 1 FROM task t
          WHERE t.list_id = tl.id AND t.is_foreman = true
            AND t.status NOT IN ('DONE'::task_status, 'CANCELLED'::task_status)
        )`;
    // How many foremen have already run for this stall, and when the last one did. "For this
    // stall" is anchored on the newest session of a NON-foreman task: anything a coordinator
    // actually got moving resets the count, so the escalation measures repeated failure to fix
    // rather than the list's age.
    const history = await this.foremanHistory(stalled.map((l) => l.id));
    const now = Date.now();
    let heldOff = 0;
    for (const list of stalled) {
      const prior = history.get(list.id);
      if (prior) {
        if (prior.count >= MAX_CONSECUTIVE_FOREMEN) {
          heldOff += 1;
          continue;
        }
        const since = now - prior.lastAt.getTime();
        if (since < FOREMAN_RETRY_BACKOFF_MS[prior.count - 1]) {
          heldOff += 1;
          continue;
        }
      }
      try {
        const task = await this.prisma.task.create({
          data: {
            title: `[FOREMAN] ${list.title} — 停滞 ${list.minutes} 分钟`.slice(0, 200),
            description: this.buildForemanBrief(list.title, list.minutes),
            ownerId: list.ownerId,
            listId: list.id,
            assigneeId: list.workspaceId,
            isForeman: true,
            // Nothing gates this run but the stall that caused it; it has no prerequisites, and
            // the auto-run sweep only ever considers tasks that do.
            autoRunWhenReady: false,
            creatorType: CreatorType.USER,
            creatorId: list.ownerId,
          },
          select: { id: true },
        });
        // As with a filed verification: this task was created in order to be run, once.
        await this.execute(
          list.ownerId,
          task.id,
          undefined,
          TASK_RUN_TRIGGER.firstRun(task.id, await this.dispatchEpochOf(task.id)),
        );
        this.logger.log(`foreman dispatched for stalled list ${list.id} (task ${task.id})`);
        // The id is encoded where it becomes prose. This detail is stored and replayed to agents
        // — `describeList` prints it verbatim beside the list's own base62 id — and
        // `PublicIdInterceptor` rewrites response *fields* only, so a raw uuid here is the one
        // part of the note nobody can hand back to `task_get`. The dispatch above, the log line
        // and the list this is filed under stay uuids: those are lookups, not text.
        await this.recordListEvent(
          list.id,
          'foreman_filed',
          `停滞约 ${list.minutes} 分钟，已自动派出协调任务 ${uuidToBase62(task.id)} 去诊断`,
        );
      } catch (e) {
        this.logger.warn(
          `foreman dispatch for list ${list.id} failed: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    if (heldOff > 0) {
      this.logger.log(
        `foreman: ${heldOff} stalled list(s) held — a previous coordinator did not clear the stall`,
      );
    }
  }

  /**
   * For each of these lists: how many foremen have run since anything else did, and when the
   * newest of them was filed.
   *
   * A foreman that ran and left the list still stalled is evidence the next one will too, so the
   * count drives an escalating hold rather than a fixed one. Anchoring on the newest session of a
   * non-foreman task is what makes it self-resetting: the moment real work runs again the list is
   * no longer failing to recover, and the next stall starts from the first backoff step.
   */
  private async foremanHistory(
    listIds: string[],
  ): Promise<Map<string, { count: number; lastAt: Date }>> {
    const out = new Map<string, { count: number; lastAt: Date }>();
    if (listIds.length === 0) return out;
    const rows = await this.prisma.$queryRaw<{ listId: string; count: bigint; lastAt: Date }[]>`
      SELECT ft.list_id AS "listId", count(*) AS "count", max(ft.created_at) AS "lastAt"
      FROM task ft
      WHERE ft.is_foreman = true
        AND ft.list_id = ANY(${listIds}::uuid[])
        AND ft.created_at > COALESCE(
          (SELECT max(s.created_at)
             FROM task wt JOIN session s ON s.task_id = wt.id
            WHERE wt.list_id = ft.list_id AND wt.is_foreman = false),
          '-infinity'::timestamp)
      GROUP BY ft.list_id`;
    for (const row of rows) out.set(row.listId, { count: Number(row.count), lastAt: row.lastAt });
    return out;
  }

  /**
   * The foreman's brief. Self-contained on purpose: it is read by an agent with no memory of the
   * list, and it names the tools rather than the conclusion — what stalled a list is exactly what
   * nobody knew in advance, so instructing it to "resume the downloads" would be guessing on its
   * behalf.
   */
  private buildForemanBrief(title: string, minutes: number): string {
    return (
      `任务列表「${title}」已停滞约 ${minutes} 分钟：仍有未完成的任务，但没有任何任务在运行，也没有新的运行被发起。\n\n` +
      `请诊断原因并处理，然后结束本次运行。这是一次性的协调任务，不要保持长时间运行或轮询。\n\n` +
      `建议的排查顺序：\n` +
      `1. 用 tasklist_get / task_list 查看该列表的任务状态分布，找出卡在哪一层。` +
      `**先看 failuresByCause**：它把已发生的失败按"真正坏了什么"归了类（quota / infrastructure / ` +
      `contentFilter / unattributed）。这几类没有一类是靠改作业指导能修的——先看归因，再决定动哪个杠杆，` +
      `不要一上来就怀疑 prompt 写得不好。\n` +
      `2. 常见原因：前置任务永远不会完成、负责的 workspace 未绑定 runner、provider 配额耗尽、磁盘低于下限、上一次运行的会话仍占着任务却已无进展。\n` +
      `3. 能在列表策略层面解决的（并发上限、暂停、作业指导），直接调整；需要改任务或依赖的，用 task_update / 依赖相关工具处理。\n` +
      `4. 如果原因不在系统内（例如需要人清理磁盘、重新登录、补充配额），用 task_comment 写清结论和所需的人工动作。\n\n` +
      `完成后请用 task_comment 记录你的判断与所做的改动，再将本任务置为 DONE。`
    );
  }

  /**
   * Of these tasks' assignees, which (runner, provider) pairs have an exhausted account quota
   * right now — mapped to the moment it frees up. Dispatching against one is pointless: the
   * run dies on arrival with the provider's own "usage limit" error, so the only effect is a
   * failed session per sweep until the window resets (a weekly limit means days of them).
   *
   * Keyed per (runner, provider) because one runner can host workspaces on several runtimes and
   * only some of their quotas may be spent. A pair whose snapshot reports no exhausted window,
   * or an exhausted one with no reset time, is absent from `blocked`.
   *
   * `blind` names the pairs this gate has *no quota data for at all*, which is a different
   * thing from "not blocked" and must not be confused with it: for a reported-and-healthy
   * quota, dispatching immediately after a usage-limit failure is right (the window reset),
   * while doing the same with no snapshot to go on is what produces the respawn loop
   * QUOTA_BLIND_RETRY_BACKOFF_MS exists to damp.
   */
  private async quotaGate(
    tasks: Array<{ assignee: { provider: string; runnerId: string | null } | null }>,
  ): Promise<{ blocked: Map<string, Date>; blind: Set<string> }> {
    const runnerIds = [
      ...new Set(
        tasks.map((t) => t.assignee?.runnerId).filter((id): id is string => typeof id === 'string'),
      ),
    ];
    const blocked = new Map<string, Date>();
    const blind = new Set<string>();
    if (runnerIds.length === 0) return { blocked, blind };
    const runners = await this.prisma.runner.findMany({
      where: { id: { in: runnerIds } },
      select: { id: true, planUsage: true },
    });
    const usageByRunner = new Map(
      runners.map((r) => [r.id, r.planUsage as unknown as PlanUsage | null]),
    );
    const now = new Date();
    for (const t of tasks) {
      const assignee = t.assignee;
      if (!assignee?.runnerId) continue;
      const key = `${assignee.runnerId}:${assignee.provider}`;
      const usage = usageByRunner.get(assignee.runnerId);
      if (!planUsageReported(usage, assignee.provider)) blind.add(key);
      if (blocked.has(key)) continue;
      const until = planUsageBlockedUntil(usage, assignee.provider, now);
      if (until) blocked.set(key, until);
    }
    return { blocked, blind };
  }

  /**
   * Of `taskIds`, which must NOT be auto-run right now because their previous runs failed:
   * either the task is still inside the backoff window for its failure count, or it has
   * burned through MAX_AUTO_RUN_FAILURES and is left for a human. Counting every FAILED
   * session of the task is deliberate — a task that ever ran to completion is DONE, not a
   * reconciler candidate, so for an OPEN auto-run task these failures are its run history.
   * Tasks with no failed run are absent from the result and dispatch immediately.
   *
   * Runs killed by an exhausted provider quota are excluded from that budget: they carry no
   * evidence that anything is wrong with the task, so letting them spend it would leave a fleet
   * permanently un-runnable after one quota outage — exactly the tasks that should pick
   * themselves back up once the window resets.
   *
   * `quotaBlindTaskIds` are the ones whose runner reports no quota snapshot to judge by. Only
   * those get the flat QUOTA_BLIND_RETRY_BACKOFF_MS hold after a usage-limit failure. A task
   * whose runner *does* report a healthy quota is dispatched at once instead: that report is
   * positive evidence the window reset, and delaying it would be the very "un-runnable fleet"
   * this exemption exists to prevent.
   */
  private async autoRunHoldOff(
    taskIds: string[],
    quotaBlindTaskIds: ReadonlySet<string>,
  ): Promise<Set<string>> {
    const held = new Set<string>();
    const uniqueIds = [...new Set(taskIds)];
    const usageLimitIs = (negated: boolean) => {
      const clauses = USAGE_LIMIT_ERROR_MARKERS.map((marker) => ({
        error: { contains: marker, mode: Prisma.QueryMode.insensitive },
      }));
      return negated ? { NOT: { OR: clauses } } : { OR: clauses };
    };
    for (let offset = 0; offset < uniqueIds.length; offset += TASK_ID_QUERY_CHUNK) {
      const ids = uniqueIds.slice(offset, offset + TASK_ID_QUERY_CHUNK);
      const failures = await this.prisma.session.groupBy({
        by: ['taskId'],
        where: {
          taskId: { in: ids },
          status: RunStatus.FAILED,
          ...usageLimitIs(true),
        },
        _count: { _all: true },
        _max: { createdAt: true },
      });
      const now = Date.now();
      for (const row of failures) {
        if (!row.taskId) continue;
        const failed = row._count._all;
        if (failed >= MAX_AUTO_RUN_FAILURES) {
          held.add(row.taskId);
          continue;
        }
        const lastFailedAt = row._max.createdAt?.getTime();
        if (lastFailedAt === undefined) continue;
        if (now - lastFailedAt < AUTO_RUN_RETRY_BACKOFF_MS[failed - 1]) held.add(row.taskId);
      }
      // The mirror query: only the usage-limit failures, counted for their recency alone, and
      // only for the tasks the gate is blind on. A separate round trip rather than one
      // unfiltered groupBy because the two populations need different arithmetic — one
      // escalates and gives up, this one never does — and a single grouped row cannot tell
      // them apart.
      const blindIds = ids.filter((id) => quotaBlindTaskIds.has(id));
      if (blindIds.length === 0) continue;
      const quotaFailures = await this.prisma.session.groupBy({
        by: ['taskId'],
        where: {
          taskId: { in: blindIds },
          status: RunStatus.FAILED,
          ...usageLimitIs(false),
        },
        _max: { createdAt: true },
      });
      for (const row of quotaFailures) {
        if (!row.taskId || held.has(row.taskId)) continue;
        const lastFailedAt = row._max.createdAt?.getTime();
        if (lastFailedAt === undefined) continue;
        if (now - lastFailedAt < QUOTA_BLIND_RETRY_BACKOFF_MS) held.add(row.taskId);
      }
    }
    return held;
  }

  /**
   * What a batch of dependency edits would do, without doing any of it.
   *
   * The half of a DAG proposal a human actually reads. The edge list says what is being written;
   * the state changes say what happens as a result — above all which tasks become runnable, since
   * the sweep collects those within the minute and starts spending real runs on them. A
   * restructure that reads as a tidy-up and quietly releases forty tasks is the outcome an
   * approval exists to catch, and it is invisible in the ops themselves.
   *
   * Cycles are checked over the owner's whole graph, not the list's: dependencies cross lists, so
   * a list-local check would pass a batch that closes a loop through a task somewhere else and
   * wedge the completion trigger for good.
   */
  async previewDag(ownerId: string, listId: string, ops: DagOp[]) {
    if (ops.length === 0) throw new BadRequestException('no dependency changes proposed');
    if (ops.length > MAX_DAG_OPS) {
      throw new BadRequestException(`at most ${MAX_DAG_OPS} dependency changes at a time`);
    }
    const list = await this.prisma.taskList.findFirst({
      where: { id: listId, ownerId },
      select: { id: true, title: true },
    });
    if (!list) throw new NotFoundException('task list not found');
    for (const op of ops) {
      if (op.taskId === op.dependsOnTaskId) {
        throw new BadRequestException('A task cannot depend on itself');
      }
    }
    const referenced = [...new Set(ops.flatMap((o) => [o.taskId, o.dependsOnTaskId]))];
    await this.assertOwnedTasks(ownerId, referenced);
    // The dependent must be in the list being restructured — that is what makes "this list's DAG"
    // a well-defined thing to approve. Prerequisites may live anywhere the owner owns, because a
    // task waiting on one in another list is an ordinary and useful shape.
    const dependents = [...new Set(ops.map((o) => o.taskId))];
    const inList = await this.prisma.task.count({
      where: { id: { in: dependents }, listId },
    });
    if (inList !== dependents.length) {
      throw new BadRequestException('every edited task must belong to the list being restructured');
    }
    const current = await this.prisma.taskDependency.findMany({
      where: { task: { ownerId } },
      select: { taskId: true, dependsOnTaskId: true },
    });
    const { effective, noop } = effectiveOps(current, ops);
    const after = resultingEdges(current, ops);
    const cycle = findCycle(after);
    // Statuses for everything whose state could move: the tasks in the batch, plus every
    // prerequisite of every one of them on either side of the change. Bounded by the batch, not
    // by the list — a 250-task list is not worth loading to describe an edit to three of them.
    const touched = new Set(referenced);
    for (const e of [...current, ...after]) {
      if (touched.has(e.taskId)) touched.add(e.dependsOnTaskId);
    }
    const tasks = await this.prisma.task.findMany({
      where: { id: { in: [...touched] }, ownerId },
      select: { id: true, title: true, status: true },
    });
    const titleOf = new Map(tasks.map((t) => [t.id, t.title]));
    const changes = stateChanges(
      current,
      after,
      new Map(tasks.map((t) => [t.id, t.status as TaskStatus])),
    ).filter((c) => titleOf.has(c.taskId));
    const name = (id: string) => titleOf.get(id) ?? id;
    return {
      listId: list.id,
      listTitle: list.title,
      ops: ops.map((o) => ({
        op: o.op,
        taskId: o.taskId,
        taskTitle: name(o.taskId),
        dependsOnTaskId: o.dependsOnTaskId,
        dependsOnTitle: name(o.dependsOnTaskId),
        noop: noop.includes(o),
      })),
      effectiveCount: effective.length,
      // Named, not just counted: a batch that is entirely no-ops means the proposer is working
      // from a stale read of the graph, which is exactly when nobody should be approving it.
      noopCount: noop.length,
      cycle: cycle?.map((id) => ({ taskId: id, title: name(id) })) ?? null,
      changes: changes.map((c) => ({ ...c, title: name(c.taskId) })),
      // Only READY. A task whose last prerequisite is *removed* becomes NONE, which looks like a
      // release and is not one: the sweep requires a prerequisite that is DONE, so a task with no
      // prerequisites left is never auto-started — it waits for a person. Counting NONE here
      // promised runs that never happened.
      becomingRunnable: changes.filter((c) => c.to === 'READY').length,
      // Freed from waiting, but now nobody will start them either.
      becomingManual: changes.filter((c) => c.to === 'NONE').length,
      becomingBlocked: changes.filter((c) => c.to === 'BLOCKED' || c.to === 'BLOCKED_FAILED').length,
      edgesBefore: current.length,
      edgesAfter: after.length,
    };
  }

  /**
   * Apply a batch of dependency edits atomically.
   *
   * Re-validated here rather than trusted from the preview: a proposal is approved by a human at
   * human speed, and the graph it described may have moved in between. The whole batch is written
   * under the same owner-wide lock the single-edge paths take, so no dispatch decision is made
   * against a half-applied restructure — which is the reason this exists as a batch at all.
   */
  async applyDag(ownerId: string, listId: string, ops: DagOp[]) {
    const preview = await this.previewDag(ownerId, listId, ops);
    if (preview.cycle) {
      throw new BadRequestException(
        `These changes would create a cycle: ${preview.cycle.map((c) => c.title).join(' → ')}`,
      );
    }
    // Retried whole. Every decision this makes is re-derived inside the closure: the edge set is
    // re-read under the owner mutex and re-checked for cycles, and `effectiveOps` is computed from
    // that read — so a retry judges the graph the winning transaction left behind, not the one the
    // aborted attempt saw. `ops` and the human-facing `preview` are computed above, outside, and
    // are the same on every attempt. The publish and the reconcile below are outside the loop.
    const applied = await withTransactionRetry(this.prisma, async (tx) => {
      await this.lockDependencyGraph(tx, ownerId);
      // No rank-30 pre-lock any more. This batch writes edges and nothing else: since 0132 an edge
      // write no longer re-writes its dependent Task, so it no longer re-checks
      // `task_creator_session_id_fkey` and no longer takes FOR KEY SHARE on that Task's creator
      // Session — a lock that conflicts with the FOR UPDATE a runner holds while it owns the
      // Session, and so made a restructure wait on unrelated live runs. The dispatch boundary the
      // pre-lock was protecting is now `task_dependency_revision`, advanced at rank 70 below.
      // The graph is re-read inside the lock and re-checked whole. The preview above is for the
      // human; this is the one that decides, and between them a concurrent edit may have made the
      // batch illegal.
      const current = await tx.taskDependency.findMany({
        where: { task: { ownerId } },
        select: { taskId: true, dependsOnTaskId: true },
      });
      const cycle = findCycle(resultingEdges(current, ops));
      if (cycle) {
        throw new ConflictException(
          'the graph changed while this was awaiting approval, and these changes would now create a cycle',
        );
      }
      // Both sides go through effectiveOps, not just the additions. An approval can be applied
      // twice — a retried tool call, a re-delivered turn — and the second time neither half should
      // claim to have written anything: `removed`/`added` are what the agent repeats back to the
      // human, and a count that includes a delete matching no rows reports a change that did not
      // happen. It also saves the pointless round trip.
      const effective = effectiveOps(current, ops).effective;
      const removals = effective.filter((o) => o.op === 'remove');
      const additions = effective.filter((o) => o.op === 'add');
      for (const op of removals) {
        await tx.taskDependency.deleteMany({
          where: { taskId: op.taskId, dependsOnTaskId: op.dependsOnTaskId },
        });
      }
      // Only the additions that are not already there, so an approval applied twice — a retried
      // tool call, a re-delivered turn — settles instead of colliding on the unique key.
      if (additions.length > 0) {
        await tx.taskDependency.createMany({
          data: additions.map((o) => ({ taskId: o.taskId, dependsOnTaskId: o.dependsOnTaskId })),
          skipDuplicates: true,
        });
      }
      return { removed: removals.length, added: additions.length };
    }, this.transientWriteRetry('tasks.applyDag'));
    // The DAG view and every task list refresh off the owner's stream; a restructure may touch
    // tasks with no creator session to publish through.
    this.realtime.publishForUser(ownerId, RunEventType.TASK_CHANGED, listId);
    // Releasing a task is only half of it: the sweep would collect the newly-runnable ones within
    // the minute anyway, and running it now makes the approval feel like it did something.
    await this.reconcileReadyTasks().catch((e) =>
      this.logger.warn(`reconcile after DAG change failed: ${e instanceof Error ? e.message : e}`),
    );
    return { ...applied, preview };
  }

  /** Add a "task depends on dependsOnTaskId" edge; rejects self-deps and cycles. */
  async addDependency(ownerId: string, taskId: string, dependsOnTaskId: string) {
    if (taskId === dependsOnTaskId) throw new BadRequestException('A task cannot depend on itself');
    await this.assertOwnedTasks(ownerId, [taskId, dependsOnTaskId]);
    try {
      // Retried whole. The cycle check re-reads the whole edge set under the owner mutex on every
      // attempt, so a re-run cannot pass a check the winning graph would fail. A duplicate edge
      // arrives as P2002, which the classifier calls permanent — it is answered below on the first
      // attempt rather than retried into the same answer three more times.
      await withTransactionRetry(this.prisma, async (tx) => {
        await this.lockDependencyGraph(tx, ownerId);
        // Rank 10 only. Since 0132 the edge write touches no `task` row, so there is no second
        // write to re-check `task_creator_session_id_fkey` against and no creator Session to
        // pre-lock (common/lock-order.ts, I2); the dispatch boundary is the revision row the
        // INSERT's statement trigger advances at rank 70.
        // Cycle check over this owner's whole dependency subgraph (both endpoints are
        // same-owner by construction, so filtering by the dependent's owner is enough).
        const edges = await tx.taskDependency.findMany({
          where: { task: { ownerId } },
          select: { taskId: true, dependsOnTaskId: true },
        });
        if (wouldCreateCycle(edges, taskId, dependsOnTaskId)) {
          throw new BadRequestException('This dependency would create a cycle');
        }
        await tx.taskDependency.create({ data: { taskId, dependsOnTaskId } });
      }, this.transientWriteRetry('tasks.addDependency'));
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('This dependency already exists');
      }
      throw e;
    }
    // Workspace edits have no guaranteed session to publish through (the target may be web-created),
    // so nudge the owner's control stream directly. The graph query lives under ['task'] and
    // refreshes together with the detail/list views. Publish before response hydration so a rare
    // post-commit read failure cannot leave other clients stale or make a retry-only conflict.
    this.realtime.publishForUser(ownerId, RunEventType.TASK_CHANGED, taskId);
    return this.get(ownerId, taskId);
  }

  /** Remove a prerequisite edge (no-op if it doesn't exist). */
  async removeDependency(ownerId: string, taskId: string, dependsOnTaskId: string) {
    await this.assertOwnedTasks(ownerId, [taskId]);
    if (!UUID_RE.test(dependsOnTaskId)) throw new NotFoundException('task not found');
    // Retried whole: one DELETE and the revision it advances, both re-derived under the owner
    // mutex on every attempt. Removing an edge that is already gone is the same answer either way.
    await withTransactionRetry(this.prisma, async (tx) => {
      await this.lockDependencyGraph(tx, ownerId);
      // Same shape as the add: the DELETE advances the same revision row and writes no `task`.
      await tx.taskDependency.deleteMany({ where: { taskId, dependsOnTaskId } });
    }, this.transientWriteRetry('tasks.removeDependency'));
    this.realtime.publishForUser(ownerId, RunEventType.TASK_CHANGED, taskId);
    return this.get(ownerId, taskId);
  }

  async remove(ownerId: string, id: string) {
    await this.get(ownerId, id);
    const { survivingLinks } = await this.deleteAndStopRuns(ownerId, [id]);
    // Cascades may remove prerequisite edges from other open DAGs, so invalidate the owner's
    // task snapshots even though the deleted focus task itself can no longer be fetched.
    this.realtime.publishForUser(ownerId, RunEventType.TASK_CHANGED, id);
    // A task LEAVING is the third change to a parent's children, beside arriving and completing,
    // and it is the one that can complete a parent rather than reopen it: delete the last
    // outstanding subtask and ALL_CHILDREN_DONE is satisfied by what remains.
    //
    // `verifiesTaskId` cascades, so deleting a subject takes its checks with it — which is why
    // the seeds are the DELETED task's own links and not the checks that pointed at it.
    if (survivingLinks.length) {
      await this.recomputeAggregates(ownerId, survivingLinks).catch((e) =>
        this.logger.warn(`aggregation after delete of ${id} failed: ${e?.message ?? e}`),
      );
    }
    return { ok: true };
  }

  /**
   * Delete the caller's tasks among `ids`, and stop whatever was still running them.
   *
   * A task run settles by finishing its task: the workspace marks it DONE and the session ends
   * as `task_done`. Delete the task under a live run and that route is gone — the run finishes
   * its turn, parks at AWAITING_INPUT, and stays there. It costs nothing (the claim counts only
   * RUNNING, so an idle session holds no slot) but it never settles, and no later sweep can
   * recognize it: Session.taskId is SET NULL by the delete, leaving a run indistinguishable
   * from an ordinary chat. The reaper's rule for a task that goes terminal under a live run
   * cannot cover this one, because by the time it looks there is no task to read a status from.
   * This is the last moment the link exists, so it is the only place that can end them.
   *
   * Terminal sessions are deliberately left alone: detaching finished runs rather than
   * cascading them away is what keeps a deleted task's history readable.
   *
   * The tasks are locked before their runs are read. Inserting a session that references a task
   * takes FOR KEY SHARE on that task's row, which FOR UPDATE conflicts with, so a dispatch
   * landing at the same moment either commits first and is seen by the scan, or waits and then
   * fails its foreign key against the row just deleted. Unlocked it could slip in between the
   * scan and the delete and be stranded by the very code meant to prevent that.
   */
  private async deleteAndStopRuns(
    ownerId: string,
    ids: string[],
  ): Promise<{ deleted: number; survivingLinks: string[] }> {
    // Retried whole. Everything it decides is read inside the closure and under the owner mutex —
    // the surviving links, the occupying runs, the rows the DELETE names — so a re-run deletes
    // against the state the winning transaction left. The run teardown below is deliberately
    // OUTSIDE the loop and outside the transaction: it talks to runners, and a retry must not be
    // able to send a second cancel for a run the first attempt never actually deleted.
    //
    // ...and the fence translation sits OUTSIDE the retry, because the two answer different
    // conditions. §13.1 AG6 reaches this path without naming it: deleting a parent fires the FK's
    // `ON DELETE SET NULL` on every child's `parent_task_id`, a column
    // `task_aggregate_parent_shape_guard` is declared on, so a delete overlapping a reconcile that
    // holds the project gets that guard's typed `TASK_AGGREGATE_PROJECT_BUSY`. That is a
    // `lock_not_available`, which `classifyTransactionError` deliberately does not call transient —
    // it is a decision, not a fault. Retrying it would spend the attempts re-earning the same
    // correct refusal; untranslated it reaches the caller as a 500 with a SQLSTATE in it.
    const { deleted, runs, links } = await this.runTaskWorkTranslatingFences(
      () => withTransactionRetry(
        this.prisma,
      async (tx) => {
        // Rank 10. A delete is a graph mutation — it cascades edges away and fires the dispatch
        // touch on whatever depended on these tasks — and it writes many `task` rows, so it takes
        // the same owner mutex every other multi-row Task write takes (lock-order.ts, I1). That
        // is what makes it unable to deadlock against a create, a dependency edit or a verdict,
        // whichever rows the two happen to share.
        await this.lockDependencyGraph(tx, ownerId);
        // Rank 30, and the reason this transaction is the order's one declared exception: the
        // DELETE below cascades `session.task_id` to NULL, which writes every run attached to
        // these tasks — a `session` lock taken from inside a `task` lock. Taking those rows here,
        // ordered, puts the ordinary case back in rank order. It cannot be complete (a dispatch
        // that commits between this statement and the task lock attaches a run this did not see),
        // which is exactly why the task lock below still comes before the run scan.
        //
        // `verifies_task_id` CASCADEs, so the rows this DELETE writes include the checks pointed at
        // these tasks — and their sessions are written by the same cascade. Taking only the named
        // tasks' sessions here left those out of rank 30 entirely.
        await tx.$queryRaw`
          SELECT "id" FROM "session"
          WHERE "owner_id" = ${ownerId}::uuid AND "task_id" IN (
            WITH RECURSIVE cascaded AS (
              SELECT t."id" FROM "task" t
               WHERE t."id" = ANY(${ids}::uuid[]) AND t."owner_id" = ${ownerId}::uuid
              UNION
              SELECT v."id" FROM cascaded c
                JOIN "task" v ON v."verifies_task_id" = c."id"
                             AND v."owner_id" = ${ownerId}::uuid
            )
            SELECT "id" FROM cascaded
          )
          ORDER BY "id"
          FOR UPDATE`;
        // Rank 40, and the same lock `project_acceptance_reopen` takes from an AFTER trigger on
        // every one of the DELETEs below — moved ahead of the task lock so this transaction is
        // never caught holding a task row while asking for its project, which is the reverse of
        // the order the Project authorization adapter takes them in. Ordered, and read under the
        // owner mutex, which is the only lock a task's project can move under.
        await tx.$queryRaw`
          SELECT "id" FROM "project"
          WHERE "id" IN (
            SELECT DISTINCT "project_id" FROM "task"
             WHERE "id" = ANY(${ids}::uuid[]) AND "owner_id" = ${ownerId}::uuid
               AND "project_id" IS NOT NULL
          )
          ORDER BY "id"
          FOR NO KEY UPDATE`;
        // Ordered, so two deletes over overlapping selections cannot take the same rows in
        // opposite orders and deadlock.
        //
        // The two links come back off the SAME locked read, which is the only moment they are both
        // still true and no longer changeable: a parent whose last outstanding subtask this delete
        // removes has to be recomputed, and after the DELETE there is nothing left to ask.
        const locked = await tx.$queryRaw<
          Array<{ parentTaskId: string | null; verifiesTaskId: string | null }>
        >`
          SELECT id, "parent_task_id" AS "parentTaskId", "verifies_task_id" AS "verifiesTaskId"
          FROM "task"
          WHERE id = ANY(${ids}::uuid[]) AND "owner_id" = ${ownerId}::uuid
          ORDER BY id
          FOR UPDATE`;
        // The runs to end are the runs on every task this DELETE actually REMOVES, which is more
        // than the ids it names: `verifies_task_id` is `ON DELETE CASCADE`, so deleting a subject
        // takes its checks with it, and a check of a check goes too.
        //
        // Scanning only `ids` left a live run sitting on a cascaded check. `session.task_id` is SET
        // NULL by the delete, so that run finishes its turn, parks at AWAITING_INPUT and stays
        // there: it holds no slot, nothing can recognise it as a task run any more, and the
        // reaper's rule for a task that goes terminal under a live run cannot reach it because by
        // then there is no task to read a status from. This is the last moment the link exists.
        //
        // A read, not a lock: the rank-30 statement above already took the session rows, and this
        // widens which of them the scan reports rather than adding an acquisition of its own.
        const doomed = await cascadedTaskClosure(tx, ownerId, ids);
        const occupying = await tx.session.findMany({
          where: { ownerId, taskId: { in: doomed }, status: { in: TASK_OCCUPYING } },
          select: { id: true },
        });
        const res = await tx.task.deleteMany({ where: { ownerId, id: { in: ids } } });
        return { deleted: res.count, runs: occupying.map((s) => s.id), links: locked };
      },
        this.transientWriteRetry('tasks.delete', {
          // The delete used to be one implicit statement under no client deadline. Inside an
          // interactive transaction Prisma's default aborts it at 5s, which a batch large enough to
          // cascade through thousands of comments and edges would hit — turning deletes that used
          // to work into P2028. The locks are held for as long as the delete takes either way.
          // Handed to every attempt, not only the first.
          transaction: { timeout: 60_000, maxWait: 10_000 },
          // Two, for the reason TaskListsService.remove gives: a cascade this size should absorb
          // one collision, not spend four deadlines on the same one.
          maxAttempts: 2,
        }),
      ),
    );
    for (const sessionId of runs) {
      // Each end is its own transaction, and one that fails must not take the delete with it:
      // the task is already gone either way, and an end nobody honors is force-finalized by
      // the reaper.
      await this.sessions
        .cancel(ownerId, sessionId, SessionEndReason.TASK_CANCELLED)
        .catch((e) =>
          this.logger.warn(
            `task delete: could not end run ${sessionId}: ${e instanceof Error ? e.message : e}`,
          ),
        );
    }
    if (runs.length > 0) {
      this.logger.log(`task delete: ended ${runs.length} in-flight run(s) across ${deleted} task(s)`);
    }
    // Only the links that OUTLIVE this delete are worth recomputing; anything inside the same
    // selection is gone. `links` is [] on a caller whose transaction returned nothing, which is
    // the same as having no aggregate to recompute.
    const doomed = new Set(ids);
    const survivingLinks = [
      ...new Set(
        (links ?? [])
          .flatMap((task) => [task.parentTaskId, task.verifiesTaskId])
          .filter((id): id is string => !!id && !doomed.has(id)),
      ),
    ];
    return { deleted, survivingLinks };
  }

  async addComment(ownerId: string, id: string, dto: CreateTaskCommentDto, author?: Creator) {
    const task = await this.get(ownerId, id);
    if (!dto.body) throw new BadRequestException('body is required');
    // Every mentioned id has to resolve, and one that does not is REFUSED rather than dropped.
    //
    // Silently filtering was the old behaviour, and it has no honest outcome under §13.8: the
    // comment commits, the trigger files a ledger row for each id that survived, and the agent the
    // caller actually named gets nothing with nothing recorded. Refusing keeps the two halves
    // together — either the comment and all its deliveries exist, or neither does — and it names
    // which id was the problem, which "we dropped one" never could.
    //
    // The ids are not stored unresolved, so nothing cross-tenant reaches the row: this check is
    // what keeps the ledger's snapshot column honest without it having to hold a foreign id.
    const requested = [...new Set(dto.mentions ?? [])];
    const mentioned = await this.resolveMentionedWorkspaces(ownerId, requested);
    if (mentioned.length !== requested.length) {
      const resolved = new Set(mentioned.map((workspace) => workspace.id));
      const missing = requested.filter((id) => !resolved.has(id));
      throw new BadRequestException(
        `these mentioned agents do not exist or are not yours: ` +
          `${missing.map((id) => uuidToBase62(id)).join(', ')}. ` +
          'Remove them from the mention list and post again — a comment is not filed with a ' +
          'mention nobody can be given',
      );
    }
    const comment = await this.prisma.taskComment.create({
      data: {
        taskId: id,
        // Defaults to the human (user-facing API); the runner path passes the workspace.
        authorType: author?.type ?? CreatorType.USER,
        authorId: author?.id ?? ownerId,
        body: dto.body,
        mentions: mentioned.map((a) => a.id),
        // §13.8. Version 1 is what makes 0131's trigger file the delivery ledger for this comment,
        // and it is written EXPLICITLY: the column defaults to 0 so a comment written by a binary
        // predating the ledger keeps the old inline contract and is not delivered twice by a sweep
        // that knows nothing about it.
        mentionDeliveryVersion: TASK_COMMENT_MENTION_DELIVERY_VERSION,
      },
    });
    // A new comment changes the list's comment count and the open detail view, so give it the
    // same live-refresh nudge as create()/update() — routed via the task's creator session.
    if (task.creatorSessionId) this.realtime.publishTaskChanged(task.creatorSessionId, id);
    // §13.8: delivery is a LEDGER, not a loop.
    //
    // 0131's trigger filed one `task_comment_mention_delivery` row per mentioned agent in the SAME
    // statement that wrote this comment, because `mentionDeliveryVersion` is 1. Nothing is
    // delivered inline any more: the old loop ran after the commit, caught its own failures and
    // logged them, so a crash, an offline runner or a second mentioned agent produced a comment
    // that looked delivered and an agent that never heard about it.
    //
    // All this does is wake the sweep. A lost wake costs one tick — which is the difference
    // between an optimisation and a mechanism.
    void this.deliverMentions().catch((e) =>
      this.logger.warn(`mention delivery kick after comment ${comment.id} failed: ${e?.message ?? e}`),
    );
    return comment;
  }

  /** Filter mention ids down to workspaces this user owns; dedupe. Returns id + runnerId. */
  private async resolveMentionedWorkspaces(ownerId: string, ids?: string[]) {
    if (!ids?.length) return [];
    const unique = [...new Set(ids)];
    return this.prisma.workspace.findMany({
      where: { id: { in: unique }, ownerId },
      select: { id: true, runnerId: true },
    });
  }

  /**
   * Create the Session THIS RUN REQUEST is named after, or read back the one it already has.
   *
   * §7.7 D5's execution claim makes "one live run per task" a property of the database, so two
   * callers arriving together produce one insert and one duplicate-key error. That error is not the
   * answer either of them wanted: both asked for the task to be running, and it is.
   *
   * The id is the request's own (`task-run-identity.ts`), so which row the insert hit is decided by
   * READING — never inferred from the shape of the error, and never searched for:
   *
   *  1. **A row at that id.** It is this request's Session, because the id is a function of the
   *     request and of nothing else. It is returned WHATEVER STATUS IT IS IN, and that is the whole
   *     repair. The read this replaces was "the newest PENDING/RUNNING Session on this task", which
   *     had two ways to be wrong about the caller's own run: a winner that had since reached
   *     `SUCCEEDED`, `FAILED` or `CANCELLED` fell out of it, and the raw `P2002` then reached the
   *     API as a 500; a winner parked at `AWAITING_INPUT` or `INTERRUPTED` fell out of it too, into
   *     the branch below, where it was reported to its own caller as somebody ELSE's live claim.
   *     There is no status in this read, so there is no status it can be wrong about.
   *  2. **No row at that id, and a Session holding the claim.** Then this request did not run, and
   *     the row in the way is not its own — it cannot be. Named, never adopted and never reported
   *     as success, off the claim index's own predicate (`TASK_OCCUPYING` is the four statuses
   *     `session_task_execution_claim_idx` lists, character for character) rather than off "the
   *     newest" or "the live one".
   *  3. **Neither.** The claim was released between the insert and the read, so nothing of this
   *     request landed and there is nothing truthful to return. Refused with the reason — a raw
   *     duplicate-key error is not an answer, it is a 500 with a PostgreSQL sentence in it.
   */
  private async createTaskSessionOrReadWinner(
    ownerId: string,
    task: TaskRunTarget,
    workspace: { id: string; runnerId: string | null },
    /** This request's own name for its Session — see `taskRunDesiredSessionId`. */
    desiredSessionId: string,
    /** The right to write it, proved inside the insert's own transaction. */
    fence: TaskRunEffectFence | undefined,
    dto: Parameters<SessionsService['create']>[1],
    opts: Parameters<SessionsService['create']>[2],
  ): Promise<{ id: string }> {
    // Has this request already been served? Asked BEFORE the insert, not only after a conflict.
    //
    // It is the same read either way, and the difference is what it costs a redelivery: a replay
    // that goes on to attempt the insert takes the Session insert's own locks — 0122's capacity
    // serialization takes the PROJECT row — so two deliveries of one press landing together made
    // one of them lose a lock it never needed and answer "retry" about work that was finished. A
    // request whose row exists is a request that is over.
    const served = await this.readOwnRun(ownerId, task, desiredSessionId);
    if (served) {
      this.logger.log(
        `task ${uuidToBase62(task.id)}: this run request already holds session ` +
          `${uuidToBase62(served.id)} (${served.status}); returning it`,
      );
      return { id: served.id };
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.sessions.create(ownerId, dto, { ...opts, id: desiredSessionId, fence });
      } catch (e) {
        // A NOWAIT fence, and the one two deliveries of ONE press reach: 0122's capacity
        // serialization takes the PROJECT row, so the loser is refused before its insert can
        // collide with the winner's — and "retry" is the entire remedy, which a request with a
        // stable name can act on itself. Bounded, and every attempt re-reads this request's own row
        // first, so the retry either finds the Session the contention was about or lands its own.
        if (isRetryableTaskFence(e) && attempt < TASK_RUN_FENCE_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, TASK_RUN_FENCE_BACKOFF_MS << attempt));
          const landed = await this.readOwnRun(ownerId, task, desiredSessionId);
          if (landed) return { id: landed.id };
          continue;
        }
        if (!this.isDuplicateKey(e) || !isTaskRunClaimConflict(e)) throw e;
      // 1. This request's own row, written by whoever won the race with this call.
      const mine = await this.readOwnRun(ownerId, task, desiredSessionId);
      if (mine) {
        this.logger.log(
          `task ${uuidToBase62(task.id)}: lost the race for this run request to session ` +
            `${uuidToBase62(mine.id)} (${mine.status}); returning it`,
        );
        return { id: mine.id };
      }
      // 2. Somebody else's claim. The unique index means there is at most one such row, so this is
      // an exact read rather than a pick — no `orderBy`, because there is nothing to order. It
      // carries no `owner_id` and no `workspace_id` filter for the same reason: the index carries
      // neither, and a reader narrower than the index it is explaining answers "nothing holds the
      // claim" for rows that do.
      const holder = await this.prisma.session.findFirst({
        where: { taskId: task.id, deletedAt: null, status: { in: TASK_OCCUPYING } },
        select: {
          id: true, status: true, workspaceId: true, provider: true, model: true,
          startsTaskWork: true, cancelRequestedAt: true,
        },
      });
      if (holder) throw this.foreignClaimRefusal(task, workspace, holder);
      // 3. The insert collided and neither row is there now — the claim was released, or the id
      // this request derives was briefly taken by something that has since gone. Nothing of this
      // request is running, and saying so is the only honest answer: adopting a row would report a
      // start that did not happen, and rethrowing would put a duplicate-key error in front of a
      // person who asked for a task to run. A retry re-derives the same id.
        throw new ConflictException(
          `task ${uuidToBase62(task.id)} could not be started: its execution claim was taken and ` +
            'released while this request was writing, so nothing of it is running. Start the task ' +
            'again',
        );
      }
    }
  }

  /**
   * The receipt for this request, opened if it does not exist yet.
   *
   * Returns the row as it stands. `COMPLETED` is the whole answer and the caller must return it
   * BEFORE any mutable check — that is what makes a repeat of one press the same request rather
   * than a fresh evaluation of a world that has moved. `IN_FLIGHT` is not a latch: an attempt that
   * crashed leaves one, and the caller resolves it from the artifacts this request names.
   *
   * The insert is `ON CONFLICT DO NOTHING` followed by a read, so two deliveries landing together
   * settle it with the primary key rather than with an exception that would abort whatever
   * transaction they were in.
   */
  private async leaseRunRequest(
    ownerId: string,
    actionKind: string,
    requestToken: string,
    fingerprint: string,
  ): Promise<TaskRunLease> {
    await this.prisma.$executeRaw`
      INSERT INTO "task_run_request" ("owner_id", "action_kind", "request_token", "fingerprint")
      VALUES (${ownerId}::uuid, ${actionKind}, ${requestToken}, ${fingerprint})
      ON CONFLICT DO NOTHING`;
    const holder = `${process.pid}:${randomUUID()}`;
    // ONE STATEMENT, and ONE CLOCK — PostgreSQL's.
    //
    // The statement decides "is it answered / is somebody answering it / may I answer it" off the
    // row rather than off a read this caller then acts on. The clock is the server's for a reason
    // the lease cannot survive without: two apiservers whose wall clocks differ by more than the
    // lease would take each other's requests over — the fast one declares a live lease expired, the
    // slow one keeps extending one it has lost — and "one evaluator at a time" would be a property
    // of NTP. `statement_timestamp()` is the same instant for both.
    const [taken] = await this.prisma.$queryRaw<Array<{
      attempt: number; status: 'OPEN' | 'BOUND'; target: unknown; fingerprint: string;
    }>>`
      UPDATE "task_run_request"
         SET "lease_holder" = ${holder},
             "lease_expires_at" =
               statement_timestamp() + make_interval(secs => ${TASK_RUN_LEASE_MS / 1000}),
             "attempt" = "attempt" + 1,
             "updated_at" = statement_timestamp()
       WHERE "owner_id" = ${ownerId}::uuid
         AND "action_kind" = ${actionKind}
         AND "request_token" = ${requestToken}
         AND "status" <> 'COMPLETED'
         AND ("lease_holder" IS NULL OR "lease_expires_at" <= statement_timestamp())
      RETURNING "attempt", "status", "target", "fingerprint"`;
    if (taken) {
      // One name, one request. A repeat carrying a different payload is refused rather than
      // answered from a row that describes something else.
      if (taken.fingerprint !== fingerprint) {
        await this.releaseRunRequest({
          ownerId, actionKind, requestToken, leaseHolder: holder, attempt: taken.attempt,
        });
        throw taskRunTokenMismatch(actionKind, requestToken);
      }
      return {
        held: true,
        claim: { ownerId, actionKind, requestToken, leaseHolder: holder, attempt: taken.attempt },
        status: taken.status,
        target: taken.target,
      };
    }
    const [row] = await this.prisma.$queryRaw<Array<TaskRunReceipt>>`
      SELECT "fingerprint", "status", "target", "result"
        FROM "task_run_request"
       WHERE "owner_id" = ${ownerId}::uuid
         AND "action_kind" = ${actionKind}
         AND "request_token" = ${requestToken}`;
    if (!row) throw new Error(`run receipt for ${actionKind}:${requestToken} vanished`);
    if (row.fingerprint !== fingerprint) throw taskRunTokenMismatch(actionKind, requestToken);
    if (row.status === 'COMPLETED') return { held: false, result: row.result };
    // Somebody else is evaluating it, and this delivery must not evaluate it a second time — that
    // is how two deliveries of one press end up applying two different effects and freezing one of
    // them as the answer.
    throw taskRunInProgress(actionKind, requestToken);
  }

  /**
   * Write down the plan, fenced, and hand back the one that is in force.
   *
   * A holder whose lease expired mid-evaluation loses this compare-and-set to whoever took over,
   * and reads the target that takeover bound — so two evaluators cannot disagree about what the
   * request is doing even when they overlapped.
   */
  private async bindRunRequest(claim: TaskRunClaim, target: unknown): Promise<unknown | null> {
    await this.prisma.$executeRaw`
      UPDATE "task_run_request"
         SET "status" = 'BOUND',
             "target" = ${JSON.stringify(target)}::jsonb,
             "bound_at" = statement_timestamp(),
             "updated_at" = statement_timestamp()
       WHERE "owner_id" = ${claim.ownerId}::uuid
         AND "action_kind" = ${claim.actionKind}
         AND "request_token" = ${claim.requestToken}
         AND "status" = 'OPEN'
         AND "lease_holder" = ${claim.leaseHolder}
         AND "attempt" = ${claim.attempt}`;
    // What the ROW says, and only that. A holder that lost this compare-and-set — its lease
    // expired, somebody took over, that takeover bound its own plan — must carry out the plan in
    // force, not the one it computed; and a row that is somehow still unbound means this delivery
    // no longer owns the request at all, which is a refusal rather than a licence.
    const [row] = await this.prisma.$queryRaw<Array<{ target: unknown }>>`
      SELECT "target" FROM "task_run_request"
       WHERE "owner_id" = ${claim.ownerId}::uuid
         AND "action_kind" = ${claim.actionKind}
         AND "request_token" = ${claim.requestToken}
         AND "status" <> 'OPEN'`;
    return row?.target ?? null;
  }

  /**
   * Keep the right to evaluate, and say honestly when it is gone.
   *
   * A press over many tasks can take longer than one lease, and the danger is not that it stops —
   * it is that it keeps going beside the takeover that replaced it. So the holder re-proves itself
   * before each effect, and a `false` here means STOP: the request now belongs to somebody else.
   */
  private async renewRunRequest(claim: TaskRunClaim): Promise<boolean> {
    const renewed = await this.prisma.$executeRaw`
      UPDATE "task_run_request"
         SET "lease_expires_at" =
               statement_timestamp() + make_interval(secs => ${TASK_RUN_LEASE_MS / 1000}),
             "updated_at" = statement_timestamp()
       WHERE "owner_id" = ${claim.ownerId}::uuid
         AND "action_kind" = ${claim.actionKind}
         AND "request_token" = ${claim.requestToken}
         AND "status" <> 'COMPLETED'
         AND "lease_holder" = ${claim.leaseHolder}
         AND "attempt" = ${claim.attempt}`;
    return renewed > 0;
  }

  /** Give the right to evaluate back, so a refused request can be asked again immediately. */
  private async releaseRunRequest(claim: TaskRunClaim): Promise<void> {
    await this.prisma.$executeRaw`
      UPDATE "task_run_request"
         SET "lease_holder" = NULL, "lease_expires_at" = NULL,
             "updated_at" = statement_timestamp()
       WHERE "owner_id" = ${claim.ownerId}::uuid
         AND "action_kind" = ${claim.actionKind}
         AND "request_token" = ${claim.requestToken}
         AND "status" <> 'COMPLETED'
         AND "lease_holder" = ${claim.leaseHolder}
         AND "attempt" = ${claim.attempt}`;
  }

  /**
   * Freeze what this door answered, so every later delivery of the same request answers the same.
   *
   * Compare-and-set on `IN_FLIGHT`: two deliveries that both got as far as producing an answer
   * agree about it — they name the same artifacts — and the first one to land is the one the
   * receipt keeps, rather than the last one to finish.
   */
  private async completeRunReceipt<T>(claim: TaskRunClaim, result: T): Promise<T> {
    await this.prisma.$executeRaw`
      UPDATE "task_run_request"
         SET "status" = 'COMPLETED',
             "result" = ${JSON.stringify(result)}::jsonb,
             "lease_holder" = NULL,
             "lease_expires_at" = NULL,
             "updated_at" = statement_timestamp()
       WHERE "owner_id" = ${claim.ownerId}::uuid
         AND "action_kind" = ${claim.actionKind}
         AND "request_token" = ${claim.requestToken}
         AND "status" <> 'COMPLETED'
         AND "lease_holder" = ${claim.leaseHolder}
         AND "attempt" = ${claim.attempt}`;
    // READ BACK, always, and return what the row says rather than what this call computed. A holder
    // that lost its lease mid-flight loses this compare-and-set too, and returning its own local
    // answer would hand a caller a result the request does not have — the exact half-success this
    // whole unit exists to remove, one layer up.
    const [row] = await this.prisma.$queryRaw<Array<{ result: unknown }>>`
      SELECT "result" FROM "task_run_request"
       WHERE "owner_id" = ${claim.ownerId}::uuid
         AND "action_kind" = ${claim.actionKind}
         AND "request_token" = ${claim.requestToken}
         AND "status" = 'COMPLETED'`;
    // No durable answer, no answer. This delivery lost its lease and the takeover that replaced it
    // has not finished, so the only true things to say are "not yet" and "ask again" — returning
    // the value THIS call computed would hand a caller a result the request does not have, which is
    // the same half-success the recovery below it exists to remove.
    if (!row) throw taskRunInProgress(claim.actionKind, claim.requestToken);
    return row.result as T;
  }

  /**
   * After a plan failed to apply: did it in fact happen, can it never happen, or is it worth
   * coming back for?
   *
   * Read off the plan's OWN artifact, by the id the plan named, and per kind — because "the target
   * is gone" means different rows for different plans:
   *
   *  - `CREATE` names a Session it writes. If that row is there the write landed after all (a lost
   *    response, a retry that raced its own predecessor); if it is not and the TASK is gone, the
   *    insert names a row `session_task_id_fkey` will refuse for ever.
   *  - `RESUME` names a turn on somebody else's Session. If the turn is there the delivery landed;
   *    if the Session has been hard-deleted, or has reached a terminal status, it can never receive
   *    that turn — a run that has ended is not revived, which is the rule this whole unit is built
   *    on. Checking only the TASK would miss both, and leave the request replaying for ever.
   *  - `ADOPT` writes nothing, so nothing it could fail at is reachable here; it is still answered
   *    from its own row rather than assumed.
   *
   * Everything else is transient by default. That is the safe direction: a request left BOUND is
   * re-attempted, while a request wrongly frozen is a run that never happens.
   */
  private async resolveAppliedArtifact(
    ownerId: string,
    task: TaskRunTarget,
    plan: TaskRunPlan,
  ): Promise<
    | { kind: 'DONE'; sessionId: string }
    | { kind: 'GONE'; why: string }
    | { kind: 'TRANSIENT' }
  > {
    if (plan.kind === 'RESUME') {
      if (await this.hasTurn(plan.sessionId, plan.turnId)) {
        return { kind: 'DONE', sessionId: plan.sessionId };
      }
      const target = await this.prisma.session.findUnique({
        where: { id: plan.sessionId },
        select: { id: true },
      });
      // Only a row that is GONE is monotone. A terminal status is NOT: `SessionsService.resume`
      // revives an ended run deliberately, so freezing a tombstone on it would answer a request
      // that could still be carried out — and answer it wrongly, for ever.
      if (!target) return { kind: 'GONE', why: 'the run it was to continue has been deleted' };
      return { kind: 'TRANSIENT' };
    }
    const mine = await this.readOwnRun(ownerId, task, plan.sessionId);
    if (mine) return { kind: 'DONE', sessionId: mine.id };
    const stillThere = await this.prisma.task.findFirst({
      where: { id: task.id }, select: { id: true },
    });
    if (stillThere) return { kind: 'TRANSIENT' };
    // READ COMMITTED, so the two reads above are two instants: another delivery could have
    // committed this request's Session between them, and the task could have been deleted after
    // that — `session_task_id_fkey` is `ON DELETE SET NULL`, so the winner survives with a null
    // `task_id` and the first read simply missed it. Asked again HERE, after the task is known
    // absent, the answer is monotone in the direction that matters: with no task row, no further
    // insert can name it, so a winner that is not there now can never appear.
    const late = await this.readOwnRun(ownerId, task, plan.sessionId);
    if (late) return { kind: 'DONE', sessionId: late.id };
    return { kind: 'GONE', why: 'the task has been deleted' };
  }

  /**
   * Somebody else's run holds this task. Said once, in one shape, from both doors that can see it.
   *
   * The pre-insert read and the post-`P2002` read reach the same fact by different routes, and they
   * used to answer it with two different sentences — so a client could not tell "wait for the run
   * that is going" from "you reused a triggerId" without parsing English. The payload carries a
   * stable code, the row in the way as a PUBLIC id, and what to do about it.
   */
  private foreignClaimRefusal(
    task: TaskRunTarget,
    workspace: { id: string },
    holder: {
      id: string;
      status?: RunStatus;
      workspaceId?: string | null;
      provider?: string | null;
      model?: string | null;
      startsTaskWork?: boolean;
      cancelRequestedAt?: Date | null;
    },
  ): ConflictException {
    const taskPublicId = uuidToBase62(task.id);
    const sessionPublicId = uuidToBase62(holder.id);
    // A run's provider is fixed for its lifetime, so a holder on another one is not this task's
    // work being done — it is the previous pin still running. This deployment has shipped a
    // provider mix-up before; reporting that as success is how it happens again. Its own code,
    // because the remedy differs: waiting fixes it, and so does clearing the pin.
    if (task.provider && holder.provider != null && holder.provider !== task.provider) {
      return taskRunPinConflict({
        taskPublicId, sessionPublicId, field: 'provider',
        pinned: task.provider, running: holder.provider,
      });
    }
    if (task.model != null && holder.model !== undefined && holder.model !== task.model) {
      return taskRunPinConflict({
        taskPublicId, sessionPublicId, field: 'model',
        pinned: task.model, running: holder.model ?? 'the agent default',
      });
    }
    return taskAlreadyRunning({
      taskPublicId,
      sessionPublicId,
      sessionStatus: holder.status ?? RunStatus.RUNNING,
      onAnotherAgent: holder.workspaceId != null && holder.workspaceId !== workspace.id,
      ending: holder.cancelRequestedAt != null,
      notWork: holder.startsTaskWork === false,
    });
  }

  /**
   * Did THIS request already put its turn on that run?
   *
   * The durable result of a delivery to a paused run, read by the same key the delivery is written
   * under (`taskRunResumeTurnId`) and made exact by `conversation_turn (session_id,
   * client_turn_id)`. Without it a repeat of one press reads a run that is live again — because its
   * own turn woke it — and refuses it as somebody else's work.
   */
  private hasDeliveredResumeTurn(requestToken: string, sessionId: string): Promise<boolean> {
    return this.hasTurn(sessionId, taskRunResumeTurnId(requestToken, sessionId));
  }

  /** Is that turn already on that session? `(session_id, client_turn_id)` is unique. */
  private async hasTurn(sessionId: string, clientTurnId: string): Promise<boolean> {
    const turn = await this.prisma.conversationTurn.findUnique({
      where: { sessionId_clientTurnId: { sessionId, clientTurnId } },
      select: { id: true },
    });
    return turn != null;
  }

  /**
   * The Session THIS request already has, if it has one.
   *
   * No status, no `deleted_at`, no ordering: every filter here is a property that MOVES while the
   * lookup is being made, and the request is entitled to its Session in every state a Session can
   * be in — which is the whole repair this unit makes.
   *
   * The id is the authority, because the id IS the request: nothing else can hold it. Owner and
   * task are CHECKED rather than filtered on, so a row that belongs to something else is reported
   * as absent and refused by the caller instead of being handed over as this caller's run.
   *
   * And the task check is only a collision guard, so it holds its tongue when the task is GONE.
   * `session_task_id_fkey` is `ON DELETE SET NULL`: deleting a task tombstones its runs rather than
   * destroying them, and requiring `task_id` to still match would make this request unable to find
   * the Session IT CREATED — after which it would try to create a second one against a task that no
   * longer exists and fail on the foreign key, for ever, under a token that can never answer. A
   * null `task_id` is not somebody else's row; it is this row, outliving what it ran.
   */
  private async readOwnRun(
    ownerId: string,
    task: TaskRunTarget,
    desiredSessionId: string,
  ): Promise<{ id: string; status: RunStatus } | null> {
    const row = await this.prisma.session.findUnique({
      where: { id: desiredSessionId },
      select: { id: true, taskId: true, ownerId: true, status: true },
    });
    if (!row || row.ownerId !== ownerId) return null;
    if (row.taskId != null && row.taskId !== task.id) return null;
    return { id: row.id, status: row.status };
  }

  /**
   * §13.8: work off the @-mention delivery ledger.
   *
   * At-least-once with an idempotent landing. Three things make it exactly-once in effect:
   *
   *  - `(comment_id, workspace_id)` is unique, so there is one row per mention however many
   *    comments, retries or workers exist;
   *  - the turn carries a FIXED `clientTurnId` derived from the delivery id, and
   *    `conversation_turn (session_id, client_turn_id)` is unique — so a worker that crashes
   *    between writing the turn and marking the row DELIVERED writes no second turn on retry;
   *  - the session it lands in is remembered on the row, so a retry continues the same
   *    conversation instead of opening another.
   *
   * Runs on the same timer as the other three sweeps (see `onModuleInit`) and is kicked directly
   * after a comment commits. The kick is an optimisation; the timer is the guarantee.
   */
  async deliverMentions(now = new Date()): Promise<void> {
    const holder = `${process.pid}:${randomUUID()}`;
    // Claim with SKIP LOCKED so two apiservers sweep the same table without either waiting, and
    // with a lease so a worker that dies mid-delivery frees its rows by expiry rather than
    // stranding them. `attempts` is spent HERE, on the claim: an attempt is a try, and a worker
    // that died having tried is not entitled to an unlimited number of them.
    // A delivery whose worker keeps dying before it can decide anything spends no budget and would
    // be re-leased for ever. `claims` bounds that: at the cap the row goes DEAD here, in the same
    // statement that would otherwise have handed it out again, so the loop cannot outlive it.
    await this.prisma.$executeRaw`
      UPDATE "task_comment_mention_delivery"
         SET "status" = 'DEAD',
             "error_code" = 'CLAIM_LOOP',
             "required_action" = 'inspect why the delivery worker is dying on this row, then re-file the mention',
             "last_error" = 'leased ' || "claims" ||
               ' times without reaching a decision — a worker is dying on this delivery',
             "lease_holder" = NULL, "lease_expires_at" = NULL, "updated_at" = ${now}
       WHERE "status" IN ('PENDING', 'DELIVERING', 'SESSION_CREATED', 'QUEUED', 'BLOCKED')
         AND "claims" >= ${MENTION_DELIVERY_MAX_CLAIMS}
         AND ("lease_expires_at" IS NULL OR "lease_expires_at" <= ${now})`;

    // ONE ROW PER CLAIM. A batch of twenty delivered serially would let the tail's lease expire
    // while the head was still working, and a second sweep would take rows this one still believes
    // it owns. Claiming one at a time makes the lease cover exactly the work it is protecting.
    const claimed: Array<{
      id: string; commentId: string; taskId: string; workspaceId: string; ownerId: string;
      attempts: number; desiredSessionId: string | null; targetSessionId: string | null;
    }> = [];
    for (let taken = 0; taken < MENTION_DELIVERY_PER_SWEEP; taken += 1) {
      const [row] = await this.prisma.$queryRaw<Array<{
        id: string; commentId: string; taskId: string; workspaceId: string; ownerId: string;
        attempts: number; desiredSessionId: string | null; targetSessionId: string | null;
      }>>(Prisma.sql`
        UPDATE "task_comment_mention_delivery" d
           SET "status" = 'DELIVERING',
               -- Only a lease that expired while still DELIVERING is a crash. A poll of a
               -- SESSION_CREATED row, or a retry of a BLOCKED one, is this system working — and
               -- counting those would drive a healthy delivery to DEAD by waiting for a runner.
               "claims" = d."claims" + CASE WHEN d."status" = 'DELIVERING' THEN 1 ELSE 0 END,
               "lease_holder" = ${holder},
               "lease_expires_at" = ${new Date(Date.now() + MENTION_DELIVERY_LEASE_MS)},
               "updated_at" = ${new Date()}
         WHERE d."id" = (
           SELECT c."id" FROM "task_comment_mention_delivery" c
            WHERE c."status" IN ('PENDING', 'DELIVERING', 'SESSION_CREATED', 'QUEUED', 'BLOCKED')
              AND c."next_attempt_at" <= ${now}
              AND c."claims" < ${MENTION_DELIVERY_MAX_CLAIMS}
              AND (c."lease_expires_at" IS NULL OR c."lease_expires_at" <= ${new Date()})
              AND NOT (c."id" = ANY (${claimed.map((d) => d.id)}::uuid[]))
            ORDER BY c."next_attempt_at", c."created_at"
            LIMIT 1
            FOR UPDATE SKIP LOCKED
         )
        RETURNING d."id", d."comment_id" AS "commentId", d."task_id" AS "taskId",
                  d."workspace_id" AS "workspaceId", d."owner_id" AS "ownerId",
                  d."attempts", d."desired_session_id" AS "desiredSessionId",
                  d."target_session_id" AS "targetSessionId"
      `);
      if (!row) break;
      claimed.push(row);
      try {
        const landed = await this.deliverOneMention(row, holder);
        // CAS on the lease. Zero rows means this worker's lease expired and somebody else owns the
        // row now — its DELIVERED, its DEAD or its target must not be overwritten by a worker that
        // has already been replaced. Stand down; the owner finishes the job.
        //
        // SESSION_CREATED, not DELIVERED, when the conversation exists but no turn does: the
        // runner has not claimed it yet, and 0131's CHECK refuses a DELIVERED with no turn.
        const settled = await this.prisma.$executeRaw`
          UPDATE "task_comment_mention_delivery"
             SET "status" = ${landed.consumed
                   ? 'DELIVERED'
                   : landed.turnId ? 'QUEUED' : 'SESSION_CREATED'}
                   ::"task_comment_mention_delivery_status",
                 "turn_id" = ${landed.turnId}::uuid,
                 "target_session_id" = ${landed.sessionId}::uuid,
                 -- The conversation exists; what has not happened yet is the runner claiming it
                 -- and seeding the prompt turn. That is waiting, not failing, so waits advances the
                 -- backoff and neither budget is touched. claims resets: this worker settled.
                 -- Anything short of consumed is a wait: the turn is queued, or the session has
                 -- not been claimed. Both advance the backoff and spend no budget.
                 "waits" = CASE WHEN ${landed.consumed} THEN "waits" ELSE "waits" + 1 END,
                 "claims" = 0,
                 "error_code" = NULL, "required_action" = NULL, "last_error" = NULL,
                 "lease_holder" = NULL, "lease_expires_at" = NULL,
                 -- Backoff on the wait generation, not a fixed poll. A runner that is offline, or
                 -- a queue that has stalled, would otherwise be asked every fifteen seconds for
                 -- ever — a hot loop whose only output is load. Waiting still costs no budget.
                 "next_attempt_at" = CASE WHEN ${landed.consumed} THEN "next_attempt_at"
                   ELSE now() + make_interval(secs =>
                     LEAST(${MENTION_DELIVERY_MAX_BACKOFF_MS} / 1000.0,
                           ${MENTION_DELIVERY_TURN_POLL_MS} / 1000.0
                             * power(2, LEAST(12, "waits")))) END,
                 "updated_at" = ${new Date()}
           WHERE "id" = ${row.id}::uuid
             AND "status" = 'DELIVERING' AND "lease_holder" = ${holder}`;
        if (settled === 0) {
          this.logger.warn(`mention delivery ${row.id} was taken over mid-flight; standing down`);
        } else {
          // §13.8's state is shown on the task, so a change to it is a change to the task. Without
          // this an open panel only refreshes while a session is busy, and a delivery that went
          // BLOCKED or DELIVERED in between would sit there stale — a status nobody sees change is
          // barely better than the log line it replaced.
          this.realtime.publishForUser(row.ownerId, RunEventType.TASK_CHANGED, row.taskId);
        }
      } catch (error) {
        await this.parkMentionDelivery(row, holder, error);
      }
    }
    return;

  }

  /**
   * Record why a delivery did not land, and when to try again.
   *
   * Two kinds of "not now", and only one of them spends the budget:
   *
   *   AVAILABILITY — no runner bound, a provider down, a project mid-reconcile. None of these is
   *     the mention's fault and all clear by themselves, so the attempt is REFUNDED. Eight tries at
   *     a rising backoff is about twenty minutes, and a runner being down for an afternoon is not
   *     a reason to give up on a message somebody sent;
   *   everything else — a real refusal. The budget is finite so a permanently undeliverable row
   *     ends up DEAD and visible rather than retried for ever.
   *
   * The park itself is CAS'd on the lease for the same reason the success path is.
   */
  private async parkMentionDelivery(
    delivery: { id: string; attempts: number; ownerId: string; taskId: string },
    holder: string,
    error: unknown,
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : String(error);
    const code = error instanceof MentionUndeliverable ? error.code : 'DELIVERY_FAILED';
    const availability = error instanceof MentionUndeliverable && error.availability;
    const requiredAction = error instanceof MentionUndeliverable ? error.requiredAction : null;
    // Both counters move INSIDE the CAS, and DEAD is decided from what the database actually wrote.
    // Computing either from the value this worker read would be a lost update the moment two
    // workers touch one row — and would put "is the budget spent" a generation behind the counter
    // that answers it.
    //
    // Availability advances `waits` (the backoff) and leaves `attempts` alone, so a runner that is
    // down for an afternoon costs a message nothing. Everything else spends the budget.
    const [parked] = await this.prisma.$queryRaw<Array<{ attempts: number; status: string }>>(
      Prisma.sql`
        UPDATE "task_comment_mention_delivery"
           SET "attempts" = "attempts" + ${availability ? 0 : 1},
               "waits" = "waits" + ${availability ? 1 : 0},
               "status" = CASE
                 -- A condition that cannot change ends it now. Retrying a deleted agent seven more
                 -- times is a spinner pretending to be a mechanism.
                 WHEN ${MENTION_DELIVERY_TERMINAL_CODES.includes(code)}
                   THEN 'DEAD'::"task_comment_mention_delivery_status"
                 WHEN ${availability} THEN 'BLOCKED'::"task_comment_mention_delivery_status"
                 WHEN "attempts" + 1 >= ${MENTION_DELIVERY_MAX_ATTEMPTS}
                   THEN 'DEAD'::"task_comment_mention_delivery_status"
                 ELSE 'BLOCKED'::"task_comment_mention_delivery_status"
               END,
               -- A landing that is spent releases its binding, so the retry picks a new one
               -- instead of returning to a session that has already ended with the message unread.
               "desired_session_id" = CASE WHEN ${MENTION_DELIVERY_REBIND_CODES.includes(code)}
                 THEN NULL ELSE "desired_session_id" END,
               "target_session_id" = CASE WHEN ${MENTION_DELIVERY_REBIND_CODES.includes(code)}
                 THEN NULL ELSE "target_session_id" END,
               "turn_id" = CASE WHEN ${MENTION_DELIVERY_REBIND_CODES.includes(code)}
                 THEN NULL ELSE "turn_id" END,
               "error_code" = ${code},
               "required_action" = ${requiredAction},
               "last_error" = ${reason.slice(0, 2_000)},
               "next_attempt_at" = now() + make_interval(secs =>
                 LEAST(${MENTION_DELIVERY_MAX_BACKOFF_MS} / 1000.0,
                       10 * power(2, LEAST(20, ${availability ? 0 : 1} * "attempts" + "waits")))),
               -- Reaching a decision is proof this worker did not crash, so the CONSECUTIVE
               -- crash count starts again. Without the reset, sixty-four ordinary waits for a
               -- runner would eventually be indistinguishable from sixty-four dying workers.
               "claims" = 0,
               "lease_holder" = NULL, "lease_expires_at" = NULL, "updated_at" = ${new Date()}
         WHERE "id" = ${delivery.id}::uuid
           AND "status" = 'DELIVERING' AND "lease_holder" = ${holder}
        RETURNING "attempts", "status"::text AS "status"
      `,
    );
    if (!parked) return;
    this.realtime.publishForUser(delivery.ownerId, RunEventType.TASK_CHANGED, delivery.taskId);
    this.logger.warn(
      `mention delivery ${delivery.id} ${parked.status === 'DEAD' ? 'gave up' : 'parked'} ` +
        `(${code}) after ${parked.attempts} attempt(s): ${reason}`,
    );
  }

  /**
   * Put one mention in front of one agent, at-least-once with an idempotent landing.
   *
   * The ORDER is the whole design, and every step is written so a crash between any two of them
   * leaves a state the next attempt reads correctly:
   *
   *  1. bind the target session id FIRST, under the lease. A crash after this leaves a binding and
   *     no session; the retry creates the session with the SAME id. A crash after the create
   *     leaves both, and the retry finds the session. Binding afterwards — which is what this did
   *     first — meant a crash in between opened a second conversation on every retry;
   *  2. deliver the turn under a FIXED `clientTurnId` derived from the delivery id. A crash before
   *     the ledger is marked writes no second turn, because `(session_id, client_turn_id)` is
   *     unique;
   *  3. the caller marks DELIVERED, CAS'd on the lease.
   *
   * A remembered target that has since ENDED is never revived — §13.6's rule about history applies
   * to conversations too. If the fixed turn is already in it the delivery is simply complete; if
   * not, a new conversation is opened and the binding moves.
   */
  private async deliverOneMention(
    // Reassigned once: a remembered target that ended is rotated away from, and the fresh-create
    // path below must not then reuse its id.
    // eslint-disable-next-line no-param-reassign
    delivery: {
      id: string; commentId: string; taskId: string; workspaceId: string; ownerId: string;
      desiredSessionId: string | null; targetSessionId: string | null;
    },
    holder: string,
  ): Promise<{ sessionId: string; turnId: string | null; consumed: boolean }> {
    // LEFT JOIN on the workspace, scoped to the owner: the mentioned id is a snapshot and may name
    // an agent that has since been deleted, or (on a hand-written comment) one belonging to
    // somebody else. Either is a fact to record, not a row to skip.
    const [comment] = await this.prisma.$queryRaw<Array<{
      body: string; taskTitle: string; workspaceModel: string | null; runnerId: string | null;
      workspaceExists: boolean; workspaceEnabled: boolean;
    }>>(Prisma.sql`
      SELECT c."body", t."title" AS "taskTitle",
             w."model" AS "workspaceModel", w."runner_id" AS "runnerId",
             (w."id" IS NOT NULL) AS "workspaceExists",
             COALESCE(w."enabled", false) AS "workspaceEnabled"
        FROM "task_comment" c
        JOIN "task" t ON t."id" = c."task_id"
        LEFT JOIN "workspace" w
          ON w."id" = ${delivery.workspaceId}::uuid
         AND w."owner_id" = ${delivery.ownerId}::uuid
         AND w."deleted_at" IS NULL
       WHERE c."id" = ${delivery.commentId}::uuid
    `);
    if (!comment) throw new MentionUndeliverable('COMMENT_GONE', 'the comment no longer exists');
    if (!comment.workspaceExists) {
      // Terminal, and NOT an availability wait: a deleted agent does not come back, so retrying is
      // pretending. The row stays as the record that this mention was made and could not be
      // delivered — which is precisely what the old cascade destroyed.
      throw new MentionUndeliverable(
        'WORKSPACE_GONE',
        'the mentioned agent no longer exists',
        false,
        'mention an agent that still exists, in a new comment',
      );
    }
    if (!comment.workspaceEnabled) {
      // Availability: an agent can be disabled and re-enabled, and `SessionsService.create` refuses
      // one with a plain Forbidden. Left unmapped that reads as a delivery failure and spends the
      // budget — eight tries and DEAD — for a switch somebody flips back.
      throw new MentionUndeliverable(
        'WORKSPACE_DISABLED',
        'the mentioned agent is disabled',
        true,
        're-enable this agent; the mention then delivers itself with no further action',
      );
    }
    if (!comment.runnerId) {
      // Availability, not failure: binding a runner clears it, and the budget is not spent.
      throw new MentionUndeliverable(
        'NO_RUNNER',
        'the mentioned agent is not bound to a runner',
        true,
        'bind this agent to a runner; the mention then delivers itself with no further action',
      );
    }

    const clientTurnId = `task-comment-mention:${delivery.id}`;
    // The task id is spelled out, in Base62, in the instruction itself — not left to
    // `ORBIT_TASK_ID`. The runner does inject it for a conversation session (queue.service reads
    // `context_task_id` for exactly this), and belt-and-braces is right here: an agent that answers
    // a comment against the wrong task, or asks which task this is, is a delivery that arrived and
    // still failed.
    const publicTaskId = uuidToBase62(delivery.taskId);
    const prompt =
      `你在任务「${comment.taskTitle}」(${publicTaskId}) 的评论区被 @ 提到。\n\n` +
      `评论内容：\n${comment.body}\n\n` +
      `请用 task_get(taskId: "${publicTaskId}") 查看该任务的完整信息与历史评论，` +
      `并用 task_comment(taskId: "${publicTaskId}", body: ...) 在该任务下回复。`;

    // Step 0: where this is going. A remembered binding wins, then the agent's own live run on the
    // task, then a new conversation.
    // Either column can name the session a previous attempt used: `target_session_id` once it
    // existed, `desired_session_id` from the moment it was intended. Both are consulted so a crash
    // in the window between them still finds the same conversation.
    // DESIRED WINS. Both columns can name a session, and when they differ the desired one is the
    // newer intent: a rotation away from an ended conversation writes the new id there and clears
    // the old target in the same statement. Reading `target` first would make a crash between that
    // rotation and the create come back to the row it had already rotated away from — and mint a
    // third id.
    let rememberedId = delivery.desiredSessionId ?? delivery.targetSessionId;
    const remembered = rememberedId
      ? await this.prisma.session.findFirst({
        where: { id: rememberedId, ownerId: delivery.ownerId },
        select: { id: true, status: true, deletedAt: true, contextTaskId: true },
      })
      : null;
    if (remembered) {
      // WHOSE session this is decides everything below, and it is read off the row rather than
      // inferred from its status.
      //
      // `context_task_id` is set only on a conversation this delivery opened. Such a session
      // ALREADY CARRIES the message — it is the opening prompt — and the ONLY turn that can be this
      // delivery's receipt is that opening one. A pre-existing WORK run is the opposite: its
      // opening prompt is the task's own instructions, and reading it as a receipt would mark the
      // mention delivered without ever having sent it. So each shape recognises exactly one key.
      const ours = remembered.contextTaskId === delivery.taskId;
      const receiptKey = ours
        ? SessionsService.initialTurnClientId(remembered.id)
        : clientTurnId;
      const already = await this.prisma.conversationTurn.findFirst({
        where: { sessionId: remembered.id, clientTurnId: receiptKey },
        select: { id: true, status: true, deliveredAt: true },
      });
      if (already) {
        // EXISTING is not DELIVERED. A turn still `PENDING` is durably queued and nothing more —
        // its session can fail before the engine ever reads it, and a work session that dies on
        // seq 1 leaves this one sitting in the table unread for ever.
        //
        // `deliveredAt` is the ONLY receipt. The inbox stamps it when the runner takes the turn, so
        // it is the moment the message stopped being ours and became the engine's — and it is the
        // one field nothing else writes.
        //
        // `status` is deliberately NOT a fallback, tempting as it looks. Finalize, the reaper's
        // drain and the failure paths settle a session's outstanding turns in bulk: those rows come
        // out ANSWERED with `delivered_at` still NULL, having been read by nobody. Accepting a
        // status would call every one of those delivered, which is the exact failure this ledger
        // was built to remove, reintroduced by a defensive `||`.
        //
        // A session that has ended with its turn unstamped is therefore stranded, whatever status
        // the teardown left on it: the ledger says so and the sweep re-homes the message.
        const consumed = already.deliveredAt != null;
        if (consumed) return { sessionId: remembered.id, turnId: already.id, consumed: true };
        const alive = !remembered.deletedAt
          && (SessionsService.LIVE.includes(remembered.status)
            || remembered.status === RunStatus.PENDING);
        if (alive) return { sessionId: remembered.id, turnId: already.id, consumed: false };
        throw new MentionUndeliverable(
          'TURN_STRANDED',
          `the run this mention was queued in (${uuidToBase62(remembered.id)}) ended before ` +
            'reading it',
          true,
          'no action needed — the mention will be re-delivered into a fresh conversation',
        );
      }

      // No receipt yet.
      //
      // Ours, and still going: WAIT. The prompt is on the row, and `ensurePromptSeeded` writes the
      // turn when the runner claims the session. Between the claim (PENDING → RUNNING) and that
      // seed the row is live and turn-less, and sending into it there would deliver the same text a
      // second time, beside the opening prompt it is about to grow.
      const live = !remembered.deletedAt
        && (SessionsService.LIVE.includes(remembered.status)
          || remembered.status === RunStatus.PENDING);
      if (ours && live) return { sessionId: remembered.id, turnId: null, consumed: false };
      if (live) {
        // A run that existed BEFORE this delivery. The comment is owed a turn of its own under the
        // fixed key — `createTurn` rather than `resume`, because this session is live and a revive
        // is not what is wanted; `resume` delegates to exactly that for a live row, and would
        // refuse a PENDING one outright.
        return this.enqueueMentionTurn(delivery.ownerId, remembered.id, clientTurnId, prompt);
      }
      // Terminal, or trashed, with nothing delivered into it. A terminal Session is what that run
      // WAS, and reviving it to carry a comment rewrites that record. Rotate: mint the next id and
      // publish it — clearing the old target in the SAME statement, so a crash immediately after
      // comes back to the rotation rather than to the row it rotated away from.
      const rotated = randomUUID();
      const moved = await this.prisma.$executeRaw`
        UPDATE "task_comment_mention_delivery"
           SET "desired_session_id" = ${rotated}::uuid,
               "target_session_id" = NULL, "turn_id" = NULL,
               "last_error" = ${`ROTATED: ${uuidToBase62(remembered.id)} ended (${remembered.status}) before carrying this mention`},
               "updated_at" = ${new Date()}
         WHERE "id" = ${delivery.id}::uuid
           AND "status" = 'DELIVERING' AND "lease_holder" = ${holder}`;
      if (moved === 0) {
        throw new MentionUndeliverable('LEASE_LOST', 'another worker owns this delivery now', true);
      }
      delivery = { ...delivery, desiredSessionId: rotated, targetSessionId: null };
      rememberedId = null;
    }

    // Only when nothing has been intended yet. A delivery that already has a desired id is
    // finishing that create, not choosing a different landing.
    if (!rememberedId) {
      const liveWork = await this.prisma.session.findFirst({
        where: {
          taskId: delivery.taskId,
          workspaceId: delivery.workspaceId,
          ownerId: delivery.ownerId,
          deletedAt: null,
          startsTaskWork: true,
          status: { in: [...SINGLE_RUN_DEDUP, RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED] },
        },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (liveWork) {
        // BIND FIRST, then deliver. The other order loses the binding to a crash and sends the
        // mention into a second session on the retry.
        await this.bindMentionTarget(delivery.id, holder, liveWork.id);
        // `createTurn`, not `resume`: this row is live, the turn belongs on the running
        // conversation, and `startsTaskWork` is deliberately not passed — answering a comment never
        // relabels somebody else's run as the task's work.
        return this.enqueueMentionTurn(delivery.ownerId, liveWork.id, clientTurnId, prompt);
      }
    }

    // A conversation of its own. `taskId` is deliberately NULL — see this method's doc — and the id
    // is REUSED from a previous attempt when there was one: `desired_session_id` is written before
    // the session exists, so a crash between the two retries with the same id and the create either
    // succeeds or collides with the row it already wrote.
    const seed = await agentProviderSeed(this.prisma, delivery.workspaceId);
    // The agent's provider has to be one it can actually run on RIGHT NOW. A configured provider
    // that has since been disabled or deleted must stop this delivery, not be quietly dropped from
    // the create — omitting it would inherit the default and answer the comment on Claude in an
    // agent's name, which is a worse outcome than waiting.
    //
    // Availability, so the delivery budget is untouched: re-enabling the provider clears it.
    if (!Object.values(AgentProvider).includes(seed.provider as AgentProvider)) {
      const usable = await this.prisma.modelProvider.findFirst({
        where: {
          slug: seed.provider, enabled: true,
          OR: [{ ownerId: null }, { ownerId: delivery.ownerId }],
        },
        select: { slug: true },
      });
      if (!usable) {
        throw new MentionUndeliverable(
          'PROVIDER_UNAVAILABLE',
          `this agent runs on "${seed.provider}", which is disabled or no longer configured`,
          true,
          `re-enable the "${seed.provider}" provider, or point this agent at one that is enabled; ` +
            'the mention then delivers itself',
        );
      }
    }
    const sessionId = delivery.desiredSessionId ?? randomUUID();
    await this.bindMentionTarget(delivery.id, holder, sessionId);
    try {
      await this.createMentionSession(
        delivery, sessionId, prompt, comment.taskTitle, seed, comment.workspaceModel,
      );
    } catch (error) {
      // The engine is signed out on a machine that is otherwise up. A 409, but an AVAILABILITY
      // one: signing in clears it and the mention delivers itself. Recognised by type — matching
      // the message would break the first time somebody improved the wording.
      if (isEngineSignedOut(error)) {
        throw new MentionUndeliverable(
          'PROVIDER_UNAVAILABLE',
          `the ${error.runtime} engine is signed out on this agent's runner`,
          true,
          `sign in to ${error.runtime} on that runner; the mention then delivers itself`,
        );
      }
      throw error;
    }
    // A fresh session's opening prompt IS the delivery, and its first turn is seeded by the runner
    // when it claims the session — so `turn_id` stays NULL and the row sits at SESSION_CREATED
    // until it appears. A column that names a turn must name one that exists.
    return { sessionId, turnId: null, consumed: false };
  }

  /** The conversation itself, split out so the availability mapping above reads as one thing. */
  private async createMentionSession(
    delivery: { ownerId: string; workspaceId: string; taskId: string },
    sessionId: string,
    prompt: string,
    taskTitle: string,
    seed: { provider: string },
    model: string | null,
  ): Promise<void> {
    await this.sessions.create(
      delivery.ownerId,
      {
        prompt,
        workspaceId: delivery.workspaceId,
        title: `回应评论：${taskTitle}`,
        // The MENTIONED AGENT's own seed, never the task's. This session is not running the task,
        // and pinning it to the task's engine would answer a comment on a runtime the agent was
        // never configured for.
        //
        // A workspace holds no provider column (migration 0088): the seed is derived from that
        // agent's own last session, which is exactly what the New Session screen shows for it.
        ...(seed ? { provider: seed.provider } : {}),
        ...(model != null ? { model } : {}),
      } as never,
      {
        source: 'user',
        dispatchOrigin: SessionDispatchOrigin.USER,
        runSource: SessionRunSource.MANUAL,
        startsTaskWork: false,
        contextTaskId: delivery.taskId,
        id: sessionId,
        // A conversation about a task needs no branch and no worktree. Creating one would leave an
        // unmerged branch behind for a reply to a comment, which reads as work nobody finished.
        noWorktree: true,
      },
    );
  }

  /**
   * Put the mention's turn on a session that was live when this worker looked at it.
   *
   * The look was unlocked, so it is a guess: a run can reach a terminal status between the read and
   * the write, and `createTurn` — which takes the session row and re-checks its lifecycle — refuses
   * when it does. That refusal is not a failed delivery and must not spend the budget; it means
   * this landing is spent and the message needs another one.
   *
   * Re-read before deciding, because the same refusal covers two worlds: a turn this worker already
   * wrote before dying (in which case the delivery is queued and nothing is owed), and a session
   * that ended with nothing on it (in which case `TURN_STRANDED` releases the binding and the sweep
   * opens a fresh conversation). Neither touches the ended run, which keeps every field it has.
   */
  private async enqueueMentionTurn(
    ownerId: string,
    sessionId: string,
    clientTurnId: string,
    prompt: string,
  ): Promise<{ sessionId: string; turnId: string | null; consumed: boolean }> {
    try {
      const turn = await this.sessions.createTurn(ownerId, sessionId, {
        clientTurnId, content: prompt,
      } as never);
      // Just written, so it is unstamped by construction: queued, not yet seen.
      return { sessionId, turnId: turn.turnId, consumed: false };
    } catch (error) {
      if (isTaskWorkFence(error)) throw error;
      const already = await this.prisma.conversationTurn.findFirst({
        where: { sessionId, clientTurnId },
        select: { id: true, deliveredAt: true },
      });
      if (already) {
        return { sessionId, turnId: already.id, consumed: already.deliveredAt != null };
      }
      // Only a session that cannot take the message is a spent landing. `createTurn` fails for
      // ordinary reasons too — an oversized prompt, a database that is down, an owner that no
      // longer matches — and re-homing on those would spin the message between fresh sessions
      // forever while hiding the failure that actually needs reporting. So: believe the typed
      // refusal, which was decided under the row lock; for anything else look at the row, and if
      // it is still able to take a message, this was a real failure and must surface as one.
      if (!(error instanceof SessionNotSendable)) {
        const now = await this.prisma.session.findFirst({
          where: { id: sessionId },
          select: { status: true, deletedAt: true, cancelRequestedAt: true },
        });
        const spent = !now || now.deletedAt != null || now.cancelRequestedAt != null
          || SessionsService.TERMINAL.includes(now.status);
        if (!spent) throw error;
      }
      throw new MentionUndeliverable(
        'TURN_STRANDED',
        `the run this mention was going into (${uuidToBase62(sessionId)}) stopped accepting ` +
          `messages first: ${error instanceof Error ? error.message : String(error)}`,
        true,
        'no action needed — the mention will be re-delivered into a fresh conversation',
      );
    }
  }

  /**
   * Remember where a delivery is going, BEFORE it goes there.
   *
   * Writes `desired_session_id`, which carries no foreign key — deliberately, because the row it
   * names does not exist yet, and that is the entire point: a crash between this and the create
   * retries with the same id instead of opening a second conversation. `target_session_id` is the
   * FK'd column and is written once the session is real.
   *
   * CAS'd on the lease like every other ledger write: a worker whose lease expired must not move a
   * target the new owner is already using.
   */
  private async bindMentionTarget(
    deliveryId: string,
    holder: string,
    sessionId: string,
  ): Promise<void> {
    const bound = await this.prisma.$executeRaw`
      UPDATE "task_comment_mention_delivery"
         SET "desired_session_id" = ${sessionId}::uuid, "updated_at" = ${new Date()}
       WHERE "id" = ${deliveryId}::uuid
         AND "status" = 'DELIVERING' AND "lease_holder" = ${holder}`;
    if (bound === 0) {
      throw new MentionUndeliverable(
        'LEASE_LOST', 'another worker owns this delivery now', true,
      );
    }
  }


  /**
   * DECIDE what this request will do, without doing any of it.
   *
   * Split from the doing so the decision can be written down first. Everything read here is
   * mutable — which run holds the task, whether one is parked, what the task is pinned to — so a
   * delivery that re-decided after a crash would answer something else: the run it started has
   * ended, or a second one was opened, or the pin changed. The plan is what a takeover repeats.
   */
  private async planWorkspaceRun(
    ownerId: string,
    task: TaskRunTarget,
    workspace: { id: string; runnerId: string | null },
    requestToken: string,
  ): Promise<TaskRunPlan> {
    // THE NAME COMES FIRST, and every branch below is decided against it.
    //
    // It is a pure function of the token this call was made under, so two doors racing over one
    // task compute the same name and collapse onto one run — and a caller repeating a request it
    // never got an answer to gets its own Session back, whatever status that run has reached.
    // `task-run-identity` carries the whole argument, including why the token has to be CARRIED
    // rather than derived from anything the database knows.
    const desiredSessionId = taskRunDesiredSessionId(
      taskRunRequestKey({ taskId: task.id, requestToken }),
    );
    // A run already mid-flight (PENDING/RUNNING) on this task. A session parked at
    // AWAITING_INPUT/INTERRUPTED is deliberately excluded (see SINGLE_RUN_DEDUP): it is idle, so it
    // falls through to the resume path below and is handed the prompt as a new turn rather than
    // no-oping (which is why "开始执行" on a parked task used to do nothing).
    //
    // Spelled with the claim index's own `deleted_at IS NULL` and with no `orderBy`: at most one
    // row can satisfy this, because `session_task_execution_claim_idx` says so, and ordering a set
    // that cannot have two members only invites a reader to think it can.
    const occupying = await this.prisma.session.findFirst({
      where: {
        taskId: task.id, deletedAt: null, status: { in: SINGLE_RUN_DEDUP }, startsTaskWork: true,
      },
      // Everything the refusal names, so this door and the post-conflict one describe the row in
      // the way identically rather than one of them guessing.
      select: {
        id: true, status: true, workspaceId: true, provider: true, model: true,
        startsTaskWork: true, cancelRequestedAt: true,
      },
    });
    if (occupying) {
      // WHOSE run is it? This used to return the id unconditionally — "the work is already under
      // way, so this call is idempotent" — which is true of THIS request's own run and false of
      // anybody else's. A different press, a sweep, a batch: each got somebody else's session id
      // reported to it as its own start, went on to record a manual Project request for it and to
      // spend the task's schedule, while the prompt it was carrying was never delivered.
      //
      // The name decides, and it is the same rule the conflict path below applies: this request's
      // Session, or a refusal that names the row in the way.
      if (occupying.id === desiredSessionId) return { kind: 'ADOPT', sessionId: occupying.id };
      // ...or a run this request already DELIVERED to. A press that finds the task paused hands it
      // the prompt as a turn on somebody else's Session (below), so that request's durable result
      // is the TURN, not a Session of its own — and by the time a repeat of it arrives, the run it
      // woke is live again and would be refused as foreign. `conversation_turn (session_id,
      // client_turn_id)` is unique and the key is the request, so this is an exact read of what
      // this request already did rather than an inference from what the task looks like now.
      if (await this.hasDeliveredResumeTurn(requestToken, occupying.id)) {
        return { kind: 'ADOPT', sessionId: occupying.id };
      }
      // The SAME refusal the post-conflict path gives, from the same builder. Two doors onto one
      // fact answered in two shapes is how a client ends up parsing English to tell them apart.
      throw this.foreignClaimRefusal(task, workspace, occupying);
    }
    // A CONVERSATION session on this task is not a reason to refuse: since 0130 the execution claim
    // covers work sessions only, so it holds nothing and a run can start beside it. That is what
    // lets an @-mention and a run coexist, and what lets two agents each hold their own
    // conversation about one task.
    // The candidate to CONTINUE is a run that is still going, never one that has ended.
    //
    // This used to be "the latest session on this task", terminal or not, and a terminal one was
    // resumed — a real FAILED, SUCCEEDED or CANCELLED row written back to live, with its status,
    // its `finished_at` and its runtime thread rewritten. That contradicts the rule this whole unit
    // is built on: a failure keeps the status its run left, a replacement is a NEW attempt, and the
    // old run stays readable as what it was. It is also the mechanism §13.6 SU6 kept having to
    // defend against from the other side — every "can this revive be refused" question exists
    // because a revive was reachable here at all.
    //
    // So a new attempt gets a new Session, related to the old one through the Task and, when it is
    // a replacement, through the supersession link. Only `AWAITING_INPUT` / `INTERRUPTED` — a run
    // that is paused, not finished — receives the prompt as a new turn, which is what "开始执行 on
    // a parked task" has always meant and the one case where continuing is continuing.
    const latest = await this.prisma.session.findFirst({
      where: {
        taskId: task.id,
        workspaceId: workspace.id,
        ownerId,
        deletedAt: null,
        status: { in: [RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED] },
        // A paused WORK run is the one this call continues. A paused conversation is somebody
        // else's thread about the task, and handing it the task's prompt would hijack it.
        startsTaskWork: true,
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, provider: true },
    });
    // This request's OWN paused run — the only way that row can carry this name is that this same
    // request created it, so this call is a repeat of the one that did. Its prompt was delivered
    // when the Session was written; delivering it again would put the task's brief in front of the
    // agent twice for one press. The request already has its answer: the Session.
    if (latest?.id === desiredSessionId) return { kind: 'ADOPT', sessionId: latest.id };
    // ...and a paused run this request has already spoken to. `resume` would collapse on the same
    // key anyway — that is what makes the delivery exactly-once — but reading it first keeps a
    // repeat from re-entering the whole resume path (its worktree checks, its lifecycle refusals)
    // for a turn that is already on the row.
    if (latest && await this.hasDeliveredResumeTurn(requestToken, latest.id)) {
      return { kind: 'ADOPT', sessionId: latest.id };
    }
    // A session's provider is fixed for its lifetime — its runtime thread belongs to the CLI that
    // created it — so a task re-pinned to a different provider can't be continued on the old
    // session. Falling through to create() is what makes re-pinning take effect on the next run;
    // resuming instead would silently keep running the previous provider forever. A model change
    // needs no such split: resume() re-spawns the runtime and applies it.
    if (latest && task.provider && task.provider !== latest.provider) {
      // A session's provider is fixed for its lifetime, and the task has since been re-pinned. The
      // old behaviour fell through to create() — which, now that the execution claim covers all
      // four live statuses, cannot succeed: the paused run still holds the task. Say so instead of
      // failing on a unique index.
      throw new ConflictException(
        `task ${uuidToBase62(task.id)} has a paused run on ${latest.provider} and is now pinned to ` +
          `${task.provider}; a run cannot change provider. Let that run reach a terminal status of ` +
          'its own, and the next attempt will start on the new provider',
      );
    }
    if (latest) {
      return {
        kind: 'RESUME',
        sessionId: latest.id,
        // A STABLE key, and stable in the only way that survives this turn being ANSWERED.
        // `conversation_turn (session_id, client_turn_id)` is unique, so one key means one turn and
        // the loser of a race returns the winner's.
        //
        // It used to be derived from `numTurns`, which collapses concurrent duplicates and nothing
        // else: a delivery whose response was lost re-arrives after the turn it wrote has been
        // answered, reads a HIGHER count, derives a different key and puts the task's brief in
        // front of the agent a second time. The count moves; the press does not.
        turnId: taskRunResumeTurnId(requestToken, latest.id),
      };
    }
    // A fresh Session, and the execution claim decides the race. Two callers with no live run both
    // reach here; the unique index lets exactly one insert, and the loser reads back the winner
    // rather than surfacing a duplicate-key error — the outcome either of them wanted is "the task
    // is running", and it is.
    return { kind: 'CREATE', sessionId: desiredSessionId };
  }

  /**
   * DO exactly what the plan says, and nothing the plan does not say.
   *
   * Every branch is idempotent by the id the plan named: adopting is a no-op, a resume collapses on
   * `conversation_turn (session_id, client_turn_id)`, and a create either lands the row or reads
   * back the one already at that id. So a takeover can run this against a plan it did not make and
   * produce the same one effect.
   */
  private async applyWorkspaceRun(
    ownerId: string,
    task: TaskRunTarget,
    workspace: { id: string; runnerId: string | null },
    prompt: string,
    newSessionTitle: string,
    batch: { id: string; maxConcurrent: number } | undefined,
    provenance: {
      dispatchOrigin: SessionDispatchOrigin;
      runSource: SessionRunSource;
      startsTaskWork?: boolean;
    } | undefined,
    plan: TaskRunPlan,
    /**
     * The right to make this effect, presented AT THE WRITE rather than checked before it. The
     * lease fences who may bind a plan and who may freeze an answer; without this it does not fence
     * the effect itself, and a holder whose lease expired mid-flight still commits the Session a
     * takeover has already answered for.
     */
    fence?: TaskRunEffectFence,
  ): Promise<string> {
    // Already this request's run: nothing to do, and nothing that could be done twice.
    if (plan.kind === 'ADOPT') return plan.sessionId;
    if (plan.kind === 'RESUME') {
      // The durable half of the delivery, read by the key the plan fixed. `resume` would collapse
      // on the same key anyway — the unique index is what makes it exactly-once — but reading first
      // keeps a takeover out of the whole resume path for a turn that is already on the row.
      if (await this.hasTurn(plan.sessionId, plan.turnId)) return plan.sessionId;
      await this.sessions.resume(
        ownerId,
        plan.sessionId,
        {
          clientTurnId: plan.turnId,
          content: prompt,
          ...(task.model != null ? { model: task.model } : {}),
        },
        // §13.6 SU6: a paused run being handed the task's prompt IS doing the task's work, so the
        // row says so — otherwise a session first opened to look at the task keeps the salvage
        // exemption while executing it, and the reaper never follows the task's lifecycle for it.
        { batch: batch ?? null, startsTaskWork: true, fence },
      );
      return plan.sessionId;
    }
    const session = await this.createTaskSessionOrReadWinner(
      ownerId,
      task,
      workspace,
      plan.sessionId,
      fence,
      {
        prompt,
        workspaceId: workspace.id,
        taskId: task.id,
        title: newSessionTitle.slice(0, 80),
        // Unpinned (null) fields are left off entirely so the session keeps inheriting the
        // workspace's provider/model, exactly as before these columns existed.
        ...(task.provider != null ? { provider: task.provider } : {}),
        ...(task.model != null ? { model: task.model } : {}),
      },
      // Task runs belong in Active regardless of whether they were started manually,
      // as a batch, by dependency auto-run, or from an @-mention. Keep `source`
      // explicit so a future default change cannot silently move them back to System.
      {
        source: 'user',
        batch,
        dispatchOrigin: provenance?.dispatchOrigin ?? SessionDispatchOrigin.USER,
        runSource: provenance?.runSource ?? SessionRunSource.MANUAL,
        // Unconditionally true. Every caller of this method is starting the task's work — Run Now,
        // the schedule sweep, the dependency sweep, a batch — and none of them is somebody opening
        // a window onto a run that already happened. That is the distinction 0130's guard needs,
        // and asserting it here rather than per-caller is what keeps a future fifth caller from
        // quietly inheriting the salvage exemption.
        startsTaskWork: true,
      },
    );
    return session.id;
  }

  /**
   * Persist one manual-run request for every affected Project.
   *
   * The outbox row is the authoritative state of this user action, so there is no second business
   * row to coordinate with it, and the signal is named after the PRESS rather than after this call:
   * `taskRunManualTriggerId(token, projectId)`. That is the difference between a retry and a second
   * click. The id used to be a `randomUUID()` minted per call, so a press whose response was lost
   * recovered its Session correctly on replay — and recorded a second durable USER trigger, and a
   * second Coordinator wake, for the one press that produced it.
   *
   * Derived per Project rather than once for the whole press, because the outbox's unique key is
   * `(project_id, dedupe_key)`: one signal per Project per press, across every delivery of it.
   */
  private async recordManualProjectTriggers(
    ownerId: string,
    projectIds: Array<string | null | undefined>,
    /** The press this run request was made under — see `RunTaskDto.triggerId`. */
    requestToken: string,
    /** Which task's run recorded it. Audit only; the trigger is per Project, not per task. */
    taskId?: string,
  ): Promise<void> {
    const distinct = [...new Set(projectIds.filter((id): id is string => !!id))].sort();
    if (distinct.length === 0) return;
    // Retried whole, and safe because every id here is a pure function of the press and the
    // Project: an attempt after a transient failure — and a delivery after a lost response — writes
    // the same ledger row and enqueues the same signal.
    //
    // The LEDGER is what makes it exactly-once for the life of the request, and 0117's dedupe key
    // could not be: `project_event_open_dedupe_idx` is unique only while an event is UNCONSUMED, so
    // a delivery arriving after the Coordinator answered the first signal would enqueue a second
    // one under the same key — a second audited USER request, and a second wake, for one press.
    // `task_run_manual_trigger` outlives the signal, and the insert and the enqueue commit
    // together, so there is no state in which the press was recorded and the signal was not.
    await withTransactionRetry(this.prisma, async (tx) => {
      // CANONICAL ORDER FIRST, explicitly, before any write in here takes a lock implicitly.
      //
      // The marker insert's three foreign keys acquire `FOR KEY SHARE` on `project`, on `user` and
      // (when the audit column is set) on `task` — in whatever order PostgreSQL checks them, which
      // is not the order `docs/postgres-lock-order.md` fixes: user (10) -> project (40) -> task
      // (50). A transaction that takes project before user can wait on one that holds user and
      // wants a project key lock, and the cycle is closed by a writer nobody wrote a `FOR UPDATE`
      // for. Taking the same locks up front, in rank order and in the weakest mode that covers what
      // follows, leaves the foreign keys re-using locks this transaction already holds.
      //
      // One statement per relation with `ORDER BY id`, so a press spanning several Projects cannot
      // interleave project/task/project with another press going the other way.
      await tx.$executeRaw(Prisma.sql`
        SELECT 1 FROM "user" WHERE "id" = ${ownerId}::uuid FOR KEY SHARE`);
      await tx.$executeRaw(Prisma.sql`
        SELECT 1 FROM "project" WHERE "id" = ANY(${distinct}::uuid[]) ORDER BY "id" FOR KEY SHARE`);
      if (taskId) {
        await tx.$executeRaw(Prisma.sql`
          SELECT 1 FROM "task" WHERE "id" = ${taskId}::uuid FOR KEY SHARE`);
      }
      for (const projectId of distinct) {
        const requestId = taskRunManualTriggerId(requestToken, projectId);
        const recorded = await tx.$executeRaw(Prisma.sql`
          INSERT INTO "task_run_manual_trigger" ("project_id", "request_id", "owner_id", "task_id")
          VALUES (${projectId}::uuid, ${requestId}::uuid, ${ownerId}::uuid, ${taskId ?? null}::uuid)
          ON CONFLICT DO NOTHING
        `);
        // Nothing inserted means this press already recorded this Project's trigger — a repeat, or
        // the loser of two deliveries landing together. Either way the signal it would enqueue is
        // one that already exists or has already been answered.
        if (recorded === 0) continue;
        // The authoritative producer, called rather than reimplemented: every Project event is
        // enqueued by this function at the database write (migration 0117).
        await tx.$executeRaw(Prisma.sql`
          SELECT "project_event_manual_trigger"(
            ${projectId}::uuid,
            ${ownerId}::uuid,
            ${requestId}::uuid
          )
        `);
      }
    }, this.transientWriteRetry('tasks.recordManualProjectTriggers'));
  }

  /**
   * Manually kick off the task's responsible workspace from the "开始执行" button: same
   * resume-first-else-create flow as an @-mention, but as a user-facing action, so a
   * missing assignee / runner becomes a hard error instead of a silent skip.
   */
  async execute(
    ownerId: string,
    id: string,
    auto?: AutoDispatch,
    /**
     * What names this run REQUEST. A manual door passes the caller's `triggerId` — generated once
     * per press or per tool invocation and reused by every retry of it — and an automatic one
     * passes the durable fact it is acting on (`TASK_RUN_TRIGGER`).
     *
     * Absent, one is minted here. That is honest for a first press and it still makes two doors
     * racing over this task collapse onto a single run, because each names its own Session; what it
     * is NOT is lost-response idempotency. A token the caller never received is a token it cannot
     * send again, so a repeat of it is a new request and is treated as one.
     */
    requestToken?: string,
  ) {
    // THE RECEIPT, BEFORE EVERYTHING.
    //
    // Every check below this line reads something mutable — the task's status, its hold, its
    // prerequisites, its assignee and that agent's runner, its Project, whether it has been
    // superseded — and a delivery of one press that arrives after any of them moved would answer a
    // different thing from the delivery it repeats: a 400 where the first returned a Session, a
    // second Session where the first returned one, a second Project trigger on a Project the press
    // never named. Stable artifact ids cannot fix that, because the door refuses before it reaches
    // them. So a request that has already been answered is answered from its answer.
    const runRequestToken = requestToken ?? randomUUID();
    const lease = await this.leaseRunRequest(
      ownerId, TASK_RUN_ACTION.execute, runRequestToken, taskRunFingerprint.execute(id),
    );
    if (!lease.held) return lease.result as TaskRunAnswer;
    try {
      return await this.executeLeased(ownerId, id, auto, runRequestToken, lease);
    } catch (e) {
      // A refused request is not a frozen one. Nothing about "prerequisites are not complete" or
      // "this list is paused" is an answer the caller should be given again after they have fixed
      // it, so the lease goes back and the receipt stays OPEN — the same token asked again
      // re-evaluates. What it does NOT do is leave the request evaluable by two deliveries at once,
      // which is the property the lease exists for.
      //
      // Except when this delivery is no longer the one: `TaskRunFenceLost` comes from inside the
      // effect's own transaction, so nothing was written, and the request now belongs to whoever
      // took it over. The release below writes nothing in that case — it is fenced on the same
      // holder and attempt — and the honest answer is that somebody else is answering it.
      await this.releaseRunRequest(lease.claim).catch(() => undefined);
      if (e instanceof TaskRunFenceLost) {
        throw taskRunInProgress(TASK_RUN_ACTION.execute, runRequestToken);
      }
      throw e;
    }
  }

  /**
   * End a delivery that is not going to start anything, by RELEASING its hold.
   *
   * One of the two endings a stand-down may take — the other is `applyStandDownTarget`, which
   * freezes one — and §7.7 D5-b4(6) is the rule for choosing between them: freezing is sound
   * exactly when the token names a moment that can never come back, and releasing is what every
   * other case owes the request. It is a decision per refusal, not a house style.
   *
   * This is that other case, and every automatic refusal in `execute` except the stale epoch takes
   * it: a supersession link can be removed, a completion policy can go back to MANUAL, a Project's
   * coordinator can be turned off. None of those facts is in the epoch's transition table, so a
   * later delivery can legitimately re-derive this very token — and it must be allowed to evaluate
   * rather than be answered with a refusal from a world that has since changed back.
   *
   * What NEITHER ending may do is what a bare `return` from inside the lease does: leave the
   * receipt OPEN with a live holder, so the next delivery of the same durable token is told the
   * request is in progress by a process that has already answered it.
   */
  private async standDownReleasing<T>(
    lease: Extract<TaskRunLease, { held: true }>,
    answer: T,
  ): Promise<T> {
    await this.releaseRunRequest(lease.claim).catch(() => undefined);
    return answer;
  }

  /**
   * CARRY OUT a frozen stand-down: bind it, then answer from the plan in force.
   *
   * The same two steps `applyExecuteTarget` takes, and for the same reason rather than for symmetry:
   * 0137's `task_run_request_target_check` says a receipt that is not OPEN HAS a plan, because a
   * state that claims a decision was made and a plan that is missing are the same fact disagreeing
   * with itself. Freezing an OPEN receipt straight to `COMPLETED` violates it — correctly, and this
   * is what it was protecting: a delivery that dies between deciding "this moment is gone" and
   * recording that answer must leave a row the next delivery can finish, and a bound plan is that
   * row.
   *
   * Reached identically by the holder that decided it and by a takeover that read it off the
   * receipt, which is what makes "the same request, the same answer" a property of the code.
   */
  private async applyStandDownTarget(
    lease: Extract<TaskRunLease, { held: true }>,
    frozen: TaskRunStandDownTarget,
  ): Promise<TaskRunAnswer> {
    const bound = await this.bindRunRequest(lease.claim, frozen) as TaskRunTargetRecord | null;
    if (!bound) throw taskRunInProgress(lease.claim.actionKind, lease.claim.requestToken);
    // The plan in force may not be the one this call computed — a takeover may have bound its own —
    // and a plan that is not a stand-down is not this method's to carry out. Read off the row,
    // never assumed from the door that got here.
    if (!(bound.v === 1 && bound.kind === 'STAND_DOWN')) {
      throw taskRunUnreadableTarget(lease.claim.actionKind, lease.claim.requestToken);
    }
    // The plan is to write nothing, so carrying it out is exactly freezing its answer.
    return this.completeRunReceipt<TaskRunAnswer>(
      lease.claim, { ok: false as const, skipped: bound.reason },
    );
  }

  /**
   * `execute` with the right to answer this request in hand.
   *
   * Split out so the lease is released on exactly one path — every refusal below, and every
   * unexpected failure, leaves the request askable again rather than held by a delivery that is
   * gone.
   */
  private async executeLeased(
    ownerId: string,
    id: string,
    auto: AutoDispatch | undefined,
    runRequestToken: string,
    lease: Extract<TaskRunLease, { held: true }>,
  ): Promise<TaskRunAnswer> {
    // ALREADY DECIDED. Not one mutable check below this line may run again: the holder that passed
    // them wrote down what it decided with, and re-reading a world that has moved is how a repeat
    // of one press answers something the press never asked — a 400 where it got a Session, a second
    // Session where it got one, a trigger on a Project it never named.
    if (lease.status === 'BOUND') {
      const bound = lease.target as TaskRunTargetRecord;
      // Dispatched on what the row SAYS it is, never on which door read it: a bulk Run's plan and a
      // single run's are both `BOUND` receipts, and reading one as the other sends this takeover
      // looking for rows the request never named. Anything this binary does not recognise — a newer
      // version, a kind it has never heard of — is refused rather than guessed at: finishing
      // somebody else's command is worse than saying it cannot, and the replica that DOES
      // understand it still holds or will take the lease.
      if (bound?.v === 1 && bound.kind === 'RUN') return this.applyExecuteTarget(lease, bound);
      // A stand-down that was decided and bound but not yet frozen — its holder died in between.
      // The plan says the request writes nothing, so finishing it is recording that answer, which
      // is exactly what the holder was about to do.
      if (bound?.v === 1 && bound.kind === 'STAND_DOWN') {
        return this.applyStandDownTarget(lease, bound);
      }
      throw taskRunUnreadableTarget(lease.claim.actionKind, lease.claim.requestToken);
    }
    const task = await this.prisma.task.findFirst({
      where: { id, ownerId },
      select: {
        id: true,
        title: true,
        description: true,
        projectId: true,
        provider: true,
        model: true,
        status: true,
        listId: true,
        isForeman: true,
        verifiesTaskId: true,
        dispatchHold: true,
        dispatchAuthority: true,
        runAt: true,
        supersededByTaskId: true,
        terminalReason: true,
        // WHICH MOMENT this row is at (0137). An automatic delivery names one, and this is what it
        // is compared against — the fence below. Always present: the table is backfilled and seeded
        // by a trigger on every INSERT, the same guarantee `dependencyRevision` carries.
        dispatchEpoch: { select: { epoch: true } },
        // §13.1 AG6's two columns, plus the existence of one direct child. `take: 1` because the
        // question is existence, not a count — the parent of a hundred subtasks reads one row.
        completionPolicy: true,
        children: { where: { ownerId }, select: { id: true }, take: 1 },
        // §13.6 SU6's derived half: a check of replaced work is obsolete even when the check itself
        // is healthy. Read here so the refusal is a sentence, not a raw constraint violation from
        // 0130's guard several layers down.
        verifies: { select: { supersededByTaskId: true, terminalReason: true } },
        list: { select: { maxConcurrent: true, instructions: true } },
        assignee: { select: { id: true, runnerId: true } },
      },
    });
    if (!task) throw new NotFoundException('task not found');
    // THE MOMENT FENCE, and it is first because it decides whether this delivery has any business
    // evaluating the gates below at all. Only automatic triggers pass `auto`; an explicit Run Now is
    // a person deciding to start the work now, and there is no moment for it to be stale against.
    //
    // An automatic door names its request `<kind>:<task>:<epoch>` and carries the epoch its own
    // candidate scan read. If the row has moved to a later one, everything that scan concluded is
    // about a world that no longer exists — the appointment was replaced, the task reopened, a
    // prerequisite moved — and the pass that reads the NEW epoch is the one that gets to decide what
    // happens next. Starting anything here would take the execution claim under a name that belongs
    // to a moment that has passed, and the current moment's own request would then be refused as
    // "already running": the old event runs and the new one does not, which is the exact inversion
    // §7.7 D5-b4 exists to remove.
    //
    // FROZEN rather than released, and this is the one stand-down that may be. The epoch only ever
    // goes up, so this token names a moment that can never come back; every later delivery of it —
    // a redelivered sweep tick, a second replica that scanned before the change — is answering the
    // same gone moment and gets the same answer without touching a thing. Every other stand-down
    // below releases, because the fact that refused it can be un-done.
    const epoch = task.dispatchEpoch?.epoch ?? 0n;
    if (auto && !autoDispatchStillValid(epoch, auto.observedEpoch)) {
      return this.applyStandDownTarget(lease, {
        v: 1,
        kind: 'STAND_DOWN',
        taskId: task.id,
        reason: 'stale-epoch',
        observedEpoch: auto.observedEpoch.toString(),
        currentEpoch: epoch.toString(),
      });
    }
    // §13.6 SU6, BEFORE anything with an effect. Run Now used to reach the Session insert — which
    // 0130's guard deliberately allows, because the origin is USER and a person may open a run on a
    // replaced attempt — and only then reach `clearFailedForRetry`, whose `FAILED → IN_PROGRESS` a
    // retired row cannot legally take. The caller got a 500 with a Session already started against
    // it: the worst outcome available, since it is a half-success that looks like a failure.
    //
    // The exception this does NOT close is the deliberate one: an explicit session_create against a
    // retired task still works. Reading a replaced attempt or salvaging something from it is a
    // decision somebody is making. "Run this task's work again", which is what execute means, is
    // the claim SU6 refuses — the work is being done by the successor.
    const refusal = taskWorkRefusal({
      supersededByTaskId: task.supersededByTaskId,
      terminalReason: task.terminalReason,
      subjectSupersededByTaskId: task.verifies?.supersededByTaskId ?? null,
      subjectTerminalReason: task.verifies?.terminalReason ?? null,
    }, uuidToBase62);
    if (refusal) {
      // A stand-down still ends this delivery's hold. Released rather than frozen: a supersession
      // link can be removed, and the same durable fact arriving later must be able to evaluate
      // again rather than replay a refusal from a world that has since changed back.
      if (auto) {
        return this.standDownReleasing(lease, { ok: false as const, skipped: 'superseded' as const });
      }
      throw new ConflictException(`task ${uuidToBase62(id)}: ${refusal}`);
    }
    // §13.1 AG6, in the same position and for the same reason it holds in §7.8's pass and at the
    // authorization commit point: after the two answers about whether this row is still the work,
    // before every clause that can lift.
    //
    // The door this method IS: Run Now, `task_start`, `orbit task start`, the dependency-unlock
    // trigger, the auto-run sweep, the scheduled sweep, the foreman sweep and the verification
    // filer all reach the Session through here. `batchExecute` does NOT — it classifies and calls
    // `planWorkspaceRun`/`applyWorkspaceRun` itself, so it carries the same predicate in its own
    // skip loop. The one
    // gate neither can bypass is migration 0132's trigger on the Session insert.
    //
    // An automatic caller SKIPS, like every other automatic stand-down here; a person gets a 409
    // with the sentence, because a manual Run on an aggregate parent is a real request that cannot
    // be honoured rather than a sweep that has nothing to do.
    if (isAggregateParent({
      completionPolicy: task.completionPolicy,
      hasDirectChildren: task.children.length > 0,
    })) {
      if (auto) {
        return this.standDownReleasing(
          lease, { ok: false as const, skipped: 'aggregate-parent' as const },
        );
      }
      throw new ConflictException(
        `task ${uuidToBase62(id)}: this task is completed by aggregating its subtasks `
        + `(${task.completionPolicy}), so it has no work of its own to run — `
        + 'run its subtasks, or set its completion policy to MANUAL',
      );
    }
    if (auto && task.dispatchAuthority === 'COORDINATOR') {
      return this.standDownReleasing(
        lease, { ok: false as const, skipped: 'coordinator-authority' as const },
      );
    }
    const depFacts = (await this.dependencyFactsFor(ownerId, [id])).get(id) ?? [];
    const depState = computeDependencyState(depFacts);
    if (!canRun(depState)) {
      // §13.3 DEP: name the CHECK when a check is what refused. "Prerequisites are not all complete
      // yet" reads as a wait, and a verdict of FAIL is not one — it is a refusal with something to
      // go and do, and a person told to wait will simply click again.
      const gate = depFacts.find((fact) => fact.verificationGate != null)?.verificationGate;
      throw new BadRequestException(
        gate
          ? `A prerequisite cannot be treated as complete: ${verificationGateMessage(gate)}`
          : depState === 'BLOCKED_FAILED'
            ? 'A prerequisite was cancelled — resolve it before running'
            : 'Prerequisites are not all complete yet, cannot run',
      );
    }
    // The sweep already filters held tasks out in SQL; this is the manual button's half of the
    // same rule, so a pause cannot be quietly bypassed by clicking Run on a task inside one.
    // Reads the task's own hold, not its list's flag: the two must not be able to disagree, and
    // only one of them survives the list being deleted.
    if (task.dispatchHold) {
      throw new BadRequestException('This task list is paused — resume it before running');
    }
    if (!task.assignee) throw new BadRequestException('Assign a responsible workspace to the task first');
    if (!task.assignee.runnerId) throw new BadRequestException('The responsible workspace is not bound to a runner, cannot run');
    // The click is itself a durable semantic request to the Project coordinator. Record it only
    // after the run exists, NOT before it.
    //
    // It used to be written first, on the reasoning that a dispatch race would still leave a
    // truthful request for the coordinator. §13.6 SU6 makes that reasoning false: the run gates
    // above read the task before the transaction that starts it, and a supersession committing in
    // between makes the dispatch itself be refused — by 0130's guard, deterministically. Writing
    // the event first would then leave a durable USER request, and a Coordinator wake to answer it,
    // for a run that does not exist and never will. "Nothing happened" has to include the audit.
    //
    // Moved below the dispatch, the two failure directions are both honest: a refused dispatch
    // records nothing, and an event that fails to write leaves a session that is already running
    // and already announces itself through its own creation.
    const prompt = this.buildExecutePrompt(task);
    // The commit-point half of the pre-check above. A supersession — or a lock this transaction
    // cannot have — landing between them is refused by the database, and arrives here as a typed
    // marker rather than as a session. Translated so the caller sees the same 409 either way,
    // instead of a 500 that depends on how narrowly it lost the race.
    const planned = await this.planWorkspaceRun(
      ownerId,
      task,
      { id: task.assignee!.id, runnerId: task.assignee!.runnerId! },
      runRequestToken,
    );
    const frozen: TaskRunExecuteTarget = {
      v: 1,
      kind: 'RUN',
      plan: planned,
      taskId: task.id,
      title: `执行任务：${task.title}`,
      prompt,
      workspaceId: task.assignee!.id,
      runnerId: task.assignee!.runnerId!,
      provider: task.provider ?? null,
      model: task.model ?? null,
      projectId: task.projectId ?? null,
      // The list doubles as a durable batch so its cap is enforced by the claim transaction's
      // existing batch gate — no second scheduler. Only when the list actually sets a cap:
      // batch_id with a NULL batch_max_concurrent makes the gate's `count(*) < NULL` evaluate to
      // NULL, and the session would never be claimed at all.
      batch: task.listId && task.list?.maxConcurrent != null
        ? { id: task.listId, maxConcurrent: task.list.maxConcurrent }
        : null,
      dispatchOrigin: auto ? SessionDispatchOrigin.LEGACY_SWEEP : SessionDispatchOrigin.USER,
      runSource: auto ? SessionRunSource.TASK_LIST_AUTO : SessionRunSource.MANUAL,
      runAt: task.runAt ? task.runAt.toISOString() : null,
      clearFailed: task.status === TaskStatus.FAILED,
      auto: auto != null,
    };
    return this.applyExecuteTarget(lease, frozen);
  }

  /**
   * CARRY OUT a frozen command: bind it, apply it, apply its effects, freeze the answer.
   *
   * The only path that writes anything for a single run, reached identically by the holder that
   * planned it and by a takeover that read it off the receipt — which is what makes "the same
   * request, the same answer" a property of the code rather than of timing.
   */
  private async applyExecuteTarget(
    lease: Extract<TaskRunLease, { held: true }>,
    frozen: TaskRunExecuteTarget,
  ): Promise<TaskRunAnswer> {
    const { ownerId, requestToken } = lease.claim;
    // The plan in force. A holder that lost its lease mid-plan loses this compare-and-set to
    // whoever took over and gets THAT plan back; a `null` here means the row is not bound and this
    // delivery no longer holds it, which is a refusal rather than a licence to use a local value.
    const bound = await this.bindRunRequest(lease.claim, frozen) as TaskRunTargetRecord | null;
    if (!bound) throw taskRunInProgress(lease.claim.actionKind, requestToken);
    // The plan in force may not be the one this call computed — a takeover may have bound its own —
    // and it may not even be a run. Both are read off the row rather than assumed.
    if (!(bound.v === 1 && bound.kind === 'RUN')) {
      throw taskRunUnreadableTarget(lease.claim.actionKind, requestToken);
    }
    const target = bound;
    const task: TaskRunTarget = {
      id: target.taskId,
      title: target.title,
      provider: target.provider,
      model: target.model,
    };
    let sessionId: string;
    try {
      sessionId = await this.runTaskWorkTranslatingFences(() => this.applyWorkspaceRun(
        ownerId,
        task,
        { id: target.workspaceId, runnerId: target.runnerId },
        target.prompt,
        target.title,
        target.batch ?? undefined,
        {
          dispatchOrigin: target.dispatchOrigin as SessionDispatchOrigin,
          runSource: target.runSource as SessionRunSource,
          // Unconditionally true. Every door through here is starting the task's work — Run Now,
          // the schedule sweep, the dependency sweep, a batch — and none of them is somebody
          // opening a window onto a run that already happened. That is the distinction 0130's guard
          // needs.
          startsTaskWork: true,
        },
        target.plan,
        lease.claim,
      ));
    } catch (e) {
      // THE PLAN FAILED. Which of two very different things that is has to be READ, because the
      // answers are opposite: a contended lock is worth coming back for, and a plan whose target no
      // longer exists is a request that can only ever fail — and leaving THAT one BOUND makes every
      // future delivery re-attempt the same doomed write for ever, under a token that can never
      // produce an answer.
      const settled = await this.resolveAppliedArtifact(ownerId, task, target.plan);
      if (settled.kind === 'TRANSIENT') throw e;
      if (settled.kind === 'DONE') {
        this.logger.log(
          `task ${uuidToBase62(target.taskId)}: the planned effect was already on the row; ` +
            'answering from it rather than from the failure',
        );
        return this.completeRunReceipt<TaskRunAnswer>(
          lease.claim, { ok: true as const, sessionId: settled.sessionId },
        );
      }
      this.logger.warn(
        `task ${uuidToBase62(target.taskId)}: this request's target is gone (${settled.why}); ` +
          'answering it as tombstoned',
      );
      return this.completeRunReceipt<TaskRunAnswer>(
        lease.claim, { ok: false as const, skipped: 'target-tombstoned' as const },
      );
    }
    // Everything below this line is a POST-COMMIT step, and the session already exists.
    //
    // A failure in any of them used to fail the whole call, which turned a live run into a 500 the
    // caller would retry — starting a second one. The Session commit is the authoritative success;
    // these three are idempotent recomputations of facts that follow from it (a compare-and-set on
    // the status, a compare-and-set on the schedule, a durable signal keyed by this request), and a
    // takeover re-derives any that did not land. So they are attempted, logged if they fail, and
    // never allowed to contradict a run that is already going.
    //
    // Each is keyed by the FROZEN command, not by what the task looks like now: the Project is the
    // one the press named, and the appointment is the one it kept.
    if (!target.auto && target.projectId) {
      await this.recordManualProjectTriggers(
        ownerId, [target.projectId], requestToken, target.taskId,
      ).catch((e) => this.logger.warn(
        `manual project trigger for task ${target.taskId} failed: ${e?.message ?? e}`,
      ));
    }
    if (target.clearFailed) {
      await this.clearFailedForRetry(ownerId, target.taskId).catch((e) =>
        this.logger.warn(`clearFailedForRetry for task ${target.taskId} failed: ${e?.message ?? e}`));
    }
    // The run is away, so the appointment has been kept — including when this call IS the button
    // that superseded it. A future run_at is deliberately not a veto on this path: "the earliest
    // time it starts by itself" says nothing about a person deciding to start it now, and a Run
    // button that refused would leave the only way to run a scheduled task early being to cancel
    // its schedule first.
    await this.consumeRunAt(
      ownerId, target.taskId, target.runAt ? new Date(target.runAt) : null,
    ).catch((e) =>
      this.logger.warn(`consumeRunAt for task ${target.taskId} failed: ${e?.message ?? e}`));
    // Frozen last, and after the post-commit steps rather than before them: those are idempotent
    // recomputations of facts that follow from the Session, so a repeat that lands before this
    // write re-derives them harmlessly, while a repeat that lands after gets the same bytes without
    // touching anything.
    //
    // The value RETURNED is the row's, not this call's. A holder whose lease expired mid-flight
    // loses the compare-and-set to whoever took over, and handing back its own local answer would
    // give a caller a result the request does not have.
    return this.completeRunReceipt<TaskRunAnswer>(lease.claim, { ok: true as const, sessionId });
  }

  /**
   * Spend a one-shot schedule: the task has been dispatched, so `run_at` goes back to NULL and
   * the task will not be started by the clock again.
   *
   * Compare-and-set on the instant the caller read, NOT a blind `update({ runAt: null })`. A
   * dispatch is several awaits long — the read, the dependency check, the session create — and a
   * user rescheduling the task inside that window has stated a new intention about a run that had
   * not happened yet. Matching on the old value makes that write win: the clear applies to the
   * appointment that was kept, and a different one is left standing. It is also what makes the
   * consumption exactly-once under an at-least-once sweep, since the second attempt matches
   * nothing.
   *
   * Unscheduled tasks — the overwhelming majority, and every task that predates the column — cost
   * one comparison and no query at all.
   */
  private async consumeRunAt(
    ownerId: string,
    taskId: string,
    runAt: Date | null | undefined,
  ): Promise<void> {
    if (!runAt) return;
    const res = await this.prisma.task.updateMany({
      where: { id: taskId, ownerId, runAt },
      data: { runAt: null },
    });
    // Only when it actually cleared: a lost CAS means somebody else's schedule is now on the row,
    // and telling their clients the task changed because we failed to change it is noise.
    if (res.count > 0) {
      this.realtime.publishForUser(ownerId, RunEventType.TASK_CHANGED, taskId);
    }
  }

  /**
   * Drop a task's FAILED label once a retry has actually been dispatched for it. Without
   * this the task keeps the status of the run that died: it stays counted under Failed and
   * listed in that filter while its row shows a live "Running" pill — the retry looks like
   * it never happened.
   *
   * IN_PROGRESS, not OPEN, is the target: it is the state reclaimStalledTask rewrites when
   * a run ends badly, so a retry that fails again lands back at FAILED. Parking it at OPEN
   * would silently swallow that second failure.
   *
   * The write is conditional on the task still being FAILED so a run that already reported
   * its own outcome is never dragged backwards.
   */
  private async clearFailedForRetry(ownerId: string, taskId: string): Promise<void> {
    // §13.6 SU6 in the WHERE clause, as a backstop rather than as the gate: `execute` refuses a
    // retired task before it has done anything, and this is what makes a supersession that landed
    // between that refusal and this write a no-op instead of a constraint violation. Matching zero
    // rows is already a normal outcome here (the task may have been retried by something else), so
    // there is nothing new to handle — which is the point of putting it here and not in a check.
    const res = await this.prisma.task.updateMany({
      where: {
        id: taskId,
        ownerId,
        status: TaskStatus.FAILED,
        terminalReason: null,
        supersededByTaskId: null,
      },
      data: { status: TaskStatus.IN_PROGRESS },
    });
    if (res.count > 0) {
      this.realtime.publishForUser(ownerId, RunEventType.TASK_CHANGED, taskId);
    }
  }

  /**
   * The run prompt: what this task is, how its list's work is done, and the reporting protocol
   * every task run follows.
   *
   * The list's standing instructions are assembled in here at dispatch rather than copied into
   * each task at creation, which is what makes editing them take effect on every task not yet
   * started — including ones already queued — for one write instead of one per task.
   *
   * They sit after the task's own description because the description is what identifies the
   * work; the instructions are the procedure it belongs to. With no instructions the string is
   * byte-for-byte what it was before this layer existed, so an untouched list dispatches exactly
   * as it always did.
   */
  private buildExecutePrompt(task: {
    title: string;
    description?: string | null;
    isForeman?: boolean;
    verifiesTaskId?: string | null;
    list?: { instructions?: string | null } | null;
  }): string {
    // Neither a foreman nor a verifier is performing the list's work — one coordinates it, the
    // other checks it — so the standing instructions, which say how that work is done, would be
    // noise at best and misdirection at worst. For a verifier it is worse than noise: handing it
    // the work procedure is the surest way to get it to do the job itself instead of judging it,
    // which launders a failure into a pass.
    return buildTaskExecutionPrompt(task);
  }

  /**
   * Run several tasks in one action. Each task's responsible workspace is kicked off the
   * same way as {@link execute} (resume-or-create), but a missing assignee/runner skips
   * that task instead of failing the batch, and per-task errors are collected.
   *
   * `maxConcurrent`, when given, is a cap *for this batch only*: all the dispatched
   * sessions share one batchId and this limit, and the claim queue gates mid-turn sessions
   * per batch on it — independently of, and on top of, each runner's own max_concurrent.
   * It is NOT written to any runner, so a batch run never disturbs a runner's persistent
   * slots. The rest queue and start as batch (and runner) slots free.
   */
  /**
   * Run a task-work call, turning migration 0130's typed fences into 409s.
   *
   * The pre-checks in `execute` and `batchExecute` are the friendly half; this is what happens when
   * a supersession, or a lock this transaction cannot have, lands between the check and the write.
   * The database refuses by name, and without this the caller would get a 500 whose text is a
   * PostgreSQL constraint message — for a condition with a remedy they can act on.
   */
  private async runTaskWorkTranslatingFences<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const fenced = taskFenceConflictMessage(error);
      if (fenced) throw new ConflictException(fenced);
      throw error;
    }
  }

  async batchExecute(
    ownerId: string,
    taskIds: string[],
    maxConcurrent?: number,
    /**
     * What names this PRESS of the bulk Run. Each task inside it gets its own request name derived
     * from the pair (`TASK_RUN_TRIGGER.batch`), so a retry of the press is the same request for
     * every task in it while two different presses stay two. As on `execute`, a caller that sends
     * none gets one minted here and is owed no lost-response idempotency for it.
     */
    requestToken?: string,
  ): Promise<TaskBatchRunResult> {
    // The receipt, before every mutable check, exactly as the single door does it — and here it
    // decides more, because a bulk Run's answer is a TALLY. A repeat that re-evaluated the world
    // would report its own live runs as "already running", its own batch as a second empty one, and
    // a task that has since been paused as skipped: three different answers to one press.
    const pressToken = requestToken ?? randomUUID();
    const lease = await this.leaseRunRequest(
      ownerId,
      TASK_RUN_ACTION.batchExecute,
      pressToken,
      taskRunFingerprint.batchExecute(taskIds, maxConcurrent),
    );
    if (!lease.held) return lease.result as TaskBatchRunResult;
    try {
      // Already decided. As at the single door, not one mutable check may run again: a bulk Run's
      // answer is a tally over rows that all move, so re-classifying is answering a different
      // question with the same name on it.
      if (lease.status === 'BOUND') {
        const bound = lease.target as TaskRunTargetRecord;
        if (!(bound?.v === 1 && bound.kind === 'BATCH')) {
          throw taskRunUnreadableTarget(TASK_RUN_ACTION.batchExecute, pressToken);
        }
        return await this.applyBatchPlan(lease, bound);
      }
      return await this.batchExecuteLeased(ownerId, taskIds, maxConcurrent, pressToken, lease);
    } catch (e) {
      await this.releaseRunRequest(lease.claim).catch(() => undefined);
      if (e instanceof TaskRunFenceLost) {
        throw taskRunInProgress(TASK_RUN_ACTION.batchExecute, pressToken);
      }
      throw e;
    }
  }

  /** `batchExecute` with the right to answer this press in hand. See `executeLeased`. */
  private async batchExecuteLeased(
    ownerId: string,
    taskIds: string[],
    maxConcurrent: number | undefined,
    pressToken: string,
    lease: Extract<TaskRunLease, { held: true }>,
  ): Promise<TaskBatchRunResult> {
    const tasks = await this.prisma.task.findMany({
      where: { id: { in: taskIds }, ownerId },
      select: {
        id: true,
        title: true,
        description: true,
        projectId: true,
        provider: true,
        model: true,
        status: true,
        runAt: true,
        // Same inputs the single-task Run assembles its prompt from: a task must not get a
        // different prompt depending on which button started it.
        isForeman: true,
        verifiesTaskId: true,
        // §13.6 SU6, read here so a retired task — or a check of replaced work — is CLASSIFIED
        // before anything with an effect. See the skip below.
        supersededByTaskId: true,
        terminalReason: true,
        // §13.1 AG6, the same two facts the single Run reads, so the two buttons cannot disagree
        // about whether a row is work. Owner-scoped like every other reader of this predicate.
        completionPolicy: true,
        children: { where: { ownerId }, select: { id: true }, take: 1 },
        verifies: { select: { supersededByTaskId: true, terminalReason: true } },
        list: { select: { instructions: true } },
        assignee: { select: { id: true, runnerId: true } },
      },
    });

    const batchFacts = await this.dependencyFactsFor(ownerId, tasks.map((t) => t.id));
    const states = new Map([...batchFacts]
      .map(([taskId, facts]) => [taskId, computeDependencyState(facts)]));
    // Tasks that are already mid-flight: skip them so the batch doesn't double-queue a
    // task that's already running (`planWorkspaceRun` also guards this, but surfacing it here
    // lets us report it as skipped rather than silently dispatched).
    //
    // SINGLE_RUN_DEDUP, not TASK_OCCUPYING: this must be the same "already running"
    // predicate the single-task 开始执行 uses, or the two Run buttons mean different
    // things. A session parked at AWAITING_INPUT/INTERRUPTED is idle — the row's Run
    // button, the Ready filter (runnableTaskWhere) and the detail panel all treat such a
    // task as runnable and nudge it with a new turn, so the batch must too. Widening to
    // TASK_OCCUPYING (which exists to answer reclaimStalledTask's different question —
    // "is anything still holding this task?") made bulk Run silently skip exactly the
    // tasks the list was offering as ready.
    //
    // It carries the SESSION, not just the fact, because "already running" is not the answer when
    // the run that is already running is THIS PRESS'S OWN. A bulk Run whose response was lost
    // re-arrives while its sessions are still live, and a set could only say "occupied" — so the
    // replay reported `dispatched: 0, skipped: N` about work it had itself started, which is a
    // different answer to the same request. The id is what tells the two apart.
    //
    // Spelled with the claim index's `deleted_at IS NULL` and `starts_task_work`, which is also
    // what the comment above requires: the single-task button reads exactly this predicate, and a
    // batch that read a wider one would call a task occupied by a conversation somebody opened
    // against it.
    const occupied = new Map(
      (
        await this.prisma.session.findMany({
          where: {
            taskId: { in: tasks.map((t) => t.id) },
            deletedAt: null,
            status: { in: SINGLE_RUN_DEDUP },
            startsTaskWork: true,
          },
          select: { taskId: true, id: true },
        })
      ).map((row) => [row.taskId!, row.id] as const),
    );
    /** What this press names the run it wants for one task — see `TASK_RUN_TRIGGER.batch`. */
    const desiredFor = (taskId: string) => taskRunDesiredSessionId(
      taskRunRequestKey({ taskId, requestToken: TASK_RUN_TRIGGER.batch(pressToken, taskId) }),
    );
    const runnable: typeof tasks = [];
    const skipped: { id: string; title: string; reason: string }[] = [];
    for (const t of tasks) {
      const state = states.get(t.id) ?? 'NONE';
      const workRefusal = taskWorkRefusal({
        supersededByTaskId: t.supersededByTaskId,
        terminalReason: t.terminalReason,
        subjectSupersededByTaskId: t.verifies?.supersededByTaskId ?? null,
        subjectTerminalReason: t.verifies?.terminalReason ?? null,
      }, uuidToBase62);
      const retirement = taskRetirement(t);
      // §13.6 SU6, first and by itself. A retired task must not reach the Project trigger set, the
      // dispatch pool, `clearFailedForRetry` or `consumeRunAt` — every one of those is a side
      // effect, and its dispatch is going to be refused by the database anyway. Classified rather
      // than dropped, so a person who selected fifty tasks is told which of them were already
      // re-done and by what.
      if (workRefusal) {
        skipped.push({
          id: t.id,
          title: t.title,
          reason: retirement
            ? (t.supersededByTaskId
              ? `Superseded by ${uuidToBase62(t.supersededByTaskId)}`
              : retirement === 'SUPERSEDED'
                ? 'Superseded (its successor has been deleted)'
                : 'Abandoned')
            : 'Obsolete: it checks work that was replaced',
        });
      } else if (isAggregateParent({
        completionPolicy: t.completionPolicy,
        hasDirectChildren: t.children.length > 0,
      })) {
        // §13.1 AG6, second and in the same position `execute` puts it: after the two answers about
        // whether the row is still the work, before every clause that can lift. Classified rather
        // than dropped, so somebody who selected fifty tasks is told which of them are roll-up
        // nodes rather than watching them silently not start.
        skipped.push({
          id: t.id,
          title: t.title,
          reason: `Completed by aggregating its subtasks (${t.completionPolicy}) — run those instead`,
        });
      } else if (!t.assignee) skipped.push({ id: t.id, title: t.title, reason: 'No assignee' });
      else if (!t.assignee.runnerId)
        skipped.push({ id: t.id, title: t.title, reason: 'Assignee not bound to a runner' });
      else if (!canRun(state)) {
        // §13.3 DEP, and the same sentence `execute` gives: a batch that reports "prerequisites not
        // complete" for a check that concluded FAIL hides the one row somebody has to act on.
        const gate = (batchFacts.get(t.id) ?? [])
          .find((fact) => fact.verificationGate != null)?.verificationGate;
        skipped.push({
          id: t.id,
          title: t.title,
          reason: gate
            ? `Prerequisite not verified: ${verificationGateMessage(gate)}`
            : state === 'BLOCKED_FAILED'
              ? 'Prerequisite cancelled'
              : 'Prerequisites not complete',
        });
      }
      // Somebody ELSE's live run — a different press, a sweep, the single-task button — is what
      // "already running" means. This press's own live run is not: it is this request's authorised
      // answer, so the item goes through the dispatch path, which recognises the name and returns
      // that Session. A replay of one press therefore reports what the press reported.
      else if (occupied.has(t.id) && occupied.get(t.id) !== desiredFor(t.id))
        skipped.push({
          id: t.id,
          title: t.title,
          reason: `Already running or queued (session ${uuidToBase62(occupied.get(t.id)!)})`,
        });
      else runnable.push(t);
    }
    // taskIds with no matching owned task (deleted / not owned) are silently ignored.

    const runnerIds = [...new Set(runnable.map((t) => t.assignee!.runnerId!))];
    // One id ties this batch's sessions together; the queue counts live siblings by it. Derived
    // from the press, so a repeat of one press names the batch its own Sessions are already in
    // rather than answering with a second, empty one whose cap governs nothing.
    const batch = maxConcurrent != null
      ? { id: taskRunBatchId(ownerId, pressToken), maxConcurrent }
      : undefined;

    // THE PRESS'S PLAN, written down before any of it happens: which batch, which tasks are in it
    // and where each one goes, and which were classified out and why. A takeover performs this — it
    // does not re-classify, because a bulk Run's answer is a TALLY and every input to that tally is
    // mutable. Re-classifying is how a repeat reports `dispatched: 0, skipped: N` about work the
    // press itself started.
    const planned: TaskRunBatchPlan = {
      v: 1,
      kind: 'BATCH',
      batchId: batch?.id ?? null,
      maxConcurrent: maxConcurrent ?? null,
      skipped,
      runnerIds,
      items: [],
    };
    for (const t of runnable) {
      planned.items.push({
        taskId: t.id,
        title: `执行任务：${t.title}`,
        prompt: this.buildExecutePrompt(t),
        workspaceId: t.assignee!.id,
        runnerId: t.assignee!.runnerId!,
        provider: t.provider ?? null,
        model: t.model ?? null,
        runAt: t.runAt ? t.runAt.toISOString() : null,
        clearFailed: t.status === TaskStatus.FAILED,
        projectId: t.projectId ?? null,
        ...(await this.planWorkspaceRun(
          ownerId,
          t,
          { id: t.assignee!.id, runnerId: t.assignee!.runnerId },
          TASK_RUN_TRIGGER.batch(pressToken, t.id),
        )),
      });
    }
    const bound = await this.bindRunRequest(lease.claim, planned) as TaskRunTargetRecord | null;
    if (!bound) throw taskRunInProgress(TASK_RUN_ACTION.batchExecute, pressToken);
    if (!(bound.v === 1 && bound.kind === 'BATCH')) {
      throw taskRunUnreadableTarget(TASK_RUN_ACTION.batchExecute, pressToken);
    }
    return this.applyBatchPlan(lease, bound);
  }

  /**
   * CARRY OUT a frozen bulk Run: every item, then the press's durable signals, then the answer.
   *
   * Reached identically by the holder that planned it and by a takeover that read the plan off the
   * receipt, which is what makes a repeat of one press answer with the same tally, the same batch
   * and the same Sessions.
   */
  private async applyBatchPlan(
    lease: Extract<TaskRunLease, { held: true }>,
    plan: TaskRunBatchPlan,
  ): Promise<TaskBatchRunResult> {
    const { ownerId, requestToken: pressToken } = lease.claim;
    /** Items that ended in neither their artifact nor a monotone tombstone. */
    const unsettled: string[] = [];
    const dispatch = async (item: TaskRunBatchItemPlan) => {
      // FENCED PER ITEM, and renewed as it goes. A press over many tasks can outlive a fixed lease,
      // and a holder whose lease was taken over must stop rather than go on applying effects
      // alongside its successor — which is the one way two evaluators can both write.
      if (!(await this.renewRunRequest(lease.claim))) {
        throw taskRunInProgress(TASK_RUN_ACTION.batchExecute, pressToken);
      }
      const task: TaskRunTarget = {
        id: item.taskId, title: item.title, provider: item.provider, model: item.model,
      };
      try {
        const sessionId = await this.runTaskWorkTranslatingFences(() => this.applyWorkspaceRun(
          ownerId,
          task,
          { id: item.workspaceId, runnerId: item.runnerId },
          item.prompt,
          item.title,
          plan.batchId != null && plan.maxConcurrent != null
            ? { id: plan.batchId, maxConcurrent: plan.maxConcurrent }
            : undefined,
          { dispatchOrigin: SessionDispatchOrigin.USER, runSource: SessionRunSource.MANUAL },
          item,
          lease.claim,
        ));
        // Post-commit, exactly as the single Run treats them: the Session is the authoritative
        // success, and neither of these may turn a live run into a reported failure. Both are
        // compare-and-sets that the reconcile sweep re-derives, so a failure here is degraded
        // bookkeeping about a run that is already going — not a run that did not start.
        if (item.clearFailed) {
          await this.clearFailedForRetry(ownerId, item.taskId).catch((e) =>
            this.logger.warn(`batchExecute: clearFailedForRetry for ${item.taskId} failed: ${e}`));
        }
        // A bulk Run keeps the appointment the same way the single one does. Without this a task
        // started here would keep its schedule and be started again by the clock afterwards —
        // "one-shot" has to mean one run, not one run per way of starting it.
        await this.consumeRunAt(
          ownerId, item.taskId, item.runAt ? new Date(item.runAt) : null,
        ).catch((e) =>
          this.logger.warn(`batchExecute: consumeRunAt for ${item.taskId} failed: ${e}`));
        return { id: item.taskId, ok: true as const, sessionId };
      } catch (e) {
        // Losing the fence is not an item outcome at all — it says this DELIVERY is no longer the
        // one, so it stops the press rather than being written into its tally.
        if (e instanceof TaskRunFenceLost) throw e;
        // The same reading the single door does, per item: an exception is not an answer. The
        // Session or the turn may already be committed — a post-commit publish can throw, and a
        // holder whose lease was taken over can be inside the write while this delivery gives up —
        // so the item's result comes off its own durable artifact.
        const settled = await this.resolveAppliedArtifact(ownerId, task, item);
        if (settled.kind === 'DONE') {
          return { id: item.taskId, ok: true as const, sessionId: settled.sessionId };
        }
        if (settled.kind === 'GONE') {
          this.logger.warn(`batchExecute: task ${item.taskId} is gone: ${settled.why}`);
          return { id: item.taskId, ok: false as const, error: settled.why };
        }
        // No artifact, and the ERROR does not get to decide what that means. NOTHING may put an
        // item into a frozen tally except a fact about a row: the Session it created, the turn it
        // delivered, or the monotone absence of the task it names. An exception is a description of
        // one attempt, and a description is exactly what cannot be trusted here — the Session may
        // be committing right now under a holder that is still writing, and a caller handed
        // `{ ok: false }` has no reason to ask again while the next delivery would tell it that
        // same item is running.
        //
        // That includes refusals that LOOK permanent. If one of them has to be final, it has to
        // become a durable artifact this door can recover — which is what `GONE` is — rather than
        // a string this code recognised once.
        this.logger.warn(`batchExecute: task ${item.taskId} did not settle: ${e}`);
        unsettled.push(item.taskId);
        return { id: item.taskId, ok: false as const, error: 'did not settle' };
      }
    };
    // A fixed worker pool avoids an unbounded Promise.all fan-out while preserving the runnable
    // order in `results`, even when individual session initializations finish out of order.
    const results = new Array<Awaited<ReturnType<typeof dispatch>>>(plan.items.length);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = nextIndex++;
        if (index >= plan.items.length) return;
        results[index] = await dispatch(plan.items[index]);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(BATCH_EXECUTE_DISPATCH_CONCURRENCY, plan.items.length) },
        () => worker(),
      ),
    );

    // One explicit request per affected Project, not one per task, and only for the tasks that
    // actually started. Written AFTER the pool, for the same reason the single-task Run writes it
    // after its own dispatch: a task whose supersession commits between the classification above
    // and its dispatch is refused by the database, and an event recorded beforehand would leave a
    // durable USER request — and a Coordinator wake to answer it — for a run that never existed.
    // One transaction and one request id still name the whole click.
    // ...and it may not fail the call either. Several worker Sessions are live by now; a 500 here
    // would tell the caller nothing started, and a retry would start them all again.
    //
    // The Project of each item comes off the PLAN, not off the task as it stands now: a task moved
    // to another Project between the plan and a takeover would otherwise have its press's signal
    // filed against a Project the press never named, or — if it was deleted — no signal at all.
    const started = new Set(results.filter((result) => result.ok).map((result) => result.id));
    await this.recordManualProjectTriggers(
      ownerId,
      plan.items.filter((item) => started.has(item.taskId)).map((item) => item.projectId),
      pressToken,
    ).catch((e) =>
      this.logger.warn(`batchExecute: manual project triggers failed: ${e?.message ?? e}`));

    const answer = {
      dispatched: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok),
      skipped: plan.skipped,
      runnerIds: plan.runnerIds,
      batchId: plan.batchId,
      maxConcurrent: plan.maxConcurrent,
      // The per-item half of the receipt: which task got which Session. The tally above says how
      // many, and a repeat has to be able to answer WHICH — that is what a client refreshing the
      // rows it just started needs, and what makes "the same bytes" checkable.
      results,
    };
    // A TALLY IS ONLY EVER FROZEN WHOLE. Every item in it is backed by its own row — the Session it
    // created, the turn it delivered, or the monotone fact that its target is gone — and an item
    // that ended in a contended lock or a lease taken over is none of those. Reporting that as a
    // failed item would make this press's answer contradict what the database is about to say, and
    // the caller would have no reason to ask again.
    //
    // So the request answers RETRYABLE and freezes nothing. Its plan is already bound, so the next
    // delivery re-applies exactly it: every item that landed resolves to its artifact, and the
    // answer that eventually freezes is one every part of which is true.
    if (unsettled.length > 0) {
      await this.releaseRunRequest(lease.claim).catch(() => undefined);
      throw taskRunUnsettled({
        actionKind: TASK_RUN_ACTION.batchExecute,
        requestToken: pressToken,
        pendingTaskIds: unsettled.map((id) => uuidToBase62(id)),
        attempt: lease.claim.attempt,
      });
    }
    return this.completeRunReceipt(lease.claim, answer);
  }

  /**
   * Stop a batch of tasks: cancel each selected task's in-flight session — running ones
   * have their claude process torn down, queued (PENDING) ones are dropped so they never
   * start. The mirror of {@link batchExecute}. Cancelled sessions settle to CANCELLED; a
   * task whose running session is torn down is reclaimed to OPEN by the runner's
   * /complete (retryable). Tasks with no stoppable session are silently no-ops.
   */
  async batchStop(ownerId: string, taskIds: string[]) {
    const sessions = await this.prisma.session.findMany({
      where: { ownerId, taskId: { in: taskIds }, status: { in: TASK_OCCUPYING } },
      select: { id: true, taskId: true },
    });
    const results = await Promise.all(
      sessions.map(async (s) => {
        try {
          return { ok: await this.sessions.cancel(ownerId, s.id) };
        } catch (e) {
          this.logger.warn(`batchStop: session ${s.id} failed: ${e}`);
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
    return {
      stopped: results.filter((r) => r.ok).length,
      failed: results.filter((r) => 'error' in r),
      tasks: new Set(sessions.map((s) => s.taskId)).size,
    };
  }

  /**
   * Hard-delete many tasks with the same semantics as {@link remove}. The owner filter
   * is part of the DELETE statement, so unknown and cross-tenant ids are indistinguishable
   * and silently ignored. Task comments and dependency edges cascade-delete; finished task
   * sessions are retained and detached by the Session.taskId SET NULL foreign key, and runs
   * still in flight are ended — see {@link deleteAndStopRuns}.
   */
  async batchDelete(ownerId: string, taskIds: string[]) {
    const uniqueIds = [...new Set(taskIds)];
    if (uniqueIds.length === 0) return { deleted: 0 };
    const { deleted, survivingLinks } = await this.deleteAndStopRuns(ownerId, uniqueIds);
    if (deleted > 0) {
      this.realtime.publishForUser(ownerId, RunEventType.TASK_CHANGED, uniqueIds[0]);
      // Same as remove, in bulk: a parent whose last outstanding subtask was in this selection is
      // completed by what is left of it, and nothing else recomputes it.
      if (survivingLinks.length) {
        await this.recomputeAggregates(ownerId, survivingLinks).catch((e) =>
          this.logger.warn(`aggregation after batch delete failed: ${e?.message ?? e}`),
        );
      }
    }
    return { deleted };
  }

  /** Set (or clear, when assigneeId is null) the responsible workspace on many tasks at once. */
  async batchAssign(ownerId: string, taskIds: string[], assigneeId?: string | null) {
    await this.assertOwnedWorkspace(ownerId, assigneeId);
    const ids = orderedIds(taskIds);
    if (ids.length === 0) return { updated: 0 };
    // A multi-row `task` write, so rank 10 of the canonical order applies (lock-order.ts, I1):
    // one `updateMany` takes its row locks in whatever order the plan produced them, and two
    // selections that overlap could take them in opposite orders. The owner mutex is what puts
    // this in one line with every other multi-row Task write instead of relying on the planner.
    // Retried whole. One conditional multi-row UPDATE under the owner mutex, and `ids` is sorted
    // and computed above, so every attempt names the same rows and writes the same value.
    const res = await withTransactionRetry(this.prisma, async (tx) => {
      await this.lockDependencyGraph(tx, ownerId);
      return tx.task.updateMany({
        where: { id: { in: ids }, ownerId },
        data: { assigneeId: assigneeId ?? null },
      });
    }, this.transientWriteRetry('tasks.batchAssign'));
    return { updated: res.count };
  }

  async removeComment(ownerId: string, id: string, commentId: string) {
    await this.get(ownerId, id);
    const comment = await this.prisma.taskComment.findFirst({
      where: { id: commentId, taskId: id },
      select: { id: true },
    });
    if (!comment) throw new NotFoundException('comment not found');
    await this.prisma.taskComment.delete({ where: { id: commentId } });
    return { ok: true };
  }
}
