import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RunStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CreateSessionDto, SessionTurnDto } from './dto';

@Injectable()
export class SessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Ensure any agent/runner a session references belongs to the caller — without
   * this a user could pin a session to another tenant's runner and have Claude
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

  async create(ownerId: string, dto: CreateSessionDto) {
    if (!dto.prompt) throw new BadRequestException('prompt is required');
    // The session runs on a runner. Prefer an explicit pin; otherwise derive it from
    // the chosen agent's machine (agents belong to a runner) — picking an agent is
    // enough to know which machine + project dir to run in.
    let assignedRunnerId: string | undefined = dto.assignedRunnerId;
    if (!assignedRunnerId && dto.agentId) {
      const agent = await this.prisma.agent.findFirst({
        where: { id: dto.agentId, ownerId },
        select: { runnerId: true },
      });
      if (!agent) throw new ForbiddenException('agent not found');
      assignedRunnerId = agent.runnerId ?? undefined;
    }
    if (!assignedRunnerId) {
      throw new BadRequestException('pick an agent bound to a runner, or pass assignedRunnerId');
    }
    await this.assertOwnedRefs(ownerId, { agentId: dto.agentId, assignedRunnerId });
    // PENDING so the assigned runner claims it and spawns the long-lived claude
    // process; it then awaits turns via the inbox.
    const session = await this.prisma.session.create({
      data: {
        title: dto.title ?? dto.prompt.slice(0, 80),
        prompt: dto.prompt,
        status: RunStatus.PENDING,
        // Pre-generate the Claude session id so the runner spawns with --session-id.
        claudeSessionId: randomUUID(),
        model: dto.model,
        permissionMode: dto.permissionMode,
        agentId: dto.agentId,
        assignedRunnerId,
        creatorId: ownerId,
        ownerId,
      },
    });
    this.queue.notifySessionQueued();
    return session;
  }

  list(ownerId: string, filters: { runnerId?: string }) {
    return this.prisma.session.findMany({
      where: { ownerId, assignedRunnerId: filters.runnerId || undefined },
      orderBy: { createdAt: 'desc' },
      include: {
        agent: { select: { id: true, name: true, model: true } },
        assignedRunner: { select: { id: true, name: true } },
      },
    });
  }

  async get(ownerId: string, id: string) {
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId },
      include: {
        agent: true,
        assignedRunner: { select: { id: true, name: true } },
      },
    });
    if (!session) throw new NotFoundException('session not found');
    return session;
  }

  private static readonly LIVE: RunStatus[] = [
    RunStatus.RUNNING,
    RunStatus.AWAITING_INPUT,
    RunStatus.INTERRUPTED,
  ];

  /** Load an owner's session and assert it's still live (not ended/cancelled). */
  private async getLive(ownerId: string, id: string) {
    const session = await this.prisma.session.findFirst({ where: { id, ownerId } });
    if (!session) throw new NotFoundException('session not found');
    if (!SessionsService.LIVE.includes(session.status) || session.cancelRequestedAt) {
      throw new ConflictException('the session has ended');
    }
    return session;
  }

  /**
   * Allocate the next per-session delivery seq and insert a turn. Retries on a seq
   * race (unique sessionId+seq); returns the existing row if clientTurnId was
   * already used (idempotent — defeats double-clicks / cross-tab duplicate sends).
   */
  private async insertTurn(
    sessionId: string,
    data: { kind: string; content?: string; clientTurnId: string },
  ) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const last = await this.prisma.conversationTurn.findFirst({
        where: { sessionId },
        orderBy: { seq: 'desc' },
        select: { seq: true },
      });
      const seq = (last?.seq ?? 0) + 1;
      try {
        return await this.prisma.conversationTurn.create({
          data: { sessionId, seq, status: 'PENDING', ...data },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          const dup = await this.prisma.conversationTurn.findUnique({
            where: { sessionId_clientTurnId: { sessionId, clientTurnId: data.clientTurnId } },
          });
          if (dup) return dup; // clientTurnId already used -> idempotent
          continue; // seq collision -> retry
        }
        throw e;
      }
    }
    throw new ConflictException('could not allocate a turn (too much contention)');
  }

  private async enqueueControlTurn(sessionId: string, kind: 'interrupt' | 'end') {
    await this.insertTurn(sessionId, { kind, clientTurnId: randomUUID() });
  }

  /** Enqueue a user message for the live session. */
  async createTurn(ownerId: string, id: string, dto: SessionTurnDto) {
    const session = await this.getLive(ownerId, id);
    const existing = await this.prisma.conversationTurn.findUnique({
      where: { sessionId_clientTurnId: { sessionId: id, clientTurnId: dto.clientTurnId } },
    });
    if (existing) return { turnId: existing.id, seq: existing.seq }; // idempotent
    // Serialize: only accept a new message when the session is idle.
    if (session.status !== RunStatus.AWAITING_INPUT) {
      throw new ConflictException('a turn is already in progress');
    }
    const turn = await this.insertTurn(id, {
      kind: 'message',
      content: dto.content,
      clientTurnId: dto.clientTurnId,
    });
    // User activity resets the idle clock so the reaper won't tear down a session
    // that just received a message but hasn't been picked up by the runner yet.
    await this.prisma.session.update({ where: { id }, data: { lastTurnAt: new Date() } });
    this.realtime.notifyInbox(id);
    return { turnId: turn.id, seq: turn.seq };
  }

  /** Abort the in-flight turn of a live session (the process stays alive). */
  async interrupt(ownerId: string, id: string) {
    const session = await this.getLive(ownerId, id);
    await this.enqueueControlTurn(session.id, 'interrupt');
    this.realtime.notifyInbox(session.id);
    return { ok: true };
  }

  /** End a live session (closes the runner's claude process). */
  async end(ownerId: string, id: string) {
    const session = await this.getLive(ownerId, id);
    await this.prisma.session.update({
      where: { id: session.id },
      data: { cancelRequestedAt: new Date() },
    });
    await this.enqueueControlTurn(session.id, 'end');
    if (session.assignedRunnerId) this.realtime.requestCancel(session.assignedRunnerId, session.id);
    this.realtime.notifyInbox(session.id);
    return { ok: true };
  }

  async remove(ownerId: string, id: string) {
    await this.get(ownerId, id);
    await this.prisma.session.delete({ where: { id } });
    return { ok: true };
  }
}
