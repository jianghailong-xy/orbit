import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RunStatus, TaskSource, TaskStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
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

  /**
   * Ensure any agent/runner a task references belongs to the caller. Without
   * this, a user could pin a task to another tenant's runner and have Claude
   * Code execute on a machine they don't own (cross-tenant RCE).
   */
  private async assertOwnedRefs(
    ownerId: string,
    refs: { agentId?: string; assignedRunnerId?: string },
  ): Promise<void> {
    if (refs.assignedRunnerId) {
      const runner = await this.prisma.runner.findFirst({
        where: { id: refs.assignedRunnerId, ownerId },
        select: { id: true },
      });
      if (!runner) throw new ForbiddenException('runner not found');
    }
    if (refs.agentId) {
      const agent = await this.prisma.agent.findFirst({
        where: { id: refs.agentId, ownerId },
        select: { id: true },
      });
      if (!agent) throw new ForbiddenException('agent not found');
    }
  }

  async create(ownerId: string, dto: CreateTaskDto) {
    await this.assertOwnedRefs(ownerId, {
      agentId: dto.agentId,
      assignedRunnerId: dto.assignedRunnerId,
    });
    // An interactive session must be queued so a runner claims it and spawns the
    // long-lived claude process; it then awaits turns via the inbox.
    const interactive = dto.interactive ?? false;
    const enqueue = interactive || (dto.enqueue ?? false);
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
        interactive,
        sessionUuid: interactive ? randomUUID() : undefined,
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
        creator: { select: { id: true, name: true } },
        runs: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, status: true, costUsd: true, numTurns: true, finishedAt: true },
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
    await this.assertOwnedRefs(ownerId, { assignedRunnerId: dto.assignedRunnerId });
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
    await this.get(ownerId, id);
    // An interactive session spends most of its life in AWAITING_INPUT, so cancel
    // must match the live non-RUNNING states too — else it no-ops and leaves a
    // zombie process holding a concurrency slot.
    const run = await this.prisma.taskRun.findFirst({
      where: {
        taskId: id,
        status: { in: [RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (run) {
      await this.prisma.taskRun.update({
        where: { id: run.id },
        data: { cancelRequestedAt: new Date() },
      });
      if (run.runnerId) this.realtime.requestCancel(run.runnerId, run.id);
      if (run.interactive) {
        await this.enqueueControlTurn(run.id, 'end');
        this.realtime.notifyInbox(run.id);
      }
    }
    return this.prisma.task.update({
      where: { id },
      data: { status: TaskStatus.CANCELLED },
    });
  }

  // ───────────────────────── Interactive sessions (Route B) ─────────────────────────

  private static readonly LIVE_RUN_STATES: RunStatus[] = [
    RunStatus.RUNNING,
    RunStatus.AWAITING_INPUT,
    RunStatus.INTERRUPTED,
  ];

  /** Resolve the live run of an owner's interactive session, or throw. */
  private async getInteractiveRun(ownerId: string, taskId: string) {
    const task = await this.get(ownerId, taskId);
    if (!task.interactive || !task.activeRunId) {
      throw new BadRequestException('not an interactive session');
    }
    const run = await this.prisma.taskRun.findUnique({ where: { id: task.activeRunId } });
    if (!run || !TasksService.LIVE_RUN_STATES.includes(run.status) || run.cancelRequestedAt) {
      throw new ConflictException('the session has ended');
    }
    return run;
  }

  /**
   * Allocate the next per-run delivery seq and insert a turn. Retries on a seq
   * race (unique runId+seq); returns the existing row if clientTurnId was already
   * used (idempotent — defeats double-clicks / cross-tab duplicate sends).
   */
  private async insertTurn(
    runId: string,
    data: { kind: string; content?: string; clientTurnId: string },
  ) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await this.prisma.conversationTurn.findFirst({
        where: { runId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      const seq = (last?.seq ?? 0) + 1;
      try {
        return await this.prisma.conversationTurn.create({
          data: { runId, seq, status: 'PENDING', ...data },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          const dup = await this.prisma.conversationTurn.findUnique({
            where: { runId_clientTurnId: { runId, clientTurnId: data.clientTurnId } },
          });
          if (dup) return dup; // clientTurnId already used -> idempotent
          continue; // seq collision -> retry
        }
        throw e;
      }
    }
    throw new ConflictException('could not allocate a turn (too much contention)');
  }

  private async enqueueControlTurn(runId: string, kind: 'interrupt' | 'end') {
    await this.insertTurn(runId, { kind, clientTurnId: randomUUID() });
  }

  /** Enqueue a user message for the live interactive session. */
  async createTurn(ownerId: string, taskId: string, dto: { clientTurnId: string; content: string }) {
    const run = await this.getInteractiveRun(ownerId, taskId);
    const existing = await this.prisma.conversationTurn.findUnique({
      where: { runId_clientTurnId: { runId: run.id, clientTurnId: dto.clientTurnId } },
    });
    if (existing) return { turnId: existing.id, seq: existing.seq }; // idempotent
    // Serialize: only accept a new message when the session is idle. (Phase 0 showed
    // claude safely FIFO-queues mid-turn input, but serializing keeps cancel/interrupt
    // control clean for v1.)
    if (run.status !== RunStatus.AWAITING_INPUT) {
      throw new ConflictException('a turn is already in progress');
    }
    const turn = await this.insertTurn(run.id, {
      kind: 'message',
      content: dto.content,
      clientTurnId: dto.clientTurnId,
    });
    this.realtime.notifyInbox(run.id);
    return { turnId: turn.id, seq: turn.seq };
  }

  /** Abort the in-flight turn of a live interactive session (process stays alive). */
  async interrupt(ownerId: string, taskId: string) {
    const run = await this.getInteractiveRun(ownerId, taskId);
    await this.enqueueControlTurn(run.id, 'interrupt');
    this.realtime.notifyInbox(run.id);
    return { ok: true };
  }

  /** End a live interactive session (closes the runner's claude process). */
  async end(ownerId: string, taskId: string) {
    const run = await this.getInteractiveRun(ownerId, taskId);
    await this.prisma.taskRun.update({
      where: { id: run.id },
      data: { cancelRequestedAt: new Date() },
    });
    await this.enqueueControlTurn(run.id, 'end');
    if (run.runnerId) this.realtime.requestCancel(run.runnerId, run.id);
    this.realtime.notifyInbox(run.id);
    return { ok: true };
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
