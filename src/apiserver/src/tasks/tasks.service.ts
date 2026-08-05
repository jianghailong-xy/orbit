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
  RunEventType,
  TaskStatus,
  USAGE_LIMIT_ERROR_MARKERS,
  type PlanUsage,
} from '@orbit/shared';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { withSessionState } from '../sessions/session-state';
import {
  CreateTaskCommentDto,
  CreateTaskDto,
  CreateTasksBatchDto,
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

/** A polymorphic actor (user or agent) that authored a task or comment. */
export type Creator = { type: CreatorType; id: string };

/** What runAgentOnTask needs off a task to dispatch it: its identity, and the provider/model
 *  pin that overrides the assignee agent's own (null on both = inherit from the agent). */
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

/** Database-side mirror of the task row's Run/Retry visibility predicate. */
function runnableTaskWhere(scope: Prisma.TaskWhereInput): Prisma.TaskWhereInput {
  return {
    AND: [
      scope,
      { status: { not: TaskStatus.DONE } },
      { assignee: { is: { runnerId: { not: null } } } },
      { sessions: { none: { status: { in: SINGLE_RUN_DEDUP } } } },
      {
        dependsOn: {
          none: { dependsOnTask: { status: { not: TaskStatus.DONE } } },
        },
      },
    ],
  };
}

// How often the auto-run reconciler re-checks for ready-but-unstarted tasks (see
// reconcileReadyTasks). This is only a backstop — the instant path is triggerDependents,
// fired the moment a prerequisite reaches DONE — so a coarse cadence is enough.
const RECONCILE_INTERVAL_MS = 60_000;

// Brake on the reconciler's re-dispatch. A task it auto-runs can land straight back in
// the candidate set: when a run dies before its agent ever moved the task to IN_PROGRESS,
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
      this.reconcileReadyTasks().catch((e) =>
        this.logger.error(`reconcile sweep failed: ${e instanceof Error ? e.message : e}`),
      );
    }, RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref(); // don't keep the process alive just for this timer
  }

  onModuleDestroy(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
  }

  /**
   * A task may only be assigned to an agent the same user owns — otherwise a user
   * could point a task at another tenant's agent (cross-tenant routing). Mirrors
   * AgentsService.assertOwnedRunner / SessionsService.assertOwnedRefs.
   */
  private async assertOwnedAgent(ownerId: string, agentId?: string | null): Promise<void> {
    if (!agentId) return;
    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId, ownerId, deletedAt: null },
      select: { id: true },
    });
    if (!agent) throw new ForbiddenException('agent not found');
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

  /** A task may only be filed under a list the same user owns (cf. assertOwnedAgent). */
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
   * Validate an agent belongs to the owner and return it as a task/comment creator.
   * Used by the runner MCP path to attribute work to the acting agent. Returns
   * undefined when no agent id is supplied so callers fall back to USER attribution.
   */
  async resolveAgentCreator(ownerId: string, agentId?: string): Promise<Creator | undefined> {
    if (!agentId) return undefined;
    const agent = await this.prisma.agent.findFirst({
      where: { id: agentId, ownerId },
      select: { id: true },
    });
    if (!agent) throw new ForbiddenException('agent not found');
    return { type: CreatorType.AGENT, id: agent.id };
  }

  async create(ownerId: string, dto: CreateTaskDto, creator?: Creator, creatorSessionId?: string) {
    if (!dto.title) throw new BadRequestException('title is required');
    await this.assertOwnedAgent(ownerId, dto.assigneeId);
    await this.assertOwnedList(ownerId, dto.listId);
    await this.assertUsableProvider(ownerId, dto.provider);
    // Link to the originating session only when it's one this owner has (the runner
    // injects its own session id, so this is a guard, not a trust boundary). A stale id
    // would otherwise fail the FK insert.
    const sessionId = await this.resolveOwnedSession(ownerId, creatorSessionId);
    // Validate prerequisites up front so we never create a task and then reject its deps.
    // No cycle check needed: a brand-new task has no dependents, so it can't close a loop.
    const dependsOnTaskIds = [...new Set(dto.dependsOnTaskIds ?? [])];
    if (dependsOnTaskIds.length) await this.assertOwnedTasks(ownerId, dependsOnTaskIds);
    const data = this.taskCreateData(ownerId, dto, creator, sessionId);
    // Initial edges and their task must become visible atomically. Taking the same owner lock
    // used by add/replace prevents a concurrent reverse-edge write from observing the new task
    // before its prerequisites and closing a cycle. Any FK/write failure rolls the task back too.
    const task = dependsOnTaskIds.length
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
  ): Prisma.TaskUncheckedCreateInput {
    return {
      title: dto.title,
      description: dto.description,
      ownerId,
      // Defaults to the human (user-facing API); the runner path passes the agent.
      creatorType: creator?.type ?? CreatorType.USER,
      creatorId: creator?.id ?? ownerId,
      creatorSessionId: sessionId,
      assigneeId: dto.assigneeId,
      listId: dto.listId,
      dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      provider: dto.provider,
      model: dto.model,
      autoRunWhenReady: dto.autoRunWhenReady,
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
      await this.assertOwnedAgent(ownerId, assigneeId);
    for (const listId of distinct(items.map((item) => item.listId)))
      await this.assertOwnedList(ownerId, listId);
    for (const provider of distinct(items.map((item) => item.provider)))
      await this.assertUsableProvider(ownerId, provider);
    const existingPrerequisites = distinct(items.flatMap((item) => item.dependsOnTaskIds ?? []));
    if (existingPrerequisites.length) await this.assertOwnedTasks(ownerId, existingPrerequisites);
    const sessionId = await this.resolveOwnedSession(ownerId, creatorSessionId);

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
        const task = await tx.task.create({
          data: this.taskCreateData(ownerId, item, creator, sessionId),
        });
        if (item.ref !== undefined) idByRef.set(item.ref, task.id);
        const dependsOnTaskIds = [
          ...new Set([
            ...(item.dependsOnTaskIds ?? []),
            // Non-null: every ref was proven to belong to an earlier, already-created item above.
            ...(item.dependsOnRefs ?? []).map((ref) => idByRef.get(ref)!),
          ]),
        ];
        if (dependsOnTaskIds.length)
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

    const filteredWhere: Prisma.TaskWhereInput = runnableOnly
      ? runnableTaskWhere(scopedWhere)
      : runningOnly
        ? { ...scopedWhere, sessions: { some: { status: RunStatus.RUNNING } } }
        : { ...scopedWhere };
    if (statuses) filteredWhere.status = { in: statuses };
    const search = query.q?.trim();
    if (search) filteredWhere.title = { contains: search.slice(0, 200), mode: 'insensitive' };

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

    const [rows, filteredTotal, statusGroups, running, queued, runnable] = await Promise.all([
      this.prisma.task.findMany({
        where: pageWhere,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        include: {
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
      }),
      this.prisma.task.count({ where: filteredWhere }),
      this.prisma.task.groupBy({
        by: ['status'],
        where: scopedWhere,
        _count: { _all: true },
      }),
      this.prisma.task.count({
        where: { ...scopedWhere, sessions: { some: { status: RunStatus.RUNNING } } },
      }),
      this.prisma.task.count({
        where: {
          ...scopedWhere,
          sessions: { some: { status: RunStatus.PENDING } },
          NOT: { sessions: { some: { status: RunStatus.RUNNING } } },
        },
      }),
      this.prisma.task.count({ where: runnableTaskWhere(scopedWhere) }),
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
    const byStatus = new Map(statusGroups.map((group) => [group.status, group._count._all]));
    const counts = {
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

    return {
      items,
      nextCursor: hasMore && items.length ? encodeTaskPageCursor(items[items.length - 1]) : null,
      total: filteredTotal,
      counts,
    };
  }

  /**
   * Tag each task with `running` = it has a RUNNING session (actually executing right
   * now) and `queued` = it has a PENDING session waiting for a runner slot but nothing
   * running yet. Both are the live ground truth, distinct from Task.status (an
   * agent-maintained label that can lag): the list breathes only for `running` and
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
            agent: { select: { name: true } },
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
    const agentIds = comments.filter((c) => c.authorType === CreatorType.AGENT).map((c) => c.authorId);
    const [users, agents] = await Promise.all([
      userIds.length
        ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
        : [],
      agentIds.length
        ? this.prisma.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } })
        : [],
    ]);
    const names = new Map<string, string>();
    for (const u of users) names.set(u.id, u.name);
    for (const a of agents) names.set(a.id, a.name);
    return comments.map((c) => ({ ...c, authorName: names.get(c.authorId) ?? null }));
  }

  async update(ownerId: string, id: string, dto: UpdateTaskDto) {
    const before = await this.get(ownerId, id);
    if (dto.assigneeId) await this.assertOwnedAgent(ownerId, dto.assigneeId);
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
    // carry the refresh. Publish it on the owner's stream so Agent/MCP and CLI replacements
    // refresh an already-open DAG immediately. Scalar-only updates keep their existing
    // session-scoped event (and its agent context).
    if (dependsOnTaskIds !== undefined) {
      this.realtime.publishForUser(ownerId, RunEventType.TASK_CHANGED, id);
    } else if (before.creatorSessionId) {
      this.realtime.publishTaskChanged(before.creatorSessionId, id);
    }
    // This is the dependency trigger point: "A 完成" is anchored on Task.status === DONE
    // (both the user PATCH and the agent's task_update MCP flow through here). On the
    // transition into DONE, release & auto-run any now-ready dependents. Best-effort: a
    // trigger failure must never fail the status write that caused it.
    if (dto.status === TaskStatus.DONE && before.status !== 'DONE') {
      await this.triggerDependents(ownerId, id).catch((e) =>
        this.logger.warn(`triggerDependents failed for task ${id}: ${e?.message ?? e}`),
      );
    }
    return updated;
  }

  /**
   * A prerequisite (`doneTaskId`) just reached DONE: find every task that depends on it
   * and auto-run the ones this completion unblocked. A dependent fires only when it is
   * now fully READY (all its prerequisites DONE), still actionable (OPEN), opted into
   * auto-run, and has an assignee bound to a runner. Each run is best-effort and isolated
   * so one failure doesn't stop the others. Downstream chains flow naturally: the agent
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
    const ready = await this.prisma.task.findMany({
      where: {
        status: TaskStatus.OPEN,
        autoRunWhenReady: true,
        // Assignee bound to a runner — the exact gap triggerDependents skips ("stays ready
        // for later"). Once a runner is attached, the task becomes eligible here.
        assignee: { runnerId: { not: null } },
        // READY, resolved database-side: the task HAS prerequisites (a dependency-free task
        // is never auto-run) and none of them is unfinished. Same predicate as
        // computeDependencyState's READY — BLOCKED and BLOCKED_FAILED alike have a
        // prerequisite that is `not DONE` and drop out here. Filtering in SQL rather than in
        // memory is what keeps this sweep proportional to the work: a backlog is
        // overwhelmingly BLOCKED tasks waiting their turn, and loading all of them (plus
        // every one of their dependency edges) once a minute only to discard them dwarfs
        // the dispatch it exists to do.
        dependsOn: { some: {}, none: { dependsOnTask: { status: { not: TaskStatus.DONE } } } },
        // Not already being worked or queued: don't double-dispatch, and don't re-poke an
        // idle AWAITING_INPUT/INTERRUPTED session every pass. Same set as reclaimStalledTask.
        sessions: { none: { status: { in: TASK_OCCUPYING } } },
      },
      select: {
        id: true,
        ownerId: true,
        assignee: { select: { provider: true, runnerId: true } },
      },
    });
    if (ready.length === 0) return;
    // Two independent brakes. The quota gate comes first because it is the one that knows
    // *when* work can resume, and it prevents the doomed run rather than reacting to it.
    const quotaBlocked = await this.quotaBlockedRunners(ready);
    // Don't re-dispatch a task whose runs keep failing (see AUTO_RUN_RETRY_BACKOFF_MS).
    const heldOff = await this.autoRunHoldOff(ready.map((t) => t.id));
    let quotaHeld = 0;
    let resumesAt: Date | undefined;
    for (const t of ready) {
      const blockedUntil = t.assignee?.runnerId
        ? quotaBlocked.get(`${t.assignee.runnerId}:${t.assignee.provider}`)
        : undefined;
      if (blockedUntil) {
        quotaHeld += 1;
        if (!resumesAt || blockedUntil < resumesAt) resumesAt = blockedUntil;
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
  }

  /**
   * Of these tasks' assignees, which (runner, provider) pairs have an exhausted account quota
   * right now — mapped to the moment it frees up. Dispatching against one is pointless: the
   * run dies on arrival with the provider's own "usage limit" error, so the only effect is a
   * failed session per sweep until the window resets (a weekly limit means days of them).
   *
   * Keyed per (runner, provider) because one runner can host agents on several runtimes and
   * only some of their quotas may be spent. Runners whose snapshot reports no exhausted
   * window — or reports one with no reset time — are simply absent: the failure backoff, not
   * this gate, handles anything we cannot put a resume time on.
   */
  private async quotaBlockedRunners(
    tasks: Array<{ assignee: { provider: string; runnerId: string | null } | null }>,
  ): Promise<Map<string, Date>> {
    const runnerIds = [
      ...new Set(
        tasks.map((t) => t.assignee?.runnerId).filter((id): id is string => typeof id === 'string'),
      ),
    ];
    if (runnerIds.length === 0) return new Map();
    const runners = await this.prisma.runner.findMany({
      where: { id: { in: runnerIds } },
      select: { id: true, planUsage: true },
    });
    const usageByRunner = new Map(
      runners.map((r) => [r.id, r.planUsage as unknown as PlanUsage | null]),
    );
    const now = new Date();
    const blocked = new Map<string, Date>();
    for (const t of tasks) {
      const assignee = t.assignee;
      if (!assignee?.runnerId) continue;
      const key = `${assignee.runnerId}:${assignee.provider}`;
      if (blocked.has(key)) continue;
      const until = planUsageBlockedUntil(
        usageByRunner.get(assignee.runnerId),
        assignee.provider,
        now,
      );
      if (until) blocked.set(key, until);
    }
    return blocked;
  }

  /**
   * Of `taskIds`, which must NOT be auto-run right now because their previous runs failed:
   * either the task is still inside the backoff window for its failure count, or it has
   * burned through MAX_AUTO_RUN_FAILURES and is left for a human. Counting every FAILED
   * session of the task is deliberate — a task that ever ran to completion is DONE, not a
   * reconciler candidate, so for an OPEN auto-run task these failures are its run history.
   * Tasks with no failed run are absent from the result and dispatch immediately.
   *
   * Runs killed by an exhausted provider quota are excluded: they carry no evidence that
   * anything is wrong with the task, so letting them spend its budget would leave a fleet
   * permanently un-runnable after one quota outage — exactly the tasks that should pick
   * themselves back up once the window resets.
   */
  private async autoRunHoldOff(taskIds: string[]): Promise<Set<string>> {
    const held = new Set<string>();
    const uniqueIds = [...new Set(taskIds)];
    for (let offset = 0; offset < uniqueIds.length; offset += TASK_ID_QUERY_CHUNK) {
      const ids = uniqueIds.slice(offset, offset + TASK_ID_QUERY_CHUNK);
      const failures = await this.prisma.session.groupBy({
        by: ['taskId'],
        where: {
          taskId: { in: ids },
          status: RunStatus.FAILED,
          NOT: {
            OR: USAGE_LIMIT_ERROR_MARKERS.map((marker) => ({
              error: { contains: marker, mode: Prisma.QueryMode.insensitive },
            })),
          },
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
    }
    return held;
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
    // Agent edits have no guaranteed session to publish through (the target may be web-created),
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
    // Keep only ids that resolve to an agent this user owns (drop unknown/cross-tenant).
    const mentioned = await this.resolveMentionedAgents(ownerId, dto.mentions);
    const comment = await this.prisma.taskComment.create({
      data: {
        taskId: id,
        // Defaults to the human (user-facing API); the runner path passes the agent.
        authorType: author?.type ?? CreatorType.USER,
        authorId: author?.id ?? ownerId,
        body: dto.body,
        mentions: mentioned.map((a) => a.id),
      },
    });
    // A new comment changes the list's comment count and the open detail view, so give it the
    // same live-refresh nudge as create()/update() — routed via the task's creator session.
    if (task.creatorSessionId) this.realtime.publishTaskChanged(task.creatorSessionId, id);
    // Notify & trigger each mentioned agent. Best-effort: a trigger failure (e.g. the
    // agent has no runner) must never fail the comment write.
    for (const agent of mentioned) {
      await this.triggerMentionedAgent(
        ownerId,
        { id: task.id, title: task.title, provider: task.provider, model: task.model },
        agent,
        dto.body,
      ).catch(
        (e) =>
          this.logger.warn(`mention trigger failed for agent ${agent.id} on task ${id}: ${e?.message ?? e}`),
      );
    }
    return comment;
  }

  /** Filter mention ids down to agents this user owns; dedupe. Returns id + runnerId. */
  private async resolveMentionedAgents(ownerId: string, ids?: string[]) {
    if (!ids?.length) return [];
    const unique = [...new Set(ids)];
    return this.prisma.agent.findMany({
      where: { id: { in: unique }, ownerId },
      select: { id: true, runnerId: true },
    });
  }

  /**
   * Notify & trigger a mentioned agent on the task: continue its latest resumable
   * session for this task when one exists, otherwise start a fresh one. The agent reads
   * the full task + comments via the orbit MCP (task_get) and replies via task_comment.
   * Agents with no runner can't run a session, so they're skipped (comment still posts).
   */
  private async triggerMentionedAgent(
    ownerId: string,
    task: TaskRunTarget,
    agent: { id: string; runnerId: string | null },
    body: string,
  ): Promise<void> {
    if (!agent.runnerId) return;
    const prompt =
      `你在任务「${task.title}」的评论区被 @ 提到。\n\n` +
      `评论内容：\n${body}\n\n` +
      `请用 task_get 查看该任务的完整信息与历史评论，并用 task_comment 在该任务下回复。`;
    await this.runAgentOnTask(ownerId, task, agent, prompt, `回应评论：${task.title}`);
  }

  /**
   * Run an agent against a task: continue the agent's most recent session for this task
   * when it's resumable (live, or ended-but-revivable), otherwise start a fresh one.
   * resume() throws ConflictException when the session can't be revived (never ran /
   * runner offline / not started yet) — fall back to a new session. Returns the session id.
   *
   * The task's own provider/model pin (when it has one) is what the run dispatches with,
   * overriding the assignee agent's defaults.
   */
  private async runAgentOnTask(
    ownerId: string,
    task: TaskRunTarget,
    agent: { id: string; runnerId: string | null },
    prompt: string,
    newSessionTitle: string,
    // Set only by batchExecute: tags the (re)claimed session with the batch's id +
    // concurrency cap. Omitted for single runs (@-mention / 开始执行), which then
    // clears any stale batch membership so the session escapes a prior batch's cap.
    batch?: { id: string; maxConcurrent: number },
  ): Promise<string | undefined> {
    if (!agent.runnerId) return undefined;
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
      where: { taskId: task.id, agentId: agent.id, ownerId },
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
        agentId: agent.id,
        taskId: task.id,
        title: newSessionTitle.slice(0, 80),
        // Unpinned (null) fields are left off entirely so the session keeps inheriting the
        // agent's provider/model, exactly as before these columns existed.
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
   * Manually kick off the task's responsible agent from the "开始执行" button: same
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
    if (!task.assignee) throw new BadRequestException('Assign a responsible agent to the task first');
    if (!task.assignee.runnerId) throw new BadRequestException('The responsible agent is not bound to a runner, cannot run');
    const prompt = this.buildExecutePrompt(task);
    const sessionId = await this.runAgentOnTask(
      ownerId,
      task,
      { id: task.assignee.id, runnerId: task.assignee.runnerId },
      prompt,
      `执行任务：${task.title}`,
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

  private buildExecutePrompt(task: { title: string; description?: string | null }): string {
    return (
      `请开始执行任务「${task.title}」。\n\n` +
      (task.description ? `任务描述：\n${task.description}\n\n` : '') +
      `请按以下步骤进行：\n` +
      `1. 先用 task_get 查看该任务的完整信息与历史评论。\n` +
      `2. 执行任务。\n` +
      `3. 完成后，用 task_comment 在该任务下评论一段本次执行的总结（做了什么、结果如何、有无遗留），` +
      `再用 task_update 将该任务状态（status）置为 DONE。\n` +
      `4. 如果执行失败或未能完成，绝不要将状态置为 DONE；请先用 task_comment 在该任务下明确说明失败/未完成的原因，再将状态置为 IN_PROGRESS。`
    );
  }

  /**
   * Run several tasks in one action. Each task's responsible agent is kicked off the
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
        assignee: { select: { id: true, runnerId: true } },
      },
    });

    const states = await this.dependencyStatesFor(tasks.map((t) => t.id));
    // Tasks that already have a queued/live session: skip them so the batch doesn't
    // double-queue a task that's already running (runAgentOnTask also guards this, but
    // surfacing it here lets us report it as skipped rather than silently dispatched).
    const occupied = new Set(
      (
        await this.prisma.session.findMany({
          where: { taskId: { in: tasks.map((t) => t.id) }, status: { in: TASK_OCCUPYING } },
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
        skipped.push({ id: t.id, title: t.title, reason: 'Already has an in-progress session' });
      else runnable.push(t);
    }
    // taskIds with no matching owned task (deleted / not owned) are silently ignored.

    const runnerIds = [...new Set(runnable.map((t) => t.assignee!.runnerId!))];
    // One id ties this batch's sessions together; the queue counts live siblings by it.
    const batch = maxConcurrent != null ? { id: randomUUID(), maxConcurrent } : undefined;

    const dispatch = async (t: (typeof runnable)[number]) => {
      try {
        const sessionId = await this.runAgentOnTask(
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

  /** Set (or clear, when assigneeId is null) the responsible agent on many tasks at once. */
  async batchAssign(ownerId: string, taskIds: string[], assigneeId?: string | null) {
    await this.assertOwnedAgent(ownerId, assigneeId);
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
