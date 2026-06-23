import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RunStatus } from '@prisma/client';
import { randomUUID } from 'crypto';
import {
  ApprovalDecisionRequest,
  ApprovalInfo,
  ApprovalStatus,
  RunEventType,
  SessionEndReason,
} from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CreateSessionDto, SessionConfigDto, SessionResumeDto, SessionTurnDto } from './dto';
import { generateNaming } from './naming';

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

  // `source` defaults to "user"; internal callers (e.g. auto-replying to an @-mention)
  // pass "system" so the session lands in the System tab instead of Active. It's not on
  // CreateSessionDto, so HTTP clients can't spoof it.
  async create(
    ownerId: string,
    dto: CreateSessionDto,
    opts?: { source?: string; batch?: { id: string; maxConcurrent: number } },
  ) {
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
    // Validate any compose-page image refs up front (caller's, still unscoped) so a bad
    // one fails the request before a session is created. They're scoped to the session
    // below and linked to the seeded first turn when the runner claims it (queue.service).
    const attachmentIds = await this.assertScopableAttachments(ownerId, dto.attachmentIds);
    // PENDING so the assigned runner claims it and spawns the long-lived claude
    // process; it then awaits turns via the inbox.
    // Title + per-session worktree branch. DeepSeek (when DEEPSEEK_API_KEY is set) returns a
    // clean English title and branch slug; otherwise a deterministic slug fallback. Keep an
    // explicit dto.title (task templates, user-typed) and only adopt DeepSeek's title for an
    // otherwise-unnamed session; the branch always uses the best available slug. The runner
    // runs claude in its own `git worktree` on this branch when the workDir is a git repo,
    // then commits the work here for a manual merge — harmless for non-git/shared runs.
    const naming = await generateNaming({ prompt: dto.prompt, title: dto.title });
    const title = dto.title ?? naming.title ?? dto.prompt.slice(0, 80);
    const session = await this.prisma.session.create({
      data: {
        title,
        branch: naming.branch,
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
        source: opts?.source ?? 'user',
        batchId: opts?.batch?.id ?? null,
        batchMaxConcurrent: opts?.batch?.maxConcurrent ?? null,
        creatorId: ownerId,
        ownerId,
      },
    });
    // Scope the compose-page uploads to this session now that it exists. They stay
    // turn-less until the runner seeds the first turn (queue.service links them to it),
    // and cascade-delete with the session.
    if (attachmentIds.length > 0) {
      await this.prisma.attachment.updateMany({
        where: { id: { in: attachmentIds }, sessionId: null, turnId: null },
        data: { sessionId: session.id },
      });
    }
    this.queue.notifySessionQueued();
    return session;
  }

  async list(
    ownerId: string,
    filters: { runnerId?: string; view?: 'active' | 'archived' | 'deleted' | 'system' },
  ) {
    // active = neither archived nor deleted; archived = archived but not deleted;
    // deleted (trash) = deleted, regardless of archive state; system = auto-created
    // (a non-deleted system session), shown in its own tab. Default to active.
    // Note: active still includes system sessions — they occupy runner slots and back
    // selection/deep-link resolution. The web Active tab hides them from its list.
    const visibility: Prisma.Sql =
      filters.view === 'deleted'
        ? Prisma.sql`s.deleted_at IS NOT NULL`
        : filters.view === 'system'
          ? Prisma.sql`s.source = 'system' AND s.deleted_at IS NULL`
          : filters.view === 'archived'
            ? Prisma.sql`s.archived_at IS NOT NULL AND s.deleted_at IS NULL`
            : Prisma.sql`s.archived_at IS NULL AND s.deleted_at IS NULL`;
    const runnerFilter = filters.runnerId
      ? Prisma.sql`AND s.assigned_runner_id = ${filters.runnerId}::uuid`
      : Prisma.empty;
    // Raw query so the (potentially multi-KB) last-reply preview is truncated in SQL —
    // only ~200 chars per row ever leave the DB. It also omits big unused columns like
    // `prompt`; together this keeps the list payload flat as the session count grows.
    // `select` can't express left()/substring(), hence the hand-written join.
    type Row = {
      id: string;
      status: RunStatus;
      title: string;
      createdAt: Date;
      lastTurnAt: Date | null;
      startedAt: Date | null;
      numTurns: number;
      costUsd: number;
      error: string | null;
      endReason: string | null;
      source: string;
      model: string | null;
      permissionMode: string | null;
      effort: string | null;
      lastAssistantText: string | null;
      lastToolUse: string | null;
      agentId: string | null;
      agentName: string | null;
      agentModel: string | null;
      runnerId: string | null;
      runnerName: string | null;
      taskId: string | null;
      taskTitle: string | null;
    };
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT
        s.id, s.status, s.title,
        s.created_at      AS "createdAt",
        s.last_turn_at    AS "lastTurnAt",
        s.started_at      AS "startedAt",
        s.num_turns       AS "numTurns",
        s.cost_usd        AS "costUsd",
        s.error,
        s.end_reason      AS "endReason",
        s.source, s.model,
        s.permission_mode AS "permissionMode",
        s.effort,
        left(s.last_assistant_text, ${SessionsService.PREVIEW_LEN}::int) AS "lastAssistantText",
        s.last_tool_use   AS "lastToolUse",
        a.id    AS "agentId",
        a.name  AS "agentName",
        a.model AS "agentModel",
        r.id    AS "runnerId",
        r.name  AS "runnerName",
        s.task_id AS "taskId",
        t.title   AS "taskTitle"
      FROM session s
      LEFT JOIN agent a  ON a.id = s.agent_id
      LEFT JOIN runner r ON r.id = s.assigned_runner_id
      LEFT JOIN task t   ON t.id = s.task_id
      WHERE s.owner_id = ${ownerId}::uuid
        ${runnerFilter}
        AND (${visibility})
      ORDER BY s.last_turn_at DESC NULLS LAST, s.created_at DESC
    `);
    // Re-nest agent/assignedRunner to keep the same response shape as the typed query.
    const sessions = rows.map((r) => ({
      id: r.id,
      status: r.status,
      title: r.title,
      createdAt: r.createdAt,
      lastTurnAt: r.lastTurnAt,
      startedAt: r.startedAt,
      numTurns: r.numTurns,
      costUsd: r.costUsd,
      error: r.error,
      endReason: r.endReason,
      source: r.source,
      model: r.model,
      permissionMode: r.permissionMode,
      effort: r.effort,
      lastAssistantText: r.lastAssistantText,
      lastToolUse: r.lastToolUse,
      agent: r.agentId ? { id: r.agentId, name: r.agentName, model: r.agentModel } : null,
      assignedRunner: r.runnerId ? { id: r.runnerId, name: r.runnerName } : null,
      taskId: r.taskId,
      taskTitle: r.taskTitle,
    }));
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

  // The session list shows the last reply as a single ellipsised line, so it only
  // needs a short prefix of the (potentially multi-KB) denormalized preview text.
  private static readonly PREVIEW_LEN = 200;

  private static readonly LIVE: RunStatus[] = [
    RunStatus.RUNNING,
    RunStatus.AWAITING_INPUT,
    RunStatus.INTERRUPTED,
  ];

  private static readonly TERMINAL: RunStatus[] = [
    RunStatus.SUCCEEDED,
    RunStatus.FAILED,
    RunStatus.CANCELLED,
    // Ended but resumable: not live, so resume() revives it (and archive/delete/config
    // treat it as already-ended) — same as CANCELLED, minus the "cancelled" stigma.
    RunStatus.PARKED,
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
   * Like {@link getLive}, but also accepts a still-PENDING session — one queued and
   * waiting for a runner slot, with no claude process yet. A user message can be lined
   * up onto it (it's delivered once the runner claims the session); only an ended or
   * cancel-requested session rejects. Used by createTurn / cancelQueuedTurn so the
   * composer works while the session waits for a slot.
   */
  private async getSendable(ownerId: string, id: string) {
    const session = await this.prisma.session.findFirst({ where: { id, ownerId } });
    if (!session) throw new NotFoundException('session not found');
    if (SessionsService.TERMINAL.includes(session.status) || session.cancelRequestedAt) {
      throw new ConflictException('the session has ended');
    }
    return session;
  }

  /**
   * Seed the session's first turn from its prompt, idempotently. A fresh PENDING session
   * isn't seeded until the runner claims it (queue.service.buildSession), so to queue a
   * follow-up onto one we must lay down the prompt as turn 1 first — otherwise the
   * follow-up would take seq 1 and the claim would skip seeding (turnCount > 0), dropping
   * the prompt. Uses the SAME fixed clientTurnId the claim uses, so whichever path runs
   * first wins and the other no-ops (insertTurn is idempotent on clientTurnId). No-op once
   * any turn exists (already seeded, or a re-claimed session with history).
   */
  private async ensurePromptSeeded(session: { id: string; prompt: string }) {
    const count = await this.prisma.conversationTurn.count({ where: { sessionId: session.id } });
    if (count > 0) return;
    const turn = await this.insertTurn(session.id, {
      kind: 'message',
      content: session.prompt,
      clientTurnId: SessionsService.initialTurnClientId(session.id),
    });
    // Link any compose-page uploads (scoped to the session, still turn-less) to the seed
    // turn, exactly as the claim would, so they ride along with the prompt.
    await this.prisma.attachment.updateMany({
      where: { sessionId: session.id, turnId: null },
      data: { turnId: turn.id },
    });
  }

  /** The fixed clientTurnId of the seeded first turn (the prompt) — see ensurePromptSeeded
   *  / queue.service.buildSession. It's a real PENDING message turn but isn't a withdrawable
   *  queued follow-up, so the queued-turn list/cancel paths exclude it. */
  private static initialTurnClientId(sessionId: string): string {
    return `initial-${sessionId}`;
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

  /**
   * Verify the given attachment ids are the caller's, scoped to this session, and not yet
   * tied to a turn. Returns the de-duped ids. Throws on any unknown/foreign/already-used id
   * so a bad reference is rejected BEFORE a turn is queued (no orphan text turn, no silent
   * drop of an image the user meant to send). Call before inserting the turn; link after.
   */
  private async assertLinkableAttachments(
    ownerId: string,
    sessionId: string,
    attachmentIds: string[] | undefined,
  ): Promise<string[]> {
    const ids = [...new Set(attachmentIds ?? [])];
    if (ids.length === 0) return [];
    const found = await this.prisma.attachment.findMany({
      where: { id: { in: ids }, ownerId, sessionId, turnId: null },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      throw new BadRequestException('one or more attachments are unknown, not yours, or already attached');
    }
    return ids;
  }

  /**
   * Verify the given attachment ids are the caller's and still unscoped (no session, no
   * turn) — i.e. fresh uploads made on the compose page before any session existed. Returns
   * the de-duped ids. Throws on any unknown/foreign/already-scoped id so a bad reference is
   * rejected BEFORE the session is created. Used by create() for the seeded first turn.
   */
  private async assertScopableAttachments(
    ownerId: string,
    attachmentIds: string[] | undefined,
  ): Promise<string[]> {
    const ids = [...new Set(attachmentIds ?? [])];
    if (ids.length === 0) return [];
    const found = await this.prisma.attachment.findMany({
      where: { id: { in: ids }, ownerId, sessionId: null, turnId: null },
      select: { id: true },
    });
    if (found.length !== ids.length) {
      throw new BadRequestException('one or more attachments are unknown, not yours, or already used');
    }
    return ids;
  }

  /** Stamp pre-validated attachments with the turn they belong to, so the inbox can
   *  deliver them. `turnId: null` in the filter keeps a concurrent link from double-using one. */
  private async linkAttachments(turnId: string, attachmentIds: string[]): Promise<void> {
    if (attachmentIds.length === 0) return;
    await this.prisma.attachment.updateMany({
      where: { id: { in: attachmentIds }, turnId: null },
      data: { turnId },
    });
  }

  /** Enqueue a user message for a live or still-queued (PENDING) session. */
  async createTurn(ownerId: string, id: string, dto: SessionTurnDto) {
    const session = await this.getSendable(ownerId, id);
    const existing = await this.prisma.conversationTurn.findUnique({
      where: { sessionId_clientTurnId: { sessionId: id, clientTurnId: dto.clientTurnId } },
    });
    if (existing) return { turnId: existing.id, seq: existing.seq }; // idempotent
    // Validate any image refs up front so a bad one fails the request before a turn lands.
    const attachmentIds = await this.assertLinkableAttachments(ownerId, id, dto.attachmentIds);
    // The session may still be PENDING (queued, waiting for a runner slot). Its first turn
    // (the prompt) isn't seeded until the runner claims it, so seed it now — otherwise this
    // follow-up would land at seq 1 and the claim would drop the prompt. No-op once seeded.
    if (session.status === RunStatus.PENDING) await this.ensurePromptSeeded(session);
    // Accept the message even while a turn is running: it's queued as PENDING and
    // delivery is serialized in the inbox (dequeueTurn releases the next message only
    // once the in-flight one is answered). The user can withdraw a still-queued one.
    const turn = await this.insertTurn(id, {
      // Whitelist: the turns endpoint may only enqueue 'message' or 'shell' — never a
      // control kind (interrupt/end/reload), which have their own dedicated routes.
      kind: dto.kind === 'shell' ? 'shell' : 'message',
      content: dto.content,
      clientTurnId: dto.clientTurnId,
    });
    await this.linkAttachments(turn.id, attachmentIds);
    // User activity resets the idle clock so the reaper won't tear down a session
    // that just received a message but hasn't been picked up by the runner yet.
    await this.prisma.session.update({ where: { id }, data: { lastTurnAt: new Date() } });
    this.realtime.notifyInbox(id);
    return { turnId: turn.id, seq: turn.seq };
  }

  /** Abort the in-flight turn of a live session (the process stays alive). */
  async interrupt(ownerId: string, id: string) {
    const session = await this.getLive(ownerId, id);
    // Drop any queued-but-undelivered follow-ups: interrupting means "stop", so the
    // user's pending messages shouldn't fire after the in-flight turn is aborted. An
    // already-delivered message is IN_FLIGHT, not PENDING — it's the turn being aborted.
    await this.prisma.conversationTurn.deleteMany({
      where: { sessionId: session.id, kind: 'message', status: 'PENDING' },
    });
    await this.enqueueControlTurn(session.id, 'interrupt');
    this.realtime.notifyInbox(session.id);
    return { ok: true };
  }

  /** The session's still-queued user messages (PENDING — accepted but not yet picked
   *  up by the runner), oldest first. A queued turn emits no event until it's delivered,
   *  so it can't be recovered from the event stream; reopening or deep-linking a running
   *  session fetches this to restore the visible queue (mirrors listApprovals). */
  async listQueuedTurns(ownerId: string, id: string) {
    const session = await this.prisma.session.findFirst({
      where: { id, ownerId },
      select: { id: true },
    });
    if (!session) throw new NotFoundException('session not found');
    const turns = await this.prisma.conversationTurn.findMany({
      // Exclude the seeded prompt turn (still PENDING until the runner claims the session):
      // it's the session's opening message, not a withdrawable queued follow-up.
      where: {
        sessionId: id,
        kind: 'message',
        status: 'PENDING',
        clientTurnId: { not: SessionsService.initialTurnClientId(id) },
      },
      orderBy: { seq: 'asc' },
      // Carry each queued turn's image refs so the composer can still render them after a
      // reload (the local object-URL previews are gone by then) — e.g. an image-only turn.
      select: { id: true, content: true, attachments: { select: { id: true, mimeType: true } } },
    });
    return turns.map((t) => ({
      turnId: t.id,
      content: t.content ?? '',
      attachments: t.attachments.map((a) => ({ id: a.id, mimeType: a.mimeType })),
    }));
  }

  /** Withdraw a queued user message. Only a still-PENDING message can be cancelled;
   *  once the runner has leased it (IN_FLIGHT) it's already feeding claude and will
   *  appear in the transcript, so cancelling is rejected. */
  async cancelQueuedTurn(ownerId: string, id: string, turnId: string) {
    await this.getSendable(ownerId, id);
    const res = await this.prisma.conversationTurn.deleteMany({
      // The seeded prompt turn isn't a withdrawable follow-up — never let it be cancelled.
      where: {
        id: turnId,
        sessionId: id,
        kind: 'message',
        status: 'PENDING',
        clientTurnId: { not: SessionsService.initialTurnClientId(id) },
      },
    });
    if (res.count === 0) throw new ConflictException('message already started or not found');
    return { ok: true };
  }

  /** End a live session (closes the runner's claude process). */
  async end(ownerId: string, id: string) {
    const session = await this.getLive(ownerId, id);
    await this.endLive(session, SessionEndReason.ENDED);
    return { ok: true };
  }

  /**
   * Stop a session and settle it to CANCELLED — unlike {@link end}, which PARKS the
   * session as dormant/resumable. A live session has its claude process torn down
   * (endLive, reason CANCELLED so /complete finalizes CANCELLED not PARKED). A still-
   * queued PENDING session is finalized in place: there's no claude to tear down and a
   * runner may never claim it (offline / batch concurrency cap full), so endLive alone
   * would leave it stuck PENDING — finalizing directly is what lets a batch-stop drop
   * its queued, not-yet-started tasks. No-op (returns false) if already terminal or
   * already ending. Used by {@link TasksService.batchStop}.
   */
  async cancel(ownerId: string, id: string): Promise<boolean> {
    const session = await this.prisma.session.findFirst({ where: { id, ownerId } });
    if (!session) throw new NotFoundException('session not found');
    if (SessionsService.TERMINAL.includes(session.status) || session.cancelRequestedAt) return false;
    if (session.status === RunStatus.PENDING) {
      // Atomic against the claim queue, which flips PENDING→RUNNING. Guarding on
      // status=PENDING means the runner can't have started claude under us.
      const res = await this.prisma.session.updateMany({
        where: { id, status: RunStatus.PENDING },
        data: {
          status: RunStatus.CANCELLED,
          endReason: SessionEndReason.CANCELLED,
          cancelRequestedAt: new Date(),
          finishedAt: new Date(),
        },
      });
      if (res.count > 0) {
        // Drain queued turns so nothing can be leased if the row is ever revived.
        await this.prisma.conversationTurn.updateMany({
          where: { sessionId: id, status: { not: 'ANSWERED' } },
          data: { status: 'ANSWERED', answeredAt: new Date() },
        });
        this.realtime.notifyInbox(id);
        return true;
      }
      // Lost the race: the runner claimed it (now RUNNING). Re-load and tear it down.
      const live = await this.prisma.session.findFirst({ where: { id, ownerId } });
      if (!live || SessionsService.TERMINAL.includes(live.status) || live.cancelRequestedAt) return false;
      await this.endLive(live, SessionEndReason.CANCELLED);
      return true;
    }
    await this.endLive(session, SessionEndReason.CANCELLED);
    return true;
  }

  /**
   * Signal the runner to tear down a session's claude process: mark cancel-requested,
   * record why it ended, enqueue an `end` control turn, and (if claimed) ask the runner
   * to cancel now. The status settles to CANCELLED async once the runner reports back —
   * `endReason` is what lets the UI tell that benign end apart from a real cancel.
   * Caller must have already loaded the session and confirmed it isn't terminal.
   */
  private async endLive(
    session: { id: string; assignedRunnerId: string | null },
    reason: SessionEndReason,
  ) {
    await this.prisma.session.update({
      where: { id: session.id },
      data: { cancelRequestedAt: new Date(), endReason: reason },
    });
    // Drop queued-but-undelivered messages so they can't replay if the session is
    // later revived (resume re-claims the same row and would otherwise deliver these
    // stale PENDING turns ahead of the new message).
    await this.prisma.conversationTurn.deleteMany({
      where: { sessionId: session.id, kind: 'message', status: 'PENDING' },
    });
    await this.enqueueControlTurn(session.id, 'end');
    if (session.assignedRunnerId) this.realtime.requestCancel(session.assignedRunnerId, session.id);
    this.realtime.notifyInbox(session.id);
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
      data: {
        status,
        message: dto.message ?? null,
        answers: dto.answers ? (dto.answers as Prisma.InputJsonValue) : Prisma.DbNull,
        // Only an allow can carry a "remember same kind" rule; the runner reads it off
        // the long-poll and adds it to claude's session permissions.
        rememberRule:
          dto.behavior === 'allow' && dto.rememberRule
            ? (dto.rememberRule as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        decidedById: ownerId,
        decidedAt: new Date(),
      },
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

  async resume(
    ownerId: string,
    id: string,
    dto: SessionResumeDto,
    opts?: { batch?: { id: string; maxConcurrent: number } | null },
  ) {
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
    // Validate image refs before reviving, mirroring createTurn.
    const attachmentIds = await this.assertLinkableAttachments(ownerId, id, dto.attachmentIds);
    // Append the message, then flip the row back to PENDING so the runner re-claims
    // it; buildSession sees the existing turns and re-spawns claude with --resume.
    const turn = await this.insertTurn(id, {
      kind: 'message',
      content: dto.content,
      clientTurnId: dto.clientTurnId,
    });
    await this.linkAttachments(turn.id, attachmentIds);
    await this.prisma.session.update({
      where: { id },
      data: {
        status: RunStatus.PENDING,
        cancelRequestedAt: null,
        endReason: null,
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
        // Batch membership for this revival: a batch run re-stamps it (object), a
        // single re-run clears it (null) so it escapes any prior batch's cap; a plain
        // user resume passes nothing and leaves it as-is.
        ...(opts?.batch !== undefined
          ? { batchId: opts.batch?.id ?? null, batchMaxConcurrent: opts.batch?.maxConcurrent ?? null }
          : {}),
      },
    });
    this.queue.notifySessionQueued();
    return { turnId: turn.id, seq: turn.seq };
  }

  /**
   * Hide a session from the active list (Archived view). Reversible. A session that
   * hasn't ended is archived too: we recycle its runner process first (enqueue an
   * `end` control turn + signal the runner to cancel) so a live claude isn't orphaned.
   * The status settles to CANCELLED async while the row already sits in Archived.
   */
  async archive(ownerId: string, id: string) {
    const session = await this.prisma.session.findFirst({ where: { id, ownerId } });
    if (!session) throw new NotFoundException('session not found');
    if (!SessionsService.TERMINAL.includes(session.status) && !session.cancelRequestedAt) {
      await this.endLive(session, SessionEndReason.COMPLETED);
    }
    await this.prisma.session.update({ where: { id: session.id }, data: { archivedAt: new Date() } });
    return { ok: true };
  }

  /**
   * Change the model / permission mode / effort of an already-started session. The live
   * claude process was spawned with the old --model/--permission-mode flags, so we
   * persist the new values and enqueue a `reload` control turn: the runner tears the
   * process down and re-spawns it with --resume + the new flags (full context kept).
   * The reload is deferred by the inbox lease until no message is in flight, so changing
   * config mid-turn doesn't abort the running turn — it applies between turns (the next
   * queued message then runs under the new config). A not-yet-claimed (PENDING) session
   * needs no reload: the claim reads the new value.
   */
  async updateConfig(ownerId: string, id: string, dto: SessionConfigDto) {
    if (dto.model === undefined && dto.permissionMode === undefined && dto.effort === undefined) {
      throw new BadRequestException('nothing to update');
    }
    const session = await this.prisma.session.findFirst({ where: { id, ownerId } });
    if (!session) throw new NotFoundException('session not found');
    if (SessionsService.TERMINAL.includes(session.status)) {
      throw new ConflictException('the session has ended');
    }
    await this.prisma.session.update({
      where: { id },
      data: {
        lastTurnAt: new Date(), // reset the idle clock so the reaper won't tear down mid-reload
        ...(dto.model !== undefined ? { model: dto.model } : {}),
        ...(dto.permissionMode !== undefined ? { permissionMode: dto.permissionMode } : {}),
        ...(dto.effort !== undefined ? { effort: dto.effort } : {}),
      },
    });
    if (session.status !== RunStatus.PENDING) {
      // Live session (RUNNING or AWAITING_INPUT): enqueue a reload. The lease holds it
      // until the current turn (if any) finishes, then the runner re-spawns with the new
      // flags. Carry only the changed fields; the runner overrides just those, keeping
      // the rest of the running config. Multiple rapid changes queue + apply in order.
      // effort is sent even when '' (clear to default) — undefined is omitted by
      // JSON.stringify, so the runner sees the key only when it actually changed.
      await this.insertTurn(id, {
        kind: 'reload',
        content: JSON.stringify({
          model: dto.model,
          permissionMode: dto.permissionMode,
          effort: dto.effort,
        }),
        clientTurnId: randomUUID(),
      });
      this.realtime.notifyInbox(id);
    }
    return { ok: true };
  }

  /**
   * Soft-delete a session (moves it to the trash view). No data is removed — the
   * transcript and billing stay; restore brings it back. There is no hard delete.
   * A session that hasn't ended is deleted too: like `archive`, we recycle its runner
   * process first (`endLive`) so a live claude isn't orphaned. Status settles to
   * CANCELLED async while the row already sits in Trash.
   */
  async remove(ownerId: string, id: string) {
    const session = await this.prisma.session.findFirst({ where: { id, ownerId } });
    if (!session) throw new NotFoundException('session not found');
    if (!SessionsService.TERMINAL.includes(session.status) && !session.cancelRequestedAt) {
      await this.endLive(session, SessionEndReason.DELETED);
    }
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
