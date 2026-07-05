import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreatorType, Prisma, RunStatus, TaskComment } from '@prisma/client';
import { TaskStatus } from '@orbit/shared';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import { CreateTaskCommentDto, CreateTaskDto, UpdateTaskDto } from './dto';
import { TASK_OCCUPYING } from './reclaim-stalled-task';
import {
  canRun,
  computeDependencyState,
  wouldCreateCycle,
  type DependencyState,
} from './task-dependencies';

/** A polymorphic actor (user or agent) that authored a task or comment. */
export type Creator = { type: CreatorType; id: string };

// Version-agnostic (UUIDv7-safe) shape check. A non-UUID id would otherwise reach
// Postgres and surface as a 500; we treat it like any unknown task instead.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Single-run dedup (开始执行 / @-mention): only a PENDING (queued) or RUNNING (a turn is
// actively executing) session means the task is already mid-flight, so re-triggering it
// must be a no-op. A session parked at AWAITING_INPUT/INTERRUPTED is idle — it is NOT in
// this set so it falls through to the resume path, where the trigger delivers its prompt
// as a new turn instead of silently returning the parked session and doing nothing.
const SINGLE_RUN_DEDUP: RunStatus[] = [RunStatus.PENDING, RunStatus.RUNNING];

@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

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
    const count = await this.prisma.task.count({ where: { id: { in: unique }, ownerId } });
    if (count !== unique.length) throw new NotFoundException('task not found');
  }

  /**
   * Derive each task's DependencyState in one batched pass: load every dependency edge
   * whose dependent is in `taskIds`, joined to its prerequisite's status, group by
   * dependent and reduce. Tasks with no prerequisites are absent (caller reads absent as
   * 'NONE'). Mirrors withRunning's single-grouped-query approach to avoid N+1.
   */
  private async dependencyStatesFor(taskIds: string[]): Promise<Map<string, DependencyState>> {
    if (taskIds.length === 0) return new Map();
    const edges = await this.prisma.taskDependency.findMany({
      where: { taskId: { in: taskIds } },
      select: { taskId: true, dependsOnTask: { select: { status: true } } },
    });
    const byTask = new Map<string, TaskStatus[]>();
    for (const e of edges) {
      const status = e.dependsOnTask.status as unknown as TaskStatus;
      const arr = byTask.get(e.taskId);
      if (arr) arr.push(status);
      else byTask.set(e.taskId, [status]);
    }
    const out = new Map<string, DependencyState>();
    for (const [taskId, statuses] of byTask) out.set(taskId, computeDependencyState(statuses));
    return out;
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
    // Link to the originating session only when it's one this owner has (the runner
    // injects its own session id, so this is a guard, not a trust boundary). A stale id
    // would otherwise fail the FK insert.
    const sessionId = await this.resolveOwnedSession(ownerId, creatorSessionId);
    // Validate prerequisites up front so we never create a task and then reject its deps.
    // No cycle check needed: a brand-new task has no dependents, so it can't close a loop.
    const dependsOnTaskIds = [...new Set(dto.dependsOnTaskIds ?? [])];
    if (dependsOnTaskIds.length) await this.assertOwnedTasks(ownerId, dependsOnTaskIds);
    const task = await this.prisma.task.create({
      data: {
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
        autoRunWhenReady: dto.autoRunWhenReady,
      },
    });
    if (dependsOnTaskIds.length) {
      await this.prisma.taskDependency.createMany({
        data: dependsOnTaskIds.map((dependsOnTaskId) => ({ taskId: task.id, dependsOnTaskId })),
        skipDuplicates: true,
      });
    }
    return task;
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
    const withRun = await this.withRunning(tasks);
    const states = await this.dependencyStatesFor(tasks.map((t) => t.id));
    return withRun.map((t) => {
      const dependencyState = states.get(t.id) ?? 'NONE';
      // `blocked` drives the list's lock indicator; canRun is the single source of truth
      // shared with the execute/batch gates so the UI never offers a run the API rejects.
      return { ...t, dependencyState, blocked: !canRun(dependencyState) };
    });
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
    tasks: T[],
  ): Promise<(T & { running: boolean; queued: boolean })[]> {
    if (tasks.length === 0) return [];
    const busy = await this.prisma.session.groupBy({
      by: ['taskId', 'status'],
      where: {
        taskId: { in: tasks.map((t) => t.id) },
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
            createdAt: true,
            agent: { select: { name: true } },
          },
        },
        creatorSession: { select: { id: true, title: true, status: true } },
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
    const data: Prisma.TaskUpdateInput = {
      title: dto.title,
      description: dto.description,
      status: dto.status,
      dueDate: dto.dueDate === null ? null : dto.dueDate ? new Date(dto.dueDate) : undefined,
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
    const updated = await this.prisma.task.update({ where: { id }, data });
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

  /** Add a "task depends on dependsOnTaskId" edge; rejects self-deps and cycles. */
  async addDependency(ownerId: string, taskId: string, dependsOnTaskId: string) {
    if (taskId === dependsOnTaskId) throw new BadRequestException('A task cannot depend on itself');
    await this.assertOwnedTasks(ownerId, [taskId, dependsOnTaskId]);
    // Cycle check over this owner's whole dependency subgraph (both endpoints are
    // same-owner by construction, so filtering edges by the dependent's owner is enough).
    const edges = await this.prisma.taskDependency.findMany({
      where: { task: { ownerId } },
      select: { taskId: true, dependsOnTaskId: true },
    });
    if (wouldCreateCycle(edges, taskId, dependsOnTaskId)) {
      throw new BadRequestException('This dependency would create a cycle');
    }
    try {
      await this.prisma.taskDependency.create({ data: { taskId, dependsOnTaskId } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('This dependency already exists');
      }
      throw e;
    }
    return this.get(ownerId, taskId);
  }

  /** Remove a prerequisite edge (no-op if it doesn't exist). */
  async removeDependency(ownerId: string, taskId: string, dependsOnTaskId: string) {
    await this.assertOwnedTasks(ownerId, [taskId]);
    await this.prisma.taskDependency.deleteMany({ where: { taskId, dependsOnTaskId } });
    return this.get(ownerId, taskId);
  }

  async remove(ownerId: string, id: string) {
    await this.get(ownerId, id);
    await this.prisma.task.delete({ where: { id } });
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
    // Notify & trigger each mentioned agent. Best-effort: a trigger failure (e.g. the
    // agent has no runner) must never fail the comment write.
    for (const agent of mentioned) {
      await this.triggerMentionedAgent(ownerId, { id: task.id, title: task.title }, agent, dto.body).catch(
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
    task: { id: string; title: string },
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
   */
  private async runAgentOnTask(
    ownerId: string,
    task: { id: string; title: string },
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
      select: { id: true },
    });
    if (latest) {
      try {
        await this.sessions.resume(
          ownerId,
          latest.id,
          { clientTurnId: randomUUID(), content: prompt },
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
      },
      { source: 'system', batch },
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
      { id: task.id, title: task.title },
      { id: task.assignee.id, runnerId: task.assignee.runnerId },
      prompt,
      `执行任务：${task.title}`,
    );
    return { ok: true, sessionId };
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
   * sessions share one batchId and this limit, and the claim queue gates live sessions
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

    const results = await Promise.all(
      runnable.map(async (t) => {
        try {
          const sessionId = await this.runAgentOnTask(
            ownerId,
            { id: t.id, title: t.title },
            { id: t.assignee!.id, runnerId: t.assignee!.runnerId },
            this.buildExecutePrompt(t),
            `执行任务：${t.title}`,
            batch,
          );
          return { id: t.id, ok: true as const, sessionId };
        } catch (e) {
          this.logger.warn(`batchExecute: task ${t.id} failed: ${e}`);
          return { id: t.id, ok: false as const, error: e instanceof Error ? e.message : String(e) };
        }
      }),
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
