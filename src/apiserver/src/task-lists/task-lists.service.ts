import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CreatorType, RunStatus } from '@prisma/client';
import {
  classifyFailure,
  FailureCause,
  RunEventType,
  TaskStatus as SharedTaskStatus,
  uuidToBase62,
} from '@orbit/shared';
import { lockOwnerTaskGraph } from '../common/lock-order';
import { SingleFlight } from '../common/single-flight';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SessionsService } from '../sessions/sessions.service';
import { TASK_OCCUPYING } from '../tasks/reclaim-stalled-task';
import { TaskListPauseProjectorService } from './task-list-pause-projector.service';
import {
  canRun,
  computeDependencyState,
  dependencyEpochGate,
  dependencyEpochStalled,
  type DependencyPrerequisiteFact,
} from '../tasks/task-dependencies';
import { loadVerificationEpochGates } from '../tasks/verification-epoch-read';
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
  private readonly listSingleFlight = new SingleFlight();
  private readonly getSingleFlight = new SingleFlight();

  constructor(
    private readonly prisma: PrismaService,
    // @Global RealtimeModule. A list has no session to hang an event off (the MCP tasklist_create
    // path included), so these push user-scoped — see RealtimeService.publishForUser.
    private readonly realtime: RealtimeService,
    // The console opens sessions and remove() cancels them; nothing on the dispatch path
    // goes through here.
    private readonly sessions: SessionsService,
    /**
     * The other half of a pause: this service decides, the projector converges the tasks.
     *
     * Optional in the signature and not in the wiring — `TaskListsModule` provides it, and the
     * ~15 places that build this service directly (unit specs) pass none. A caller with no
     * projector gets exactly the pre-split behaviour of the DECISION (the epoch is bumped, the
     * revision recorded) and no projection, which is what the specs that are about the decision
     * alone want; the pg spec that asserts convergence constructs one and passes it.
     */
    private readonly pauseProjector?: TaskListPauseProjectorService,
  ) {}

  /** A pause/restore/delete can rewrite an unbounded number of task rows. A list id is not a
   * task-row invalidation, so incremental clients must reconcile these changes explicitly. */
  private publishTaskResync(ownerId: string): void {
    this.realtime.publishForUser(ownerId, RunEventType.TASK_CHANGED, {
      taskIds: [],
      resync: true,
    });
  }

  async create(ownerId: string, dto: CreateTaskListDto) {
    if (!dto.title) throw new BadRequestException('title is required');
    const list = await this.prisma.taskList.create({
      data: { title: dto.title, ownerId },
    });
    this.realtime.publishForUser(ownerId, RunEventType.TASK_LIST_CHANGED, list.id);
    return list;
  }

  list(ownerId: string) {
    // The shipped native refresh path asks for this index on every task event. Only concurrent
    // reads for the same owner are shared, and settlement removes the promise immediately.
    return this.listSingleFlight.run(ownerId, () => this.loadList(ownerId));
  }

  private async loadList(ownerId: string) {
    const lists = await this.prisma.taskList.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
      // Explicit projection, and `instructions` is deliberately not in it. A list's standing
      // instructions run to kilobytes of prose — on this deployment four lists carry 13KB of the
      // 18.7KB this endpoint returned — and nothing reads them from the index: the sidebar draws a
      // title and a dot, the prompt composer reads them off the task's own list join, and an agent
      // that wants them asks `GET task-lists/:id` (see `summary`). Paying to serialize them a few
      // times a second so every caller can discard them is the same trade `TASK_LIST_SELECT` had to
      // undo for task descriptions.
      select: {
        id: true,
        title: true,
        ownerId: true,
        createdAt: true,
        updatedAt: true,
        paused: true,
        maxConcurrent: true,
        foremanWorkspaceId: true,
        foremanStallMinutes: true,
        verifyOnDone: true,
        ownerSessionId: true,
        // The maintained count, not `_count: { select: { tasks: true } }`. That relation aggregate
        // compiles to a LEFT JOIN onto an UNFILTERED `GROUP BY list_id` over the whole `task`
        // table — Prisma emits `WHERE $4=$5` for it, an always-true placeholder — so every poll of
        // this index recounted all 111,717 rows to produce 13 numbers, and on 2026-09-17 that one
        // statement was 22.1% of the database's entire execution time. Filtering it does not help:
        // 110,439 of those rows belong to the polling owner's own lists. The count is the same
        // number and still exact (see `TaskList.taskCount` and migration 0280); it is answered from
        // the list row, and re-wrapped as `_count` below so no client sees a changed shape.
        taskCount: true,
        // `completed` needs a second number and used to go back to `task` for it: the same list ids
        // under `status: DONE`, which `task_status_idx` answers by visiting every DONE row this
        // deployment has — 1,482 of them on 2026-09-19, for 935 buffers a call at ~370 calls an
        // hour. That read is gone (migration 0287). This column is maintained by the same three
        // triggers `taskCount` uses and fetched by the same statement, so `completed` costs nothing
        // extra at all; see `TaskList.taskDoneCount` for what it holds and why it is exact.
        taskDoneCount: true,
      },
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
    // task is DONE. Both numbers are maintained columns on the list row, so the
    // comparison is free and exact — the same expression as before, with the
    // DONE count read instead of recounted.
    return lists.map(({ taskCount, taskDoneCount, ...l }) => {
      const total = taskCount ?? 0;
      return {
        ...l,
        _count: { tasks: total },
        runningTasks: running.get(l.id) ?? 0,
        completed: total > 0 && taskDoneCount === total,
      };
    });
  }

  /**
   * The list's own row, with none of its tasks — what `GET /task-lists/:id?tasks=none` answers.
   *
   * `get()` below embeds every task the list has, which is fine for a list of twenty and ruinous
   * for one of twenty-seven thousand: measured on this deployment at 19MB and ~1.2s of database
   * time, most of it spent producing rows the caller then throws away because all it wanted was
   * the title. Callers that need the contents page them through `GET /tasks/page?listId=…`.
   *
   * Why this is opt-in rather than the default: `tasks` is a non-optional field on the shipped
   * macOS client's `TaskListDetail`, so omitting it unasked would not make that client fast — it
   * would make it fail to decode. Same trap `counts=none` had to step around on the task page.
   */
  async getHeader(ownerId: string, id: string) {
    const list = await this.prisma.taskList.findFirst({ where: { id, ownerId } });
    if (!list) throw new NotFoundException('task list not found');
    return list;
  }

  get(ownerId: string, id: string) {
    // Old native clients reload the selected named list (including all embedded task rows) on each
    // task event. Collapse only concurrent reads of that same owner/list; never retain the result.
    return this.getSingleFlight.run(`${ownerId}:${id}`, () => this.loadGet(ownerId, id));
  }

  private async loadGet(ownerId: string, id: string) {
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
            select: {
              taskId: true,
              dependsOnTaskId: true,
              dependsOnTask: { select: { status: true } },
            },
          }),
        ])
      : [[], []];
    const running = new Set(
      busy.filter((b) => b.status === RunStatus.RUNNING).map((b) => b.taskId),
    );
    const queued = new Set(
      busy.filter((b) => b.status === RunStatus.PENDING).map((b) => b.taskId),
    );
    // §13.3 DEP. The Ready tab must never offer a run the API would reject, so it asks the same
    // question the Run button does — including "is this prerequisite a CHECK, and did it pass".
    const epochs = await loadVerificationEpochGates(
      this.prisma,
      ownerId,
      dependencies.map((dependency) => dependency.dependsOnTaskId),
    );
    const prerequisites = new Map<string, DependencyPrerequisiteFact[]>();
    for (const dependency of dependencies) {
      const facts = prerequisites.get(dependency.taskId) ?? [];
      facts.push({
        status: dependency.dependsOnTask.status as unknown as SharedTaskStatus,
        verificationGate: dependencyEpochGate(dependency.dependsOnTaskId, epochs),
        verificationGateStalled: dependencyEpochStalled(dependency.dependsOnTaskId, epochs),
      });
      prerequisites.set(dependency.taskId, facts);
    }
    return {
      ...list,
      tasks: tasks.map((t) => {
        const dependencyState = computeDependencyState(prerequisites.get(t.id) ?? []);
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
    const { list, pauseDecided } = await this.writePolicy(
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
    // A pause that CHANGED something changes which tasks may be dispatched: an unbounded
    // runnable-row change, so the client has to reconcile rather than be told which rows moved,
    // and the rows themselves are converged by the projector — kicked here, after the transaction
    // above has committed and therefore after the decision is durable. The kick is the latency;
    // the projector's catch-up scan is the guarantee, and it is what converges a kick that never
    // arrived because this process died between the commit and this line.
    //
    // Keyed on the decision and not on `dto.paused !== undefined`, which is what this condition
    // was when the sweep lived in the transaction above: a same-value PATCH rewrote every task row
    // then and had to say so, and it now rewrites none of them and says nothing. The distinction
    // matters — a client retrying a PATCH it already sent is exactly the traffic that turned one
    // slow write into fourteen minutes of them on 2026-09-14, and asking for a sweep of the list
    // would put that traffic back on the expensive path.
    if (pauseDecided) {
      this.publishTaskResync(ownerId);
      this.pauseProjector?.kick(id);
    }
    return list;
  }

  /**
   * Apply `data` to the list and, when it touches dispatch policy, record the result as the next
   * revision — both under the list's row lock, so a concurrent writer can neither interleave
   * with the read-modify-write nor mint the same version number.
   *
   * A pause is DECIDED here, in a write whose cost does not depend on how many tasks the list has:
   * the row gains the new value and its epoch. Converging the tasks onto that decision is the
   * projector's job, after this commits — so nothing in this method may write a `task` row, and
   * that is the property the rest of the design leans on (see the note inside).
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
    // Retried whole. Everything it decides — the revision number, the seeded before-state, the
    // pause epoch — is derived inside the closure from rows read under the two locks below, so a
    // re-run re-derives all of it against the snapshot that actually won rather than replaying a
    // version of the list that no longer exists.
    return withTransactionRetry(this.prisma, async (tx) => {
      // Rank 10 before rank 20 (common/lock-order.ts, I1), kept after the task sweep left this
      // transaction. Three reasons, in order of weight. The projector's chunks write `task` rows
      // for a list and take rank 10 first, so a PATCH that read the decision without it could
      // compare `paused` against a value a chunk was concurrently rewriting the tasks of. The
      // list delete (remove, below) writes this same list row and those same task rows under the
      // mutex, and the two must not reach the same pair in opposite orders. And this is still a
      // member of the Task-writing family the rank is stated over; leaving it out for the one
      // transaction that also decrees what the whole family will do is how an invariant like I1
      // stops being one.
      await lockOwnerTaskGraph(tx, ownerId);
      const locked = await tx.$queryRaw<
        Array<{ id: string; paused: boolean; pauseEpoch: number }>
      >`
        SELECT id, paused, "pause_epoch" AS "pauseEpoch" FROM "task_list"
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
      // The pause DECISION, in O(1): this transaction records that the list is now paused (or no
      // longer is) and nothing else. The tasks are converged by the projector afterwards, because
      // writing `dispatch_hold` onto every task of a 27,468-task list here — under the owner graph
      // mutex, in front of every same-owner request — is the 2026-09-14 outage: 5+ minutes per
      // PATCH, clients timing out and re-running the whole O(n) unit until the pool was exhausted.
      //
      // The counter is the whole handoff. Bumped only on an actual change, so a same-value PATCH is
      // a no-op that asks for no projection; `pause_applied_epoch < pause_epoch` is then the
      // worklist the projector claims from, with no cursor or lease anywhere.
      //
      // `pauseDecided` goes back to the caller, which is where the kick and the resync hang off it:
      // whether a pause was DECIDED is a fact only this transaction can establish, because it is a
      // comparison against the stored value read under the lock — a caller comparing `dto.paused`
      // with anything it read earlier would be comparing against a value a concurrent write may
      // already have replaced.
      const asked = data.paused as boolean | undefined;
      const decided = asked !== undefined && asked !== locked[0].paused;
      const list = await tx.taskList.update({
        where: { id },
        data: decided ? { ...data, pauseEpoch: locked[0].pauseEpoch + 1 } : data,
      });
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
      return { list, pauseDecided: decided };
    }, loggedRetry(this.logger, 'taskLists.writePolicy'));
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
   *
   * The id is spelled base62, the same as the `id` the agent gets back from `tasklist_get`. Prose
   * is the one boundary `PublicIdInterceptor` cannot reach — it rewrites response *fields*, and a
   * message body is not one — so the encode happens here, where the id becomes text. An id worth
   * carrying is an id meant to be used, and a console told one spelling and shown another has no
   * way to tell it is looking at its own list.
   */
  private buildConsoleOpening(title: string, listId: string): string {
    return (
      `你是任务列表「${title}」（id: ${uuidToBase62(listId)}）的调度会话。\n\n` +
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
    const { list, pauseDecided } = await this.writePolicy(
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
    // A restore always includes `paused`, so the tasks have to be converged onto whatever it
    // restored — but only when that is a new decision. The resync below stays unconditional, as it
    // was before the split: a restore can move several policy fields at once and the client is told
    // to reconcile either way. The kick is not, because a restore that puts back the pause the list
    // already had asks for a sweep whose result is already in the rows.
    this.publishTaskResync(ownerId);
    if (pauseDecided) this.pauseProjector?.kick(id);
    return list;
  }

  /**
   * Delete a list and stop the work it was driving.
   *
   * Tasks are detached (list_id -> null) by the SET NULL FK, not deleted — that part is
   * deliberate, and it is why the stop has to be written into the tasks themselves. 112 lists
   * deleted here in August left 27,783 tasks re-dispatching once a minute for a fortnight,
   * saturating a runner, because nothing in the delete said anything about running.
   *
   * Deletion cannot be a way to express intent about behaviour — it is the removal of the thing
   * that holds intent, so on its own it can only destroy the ability to say "stop". That is why
   * this is a compound operation and not a cascade: the intent is transferred onto the tasks
   * first (they are the only rows that survive), and only then does the list go.
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
    //
    // The hold is released in the same write. A hold is the list's, and this is the list ceasing
    // to exist — leaving it set would produce a task that can neither auto-run nor be started nor
    // ever be resumed, which is a wedge rather than a stop. Disarming and releasing together say
    // the one thing that is actually true: nothing will start this on its own any more, and a
    // person still can.
    // One transaction, under the owner graph mutex (common/lock-order.ts, I1). Two multi-row
    // `task` writes happen here — this one, and the `Task.listId` SET NULL the delete cascades —
    // and neither takes its rows in an order any other writer shares. Rank 10 is what puts them
    // in one line with every other multi-row Task write rather than trusting two planners to
    // agree; making the pair atomic while we are here also removes the state where the tasks were
    // disarmed and the list survived.
    await withTransactionRetry(
      this.prisma,
      async (tx) => {
        await lockOwnerTaskGraph(tx, ownerId);
        await tx.task.updateMany({
          where: { ownerId, listId: id },
          data: { autoRunWhenReady: false, dispatchHold: false },
        });
        await tx.taskList.delete({ where: { id } });
      },
      loggedRetry(this.logger, 'taskLists.remove', {
        // The same deadline TasksService.deleteAndStopRuns carries, and for the same reason: these
        // two statements used to run under no client deadline at all, and inside an interactive
        // transaction Prisma's default aborts at 5s. A list on the scale this deployment actually
        // has — 27,548 tasks on one of them — cascades through far more than that, so the default
        // would turn deletes that used to work into P2028. The locks are held for as long as the
        // delete takes either way. Handed to every attempt, not only the first.
        transaction: { timeout: 60_000, maxWait: 10_000 },
        // A deadlock victim aborts at the statement that lost, not at its deadline, so a retry
        // costs what that attempt had already spent rather than another 60s. Three chances is
        // still the wrong shape for a cascade this size: two absorbs the collision this can
        // actually have — a Task write that arrived at the same list — without turning one slow
        // delete into four.
        maxAttempts: 2,
      }),
    );
    // Every surviving task was detached and disarmed. The set can exceed the event wire budget,
    // and after the SET NULL cascade it cannot be recovered by list id without a pre-delete scan.
    this.publishTaskResync(ownerId);
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
