import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ProjectStatus, TaskStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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
  assignee: { select: { id: true, name: true } },
} satisfies Prisma.TaskSelect;

/**
 * Projects: what a body of work is trying to achieve, and how anyone would know it got there.
 *
 * Read-and-write only. Nothing here dispatches, cancels, holds or releases anything, and that is
 * a property to preserve rather than an omission to fill in: a project carries no authority over
 * how its tasks run, so no write on this service can change what the sweep, the claim gate or a
 * runner does. `TaskListsService.remove` has to disarm its tasks before deleting a list precisely
 * because a list *does* carry that authority; the equivalent here would be code with nothing to do.
 */
@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

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
