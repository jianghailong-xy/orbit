import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
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
    return list;
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
