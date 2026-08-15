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
import { CreatorType, Prisma, RunStatus, Task, TaskComment } from '@prisma/client';
import {
  AgentProvider,
  planUsageBlockedUntil,
  planUsageReported,
  RunEventType,
  TaskStatus,
  USAGE_LIMIT_ERROR_MARKERS,
  type PlanUsage,
} from '@orbit/shared';
import { createHash, randomUUID } from 'crypto';
import { DEFAULT_AGENT_PROVIDER, lastProviderByWorkspace } from '../workspaces/workspace-provider';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { withSessionState } from '../sessions/session-state';
import {
  CreateTaskCommentDto,
  CreateTaskDto,
  CreateTasksBatchDto,
  DAG_PREVIEW_TITLES,
  MAX_DAG_OPS,
  TASK_BATCH_CREATE_MAX,
  UpdateTaskDto,
} from './dto';
import { TASK_OCCUPYING } from './reclaim-stalled-task';
import {
  canRun,
  computeDependencyState,
  wouldCreateCycle,
  wouldReplacementCreateCycle,
  type DependencyState,
} from './task-dependencies';
import { DagOp, effectiveOps, findCycle, resultingEdges, stateChanges } from './task-dag';

/** A polymorphic actor (user or workspace) that authored a task or comment. */
export type Creator = { type: CreatorType; id: string };

/** What runWorkspaceOnTask needs off a task to dispatch it: its identity, and the provider/model
 *  pin that overrides the assignee workspace's own (null on both = inherit from the workspace). */
type TaskRunTarget = {
  id: string;
  title: string;
  provider?: string | null;
  model?: string | null;
};

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
 * What a task LIST row needs: every scalar column except `description`, plus the assignee
 * (with its runner, for the batch-run modal) and the comment tally. No client renders a
 * description in a list row — the detail panel fetches `GET /tasks/:id` for that — and it
 * averages ~500 bytes per task, so including it here inflated a 200-row page by ~46% and a
 * 701-task list view by ~440KB for bytes that were parsed and thrown away.
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
  createdAt: true,
  updatedAt: true,
  listId: true,
  creatorSessionId: true,
  autoRunWhenReady: true,
  provider: true,
  model: true,
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
const RUNNABLE_TASK_SQL = Prisma.sql`
  t.status <> 'DONE'::task_status
  AND EXISTS (SELECT 1 FROM workspace a WHERE a.id = t.assignee_id AND a.runner_id IS NOT NULL)
  AND NOT EXISTS (
    SELECT 1 FROM session s
    WHERE s.task_id = t.id AND s.status IN ('PENDING'::run_status, 'RUNNING'::run_status)
  )
  AND NOT EXISTS (
    SELECT 1 FROM task_dependency d
    JOIN task p ON p.id = d.depends_on_task_id
    WHERE d.task_id = t.id AND p.status <> 'DONE'::task_status
  )`;

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
  AND t.auto_run_when_ready = true
  AND EXISTS (SELECT 1 FROM workspace a WHERE a.id = t.assignee_id AND a.runner_id IS NOT NULL)
  -- A paused list is out of the sweep entirely: pausing is the stop for a campaign dispatching
  -- wrongly, so it has to work here, not only on the manual button. Filtered in SQL rather than
  -- by letting execute() throw per task, which would log one rejection per task per minute for
  -- as long as the pause lasts. A task with no list has nothing to pause and is unaffected.
  AND NOT EXISTS (SELECT 1 FROM task_list tl WHERE tl.id = t.list_id AND tl.paused = true)
  AND EXISTS (
    SELECT 1 FROM task_dependency d
    JOIN task p ON p.id = d.depends_on_task_id
    WHERE d.task_id = t.id AND p.status = 'DONE'::task_status
  )
  AND NOT EXISTS (
    SELECT 1 FROM task_dependency d
    JOIN task p ON p.id = d.depends_on_task_id
    WHERE d.task_id = t.id AND p.status <> 'DONE'::task_status
  )
  AND NOT EXISTS (
    SELECT 1 FROM session s
    WHERE s.task_id = t.id
      AND s.status IN (${Prisma.join(
        TASK_OCCUPYING.map((status) => Prisma.sql`${status}::run_status`),
        ', ',
      )})
  )`;

/**
 * SQL mirror of the `{ ownerId, listId?, assigneeId? }` scope the Prisma queries are built
 * from. Derived from that same object rather than re-read from the query string, so the two
 * spellings of the scope cannot drift.
 */
function taskScopeSql(scope: Prisma.TaskWhereInput): Prisma.Sql {
  const clauses: Prisma.Sql[] = [Prisma.sql`t.owner_id = ${scope.ownerId as string}::uuid`];
  if (scope.listId === null) clauses.push(Prisma.sql`t.list_id IS NULL`);
  else if (typeof scope.listId === 'string') {
    clauses.push(Prisma.sql`t.list_id = ${scope.listId}::uuid`);
  }
  if (typeof scope.assigneeId === 'string') {
    clauses.push(Prisma.sql`t.assignee_id = ${scope.assigneeId}::uuid`);
  }
  return Prisma.join(clauses, ' AND ');
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
export const AUTO_RUN_RETRY_BACKOFF_MS = [2 * 60_000, 8 * 60_000, 30 * 60_000, 120 * 60_000];
export const MAX_AUTO_RUN_FAILURES = AUTO_RUN_RETRY_BACKOFF_MS.length + 1;

// Flat brake for runs killed by a provider usage limit that the quota gate could not put a
// resume time on. Those failures are excluded from the budget above on purpose (see
// autoRunHoldOff) — one quota outage must not permanently retire a fleet — and
// planUsageBlockedUntil deliberately declines to block without a reported `resetsAt`, leaving
// "the caller's normal failure backoff" to handle it. Between those two decisions nothing
// actually did: a blind gate plus an exempt failure is the once-a-minute respawn loop the
// backoff exists to stop. This is that missing brake, and it is flat rather than escalating
// because a quota is not evidence the task is broken — it recovers on its own schedule, and
// the only job here is to stop burning a session a minute while waiting for it.
export const QUOTA_BLIND_RETRY_BACKOFF_MS = 15 * 60_000;

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
const DEFAULT_TASK_PAGE_SIZE = 100;
const MAX_TASK_PAGE_SIZE = 200;
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
  assigneeId?: string;
  q?: string;
  /** `'none'` drops the aggregate block (and `total`) from the response. Omitted = include it. */
  counts?: string;
}

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

function encodeTaskPageCursor(task: { createdAt: Date; id: string }): string {
  return Buffer.from(
    JSON.stringify({ createdAt: task.createdAt.toISOString(), id: task.id } satisfies TaskPageCursor),
  ).toString('base64url');
}

function decodeTaskPageCursor(cursor: string): { createdAt: Date; id: string } {
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
  ) {}

  onModuleInit(): void {
    // Periodic backstop for auto-run edges triggerDependents can't catch (see
    // reconcileReadyTasks). Single-replica assumption, same as ReaperService.
    this.reconcileTimer = setInterval(() => {
      // Both sweeps ride this one timer. A second setInterval is how the reconciler once ended
      // up running twice a minute (TasksService was provided by two modules), and the symptom —
      // duplicate dispatch — took a production incident to spot. Sequential, not concurrent, so
      // the foreman sees the dispatch decisions this same tick already made.
      this.reconcileReadyTasks()
        .catch((e) =>
          this.logger.error(`reconcile sweep failed: ${e instanceof Error ? e.message : e}`),
        )
        .then(() => this.dispatchStalledListForemen())
        .catch((e) =>
          this.logger.error(`foreman sweep failed: ${e instanceof Error ? e.message : e}`),
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
   */
  private async lockDependencyGraph(tx: Prisma.TransactionClient, ownerId: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "user" WHERE "id" = ${ownerId}::uuid FOR UPDATE`;
  }

  /**
   * Derive each task's DependencyState in one batched pass: load every dependency edge
   * whose dependent is in `taskIds`, joined to its prerequisite's status, group by
   * dependent and reduce. Tasks with no prerequisites are absent (caller reads absent as
   * 'NONE'). Mirrors withRunning's single-grouped-query approach to avoid N+1.
   */
  private async dependencyStatesFor(taskIds: string[]): Promise<Map<string, DependencyState>> {
    if (taskIds.length === 0) return new Map();
    const byTask = new Map<string, TaskStatus[]>();
    const uniqueIds = [...new Set(taskIds)];
    for (let offset = 0; offset < uniqueIds.length; offset += TASK_ID_QUERY_CHUNK) {
      const ids = uniqueIds.slice(offset, offset + TASK_ID_QUERY_CHUNK);
      const edges = await this.prisma.taskDependency.findMany({
        where: { taskId: { in: ids } },
        select: { taskId: true, dependsOnTask: { select: { status: true } } },
      });
      for (const e of edges) {
        const status = e.dependsOnTask.status as unknown as TaskStatus;
        const arr = byTask.get(e.taskId);
        if (arr) arr.push(status);
        else byTask.set(e.taskId, [status]);
      }
    }
    const out = new Map<string, DependencyState>();
    for (const [taskId, statuses] of byTask) out.set(taskId, computeDependencyState(statuses));
    return out;
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
    const states = new Map<string, DependencyState>();
    for (const row of totals) {
      const failedCount = failedByTask.get(row.taskId) ?? 0;
      const completedCount = completedByTask.get(row.taskId) ?? 0;
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

  async create(ownerId: string, dto: CreateTaskDto, creator?: Creator, creatorSessionId?: string) {
    if (!dto.title) throw new BadRequestException('title is required');
    await this.assertOwnedWorkspace(ownerId, dto.assigneeId);
    await this.assertOwnedList(ownerId, dto.listId);
    await this.assertUsableProvider(ownerId, dto.provider);
    // Link to the originating session only when it's one this owner has (the runner
    // injects its own session id, so this is a guard, not a trust boundary). A stale id
    // would otherwise fail the FK insert.
    const sessionId = await this.resolveOwnedSession(ownerId, creatorSessionId);
    // Best-effort idempotency: a redelivered turn re-runs and re-creates the same tasks. A key is
    // only formed inside a live turn; without one this stays exactly the old create path. Checking
    // first lets the common (sequential) re-run return the original task without a write attempt.
    const turnId = sessionId ? await this.currentTurnId(sessionId) : undefined;
    const idempotencyKey =
      sessionId && turnId ? this.taskIdempotencyKey(sessionId, turnId, dto.title, dto.description) : undefined;
    if (idempotencyKey) {
      const existing = await this.prisma.task.findUnique({ where: { idempotencyKey } });
      if (existing) return existing;
    }
    // Validate prerequisites up front so we never create a task and then reject its deps.
    // No cycle check needed: a brand-new task has no dependents, so it can't close a loop.
    const dependsOnTaskIds = [...new Set(dto.dependsOnTaskIds ?? [])];
    if (dependsOnTaskIds.length) await this.assertOwnedTasks(ownerId, dependsOnTaskIds);
    const data = this.taskCreateData(ownerId, dto, creator, sessionId, idempotencyKey);
    // Initial edges and their task must become visible atomically. Taking the same owner lock
    // used by add/replace prevents a concurrent reverse-edge write from observing the new task
    // before its prerequisites and closing a cycle. Any FK/write failure rolls the task back too.
    let task: Task;
    try {
      task = dependsOnTaskIds.length
        ? await this.prisma.$transaction(async (tx) => {
            await this.lockDependencyGraph(tx, ownerId);
            const created = await tx.task.create({ data });
            await tx.taskDependency.createMany({
              data: dependsOnTaskIds.map((dependsOnTaskId) => ({
                taskId: created.id,
                dependsOnTaskId,
              })),
            });
            return created;
          })
        : await this.prisma.task.create({ data });
    } catch (e) {
      // The unique index backstops a concurrent (not merely sequential) re-run that raced past the
      // pre-check above. Return the winner rather than surfacing a write conflict to the workspace.
      if (idempotencyKey && this.isDuplicateKey(e)) {
        const existing = await this.prisma.task.findUnique({ where: { idempotencyKey } });
        if (existing) return existing;
      }
      throw e;
    }
    // Push the new task to the owner's control-plane stream (GET /api/events) so their task
    // list refreshes live instead of on the next poll — the fix for "MCP-created tasks only
    // show up after a manual refresh". Scoped via the creating session (the MCP path always
    // sends one); a task created without an owned session just falls back to the poll. Mirrors
    // SessionsService.create's publishSessionCreated.
    if (sessionId) this.realtime.publishTaskChanged(sessionId, task.id);
    return task;
  }

  /** The Task row one create DTO turns into. Shared by create and createMany so the two
   *  write paths can never drift on a newly added field. */
  private taskCreateData(
    ownerId: string,
    dto: CreateTaskDto,
    creator: Creator | undefined,
    sessionId: string | undefined,
    idempotencyKey?: string,
  ): Prisma.TaskUncheckedCreateInput {
    return {
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
      dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      provider: dto.provider,
      model: dto.model,
      autoRunWhenReady: dto.autoRunWhenReady,
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

    // Validate every referenced entity before writing anything, once per distinct value.
    const distinct = (values: Array<string | null | undefined>) => [
      ...new Set(values.filter((value): value is string => !!value)),
    ];
    for (const assigneeId of distinct(items.map((item) => item.assigneeId)))
      await this.assertOwnedWorkspace(ownerId, assigneeId);
    for (const listId of distinct(items.map((item) => item.listId)))
      await this.assertOwnedList(ownerId, listId);
    for (const provider of distinct(items.map((item) => item.provider)))
      await this.assertUsableProvider(ownerId, provider);
    const existingPrerequisites = distinct(items.flatMap((item) => item.dependsOnTaskIds ?? []));
    if (existingPrerequisites.length) await this.assertOwnedTasks(ownerId, existingPrerequisites);
    return items;
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
        select: { id: true, title: true },
      }),
    ]);
    const runnerOf = new Map(assignees.map((a) => [a.id, a.runnerId]));
    const nameOf = new Map(assignees.map((a) => [a.id, a.name]));
    const statusOf = new Map(prerequisites.map((t) => [t.id, t.status]));

    let startingNow = 0;
    let blocked = 0;
    let notDispatchable = 0;
    let internalEdges = 0;
    let externalEdges = 0;
    for (const item of items) {
      internalEdges += item.dependsOnRefs?.length ?? 0;
      externalEdges += item.dependsOnTaskIds?.length ?? 0;
      // A prerequisite created by this same batch is OPEN the moment it exists, so anything
      // naming one waits — no need to consult the graph for it.
      const waitsOnBatch = (item.dependsOnRefs?.length ?? 0) > 0;
      const waitsOnExisting = (item.dependsOnTaskIds ?? []).some(
        (id) => statusOf.get(id) !== TaskStatus.DONE,
      );
      if (waitsOnBatch || waitsOnExisting) {
        blocked += 1;
        continue;
      }
      const dispatchable =
        item.autoRunWhenReady !== false && !!item.assigneeId && !!runnerOf.get(item.assigneeId);
      if (dispatchable) startingNow += 1;
      else notDispatchable += 1;
    }
    return {
      taskCount: items.length,
      startingNow,
      blocked,
      // Written but inert: no assignee, no runner behind the assignee, or auto-run switched off.
      // Worth separating from `blocked`, because these do not start when something finishes —
      // they wait for a person, and a batch that is silently all of these did nothing.
      notDispatchable,
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
    const items = await this.assertBatchValid(ownerId, dto);
    const sessionId = await this.resolveOwnedSession(ownerId, creatorSessionId);
    // One turn for the whole batch (see create): the same key that collapses a re-run of a single
    // create collapses a re-run of a batch, item by item, without merging distinct items.
    const turnId = sessionId ? await this.currentTurnId(sessionId) : undefined;

    const hasDependencies = items.some(
      (item) => item.dependsOnTaskIds?.length || item.dependsOnRefs?.length,
    );
    const created = await this.prisma.$transaction(async (tx) => {
      // Same owner lock as create: the tasks and their edges must become visible together, or a
      // concurrent reverse-edge write could see a task before its prerequisites and close a cycle.
      if (hasDependencies) await this.lockDependencyGraph(tx, ownerId);
      const idByRef = new Map<string, string>();
      const rows: Array<Task & { ref?: string }> = [];
      for (const item of items) {
        // find-or-create by the item's key: a re-run's items already exist (committed by the first
        // run), and a within-batch duplicate resolves to the row this same transaction just wrote.
        // A ref pointing at a collapsed item therefore resolves to the surviving task's id.
        const idempotencyKey =
          sessionId && turnId ? this.taskIdempotencyKey(sessionId, turnId, item.title, item.description) : undefined;
        const existing = idempotencyKey
          ? await tx.task.findUnique({ where: { idempotencyKey } })
          : null;
        const task =
          existing ??
          (await tx.task.create({
            data: this.taskCreateData(ownerId, item, creator, sessionId, idempotencyKey),
          }));
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
        rows.push(item.ref === undefined ? task : { ...task, ref: item.ref });
      }
      return rows;
    });
    // One control-plane nudge per task, exactly as create does (see its comment).
    if (sessionId) for (const task of created) this.realtime.publishTaskChanged(sessionId, task.id);
    return created;
  }

  /** Return the session id only if it exists under this owner; otherwise undefined. */
  private async resolveOwnedSession(ownerId: string, sessionId?: string): Promise<string | undefined> {
    if (!sessionId) return undefined;
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, ownerId },
      select: { id: true },
    });
    return session?.id;
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
   * A best-effort key that collapses the SAME task created twice inside one turn — the shape of a
   * redelivered turn re-running its side effects (a lease expiry hands the turn back and the engine
   * re-creates the tasks it already created; see the runner's redelivery double-run). Scoped by
   * turnId so two DIFFERENT turns that each legitimately create an identically worded task are
   * never merged. The tradeoff — two byte-identical creates within ONE turn collapse to one — is
   * deliberate and far rarer than the duplicate it prevents.
   */
  private taskIdempotencyKey(
    sessionId: string,
    turnId: string,
    title: string,
    description?: string,
  ): string {
    return createHash('sha256')
      .update(JSON.stringify(['task-create', sessionId, turnId, title.trim(), (description ?? '').trim()]))
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
    const states = await this.dependencyStatesFor(tasks.map((t) => t.id));
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
    if (countsMode !== undefined && countsMode !== 'none') {
      throw new BadRequestException("counts must be 'none' when set");
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
    if (query.assigneeId) {
      if (!UUID_RE.test(query.assigneeId)) throw new BadRequestException('invalid assignee id');
      scopedWhere.assigneeId = query.assigneeId;
    }

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

    // `counts=none` drops the whole aggregate block. The counts describe the scope, not the
    // page, so every page after the first recomputes numbers the client already has — and the
    // client only ever reads them off page 1. Opt-in (rather than "skip when a cursor is set")
    // because `counts` is a required field for already-shipped native clients.
    const wantCounts = countsMode !== 'none';
    // On the Ready tab the filtered total IS the runnable count; count it once and share it.
    // A title search narrows the filtered total but deliberately not the tab badge, so that
    // case still needs its own count.
    const [rows, ownFilteredTotal, statusGroups, running, queued, runnable] = await Promise.all([
      runnableOnly
        ? this.runnableTaskPage(scopedWhere, { search, cursor, take: limit + 1 })
        : this.prisma.task.findMany({
            where: pageWhere,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: limit + 1,
            select: TASK_LIST_SELECT,
          }),
      !wantCounts || (runnableOnly && !search)
        ? undefined
        : runnableOnly
          ? this.runnableTaskCount(scopedWhere, search)
          : this.prisma.task.count({ where: filteredWhere }),
      wantCounts
        ? this.prisma.task.groupBy({ by: ['status'], where: scopedWhere, _count: { _all: true } })
        : undefined,
      wantCounts
        ? this.prisma.task.count({
            where: { ...scopedWhere, sessions: { some: { status: RunStatus.RUNNING } } },
          })
        : undefined,
      wantCounts
        ? this.prisma.task.count({
            where: {
              ...scopedWhere,
              sessions: { some: { status: RunStatus.PENDING } },
              NOT: { sessions: { some: { status: RunStatus.RUNNING } } },
            },
          })
        : undefined,
      wantCounts ? this.runnableTaskCount(scopedWhere) : undefined,
    ]);

    const hasMore = rows.length > limit;
    const pageTasks = hasMore ? rows.slice(0, limit) : rows;
    const [withRun, states] = await Promise.all([
      this.withRunning(ownerId, pageTasks),
      this.dependencyStatesFor(pageTasks.map((task) => task.id)),
    ]);
    const items = withRun.map((task) => {
      const dependencyState = states.get(task.id) ?? 'NONE';
      return { ...task, dependencyState, blocked: !canRun(dependencyState) };
    });
    const nextCursor =
      hasMore && items.length ? encodeTaskPageCursor(items[items.length - 1]) : null;
    if (!wantCounts) return { items, nextCursor };

    const groups = statusGroups ?? [];
    const byStatus = new Map(groups.map((group) => [group.status, group._count._all]));
    const counts = {
      total: groups.reduce((sum, group) => sum + group._count._all, 0),
      open: byStatus.get(TaskStatus.OPEN) ?? 0,
      inProgress: byStatus.get(TaskStatus.IN_PROGRESS) ?? 0,
      done: byStatus.get(TaskStatus.DONE) ?? 0,
      failed: byStatus.get(TaskStatus.FAILED) ?? 0,
      cancelled: byStatus.get(TaskStatus.CANCELLED) ?? 0,
      running: running ?? 0,
      queued: queued ?? 0,
      runnable: runnable ?? 0,
    };

    return { items, nextCursor, total: ownFilteredTotal ?? counts.runnable, counts };
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
        comments: { orderBy: { createdAt: 'asc' } },
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
      },
    });
    if (!task) throw new NotFoundException('task not found');
    const dependencyState = computeDependencyState(
      task.dependsOn.map((d) => d.dependsOnTask.status as unknown as TaskStatus),
    );
    return {
      ...task,
      sessions: (task.sessions ?? []).map((session) => withSessionState(session)),
      creatorSession: task.creatorSession ? withSessionState(task.creatorSession) : null,
      comments: await this.resolveCommentAuthors(task.comments),
      dependencyState,
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

  async update(ownerId: string, id: string, dto: UpdateTaskDto) {
    const before = await this.get(ownerId, id);
    if (dto.assigneeId) await this.assertOwnedWorkspace(ownerId, dto.assigneeId);
    if (dto.listId) await this.assertOwnedList(ownerId, dto.listId);
    if (dto.provider) await this.assertUsableProvider(ownerId, dto.provider);
    const dependsOnTaskIds =
      dto.dependsOnTaskIds === undefined ? undefined : [...new Set(dto.dependsOnTaskIds)];
    if (dependsOnTaskIds?.includes(id)) {
      throw new BadRequestException('A task cannot depend on itself');
    }
    if (dependsOnTaskIds?.length) {
      await this.assertOwnedTasks(ownerId, dependsOnTaskIds);
    }
    const data: Prisma.TaskUpdateInput = {
      title: dto.title,
      description: dto.description,
      status: dto.status,
      dueDate: dto.dueDate === null ? null : dto.dueDate ? new Date(dto.dueDate) : undefined,
      // Three-state like the FKs above, except these are plain columns: omitted keeps the current
      // pin, null goes back to inheriting the assignee's provider/model.
      provider: dto.provider === undefined ? undefined : (dto.provider ?? null),
      model: dto.model === undefined ? undefined : (dto.model ?? null),
      autoRunWhenReady: dto.autoRunWhenReady,
    };
    // assigneeId is a relation FK: connect to (re)assign, disconnect to clear.
    if (dto.assigneeId !== undefined) {
      data.assignee = dto.assigneeId ? { connect: { id: dto.assigneeId } } : { disconnect: true };
    }
    // listId is a relation FK: connect to (re)assign, disconnect to detach.
    if (dto.listId !== undefined) {
      data.list = dto.listId ? { connect: { id: dto.listId } } : { disconnect: true };
    }
    const updated =
      dependsOnTaskIds === undefined
        ? await this.prisma.task.update({ where: { id }, data })
        : await this.prisma.$transaction(async (tx) => {
            await this.lockDependencyGraph(tx, ownerId);
            if (dependsOnTaskIds.length) {
              const edges = await tx.taskDependency.findMany({
                where: { task: { ownerId } },
                select: { taskId: true, dependsOnTaskId: true },
              });
              if (wouldReplacementCreateCycle(edges, id, dependsOnTaskIds)) {
                throw new BadRequestException('These dependencies would create a cycle');
              }
            }
            // Delete before re-inserting so a retained prerequisite cannot collide with the
            // (taskId, dependsOnTaskId) unique key. The transaction keeps the scalar update and
            // full dependency replacement atomic; [] intentionally stops after the delete.
            const task = await tx.task.update({ where: { id }, data });
            await tx.taskDependency.deleteMany({ where: { taskId: id } });
            if (dependsOnTaskIds.length) {
              await tx.taskDependency.createMany({
                data: dependsOnTaskIds.map((dependsOnTaskId) => ({ taskId: id, dependsOnTaskId })),
              });
            }
            return task;
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
    if (before.status === 'DONE' && dto.status !== undefined && dto.status !== TaskStatus.DONE && before.listId) {
      const checks = await this.prisma.task.count({ where: { verifiesTaskId: id } });
      await this.recordListEvent(
        before.listId,
        'completion_reverted',
        `任务「${before.title}」(${id}) 从 DONE 被退回 ${dto.status}` +
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
      where: { taskId, numTurns: { gt: 0 } },
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
        assigneeId: task.assignee.id,
        verifiesTaskId: taskId,
        // Dispatched by the DONE it follows, not by a prerequisite reaching DONE.
        autoRunWhenReady: false,
        creatorType: CreatorType.USER,
        creatorId: ownerId,
      },
      select: { id: true },
    });
    await this.execute(ownerId, verification.id);
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
   */
  private buildVerificationBrief(title: string, taskId: string, unevidenced = false): string {
    return (
      `任务「${title}」（id: ${taskId}）刚刚被标记为 DONE。请独立核实它是否真的完成了，然后结束本次运行。\n\n` +
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
    const states = await this.dependencyStatesFor(dependentIds);
    const dependents = await this.prisma.task.findMany({
      where: { id: { in: dependentIds }, ownerId },
      select: {
        id: true,
        status: true,
        autoRunWhenReady: true,
        assignee: { select: { id: true, runnerId: true } },
      },
    });
    for (const dep of dependents) {
      if ((states.get(dep.id) ?? 'NONE') !== 'READY') continue;
      if (dep.status !== 'OPEN') continue; // already running/done/cancelled — leave it
      if (!dep.autoRunWhenReady) continue; // gate kept, manual trigger only
      if (!dep.assignee?.runnerId) continue; // nothing to run it on — stays ready for later
      try {
        await this.execute(ownerId, dep.id);
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
      }[]
    >`
      SELECT t.id, t.owner_id AS "ownerId", a.id AS "workspaceId", a.runner_id AS "runnerId",
             a.work_dir_free_bytes AS "freeBytes", r.min_free_disk_mb AS "minFreeDiskMb",
             t.list_id AS "listId"
      FROM task t
      LEFT JOIN workspace a ON a.id = t.assignee_id
      LEFT JOIN runner r ON r.id = a.runner_id
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
    let quotaHeld = 0;
    let diskHeld = 0;
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
      try {
        await this.execute(t.ownerId, t.id);
        this.logger.log(`reconciled ready task ${t.id} -> auto-run`);
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
        await this.execute(list.ownerId, task.id);
        this.logger.log(`foreman dispatched for stalled list ${list.id} (task ${task.id})`);
        await this.recordListEvent(
          list.id,
          'foreman_filed',
          `停滞约 ${list.minutes} 分钟，已自动派出协调任务 ${task.id} 去诊断`,
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
      becomingRunnable: changes.filter((c) => c.to === 'READY' || c.to === 'NONE').length,
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
    const applied = await this.prisma.$transaction(async (tx) => {
      await this.lockDependencyGraph(tx, ownerId);
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
    });
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
      await this.prisma.$transaction(async (tx) => {
        await this.lockDependencyGraph(tx, ownerId);
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
      });
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
    await this.prisma.$transaction(async (tx) => {
      await this.lockDependencyGraph(tx, ownerId);
      await tx.taskDependency.deleteMany({ where: { taskId, dependsOnTaskId } });
    });
    this.realtime.publishForUser(ownerId, RunEventType.TASK_CHANGED, taskId);
    return this.get(ownerId, taskId);
  }

  async remove(ownerId: string, id: string) {
    await this.get(ownerId, id);
    await this.prisma.task.delete({ where: { id } });
    // Cascades may remove prerequisite edges from other open DAGs, so invalidate the owner's
    // task snapshots even though the deleted focus task itself can no longer be fetched.
    this.realtime.publishForUser(ownerId, RunEventType.TASK_CHANGED, id);
    return { ok: true };
  }

  async addComment(ownerId: string, id: string, dto: CreateTaskCommentDto, author?: Creator) {
    const task = await this.get(ownerId, id);
    if (!dto.body) throw new BadRequestException('body is required');
    // Keep only ids that resolve to a workspace this user owns (drop unknown/cross-tenant).
    const mentioned = await this.resolveMentionedWorkspaces(ownerId, dto.mentions);
    const comment = await this.prisma.taskComment.create({
      data: {
        taskId: id,
        // Defaults to the human (user-facing API); the runner path passes the workspace.
        authorType: author?.type ?? CreatorType.USER,
        authorId: author?.id ?? ownerId,
        body: dto.body,
        mentions: mentioned.map((a) => a.id),
      },
    });
    // A new comment changes the list's comment count and the open detail view, so give it the
    // same live-refresh nudge as create()/update() — routed via the task's creator session.
    if (task.creatorSessionId) this.realtime.publishTaskChanged(task.creatorSessionId, id);
    // Notify & trigger each mentioned workspace. Best-effort: a trigger failure (e.g. the
    // workspace has no runner) must never fail the comment write.
    for (const workspace of mentioned) {
      await this.triggerMentionedWorkspace(
        ownerId,
        { id: task.id, title: task.title, provider: task.provider, model: task.model },
        workspace,
        dto.body,
      ).catch(
        (e) =>
          this.logger.warn(`mention trigger failed for workspace ${workspace.id} on task ${id}: ${e?.message ?? e}`),
      );
    }
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
   * Notify & trigger a mentioned workspace on the task: continue its latest resumable
   * session for this task when one exists, otherwise start a fresh one. The workspace reads
   * the full task + comments via the orbit MCP (task_get) and replies via task_comment.
   * Workspaces with no runner can't run a session, so they're skipped (comment still posts).
   */
  private async triggerMentionedWorkspace(
    ownerId: string,
    task: TaskRunTarget,
    workspace: { id: string; runnerId: string | null },
    body: string,
  ): Promise<void> {
    if (!workspace.runnerId) return;
    const prompt =
      `你在任务「${task.title}」的评论区被 @ 提到。\n\n` +
      `评论内容：\n${body}\n\n` +
      `请用 task_get 查看该任务的完整信息与历史评论，并用 task_comment 在该任务下回复。`;
    await this.runWorkspaceOnTask(ownerId, task, workspace, prompt, `回应评论：${task.title}`);
  }

  /**
   * Run a workspace against a task: continue the workspace's most recent session for this task
   * when it's resumable (live, or ended-but-revivable), otherwise start a fresh one.
   * resume() throws ConflictException when the session can't be revived (never ran /
   * runner offline / not started yet) — fall back to a new session. Returns the session id.
   *
   * The task's own provider/model pin (when it has one) is what the run dispatches with,
   * overriding the assignee workspace's defaults.
   */
  private async runWorkspaceOnTask(
    ownerId: string,
    task: TaskRunTarget,
    workspace: { id: string; runnerId: string | null },
    prompt: string,
    newSessionTitle: string,
    // Set only by batchExecute: tags the (re)claimed session with the batch's id +
    // concurrency cap. Omitted for single runs (@-mention / 开始执行), which then
    // clears any stale batch membership so the session escapes a prior batch's cap.
    batch?: { id: string; maxConcurrent: number },
  ): Promise<string | undefined> {
    if (!workspace.runnerId) return undefined;
    // Dedup against a session already mid-flight (PENDING/RUNNING): don't spawn a
    // duplicate. This is the guard the resume-or-create path below lacks: a leftover
    // PENDING session (e.g. from an earlier batch the runner never claimed) makes
    // resume() throw ConflictException, which would otherwise fall through to create()
    // and double-queue the task. A session parked at AWAITING_INPUT/INTERRUPTED is
    // deliberately excluded (see SINGLE_RUN_DEDUP): it's idle, so it falls through to
    // the resume path and the trigger delivers its prompt as a new turn rather than
    // no-oping (which is why "开始执行" on a parked task used to do nothing).
    const occupying = await this.prisma.session.findFirst({
      where: { taskId: task.id, status: { in: SINGLE_RUN_DEDUP } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });
    if (occupying) return occupying.id;
    const latest = await this.prisma.session.findFirst({
      where: { taskId: task.id, workspaceId: workspace.id, ownerId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, provider: true },
    });
    // A session's provider is fixed for its lifetime — its runtime thread belongs to the CLI that
    // created it — so a task re-pinned to a different provider can't be continued on the old
    // session. Falling through to create() is what makes re-pinning take effect on the next run;
    // resuming instead would silently keep running the previous provider forever. A model change
    // needs no such split: resume() re-spawns the runtime and applies it.
    if (latest && (!task.provider || task.provider === latest.provider)) {
      try {
        await this.sessions.resume(
          ownerId,
          latest.id,
          {
            clientTurnId: randomUUID(),
            content: prompt,
            ...(task.model != null ? { model: task.model } : {}),
          },
          { batch: batch ?? null },
        );
        return latest.id;
      } catch (e) {
        if (!(e instanceof ConflictException)) throw e;
      }
    }
    const session = await this.sessions.create(
      ownerId,
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
      { source: 'user', batch },
    );
    return session.id;
  }

  /**
   * Manually kick off the task's responsible workspace from the "开始执行" button: same
   * resume-first-else-create flow as an @-mention, but as a user-facing action, so a
   * missing assignee / runner becomes a hard error instead of a silent skip.
   */
  async execute(ownerId: string, id: string) {
    const task = await this.prisma.task.findFirst({
      where: { id, ownerId },
      select: {
        id: true,
        title: true,
        description: true,
        provider: true,
        model: true,
        status: true,
        listId: true,
        isForeman: true,
        verifiesTaskId: true,
        list: { select: { paused: true, maxConcurrent: true, instructions: true } },
        assignee: { select: { id: true, runnerId: true } },
      },
    });
    if (!task) throw new NotFoundException('task not found');
    const depState = (await this.dependencyStatesFor([id])).get(id) ?? 'NONE';
    if (!canRun(depState)) {
      throw new BadRequestException(
        depState === 'BLOCKED_FAILED'
          ? 'A prerequisite was cancelled — resolve it before running'
          : 'Prerequisites are not all complete yet, cannot run',
      );
    }
    // The sweep already filters paused lists out in SQL; this is the manual button's half of the
    // same rule, so "paused" cannot be quietly bypassed by clicking Run on a task inside one.
    if (task.list?.paused) {
      throw new BadRequestException('This task list is paused — resume it before running');
    }
    if (!task.assignee) throw new BadRequestException('Assign a responsible workspace to the task first');
    if (!task.assignee.runnerId) throw new BadRequestException('The responsible workspace is not bound to a runner, cannot run');
    const prompt = this.buildExecutePrompt(task);
    const sessionId = await this.runWorkspaceOnTask(
      ownerId,
      task,
      { id: task.assignee.id, runnerId: task.assignee.runnerId },
      prompt,
      `执行任务：${task.title}`,
      // The list doubles as a durable batch so its cap is enforced by the claim transaction's
      // existing batch gate — no second scheduler. Only when the list actually sets a cap:
      // batch_id with a NULL batch_max_concurrent makes the gate's `count(*) < NULL` evaluate
      // to NULL, and the session would never be claimed at all.
      task.listId && task.list?.maxConcurrent != null
        ? { id: task.listId, maxConcurrent: task.list.maxConcurrent }
        : undefined,
    );
    if (task.status === TaskStatus.FAILED) await this.clearFailedForRetry(ownerId, task.id);
    return { ok: true, sessionId };
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
    const res = await this.prisma.task.updateMany({
      where: { id: taskId, ownerId, status: TaskStatus.FAILED },
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
  async batchExecute(ownerId: string, taskIds: string[], maxConcurrent?: number) {
    const tasks = await this.prisma.task.findMany({
      where: { id: { in: taskIds }, ownerId },
      select: {
        id: true,
        title: true,
        description: true,
        provider: true,
        model: true,
        status: true,
        // Same inputs the single-task Run assembles its prompt from: a task must not get a
        // different prompt depending on which button started it.
        isForeman: true,
        verifiesTaskId: true,
        list: { select: { instructions: true } },
        assignee: { select: { id: true, runnerId: true } },
      },
    });

    const states = await this.dependencyStatesFor(tasks.map((t) => t.id));
    // Tasks that are already mid-flight: skip them so the batch doesn't double-queue a
    // task that's already running (runWorkspaceOnTask also guards this, but surfacing it here
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
    const occupied = new Set(
      (
        await this.prisma.session.findMany({
          where: { taskId: { in: tasks.map((t) => t.id) }, status: { in: SINGLE_RUN_DEDUP } },
          select: { taskId: true },
        })
      ).map((s) => s.taskId),
    );
    const runnable: typeof tasks = [];
    const skipped: { id: string; title: string; reason: string }[] = [];
    for (const t of tasks) {
      const state = states.get(t.id) ?? 'NONE';
      if (!t.assignee) skipped.push({ id: t.id, title: t.title, reason: 'No assignee' });
      else if (!t.assignee.runnerId)
        skipped.push({ id: t.id, title: t.title, reason: 'Assignee not bound to a runner' });
      else if (!canRun(state))
        skipped.push({
          id: t.id,
          title: t.title,
          reason: state === 'BLOCKED_FAILED' ? 'Prerequisite cancelled' : 'Prerequisites not complete',
        });
      else if (occupied.has(t.id))
        skipped.push({ id: t.id, title: t.title, reason: 'Already running or queued' });
      else runnable.push(t);
    }
    // taskIds with no matching owned task (deleted / not owned) are silently ignored.

    const runnerIds = [...new Set(runnable.map((t) => t.assignee!.runnerId!))];
    // One id ties this batch's sessions together; the queue counts live siblings by it.
    const batch = maxConcurrent != null ? { id: randomUUID(), maxConcurrent } : undefined;

    const dispatch = async (t: (typeof runnable)[number]) => {
      try {
        const sessionId = await this.runWorkspaceOnTask(
          ownerId,
          t,
          { id: t.assignee!.id, runnerId: t.assignee!.runnerId },
          this.buildExecutePrompt(t),
          `执行任务：${t.title}`,
          batch,
        );
        if (t.status === TaskStatus.FAILED) await this.clearFailedForRetry(ownerId, t.id);
        return { id: t.id, ok: true as const, sessionId };
      } catch (e) {
        this.logger.warn(`batchExecute: task ${t.id} failed: ${e}`);
        return { id: t.id, ok: false as const, error: e instanceof Error ? e.message : String(e) };
      }
    };
    // A fixed worker pool avoids an unbounded Promise.all fan-out while preserving the runnable
    // order in `results`, even when individual session initializations finish out of order.
    const results = new Array<Awaited<ReturnType<typeof dispatch>>>(runnable.length);
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = nextIndex++;
        if (index >= runnable.length) return;
        results[index] = await dispatch(runnable[index]);
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(BATCH_EXECUTE_DISPATCH_CONCURRENCY, runnable.length) },
        () => worker(),
      ),
    );

    return {
      dispatched: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok),
      skipped,
      runnerIds,
      batchId: batch?.id ?? null,
      maxConcurrent: maxConcurrent ?? null,
    };
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
   * and silently ignored. Task comments and dependency edges cascade-delete; task sessions
   * are retained and detached by the Session.taskId SET NULL foreign key, including live runs.
   */
  async batchDelete(ownerId: string, taskIds: string[]) {
    const uniqueIds = [...new Set(taskIds)];
    if (uniqueIds.length === 0) return { deleted: 0 };
    const result = await this.prisma.task.deleteMany({
      where: { ownerId, id: { in: uniqueIds } },
    });
    if (result.count > 0) {
      this.realtime.publishForUser(ownerId, RunEventType.TASK_CHANGED, uniqueIds[0]);
    }
    return { deleted: result.count };
  }

  /** Set (or clear, when assigneeId is null) the responsible workspace on many tasks at once. */
  async batchAssign(ownerId: string, taskIds: string[], assigneeId?: string | null) {
    await this.assertOwnedWorkspace(ownerId, assigneeId);
    const res = await this.prisma.task.updateMany({
      where: { id: { in: taskIds }, ownerId },
      data: { assigneeId: assigneeId ?? null },
    });
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
