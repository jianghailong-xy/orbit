import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CreatorType, RunStatus, TaskStatus } from '@prisma/client';
import { RunEventType, TaskStatus as SharedTaskStatus } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { canRun, computeDependencyState } from '../tasks/task-dependencies';
import { CreateTaskListDto, UpdateTaskListDto } from './dto';

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
        // Mirror TasksService.list()'s shape so the frontend can reuse the row.
        tasks: {
          orderBy: { createdAt: 'desc' },
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
        },
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
    const agentIds = [
      ...new Set(tasks.filter((t) => t.creatorType === CreatorType.AGENT).map((t) => t.creatorId)),
    ];
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
    return tasks.map((t) => ({ ...t, creatorName: names.get(t.creatorId) ?? null }));
  }

  async update(ownerId: string, id: string, dto: UpdateTaskListDto) {
    await this.get(ownerId, id);
    const list = await this.prisma.taskList.update({ where: { id }, data: { title: dto.title } });
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
