import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TaskSource, TaskStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CreateTaskDto, UpdateTaskDto } from './dto';

const toDate = (v?: string): Date | undefined => (v ? new Date(v) : undefined);

@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly realtime: RealtimeService,
  ) {}

  async create(ownerId: string, dto: CreateTaskDto) {
    const enqueue = dto.enqueue ?? false;
    const task = await this.prisma.task.create({
      data: {
        title: dto.title,
        prompt: dto.prompt ?? dto.title,
        input: (dto.input ?? {}) as Prisma.InputJsonValue,
        source: dto.agentId ? TaskSource.AGENT : TaskSource.MANUAL,
        status: enqueue ? TaskStatus.QUEUED : TaskStatus.DRAFT,
        type: dto.type,
        estimates: dto.estimates,
        priority: dto.priority ?? 0,
        agentId: dto.agentId,
        assignedRunnerId: dto.assignedRunnerId,
        startTime: toDate(dto.startTime),
        dueDate: toDate(dto.dueDate),
        scheduledAt: toDate(dto.scheduledAt),
        creatorId: ownerId,
        ownerId,
      },
    });
    if (enqueue) this.queue.notifyQueued();
    return task;
  }

  list(ownerId: string, filters: { status?: string; source?: string }) {
    return this.prisma.task.findMany({
      where: {
        ownerId,
        status: filters.status ? (filters.status as TaskStatus) : undefined,
        source: filters.source ? (filters.source as TaskSource) : undefined,
      },
      orderBy: [{ createdAt: 'desc' }],
      include: {
        agent: { select: { id: true, name: true, model: true } },
        assignedRunner: { select: { id: true, name: true } },
        runs: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, status: true, costUsd: true, finishedAt: true },
        },
      },
    });
  }

  async get(ownerId: string, id: string) {
    const task = await this.prisma.task.findFirst({
      where: { id, ownerId },
      include: {
        agent: true,
        assignedRunner: { select: { id: true, name: true } },
        runs: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!task) throw new NotFoundException('task not found');
    return task;
  }

  async update(ownerId: string, id: string, dto: UpdateTaskDto) {
    await this.get(ownerId, id);
    return this.prisma.task.update({
      where: { id },
      data: {
        title: dto.title,
        prompt: dto.prompt,
        input: dto.input ? (dto.input as Prisma.InputJsonValue) : undefined,
        type: dto.type,
        estimates: dto.estimates,
        priority: dto.priority,
        assignedRunnerId: dto.assignedRunnerId,
        startTime: toDate(dto.startTime),
        dueDate: toDate(dto.dueDate),
        scheduledAt: toDate(dto.scheduledAt),
      },
    });
  }

  async enqueue(ownerId: string, id: string) {
    const task = await this.get(ownerId, id);
    if (task.status === TaskStatus.RUNNING || task.status === TaskStatus.QUEUED) {
      throw new BadRequestException(`task is already ${task.status}`);
    }
    const updated = await this.prisma.task.update({
      where: { id },
      data: { status: TaskStatus.QUEUED },
    });
    this.queue.notifyQueued();
    return updated;
  }

  async cancel(ownerId: string, id: string) {
    const task = await this.get(ownerId, id);
    if (task.status === TaskStatus.RUNNING) {
      const run = await this.prisma.taskRun.findFirst({
        where: { taskId: id, status: 'RUNNING' },
        orderBy: { createdAt: 'desc' },
      });
      if (run?.runnerId) this.realtime.requestCancel(run.runnerId, run.id);
    }
    return this.prisma.task.update({
      where: { id },
      data: { status: TaskStatus.CANCELLED },
    });
  }

  async runs(ownerId: string, id: string) {
    await this.get(ownerId, id);
    return this.prisma.taskRun.findMany({
      where: { taskId: id },
      orderBy: { createdAt: 'desc' },
    });
  }

  async remove(ownerId: string, id: string) {
    await this.get(ownerId, id);
    await this.prisma.task.delete({ where: { id } });
    return { ok: true };
  }
}
