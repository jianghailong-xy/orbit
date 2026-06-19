import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RunStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import { ApprovalDecisionRequest, ApprovalInfo, ApprovalStatus, RunEventType } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CreateSessionDto, SessionConfigDto, SessionResumeDto, SessionTurnDto } from './dto';

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
    // Linking to a task: it must belong to the same user (no cross-tenant linking).
    if (dto.taskId) {
      const task = await this.prisma.task.findFirst({
        where: { id: dto.taskId, ownerId },
        select: { id: true },
      });
      if (!task) throw new ForbiddenException('task not found');
    }
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
        effort: dto.effort,
        agentId: dto.agentId,
        assignedRunnerId,
        taskId: dto.taskId,
        creatorId: ownerId,
        ownerId,
      },
    });
    this.queue.notifySessionQueued();
    return session;
  }

  async list(ownerId: string, filters: { runnerId?: string; view?: 'active' | 'archived' | 'deleted' }) {
    // active = neither archived nor deleted; archived = archived but not deleted;
    // deleted (trash) = deleted, regardless of archive state. Default to active.
    const visibility: Prisma.SessionWhereInput =
      filters.view === 'deleted'
        ? { deletedAt: { not: null } }
        : filters.view === 'archived'
          ? { archivedAt: { not: null }, deletedAt: null }
          : { archivedAt: null, deletedAt: null };
    const sessions = await this.prisma.session.findMany({
      where: { ownerId, assignedRunnerId: filters.runnerId || undefined, ...visibility },
      orderBy: [{ lastTurnAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      include: {
        agent: { select: { id: true, name: true, model: true } },
        assignedRunner: { select: { id: true, name: true } },
      },
    });
    // A turn blocked on a permission prompt keeps the session RUNNING, so the
    // list can't tell "running" from "waiting for approval" without this count.
    // Only RUNNING sessions can hold a live approval; skip the query otherwise.
    const running = sessions.filter((s) => s.status === RunStatus.RUNNING).map((s) => s.id);
    if (running.length === 0) return sessions.map((s) => ({ ...s, pendingApprovals: 0 }));
    const counts = await this.prisma.approval.groupBy({
      by: ['sessionId'],
      where: { sessionId: { in: running }, status: 'PENDING' },
      _count: { _all: true },
    });
    const byId = new Map(counts.map((c) => [c.sessionId, c._count._all]));
    return sessions.map((s) => ({ ...s, pendingApprovals: byId.get(s.id) ?? 0 }));
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

  private static readonly TERMINAL: RunStatus[] = [
    RunStatus.SUCCEEDED,
    RunStatus.FAILED,
    RunStatus.CANCELLED,
  ];

  // A runner heartbeats every 30s; a missed window reads as offline. Resuming needs
  // the original runner online — claude's transcript lives on that machine's disk.
  private static readonly RUNNER_OFFLINE_AFTER_MS = 90_000;

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

  /**
   * Revive an ended session with a new user message. The same Session row goes back
   * to PENDING so its assigned runner re-claims it and --resumes claude's existing
   * session (full prior context) rather than starting fresh. Requires that runner to
   * be online: claude's transcript lives on its disk, so no other machine can resume.
   */
  /** Pending (or all) tool-permission approvals for a session the caller owns. */
  async listApprovals(ownerId: string, id: string, status?: string): Promise<ApprovalInfo[]> {
    const session = await this.prisma.session.findFirst({ where: { id, ownerId }, select: { id: true } });
    if (!session) throw new NotFoundException('session not found');
    const approvals = await this.prisma.approval.findMany({
      where: { sessionId: id, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'asc' },
    });
    return approvals.map((a) => this.toApprovalInfo(a));
  }

  /** Record a human allow/deny on a pending approval; the runner's long-poll picks
   *  it up and returns it to claude's --permission-prompt-tool. */
  async decideApproval(
    ownerId: string,
    id: string,
    approvalId: string,
    dto: ApprovalDecisionRequest,
  ): Promise<ApprovalInfo> {
    const session = await this.prisma.session.findFirst({ where: { id, ownerId }, select: { id: true } });
    if (!session) throw new NotFoundException('session not found');
    if (dto.behavior !== 'allow' && dto.behavior !== 'deny') {
      throw new BadRequestException('behavior must be "allow" or "deny"');
    }
    const status = dto.behavior === 'allow' ? 'ALLOWED' : 'DENIED';
    // Only the first decision on a still-PENDING approval applies (idempotent).
    const res = await this.prisma.approval.updateMany({
      where: { id: approvalId, sessionId: id, status: 'PENDING' },
      data: { status, message: dto.message ?? null, decidedById: ownerId, decidedAt: new Date() },
    });
    const a = await this.prisma.approval.findFirst({ where: { id: approvalId, sessionId: id } });
    if (!a) throw new NotFoundException('approval not found');
    if (res.count > 0) {
      this.realtime.publish(id, {
        seq: 0,
        type: RunEventType.APPROVAL_RESOLVED,
        payload: { id: approvalId, behavior: dto.behavior },
        ts: new Date().toISOString(),
      });
    }
    return this.toApprovalInfo(a);
  }

  private toApprovalInfo(a: {
    id: string;
    sessionId: string;
    toolName: string;
    input: Prisma.JsonValue;
    toolUseId: string | null;
    status: string;
    message: string | null;
    createdAt: Date;
    decidedAt: Date | null;
  }): ApprovalInfo {
    return {
      id: a.id,
      sessionId: a.sessionId,
      toolName: a.toolName,
      input: a.input,
      toolUseId: a.toolUseId ?? undefined,
      status: a.status as ApprovalStatus,
      message: a.message ?? undefined,
      createdAt: a.createdAt.toISOString(),
      decidedAt: a.decidedAt?.toISOString(),
    };
  }

  async resume(ownerId: string, id: string, dto: SessionResumeDto) {
    const session = await this.prisma.session.findFirst({ where: { id, ownerId } });
    if (!session) throw new NotFoundException('session not found');
    // Still live — a normal turn belongs on the running process, not a revive.
    if (SessionsService.LIVE.includes(session.status) && !session.cancelRequestedAt) {
      return this.createTurn(ownerId, id, dto);
    }
    if (!SessionsService.TERMINAL.includes(session.status)) {
      throw new ConflictException('the session has not started yet');
    }
    if (!session.startedAt || !session.claudeSessionId) {
      throw new ConflictException('this session never ran and cannot be resumed');
    }
    // Idempotent: a retried send with the same clientTurnId returns the same turn.
    const existing = await this.prisma.conversationTurn.findUnique({
      where: { sessionId_clientTurnId: { sessionId: id, clientTurnId: dto.clientTurnId } },
    });
    if (existing) return { turnId: existing.id, seq: existing.seq };
    if (!session.assignedRunnerId) {
      throw new ConflictException('the session has no runner to resume on');
    }
    const runner = await this.prisma.runner.findUnique({
      where: { id: session.assignedRunnerId },
      select: { status: true, lastHeartbeatAt: true },
    });
    const online =
      !!runner &&
      runner.status !== 'OFFLINE' &&
      !!runner.lastHeartbeatAt &&
      runner.lastHeartbeatAt.getTime() >= Date.now() - SessionsService.RUNNER_OFFLINE_AFTER_MS;
    if (!online) {
      throw new ConflictException('the runner is offline; it must be online to resume this session');
    }
    // Append the message, then flip the row back to PENDING so the runner re-claims
    // it; buildSession sees the existing turns and re-spawns claude with --resume.
    const turn = await this.insertTurn(id, {
      kind: 'message',
      content: dto.content,
      clientTurnId: dto.clientTurnId,
    });
    await this.prisma.session.update({
      where: { id },
      data: {
        status: RunStatus.PENDING,
        cancelRequestedAt: null,
        finishedAt: null,
        error: null,
        result: null,
        lastTurnAt: new Date(),
        // Re-apply any mode/model/effort changes made while the session was ended;
        // buildSession reads these when the runner re-claims and re-spawns claude.
        // Omitted fields keep their prior value (don't clobber to null).
        ...(dto.model !== undefined ? { model: dto.model } : {}),
        ...(dto.permissionMode !== undefined ? { permissionMode: dto.permissionMode } : {}),
        ...(dto.effort !== undefined ? { effort: dto.effort } : {}),
      },
    });
    this.queue.notifySessionQueued();
    return { turnId: turn.id, seq: turn.seq };
  }

  /**
   * Load an owner's session and assert it has ended — only terminal sessions can be
   * archived or deleted. Hiding a live one would desync the "what's running" list and
   * could orphan the runner's claude process.
   */
  private async getEnded(ownerId: string, id: string) {
    const session = await this.prisma.session.findFirst({ where: { id, ownerId } });
    if (!session) throw new NotFoundException('session not found');
    if (!SessionsService.TERMINAL.includes(session.status)) {
      throw new ConflictException('end the session before archiving or deleting it');
    }
    return session;
  }

  /** Hide a terminal session from the active list (Archived view). Reversible. */
  async archive(ownerId: string, id: string) {
    const session = await this.getEnded(ownerId, id);
    await this.prisma.session.update({ where: { id: session.id }, data: { archivedAt: new Date() } });
    return { ok: true };
  }

  /**
   * Change the model / permission mode of an already-started session. The live
   * claude process was spawned with the old --model/--permission-mode flags, so we
   * persist the new values and enqueue a `reload` control turn: the runner tears the
   * process down and re-spawns it with --resume + the new flags (full context kept).
   * Only allowed between turns (AWAITING_INPUT) — a swap would abort an in-flight turn.
   * A not-yet-claimed (PENDING) session needs no reload: the claim reads the new value.
   */
  async updateConfig(ownerId: string, id: string, dto: SessionConfigDto) {
    if (dto.model === undefined && dto.permissionMode === undefined) {
      throw new BadRequestException('nothing to update');
    }
    const session = await this.prisma.session.findFirst({ where: { id, ownerId } });
    if (!session) throw new NotFoundException('session not found');
    if (SessionsService.TERMINAL.includes(session.status)) {
      throw new ConflictException('the session has ended');
    }
    if (session.status !== RunStatus.AWAITING_INPUT && session.status !== RunStatus.PENDING) {
      throw new ConflictException('a turn is in progress; change the model between turns');
    }
    await this.prisma.session.update({
      where: { id },
      data: {
        lastTurnAt: new Date(), // reset the idle clock so the reaper won't tear down mid-reload
        ...(dto.model !== undefined ? { model: dto.model } : {}),
        ...(dto.permissionMode !== undefined ? { permissionMode: dto.permissionMode } : {}),
      },
    });
    if (session.status === RunStatus.AWAITING_INPUT) {
      // Carry only the changed fields; the runner overrides just those, keeping the
      // rest of the running config. Multiple rapid changes queue + apply in order.
      await this.insertTurn(id, {
        kind: 'reload',
        content: JSON.stringify({ model: dto.model, permissionMode: dto.permissionMode }),
        clientTurnId: randomUUID(),
      });
      this.realtime.notifyInbox(id);
    }
    return { ok: true };
  }

  /**
   * Soft-delete a terminal session (moves it to the trash view). No data is removed —
   * the transcript and billing stay; restore brings it back. There is no hard delete.
   */
  async remove(ownerId: string, id: string) {
    const session = await this.getEnded(ownerId, id);
    await this.prisma.session.update({ where: { id: session.id }, data: { deletedAt: new Date() } });
    return { ok: true };
  }

  /** Bring an archived or soft-deleted session back to the active list. */
  async restore(ownerId: string, id: string) {
    await this.get(ownerId, id); // ownership check (404s otherwise)
    await this.prisma.session.update({
      where: { id },
      data: { archivedAt: null, deletedAt: null },
    });
    return { ok: true };
  }
}
