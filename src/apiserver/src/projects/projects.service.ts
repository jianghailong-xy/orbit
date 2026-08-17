import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ProjectStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateProjectDto, UpdateProjectDto } from './dto';

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
