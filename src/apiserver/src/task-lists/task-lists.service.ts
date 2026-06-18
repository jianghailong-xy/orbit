import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CreatorType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateTaskListDto, UpdateTaskListDto } from './dto';

@Injectable()
export class TaskListsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(ownerId: string, dto: CreateTaskListDto) {
    if (!dto.title) throw new BadRequestException('title is required');
    return this.prisma.taskList.create({
      data: { title: dto.title, ownerId },
    });
  }

  list(ownerId: string) {
    return this.prisma.taskList.findMany({
      where: { ownerId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { tasks: true } } },
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
            assignee: { select: { id: true, name: true, model: true } },
            _count: { select: { comments: true } },
          },
        },
      },
    });
    if (!list) throw new NotFoundException('task list not found');
    return { ...list, tasks: await this.resolveTaskCreators(list.tasks) };
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
    const userIds = tasks.filter((t) => t.creatorType === CreatorType.USER).map((t) => t.creatorId);
    const agentIds = tasks.filter((t) => t.creatorType === CreatorType.AGENT).map((t) => t.creatorId);
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
    return this.prisma.taskList.update({ where: { id }, data: { title: dto.title } });
  }

  async remove(ownerId: string, id: string) {
    await this.get(ownerId, id);
    // Tasks are detached (list_id -> null) by the SET NULL FK, not deleted.
    await this.prisma.taskList.delete({ where: { id } });
    return { ok: true };
  }
}
