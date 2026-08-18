import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ProjectStatus, TaskStatus } from '@prisma/client';
import { uuidToBase62 } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SessionsService } from '../sessions/sessions.service';
import {
  DEFAULT_TASK_PAGE_SIZE,
  MAX_TASK_PAGE_SIZE,
  decodeTaskPageCursor,
  encodeTaskPageCursor,
} from '../tasks/tasks.service';
import { CreateProjectDto, UpdateProjectDto } from './dto';

export interface ProjectTaskPageQuery {
  /** Absent = the project's top level. Present = that task's direct children, and only those. */
  parentId?: string;
  cursor?: string;
  limit?: string | number;
  status?: string;
}

/**
 * What ONE row of the project's task tree needs, and nothing else.
 *
 * The tree's first screen shows a title, where the work stands, when it is due and who would run
 * it — so `description` is out for the reason it is out of `TASK_LIST_SELECT` (~500 bytes a task,
 * parsed and thrown away by every client that renders a row), and `comments`, `sessions` and
 * `children` are out because each is an unbounded collection that turns one page into a fan-out.
 *
 * The child tally a row needs in order to know whether it has anything to expand is added by
 * `taskPage` rather than listed here, because it is scoped to the request's owner and project.
 * It is a `_count` — one joined aggregate — and NOT `children: true` with a `.length`, which is
 * the difference between an integer per row and every subtask of every row on the page.
 */
const PROJECT_TASK_TREE_SELECT = {
  id: true,
  title: true,
  status: true,
  parentTaskId: true,
  acceptanceCriteria: true,
  createdAt: true,
  updatedAt: true,
  dueDate: true,
  // Both instants a row carries, and they answer different questions: `dueDate` is when the work
  // is wanted by, `runAt` is when it starts by itself. Omitting this one made a schedule saved
  // through the task API unreadable through the project tree — the client could set it and then
  // could not see it, which reads as the write having been lost.
  runAt: true,
  assignee: { select: { id: true, name: true } },
} satisfies Prisma.TaskSelect;

/**
 * Projects: what a body of work is trying to achieve, and how anyone would know it got there.
 *
 * Nothing here dispatches, cancels, holds or releases a TASK, and that is a property to preserve
 * rather than an omission to fill in: a project carries no authority over how its tasks run, so no
 * write on this service can change what the sweep, the claim gate or a runner does.
 * `TaskListsService.remove` has to disarm its tasks before deleting a list precisely because a
 * list *does* carry that authority; the equivalent here would be code with nothing to do.
 *
 * `coordinator` opens a session, which is the one thing on this service that starts anything — and
 * it starts a conversation ABOUT the project, not any of its work. Nothing on the dispatch path
 * reads the binding it writes, so the property above survives it intact.
 */
@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  /**
   * One wording for "this project's coordinator is not where you asked", whether that was noticed
   * before a session was created or after losing the race to bind one. Two phrasings would read as
   * two different rules to anyone who hit both.
   */
  private static readonly ELSEWHERE =
    'this project already has a coordinator, and it runs in a different workspace — open it where ' +
    'it is, or delete it first. Moving a coordinator is not something this endpoint does as a side ' +
    'effect of asking for one.';

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

  /**
   * Ownership check for the write paths, and the 404 every unknown or cross-tenant id gets.
   *
   * Cheap on purpose (cf. `TaskListsService.assertOwned`): a project's detail read counts its
   * tasks, which is the right shape for a detail page and absurd as authorization for setting
   * one field.
   */
  private async assertOwned(ownerId: string, id: string): Promise<void> {
    const project = await this.prisma.project.findFirst({
      where: { id, ownerId },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('project not found');
  }

  /**
   * Blank prose is stored as null so "not set" has exactly one representation — the same rule
   * `TaskListsService.update` applies to a list's instructions, and for the same reason: an empty
   * string and a null must not be able to mean different things to whatever reads them later.
   * `undefined` (the field was not sent) is passed through untouched, so a rename cannot blank a
   * goal.
   */
  private static blankToNull(value: string | null | undefined): string | null | undefined {
    if (value === undefined) return undefined;
    return value?.trim() ? value : null;
  }

  async create(ownerId: string, dto: CreateProjectDto) {
    if (!dto.title) throw new BadRequestException('title is required');
    return this.prisma.project.create({
      data: {
        title: dto.title,
        ownerId,
        goal: ProjectsService.blankToNull(dto.goal),
        acceptanceCriteria: ProjectsService.blankToNull(dto.acceptanceCriteria),
        instructions: ProjectsService.blankToNull(dto.instructions),
      },
    });
  }

  /**
   * The owner's projects, newest first.
   *
   * Finished and cancelled ones are included unless the caller narrows by status. `status` says
   * what happened to the work, not whether anyone wants to look at it, so it is not the column to
   * decide a default visibility from — a project nobody can see through the only endpoint that
   * lists projects is deleted in every respect except the one that matters when something goes
   * wrong.
   *
   * The task tally is a `_count`, not an embedded task array. `GET /task-lists/:id` embeds its
   * list's tasks and had to grow a `?tasks=none` escape hatch when one list reached 27k of them;
   * starting from the count is the same decision made once instead of twice.
   */
  async list(ownerId: string, status?: ProjectStatus) {
    return this.prisma.project.findMany({
      where: { ownerId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { tasks: true } } },
    });
  }

  /**
   * One project, with how its work is distributed — but not the work itself, for the reason
   * `list` gives above. One grouped query, so the cost is bounded by the number of task statuses
   * rather than by the number of tasks.
   */
  async get(ownerId: string, id: string) {
    const project = await this.prisma.project.findFirst({
      where: { id, ownerId },
      include: { _count: { select: { tasks: true } } },
    });
    if (!project) throw new NotFoundException('project not found');
    const byStatus = await this.prisma.task.groupBy({
      by: ['status'],
      where: { projectId: id },
      _count: { _all: true },
    });
    return {
      ...project,
      tasksByStatus: Object.fromEntries(byStatus.map((row) => [row.status, row._count._all])),
    };
  }

  /**
   * One level of the project's task tree, newest first.
   *
   * The tree is read a level at a time rather than as a tree. `parentId` absent means the
   * project's top level (`parentTaskId IS NULL`) and NEVER a subtask; `parentId` present means
   * that task's direct children and never a grandchild. So the cost of opening a project is one
   * page of its roots, and the cost of expanding a node is one page of that node's children —
   * neither is the size of the project, which is the property the whole endpoint exists for.
   *
   * Every query here is bounded by all three of `ownerId`, `projectId` and `parentTaskId`
   * together. The project alone would be the shape that has to be avoided: "load the project's
   * tasks and assemble the tree in memory" is exactly the read that stops working at the size a
   * project reaches when it is worth having.
   *
   * `(createdAt DESC, id DESC)` because `createdAt` alone is not a total order — tasks filed in
   * one batch share a millisecond, and a page boundary landing inside such a group would repeat
   * some of them and skip others. `id` breaks the tie, and the cursor carries both.
   */
  async taskPage(ownerId: string, projectId: string, query: ProjectTaskPageQuery = {}) {
    await this.assertOwned(ownerId, projectId);

    const limit = query.limit === undefined ? DEFAULT_TASK_PAGE_SIZE : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TASK_PAGE_SIZE) {
      throw new BadRequestException(`limit must be an integer from 1 to ${MAX_TASK_PAGE_SIZE}`);
    }

    const status = ProjectsService.parseTaskStatus(query.status);
    const parentTaskId = query.parentId
      ? await this.assertParentInProject(ownerId, projectId, query.parentId)
      : null;

    const scope: Prisma.TaskWhereInput = {
      ownerId,
      projectId,
      parentTaskId,
      ...(status ? { status } : {}),
    };
    const cursor = query.cursor ? decodeTaskPageCursor(query.cursor) : undefined;
    const where: Prisma.TaskWhereInput = cursor
      ? {
          AND: [
            scope,
            {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            },
          ],
        }
      : scope;

    // One row over the page: the only thing `nextCursor` must not do is promise a page that turns
    // out to be empty, and counting the remainder to find that out would cost the scan the paging
    // is here to avoid.
    const rows = await this.prisma.task.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        ...PROJECT_TASK_TREE_SELECT,
        // Scoped to the same owner and project as the page it would open, so the number a row
        // shows is the number expanding it returns. Today those clauses match every child a task
        // can have — a subtask is created into its parent's project and cannot be moved out of it
        // while it is still linked — which is exactly why they are stated rather than assumed: an
        // invariant enforced elsewhere is not a reason for this count to be a guess.
        _count: { select: { children: { where: { ownerId, projectId } } } },
      },
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map(({ _count, ...task }) => ({ ...task, childCount: _count.children }));
    return {
      items,
      nextCursor: hasMore && page.length ? encodeTaskPageCursor(page[page.length - 1]) : null,
    };
  }

  /**
   * The parent a subtask page may be asked for: a task this owner has, in THIS project.
   *
   * Both halves are checked in the one query that resolves it, so a parent in someone else's
   * account and a parent in the caller's own next project are the same 404 — an id that is not
   * part of this tree is not part of it, and saying which kind of not-part-of-it it was would
   * answer a question about another project's contents.
   */
  private async assertParentInProject(
    ownerId: string,
    projectId: string,
    parentId: string,
  ): Promise<string> {
    const parent = await this.prisma.task.findFirst({
      where: { id: parentId, ownerId, projectId },
      select: { id: true },
    });
    if (!parent) throw new NotFoundException('parent task not found');
    return parent.id;
  }

  /**
   * A task status, or a 400 naming the ones that exist.
   *
   * Only the real `TaskStatus` values: `GET /tasks/page` also answers to RUNNABLE, RUNNING and
   * ONGOING, and those are questions about runs and tabs rather than about a tree. An unknown
   * value is refused rather than ignored, for the reason the project filter refuses one — a
   * silently dropped filter reports the unfiltered tree as if it were the answer.
   */
  private static parseTaskStatus(status?: string): TaskStatus | undefined {
    if (status === undefined || status.trim() === '') return undefined;
    const value = status.trim().toUpperCase();
    if (!Object.values<string>(TaskStatus).includes(value)) {
      throw new BadRequestException(`status must be one of ${Object.values(TaskStatus).join(', ')}`);
    }
    return value as TaskStatus;
  }

  /**
   * The session this project is coordinated from, opening one if it has none it can still use.
   *
   * Resolve-or-create, for the reason `TaskListsService.console` is: the point of the binding is
   * that coming back to a project comes back to the same conversation, with the reasoning behind
   * everything decided in it still there. Calling this twice therefore returns one session and
   * says `created: false` the second time — it is not a "new coordinator" endpoint that happens to
   * be reachable twice.
   *
   * A bound session is reused even when it has FAILED: that is a terminal state Orbit revives with
   * a new turn, and the history is the thing worth keeping. Only a session the user put in Trash,
   * or one deleted out from under the pointer, earns a replacement — those are the two cases where
   * the conversation is genuinely gone rather than merely finished.
   *
   * What this deliberately will NOT do is move an existing coordinator. A request naming a
   * different workspace than the binding was made in is a 409, not a re-point: the conversation is
   * where the work was discussed, and relocating it is a decision someone has to make on purpose.
   * Replacing a coordinator is its own endpoint, and this is not it.
   */
  async coordinator(
    ownerId: string,
    id: string,
    workspaceId?: string,
  ): Promise<{ sessionId: string; created: boolean; workspaceId: string | null }> {
    const project = await this.prisma.project.findFirst({
      where: { id, ownerId },
      select: {
        id: true,
        title: true,
        coordinatorSessionId: true,
        coordinatorWorkspaceId: true,
        coordinatorSession: { select: { id: true, deletedAt: true } },
      },
    });
    if (!project) throw new NotFoundException('project not found');

    // Trashed, not merely ended: reviving a session out of Trash behind the user's back would undo
    // a deletion they performed deliberately.
    if (project.coordinatorSession && !project.coordinatorSession.deletedAt) {
      // Only when BOTH are known. A workspace deleted since the binding leaves `null` here (the FK
      // is SET NULL), and "different from something we no longer know" is not a conflict anyone
      // could act on — so that case returns the coordinator it has, which re-points nothing.
      if (
        workspaceId &&
        project.coordinatorWorkspaceId &&
        workspaceId !== project.coordinatorWorkspaceId
      ) {
        throw new ConflictException(ProjectsService.ELSEWHERE);
      }
      return {
        sessionId: project.coordinatorSession.id,
        created: false,
        workspaceId: project.coordinatorWorkspaceId,
      };
    }

    // Where a replacement opens, in the order the answers are trustworthy: what the caller said,
    // then where this project's coordinator ran last, then where its work runs.
    //
    // The middle one is why `coordinatorWorkspaceId` is a column rather than a derived value. A
    // project whose coordinator was trashed and reopened lands back in the same workspace, which is
    // the whole point of having recorded it — skipping straight to the busiest assignee would move
    // the coordinator on the most ordinary path there is, and move it silently, which is the exact
    // migration the 409 above exists to refuse.
    const runIn =
      workspaceId ?? (await this.lastCoordinatorWorkspace(ownerId, project)) ?? (await this.busiestAssignee(id));
    if (!runIn) {
      throw new BadRequestException(
        'no workspace to open the coordinator in — none of this project’s tasks has an assignee ' +
          'to borrow one from. Assign a task, or pass workspaceId.',
      );
    }

    // Ownership, soft-deletion, "is it disabled" and "is it bound to a runner" are all checked by
    // sessions.create, which is the only thing that may build a session row. Re-deriving any of
    // that here would be a second opinion on a question that already has an owner.
    const session = await this.sessions.create(
      ownerId,
      {
        workspaceId: runIn,
        title: `协调：${project.title}`.slice(0, 80),
        prompt: ProjectsService.buildCoordinatorOpening(project.title, project.id),
      },
      { source: 'user' },
    );

    // Written only after the session exists, so a failed create leaves the project exactly as it
    // was rather than pointing at a session that was never made — and written as a compare-and-swap
    // against the pointer this call read, not as an unconditional update. Two people opening the
    // coordinator at once both see it unbound and both write; the swap is what makes exactly one
    // of those writes land, in the database rather than in this process.
    //
    // The condition is the value we READ rather than "still null", because the reuse path above
    // also replaces a trashed session — swapping on what we saw covers both without a second branch.
    //
    // A row lock held across the create would avoid the wasted session altogether. Not here, for
    // the reason the console gives: sessions.create is heavy, Prisma's interactive transactions
    // time out at five seconds, and holding a lock across one trades a rare harmless race for a
    // rarer and far more confusing failure.
    // `ownerId` is in the swap as well as the id. The project was resolved by owner above, so this
    // cannot currently narrow anything — it is here because this is a WRITE, and a write that
    // carries its own tenant scope stays correct if the read above is ever moved, cached or
    // refactored into something that does not.
    const claimed = await this.prisma.project.updateMany({
      where: { id, ownerId, coordinatorSessionId: project.coordinatorSessionId },
      data: { coordinatorSessionId: session.id, coordinatorWorkspaceId: runIn },
    });
    if (claimed.count === 0) {
      // We lost. Discard the session this call made BEFORE deciding anything else, so that every
      // path out of here — adopted, conflicted, or retryable — has already dealt with it. If the
      // discard itself fails, this throws rather than returning: reporting success while a live
      // agent sits in a workspace nobody points at is the one outcome that must never be reachable.
      await this.discardLoser(ownerId, session.id);

      const winner = await this.prisma.project.findFirst({
        where: { id, ownerId },
        select: {
          coordinatorWorkspaceId: true,
          coordinatorSession: { select: { id: true, deletedAt: true } },
        },
      });
      // Adopted only if it is a conversation the caller can actually open. A pointer that is empty
      // again, or that leads into Trash, is not something to hand back as this project's
      // coordinator — the caller would get an id it cannot use and a `created: false` saying that
      // was the intended answer. Both are transient, so both say "try again".
      if (!winner?.coordinatorSession || winner.coordinatorSession.deletedAt) {
        throw new ConflictException(
          'this project’s coordinator changed while one was being opened for it — try again',
        );
      }
      // The cross-workspace contract holds however the binding got there. Losing a race is not a
      // reason to hand back a coordinator somewhere the caller did not ask for and would have been
      // refused a moment earlier — the answer to "not where you asked" must not depend on timing.
      if (
        workspaceId &&
        winner.coordinatorWorkspaceId &&
        workspaceId !== winner.coordinatorWorkspaceId
      ) {
        throw new ConflictException(ProjectsService.ELSEWHERE);
      }
      return {
        sessionId: winner.coordinatorSession.id,
        created: false,
        workspaceId: winner.coordinatorWorkspaceId,
      };
    }
    return { sessionId: session.id, created: true, workspaceId: runIn };
  }

  /**
   * Get rid of a coordinator this call created and then lost the race to bind.
   *
   * `remove` rather than `end`, which is the difference between a finished session and one that is
   * gone: the loser is a conversation nobody will ever open — no project points at it and nothing
   * links to it — so leaving it in Open is litter that looks exactly like a real coordinator. The
   * soft delete also recycles the runtime on its way out (it ends the session first, exactly as
   * `end` would), so this is strictly more cleanup, not different cleanup. Nothing is destroyed:
   * the row, the transcript and the billing stay, and it is restorable from Trash.
   *
   * A failure here is re-thrown, never swallowed. The whole reason the loser is discarded is that
   * an unreferenced live session must not exist; a caught-and-ignored failure would report success
   * in precisely the case where that guarantee was not met. The id is logged first, because at that
   * point it is the only place the orphan is named — the caller's retry will resolve the winner and
   * never mention this session again.
   */
  private async discardLoser(ownerId: string, sessionId: string): Promise<void> {
    try {
      await this.sessions.remove(ownerId, sessionId);
    } catch (e) {
      this.logger.error(
        `lost the coordinator race and could not discard session ${sessionId} — it may still be ` +
          'live and is bound to no project',
        e instanceof Error ? e.stack : String(e),
      );
      throw e;
    }
  }

  /**
   * Where this project's previous coordinator ran, if that workspace can still run one.
   *
   * Checked for liveness rather than trusted. Workspaces are SOFT-deleted, so the FK's SET NULL
   * never fires for one and the column goes on naming a workspace `sessions.create` will refuse —
   * which would turn every replacement on that project into a 403, with the borrow-a-workspace
   * fallback sitting right there unused. Only the DERIVED value is filtered this way: an explicit
   * `workspaceId` is the caller's own claim and is left to fail loudly if it is wrong.
   */
  private async lastCoordinatorWorkspace(
    ownerId: string,
    project: { coordinatorWorkspaceId: string | null },
  ): Promise<string | null> {
    if (!project.coordinatorWorkspaceId) return null;
    const workspace = await this.prisma.workspace.findFirst({
      where: { id: project.coordinatorWorkspaceId, ownerId, deletedAt: null },
      select: { id: true },
    });
    return workspace?.id ?? null;
  }

  /**
   * The workspace most of this project's tasks are assigned to, or null.
   *
   * A coordinator is a conversation about the project, so it belongs where the project's work
   * actually runs. Soft-deleted workspaces are excluded rather than merely sorted last:
   * `sessions.create` filters on `deletedAt: null`, so borrowing one produces a coordinator that
   * cannot be opened at all — a 403 in place of the 400 that would at least have said what to do.
   */
  private async busiestAssignee(projectId: string): Promise<string | null> {
    const rows = await this.prisma.task.groupBy({
      by: ['assigneeId'],
      where: { projectId, assigneeId: { not: null }, assignee: { deletedAt: null } },
      _count: { _all: true },
      orderBy: { _count: { assigneeId: 'desc' } },
      take: 1,
    });
    return rows[0]?.assigneeId ?? null;
  }

  /**
   * The opening message of a project's coordinator.
   *
   * Self-contained, because the agent reading it has no idea which project it is in or that a
   * coordinator is a thing — so it names the project and carries its id, which is the only thing
   * in the message that ties the conversation back to a row.
   *
   * That id is spelled base62, the same as the `id` the agent gets back from `project_get`. Prose
   * is the one boundary `PublicIdInterceptor` cannot reach — it rewrites response *fields*, and a
   * message body is not one — so the encode happens here, where the id becomes text. An id worth
   * carrying is an id meant to be used, and a coordinator told one spelling and shown another has
   * no way to tell it is looking at its own project.
   *
   * It names the tools a coordinator actually has, and only those. `project_get`, the task tools
   * and `project_update` all reach a runner now, so the older wording — "assume you have nothing
   * that can change anything" — had stopped being caution and become a false statement: the one
   * session built to coordinate a project was the one told not to try. A prompt that undersells
   * the tools produces a coordinator that asks a human to do what it was handed the authority to
   * do; a prompt that oversells them produces an opening turn spent hunting for tools that are not
   * there, and then a confident report assembled from whatever it found instead. Both are wrong in
   * the same way, so this names the real set.
   *
   * Read before write, in that order, because neither the goal nor the acceptance criteria is
   * repeated in a task's description — a coordinator that starts by editing has nothing to have
   * based the edit on. And coordinating is not doing: the implementation belongs to each task's
   * own session, which is what having a project full of tasks is for.
   *
   * Still no promise of listing or deleting projects, opening another coordinator, or driving a
   * runner directly. None of those reaches a runner, and naming one would recreate the hunt.
   */
  private static buildCoordinatorOpening(title: string, projectId: string): string {
    return (
      `你是项目「${title}」（id: ${uuidToBase62(projectId)}）的协调会话。\n\n` +
      `这里用来跟进这个项目的进展、协调它下面的任务，不是用来替它干活的——具体实现交给各个任务自己的会话去做。\n\n` +
      `先读再说：用 project_get 读这个项目的目标、验收标准和作业指导，再用 task_list（projectId 传上面那个 id）` +
      `看它下面的任务各自停在哪里。这两样都不在任务的描述里，不读就只能靠猜。读完先简短汇报现状。\n\n` +
      `该动的时候你手上有工具，按我这次的要求来定：project_update 改这个项目的标题、目标、验收标准、作业指导，` +
      `或在工作真的落地时把 status 记成 DONE / CANCELLED；task_create、task_update、task_start 管它下面的任务。` +
      `我没让你改的，先说清楚该动什么、为什么，由我来决定。\n\n` +
      `没给你的工具就别去找：列出或删除项目、另开一个协调会话、直接指挥 runner，都不在你手上。`
    );
  }

  /** Each field is written only when the caller sent it, so closing a project cannot blank the goal
   *  that says what it was for, and a rename cannot reopen it. Settling `status` changes nothing
   *  about the project's tasks, which keep running or not running exactly as before — this phase
   *  adds no rule that a DONE project finishes its work, or that unfinished work reopens it. */
  async update(ownerId: string, id: string, dto: UpdateProjectDto) {
    await this.assertOwned(ownerId, id);
    const data: Prisma.ProjectUpdateInput = {
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.status !== undefined ? { status: dto.status } : {}),
      ...(dto.goal !== undefined ? { goal: ProjectsService.blankToNull(dto.goal) } : {}),
      ...(dto.acceptanceCriteria !== undefined
        ? { acceptanceCriteria: ProjectsService.blankToNull(dto.acceptanceCriteria) }
        : {}),
      ...(dto.instructions !== undefined
        ? { instructions: ProjectsService.blankToNull(dto.instructions) }
        : {}),
    };
    return this.prisma.project.update({ where: { id }, data });
  }

  /**
   * Delete a project, but only while it is empty.
   *
   * A task's `projectId` is what the task is FOR, so there is no harmless way to remove a project
   * out from under one: detaching would erase that record invisibly (nothing about a project-less
   * task says it ever had a project), and deleting the tasks would destroy work nobody asked to
   * lose. Refusing is the only option that leaves the caller able to decide, so this reports how
   * many tasks are in the way and stops.
   *
   * The count and the delete run in one transaction that takes the project's row lock first. That
   * lock is what makes the check binding rather than advisory: inserting a task that references
   * this project takes FOR KEY SHARE on this very row, which FOR UPDATE conflicts with, so a
   * concurrent file-into-the-project either commits before the count sees it or waits behind the
   * delete and then fails its foreign key. (The same mechanism `TasksService.deleteAndStopRuns`
   * relies on for tasks and their sessions.)
   *
   * And if something still gets past all of that, `ON DELETE RESTRICT` refuses at the database.
   * P2003 is translated to the same 409 the check raises, so one race cannot produce two different
   * answers to the same question.
   */
  async remove(ownerId: string, id: string) {
    try {
      await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "project"
          WHERE id = ${id}::uuid AND "owner_id" = ${ownerId}::uuid
          FOR UPDATE`;
        if (locked.length === 0) throw new NotFoundException('project not found');
        const tasks = await tx.task.count({ where: { projectId: id } });
        if (tasks > 0) throw new ConflictException(this.notEmptyMessage(tasks));
        await tx.project.delete({ where: { id } });
      });
    } catch (e) {
      // The database's own refusal, phrased as the endpoint's. Reached only by a writer that beat
      // the lock — but a 500 there would say "we broke" about a rule working exactly as intended.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') {
        throw new ConflictException(this.notEmptyMessage());
      }
      throw e;
    }
    return { ok: true };
  }

  /** One wording for both paths, so the answer does not depend on who noticed. */
  private notEmptyMessage(tasks?: number): string {
    return (
      `This project still holds ${tasks ?? 'one or more'} task(s) and cannot be deleted — ` +
      'move them to another project or delete them first'
    );
  }
}
