import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreatorType, RunStatus, TaskStatus } from '@prisma/client';
import {
  classifyFailure,
  FailureCause,
  RunEventType,
  TaskStatus as SharedTaskStatus,
} from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TASK_OCCUPYING } from '../tasks/reclaim-stalled-task';
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
  private readonly logger = new Logger(TaskListsService.name);

  constructor(
    private readonly prisma: PrismaService,
    // @Global RealtimeModule. A list has no session to hang an event off (the MCP tasklist_create
    // path included), so these push user-scoped — see RealtimeService.publishForUser.
    private readonly realtime: RealtimeService,
    // The console opens sessions and remove() cancels them; nothing on the dispatch path
    // goes through here.
    private readonly sessions: SessionsService,
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
      ...(dto.verifyOnDone !== undefined ? { verifyOnDone: dto.verifyOnDone } : {}),
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
              verifyOnDone: true,
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
            verifyOnDone: list.verifyOnDone,
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
        verifyOnDone: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!list) throw new NotFoundException('task list not found');
    const [byStatus, live, lastRunAt, latestRevision, failures, conditions] = await Promise.all([
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
      // Error text only — the classifier reads nothing else, and a list can have thousands of
      // failed runs whose bodies are of no use here.
      this.prisma.session.findMany({
        where: { task: { listId: id }, status: RunStatus.FAILED },
        select: { error: true },
      }),
      // Bounded by kinds, not by occurrences: one row per condition, bumped in place.
      this.prisma.taskListEvent.findMany({
        where: { listId: id },
        orderBy: { lastSeenAt: 'desc' },
      }),
    ]);
    // Why this list's runs died, bucketed by the lever that fixes each. Attribution rather than a
    // count: "47 failures" prompts a guess, and the guess is usually the instructions. On this
    // deployment 99.3% of failures are a spent quota or a dead runner, and rewriting a word of
    // any prompt would have fixed none of them.
    const failuresByCause = failures.reduce<Record<FailureCause, number>>(
      (acc, s) => {
        acc[classifyFailure(s.error)] += 1;
        return acc;
      },
      { quota: 0, infrastructure: 0, contentFilter: 0, unattributed: 0 },
    );
    return {
      ...list,
      tasksByStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      // Sessions currently holding a slot, and when this list last started anything at all —
      // together these are the stall signal, so a foreman can confirm what woke it.
      liveSessions: live,
      lastRunStartedAt: lastRunAt._max.createdAt,
      policyVersion: latestRevision._max.version ?? null,
      failuresByCause,
      // What the control plane noticed about this list. Also delivered into the console
      // (ListEventsService), but exposed here too so an agent that wants the current picture can
      // ask for it instead of waiting to be told — a foreman woken by a stall arrives with no
      // delivery behind it and this is the only place it can read why nothing was running.
      conditions: conditions.map((c) => ({
        kind: c.kind,
        detail: c.detail,
        occurrences: c.occurrences,
        firstSeenAt: c.firstSeenAt,
        lastSeenAt: c.lastSeenAt,
      })),
    };
  }

  /**
   * The conversation this list is steered from, opening one if it has none it can still use.
   *
   * Resolve-or-create rather than create-on-demand: the point of the binding is that returning to
   * a list returns to the same conversation, with the reasoning behind every earlier policy
   * change still in it.
   *
   * A bound session is reused even when it has FAILED — that is a terminal state Orbit can revive
   * with a new turn, and its history is the thing worth keeping. Only a session the user put in
   * Trash, or one deleted out from under the pointer, earns a replacement: those are the two
   * cases where the conversation is genuinely gone rather than merely finished.
   */
  async console(
    ownerId: string,
    id: string,
    workspaceId?: string,
  ): Promise<{ sessionId: string; created: boolean }> {
    const list = await this.prisma.taskList.findFirst({
      where: { id, ownerId },
      select: {
        id: true,
        title: true,
        ownerSessionId: true,
        foremanWorkspaceId: true,
        ownerSession: { select: { id: true, deletedAt: true } },
      },
    });
    if (!list) throw new NotFoundException('task list not found');
    // Trashed, not merely ended. Reviving a session out of Trash behind the user's back would
    // undo a deletion they performed deliberately.
    if (list.ownerSession && !list.ownerSession.deletedAt) {
      return { sessionId: list.ownerSession.id, created: false };
    }
    // The foreman's workspace is the sensible default: it is already the one this list's
    // coordination runs in. An explicit argument wins, and with neither there is nowhere to open
    // a conversation — which is a caller error rather than something to guess at.
    const runIn = workspaceId ?? list.foremanWorkspaceId ?? (await this.busiestAssignee(id));
    if (!runIn) {
      throw new BadRequestException(
        'no workspace to open the console in — this list has no foreman and none of its tasks ' +
          'has an assignee to borrow one from. Assign a task, set the list a foreman, or pass ' +
          'workspaceId.',
      );
    }
    const session = await this.sessions.create(
      ownerId,
      {
        workspaceId: runIn,
        title: `调度：${list.title}`.slice(0, 80),
        prompt: this.buildConsoleOpening(list.title, list.id),
      },
      { source: 'user' },
    );
    // Written after the session exists, so a failed create leaves no dangling pointer — and as a
    // compare-and-swap against the pointer this call read, not an unconditional write. Two people
    // opening the console at once both saw it unbound, and both wrote: last writer won and the
    // other's session was left created, bound to nothing, sitting in the workspace forever.
    //
    // The condition is the value we read rather than "still null", because the reuse path above
    // also replaces a *trashed* session — swapping on what we saw covers both without a second
    // branch.
    //
    // A row lock across the create would avoid the wasted session entirely, and is the pattern
    // writePolicy uses on this same row. Not here: sessions.create is heavy, Prisma's interactive
    // transactions time out at five seconds, and holding a lock across it trades a rare harmless
    // race for a less rare and far more confusing failure.
    const claimed = await this.prisma.taskList.updateMany({
      where: { id, ownerSessionId: list.ownerSessionId },
      data: { ownerSessionId: session.id },
    });
    if (claimed.count === 0) {
      // Somebody else bound one in between. Adopt theirs — the point of this endpoint is that
      // repeat clicks land in the same conversation, so returning a second one would defeat it.
      const winner = await this.prisma.taskList.findFirst({
        where: { id, ownerId },
        select: { ownerSessionId: true },
      });
      if (winner?.ownerSessionId) {
        // End the one this call made rather than deleting it. Its opening turn may already be
        // running, and tearing down a live session to tidy up is worse than leaving a finished
        // one that says what it was.
        await this.sessions
          .end(ownerId, session.id)
          .catch(() => undefined);
        return { sessionId: winner.ownerSessionId, created: false };
      }
    }
    this.realtime.publishForUser(ownerId, RunEventType.TASK_LIST_CHANGED, id);
    return { sessionId: session.id, created: true };
  }

  /**
   * The workspace most of this list's tasks are assigned to, or null.
   *
   * The console is a conversation *about* the list, so it belongs where the list's work actually
   * runs. Without this the button was unusable: a foreman is opt-in and rarely set, so seven of
   * this deployment's eight lists had nothing to fall back on and every click returned 400. The
   * error message it returned was accurate and useless — it described an edge case that was in
   * fact the normal one.
   *
   * Soft-deleted workspaces are excluded rather than merely sorted last. `sessions.create` filters
   * on `deletedAt: null`, so borrowing one produces a console that cannot be opened at all —
   * exactly the failure that put six verification tasks against a deleted workspace earlier.
   */
  private async busiestAssignee(listId: string): Promise<string | null> {
    const rows = await this.prisma.task.groupBy({
      by: ['assigneeId'],
      where: { listId, assigneeId: { not: null }, assignee: { deletedAt: null } },
      _count: { _all: true },
      orderBy: { _count: { assigneeId: 'desc' } },
      take: 1,
    });
    return rows[0]?.assigneeId ?? null;
  }

  /**
   * The opening message of a list's console.
   *
   * Self-contained, because the agent reading it has no idea which list it is in or that a
   * console is a thing. It names the list, points at the two read tools, and — the part that
   * matters — states the standing instructions lever explicitly, since editing task descriptions
   * one at a time is the obvious move and the wrong one at this scale.
   */
  private buildConsoleOpening(title: string, listId: string): string {
    return (
      `你是任务列表「${title}」（id: ${listId}）的调度会话。\n\n` +
      `这里用来观察和调整这个列表怎么跑，不是用来替它干活的。请先用 tasklist_get 读一遍它当前的策略与进度，` +
      `再用 task_list 看任务分布，然后简短汇报现状即可，不要自行改动任何东西。\n\n` +
      `之后我会用自然语言提要求，你用 tasklist_update 落到策略上。可调的有：\n` +
      `- instructions：本列表所有任务通用的作业指导，会在派发时拼进每个任务的运行 prompt。` +
      `**要改"这类活该怎么干"，改这里，不要逐个改任务描述** —— 一次写入对所有尚未开跑的任务生效。\n` +
      `- paused：暂停/恢复整个列表的派发；已经在跑的不受影响。\n` +
      `- maxConcurrent：这个列表最多同时跑几个任务。\n` +
      `- verifyOnDone：任务报完成时是否自动派一次独立验收。\n` +
      `- foremanWorkspaceId / foremanStallMinutes：列表停滞多久后自动派一个协调任务来诊断。\n\n` +
      `每次改动都请带上 note 说明原因：改动会记成可回滚的版本，而三个月后有用的是"为什么"，不是"改了哪个字段"。`
    );
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
        verifyOnDone: target.verifyOnDone,
      },
      { note: note ?? `Restored v${version}`, author },
    );
    this.realtime.publishForUser(ownerId, RunEventType.TASK_LIST_CHANGED, id);
    return list;
  }

  /**
   * Delete a list and stop the work it was driving.
   *
   * Tasks are detached (list_id -> null) by the SET NULL FK, not deleted — that part is
   * deliberate, and it is why the stop has to be written into the tasks themselves. The auto-run
   * sweep is deployment-wide and its only list-level gate is `paused` (see AUTO_RUN_READY_SQL);
   * a detached task matches no list row, so deleting a list used to *remove the brake* while
   * leaving the engine running, and the orphans could never be paused again. 112 lists deleted
   * here in August left 27,783 tasks in exactly that state, re-dispatched once a minute for a
   * fortnight and saturating a runner. Deleting a list must stop its work at least as firmly as
   * pausing one does.
   */
  async remove(ownerId: string, id: string) {
    await this.get(ownerId, id);
    // Read while the tasks still point at the list — after the delete they are unfindable by it.
    const running = await this.prisma.session.findMany({
      where: { ownerId, task: { listId: id }, status: { in: TASK_OCCUPYING } },
      select: { id: true },
    });
    // Only the automatic dispatch goes: status and dependency edges are left alone, so a
    // detached task is still there to read and still startable by hand.
    await this.prisma.task.updateMany({
      where: { ownerId, listId: id, autoRunWhenReady: true },
      data: { autoRunWhenReady: false },
    });
    await this.prisma.taskList.delete({ where: { id } });
    // In-flight runs, torn down only after the tasks can no longer be re-dispatched — the other
    // order re-runs whatever the sweep catches in between. Best-effort, as in
    // TasksService.batchStop: a runner that will not answer must not fail the delete.
    for (const session of running) {
      await this.sessions
        .cancel(ownerId, session.id)
        .catch((e) =>
          this.logger.warn(`list ${id} delete: cancelling session ${session.id} failed: ${e}`),
        );
    }
    this.realtime.publishForUser(ownerId, RunEventType.TASK_LIST_CHANGED, id);
    return { ok: true };
  }
}
