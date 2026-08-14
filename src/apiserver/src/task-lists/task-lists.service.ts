import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CreatorType, RunStatus, TaskStatus } from '@prisma/client';
import { RunEventType, TaskStatus as SharedTaskStatus } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { canRun, computeDependencyState } from '../tasks/task-dependencies';
import { TASK_LIST_SELECT } from '../tasks/tasks.service';
import { CreateTaskListDto, UpdateTaskListDto } from './dto';

/**
 * Who is making a policy change. Defaults to the owning user when absent, which is what the HTTP
 * endpoints pass; an in-session agent supplies its own identity and the session it acted from, so
 * a change made by a run can be traced back to the run that made it.
 */
export interface RevisionAuthor {
  type: CreatorType;
  id: string;
  sessionId?: string | null;
}

@Injectable()
export class TaskListsService {
  constructor(
    private readonly prisma: PrismaService,
    // @Global RealtimeModule. A list has no session to hang an event off (the MCP tasklist_create
    // path included), so these push user-scoped — see RealtimeService.publishForUser.
    private readonly realtime: RealtimeService,
  ) {}

  async create(ownerId: string, dto: CreateTaskListDto) {
    if (!dto.title) throw new BadRequestException('title is required');
    const list = await this.prisma.taskList.create({
      data: { title: dto.title, ownerId },
    });
    this.realtime.publishForUser(ownerId, RunEventType.TASK_LIST_CHANGED, list.id);
    return list;
  }

  async list(ownerId: string) {
    const lists = await this.prisma.taskList.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { tasks: true } } },
    });
    // `runningTasks` = how many of the list's tasks are actually executing right now:
    // a task with a busy (PENDING/RUNNING) session. Same liveness notion the task
    // detail panel uses for its 执行中 state — IN_PROGRESS is just a label, not a live
    // run. One grouped query keeps this O(1) regardless of list count.
    const listIds = lists.map((l) => l.id);
    const grouped = await this.prisma.task.groupBy({
      by: ['listId'],
      where: {
        listId: { in: listIds },
        sessions: { some: { status: { in: [RunStatus.PENDING, RunStatus.RUNNING] } } },
      },
      _count: { _all: true },
    });
    const running = new Map(grouped.map((g) => [g.listId, g._count._all]));
    // `completed` = the whole list is finished: it has at least one task and every
    // task is DONE. Counted with the same grouped shape (one query, O(1) in list
    // count); compared against the list's total task count below.
    const doneGrouped = await this.prisma.task.groupBy({
      by: ['listId'],
      where: { listId: { in: listIds }, status: TaskStatus.DONE },
      _count: { _all: true },
    });
    const done = new Map(doneGrouped.map((g) => [g.listId, g._count._all]));
    return lists.map((l) => {
      const total = l._count?.tasks ?? 0;
      return {
        ...l,
        runningTasks: running.get(l.id) ?? 0,
        completed: total > 0 && (done.get(l.id) ?? 0) === total,
      };
    });
  }

  async get(ownerId: string, id: string) {
    const list = await this.prisma.taskList.findFirst({
      where: { id, ownerId },
      include: {
        // Mirror TasksService.listPage()'s row shape so the frontend can reuse the row.
        tasks: { orderBy: { createdAt: 'desc' }, select: TASK_LIST_SELECT },
      },
    });
    if (!list) throw new NotFoundException('task list not found');
    const tasks = await this.resolveTaskCreators(list.tasks);
    // Tag each task with the same live-run and dependency-gate fields as the Active view,
    // so its row keeps the running/queued treatment and lock indicator in sync.
    const [busy, dependencies] = tasks.length
      ? await Promise.all([
          this.prisma.session.groupBy({
            by: ['taskId', 'status'],
            where: {
              ownerId,
              taskId: { not: null },
              task: { is: { listId: id } },
              status: { in: [RunStatus.PENDING, RunStatus.RUNNING] },
            },
            _count: { _all: true },
          }),
          this.prisma.taskDependency.findMany({
            where: { task: { ownerId, listId: id } },
            select: { taskId: true, dependsOnTask: { select: { status: true } } },
          }),
        ])
      : [[], []];
    const running = new Set(
      busy.filter((b) => b.status === RunStatus.RUNNING).map((b) => b.taskId),
    );
    const queued = new Set(
      busy.filter((b) => b.status === RunStatus.PENDING).map((b) => b.taskId),
    );
    const prerequisiteStatuses = new Map<string, SharedTaskStatus[]>();
    for (const dependency of dependencies) {
      const statuses = prerequisiteStatuses.get(dependency.taskId) ?? [];
      statuses.push(dependency.dependsOnTask.status as unknown as SharedTaskStatus);
      prerequisiteStatuses.set(dependency.taskId, statuses);
    }
    return {
      ...list,
      tasks: tasks.map((t) => {
        const dependencyState = computeDependencyState(prerequisiteStatuses.get(t.id) ?? []);
        return {
          ...t,
          running: running.has(t.id),
          queued: queued.has(t.id) && !running.has(t.id),
          dependencyState,
          blocked: !canRun(dependencyState),
        };
      }),
    };
  }

  /**
   * Resolve each task's polymorphic creator (USER|AGENT) to a display name in one
   * batched pass (no FK to include), mirroring TasksService.resolveCommentAuthors.
   * Adds `creatorName` so the frontend row can show who filed the task.
   */
  private async resolveTaskCreators<T extends { creatorType: CreatorType; creatorId: string }>(
    tasks: T[],
  ): Promise<(T & { creatorName: string | null })[]> {
    if (tasks.length === 0) return [];
    const userIds = [
      ...new Set(tasks.filter((t) => t.creatorType === CreatorType.USER).map((t) => t.creatorId)),
    ];
    const workspaceIds = [
      ...new Set(tasks.filter((t) => t.creatorType === CreatorType.AGENT).map((t) => t.creatorId)),
    ];
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
    return tasks.map((t) => ({ ...t, creatorName: names.get(t.creatorId) ?? null }));
  }

  /**
   * Cheap ownership check for the policy paths. get() loads every task in the list with its
   * dependency state, which is the right shape for a detail page and absurd as authorization for
   * a one-field write — a 501-task list would be read in full to set a boolean.
   */
  private async assertOwned(ownerId: string, id: string): Promise<void> {
    const list = await this.prisma.taskList.findFirst({
      where: { id, ownerId },
      select: { id: true },
    });
    if (!list) throw new NotFoundException('task list not found');
  }

  /**
   * Resolve the session a policy change was made from, keeping only one this owner really has.
   * An unknown id becomes null rather than an error: the attribution is a breadcrumb, and losing
   * it must not fail the write it describes.
   */
  private async resolveAuthorSession(
    ownerId: string,
    sessionId?: string | null,
  ): Promise<string | null> {
    if (!sessionId) return null;
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, ownerId },
      select: { id: true },
    });
    return session?.id ?? null;
  }

  async update(ownerId: string, id: string, dto: UpdateTaskListDto, author?: RevisionAuthor) {
    await this.assertOwned(ownerId, id);
    // Each field is written only when the caller sent it, so a title rename cannot silently
    // clear a pause and a pause cannot blank a title. `maxConcurrent: null` is a meaningful
    // value (uncap), which is why it is distinguished from "absent" rather than falsy-checked.
    const policy = {
      ...(dto.paused !== undefined ? { paused: dto.paused } : {}),
      ...(dto.maxConcurrent !== undefined ? { maxConcurrent: dto.maxConcurrent } : {}),
      ...(dto.foremanWorkspaceId !== undefined
        ? { foremanWorkspaceId: dto.foremanWorkspaceId }
        : {}),
      ...(dto.foremanStallMinutes !== undefined
        ? { foremanStallMinutes: dto.foremanStallMinutes }
        : {}),
      // Blank is stored as null so "no instructions" has one representation: an empty string
      // and null must not assemble into different prompts.
      ...(dto.instructions !== undefined
        ? { instructions: dto.instructions?.trim() ? dto.instructions : null }
        : {}),
    };
    const list = await this.writePolicy(
      ownerId,
      id,
      { ...(dto.title !== undefined ? { title: dto.title } : {}), ...policy },
      Object.keys(policy).length > 0
        ? {
            note: dto.note,
            author,
            authorSessionId: await this.resolveAuthorSession(ownerId, author?.sessionId),
          }
        : null,
    );
    this.realtime.publishForUser(ownerId, RunEventType.TASK_LIST_CHANGED, id);
    return list;
  }

  /**
   * Apply `data` to the list and, when it touches dispatch policy, record the result as the next
   * revision — both under the list's row lock, so a concurrent writer can neither interleave
   * with the read-modify-write nor mint the same version number.
   *
   * `recordAs` null means this write changed no policy (a rename), which deliberately produces
   * no revision: history is for decisions about how the list dispatches, and padding it with
   * renames buries them.
   */
  private async writePolicy(
    ownerId: string,
    id: string,
    data: Record<string, unknown>,
    recordAs: { note?: string | null; author?: RevisionAuthor; authorSessionId?: string | null } | null,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "task_list"
        WHERE id = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
        FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundException('task list not found');
      if (recordAs) {
        // A list edited for the first time has no history, so its pre-change state is recorded
        // as v1 before the new one lands. That is what makes "restore" reach back past the
        // first edit on the 118 lists that predate this table, without a migration inventing a
        // revision for lists nobody has touched.
        const existing = await tx.taskListRevision.count({ where: { listId: id } });
        if (existing === 0) {
          const before = await tx.taskList.findUniqueOrThrow({
            where: { id },
            select: {
              instructions: true,
              paused: true,
              maxConcurrent: true,
              foremanWorkspaceId: true,
              foremanStallMinutes: true,
            },
          });
          await tx.taskListRevision.create({
            data: {
              listId: id,
              version: 1,
              ...before,
              note: 'Recorded automatically as the state before the first tracked change',
              authorType: CreatorType.USER,
              authorId: ownerId,
            },
          });
        }
      }
      const list = await tx.taskList.update({ where: { id }, data });
      if (recordAs) {
        const max = await tx.taskListRevision.aggregate({
          where: { listId: id },
          _max: { version: true },
        });
        await tx.taskListRevision.create({
          data: {
            listId: id,
            version: (max._max.version ?? 0) + 1,
            instructions: list.instructions,
            paused: list.paused,
            maxConcurrent: list.maxConcurrent,
            foremanWorkspaceId: list.foremanWorkspaceId,
            foremanStallMinutes: list.foremanStallMinutes,
            note: recordAs.note ?? null,
            authorType: recordAs.author?.type ?? CreatorType.USER,
            authorId: recordAs.author?.id ?? ownerId,
            authorSessionId: recordAs.authorSessionId ?? null,
          },
        });
      }
      return list;
    });
  }

  /**
   * A list's policy and progress without its tasks.
   *
   * `get()` returns every task with its dependency state, which is right for a detail page and
   * wrong for anything reading a 500-task list to make one decision: a foreman diagnosing a
   * stall, or an `orbit-list:` reference being expanded into a prompt. Both need the shape of
   * the list, not its contents — and at this size the contents do not fit in a context window
   * anyway (the deployment's task descriptions total ~11 MB).
   */
  async summary(ownerId: string, id: string) {
    const list = await this.prisma.taskList.findFirst({
      where: { id, ownerId },
      select: {
        id: true,
        title: true,
        instructions: true,
        paused: true,
        maxConcurrent: true,
        foremanWorkspaceId: true,
        foremanStallMinutes: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!list) throw new NotFoundException('task list not found');
    const [byStatus, live, lastRunAt, latestRevision] = await Promise.all([
      this.prisma.task.groupBy({
        by: ['status'],
        where: { listId: id },
        _count: { _all: true },
      }),
      this.prisma.session.count({
        where: { task: { listId: id }, status: { in: [RunStatus.PENDING, RunStatus.RUNNING] } },
      }),
      this.prisma.session.aggregate({
        where: { task: { listId: id } },
        _max: { createdAt: true },
      }),
      this.prisma.taskListRevision.aggregate({
        where: { listId: id },
        _max: { version: true },
      }),
    ]);
    return {
      ...list,
      tasksByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      // Sessions currently holding a slot, and when this list last started anything at all —
      // together these are the stall signal, so a foreman can confirm what woke it.
      liveSessions: live,
      lastRunStartedAt: lastRunAt._max.createdAt,
      policyVersion: latestRevision._max.version ?? null,
    };
  }

  /** This list's policy history, newest first. */
  async revisions(ownerId: string, id: string) {
    await this.assertOwned(ownerId, id);
    return this.prisma.taskListRevision.findMany({
      where: { listId: id },
      orderBy: { version: 'desc' },
    });
  }

  /**
   * Put the list's policy back to what `version` recorded.
   *
   * The restore is itself a new revision rather than a rewind that discards what came after:
   * undoing a change is a decision too, and a history that erased its own mistakes could not
   * answer the question it exists for. Restoring twice is therefore idempotent in effect and
   * still visible as two entries.
   */
  async restoreRevision(
    ownerId: string,
    id: string,
    version: number,
    note?: string | null,
    author?: RevisionAuthor,
  ) {
    await this.assertOwned(ownerId, id);
    const target = await this.prisma.taskListRevision.findUnique({
      where: { listId_version: { listId: id, version } },
    });
    if (!target) throw new NotFoundException('revision not found');
    const list = await this.writePolicy(
      ownerId,
      id,
      {
        instructions: target.instructions,
        paused: target.paused,
        maxConcurrent: target.maxConcurrent,
        foremanWorkspaceId: target.foremanWorkspaceId,
        foremanStallMinutes: target.foremanStallMinutes,
      },
      { note: note ?? `Restored v${version}`, author },
    );
    this.realtime.publishForUser(ownerId, RunEventType.TASK_LIST_CHANGED, id);
    return list;
  }

  async remove(ownerId: string, id: string) {
    await this.get(ownerId, id);
    // Tasks are detached (list_id -> null) by the SET NULL FK, not deleted.
    await this.prisma.taskList.delete({ where: { id } });
    this.realtime.publishForUser(ownerId, RunEventType.TASK_LIST_CHANGED, id);
    return { ok: true };
  }
}
