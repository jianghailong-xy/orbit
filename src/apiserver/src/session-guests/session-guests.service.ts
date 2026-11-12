import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, RunStatus } from '@prisma/client';
import type { GuestSessionSummary, SessionGuestPerson } from '@orbit/shared';
import { PrismaService } from '../prisma/prisma.service';
import { SessionNotSendable, SessionsService } from '../sessions/sessions.service';
import type { ExternalTurnSender } from '../sessions/session-message';
import { assertEngineSession } from '../sessions/engine-session';
import { withSessionState } from '../sessions/session-state';
import { parseMaxPayload } from '../sessions/truncate-payload';

/** The one answer a guest door gives when there is no live invitation: never invited, removed, left, or Trash. */
export const GUEST_SESSION_NOT_SHARED = 'This conversation is no longer shared with you.';
const notShared = () => new NotFoundException(GUEST_SESSION_NOT_SHARED);

/** What inviting an email no enabled Orbit account uses answers (the shared pools' sentence, in this shape). */
export const GUEST_NO_ACCOUNT = 'No Orbit account uses this email.';
export const GUEST_NOT_YOURSELF = "You can't invite yourself to your own session.";

/** The activity row each guest turn writes (docs/session-guests-design.md §5 step 6). */
export const GUEST_TURN_ACTIVITY = 'session.guest.turn';

const num = (s?: string): number | undefined => {
  const n = Number(s);
  return s !== undefined && s !== '' && Number.isFinite(n) ? n : undefined;
};

/** Midnight UTC of today: a guest's day (§6 rule 5). */
const utcMidnight = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** A live invitation as the guest door reads it: whose session, and the guest's name for the turn. */
interface LiveInvitation {
  guestRowId: string;
  sessionId: string;
  ownerId: string;
  guestName: string;
  openedAt: Date | null;
}

/** The body of `POST /guest-sessions/:id/turns`. Only these two are read; G1b refuses everything else by name. */
export interface GuestTurnBody {
  clientTurnId?: unknown;
  content?: unknown;
  [field: string]: unknown;
}

/**
 * Session guests (docs/session-guests-design.md §3–§7): the owner invites registered accounts by email to reply in one
 * of their sessions, and each guest's words become a turn of the owner's own session, recorded with external sender
 * ORBIT_GUEST and the guest's name — the 0502 path the Feishu door writes, through the same internal option of
 * SessionsService.createTurn. The guest's user id is written only to `session_guest` and the turn's
 * `external_sender_id`; nothing a client or the runner reads carries it.
 */
@Injectable()
export class SessionGuestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

  // ── The owner's side ─────────────────────────────────────────────────────────────────────────

  /** The owner's own session, or 404; for a write, an engine session (a LANDING is refused, 409). */
  private async ownedSession(ownerId: string, sessionId: string, opts: { live: boolean; write: boolean }) {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, ownerId, ...(opts.live ? { deletedAt: null } : {}) },
      select: { id: true, sessionKind: true },
    });
    if (!session) throw new NotFoundException('session not found');
    // Nobody is invited into the platform's landing record: it runs no engine turn (§2.9 LS6).
    if (opts.write) assertEngineSession(session);
    return session;
  }

  /** The people who can reply in the session: each one's name and email, today's messages and whether they opened it. */
  async list(ownerId: string, sessionId: string): Promise<{ guests: SessionGuestPerson[] }> {
    await this.ownedSession(ownerId, sessionId, { live: false, write: false });
    const rows = await this.prisma.sessionGuest.findMany({
      where: { sessionId, removedAt: null },
      orderBy: { addedAt: 'asc' },
      select: { userId: true, addedAt: true, openedAt: true, user: { select: { name: true, email: true } } },
    });
    const today = rows.length === 0 ? [] : await this.prisma.conversationTurn.groupBy({
      by: ['externalSenderId'],
      where: {
        sessionId,
        externalSenderSource: 'ORBIT_GUEST',
        externalSenderId: { in: rows.map((r) => r.userId) },
        createdAt: { gte: utcMidnight() },
      },
      _count: { _all: true },
    });
    const counted = new Map(today.map((t) => [t.externalSenderId, t._count._all]));
    return {
      guests: rows.map((r) => ({
        userId: r.userId,
        name: r.user.name,
        email: r.user.email,
        addedAt: r.addedAt.toISOString(),
        messagesToday: counted.get(r.userId) ?? 0,
        opened: r.openedAt !== null,
      })),
    };
  }

  /**
   * Invite an account by the email it signs in with. Only a registered, enabled account other than the owner; an
   * email nobody uses — or a disabled account's, which reads the same — is refused and nothing is written. Inviting
   * someone already invited changes nothing.
   */
  async invite(ownerId: string, sessionId: string, email: unknown) {
    if (typeof email !== 'string' || email.trim() === '') throw new BadRequestException('email is required');
    await this.ownedSession(ownerId, sessionId, { live: true, write: true });
    const person = await this.prisma.user.findFirst({
      where: { email: { equals: email.trim(), mode: 'insensitive' }, disabledAt: null },
      select: { id: true },
    });
    if (!person) throw new NotFoundException(GUEST_NO_ACCOUNT);
    if (person.id === ownerId) throw new BadRequestException(GUEST_NOT_YOURSELF);
    await this.prisma.$executeRaw`
      INSERT INTO "session_guest" ("id", "session_id", "owner_id", "user_id")
      VALUES (gen_random_uuid(), ${sessionId}::uuid, ${ownerId}::uuid, ${person.id}::uuid)
      ON CONFLICT ("session_id", "user_id") WHERE "removed_at" IS NULL DO NOTHING`;
    return this.list(ownerId, sessionId);
  }

  /** Take a guest out: their door answers 404 from now on. */
  async remove(ownerId: string, sessionId: string, userId: string) {
    await this.ownedSession(ownerId, sessionId, { live: false, write: true });
    const { count } = await this.prisma.sessionGuest.updateMany({
      where: { sessionId, userId, removedAt: null },
      data: { removedAt: new Date(), removedReason: 'REMOVED' },
    });
    if (count === 0) throw new NotFoundException('guest not found');
    return this.list(ownerId, sessionId);
  }

  // ── The guest's side ─────────────────────────────────────────────────────────────────────────

  /**
   * The guest's live invitation to the session, or the one 404. Every guest route asks this first, so a removed
   * guest, one who left, a session in the Trash and a session the caller was never invited to are the same answer.
   */
  private async invitation(guestId: string, sessionId: string): Promise<LiveInvitation> {
    const row = await this.prisma.sessionGuest.findFirst({
      where: { sessionId, userId: guestId, removedAt: null, session: { deletedAt: null } },
      select: {
        id: true,
        openedAt: true,
        session: { select: { ownerId: true } },
        user: { select: { name: true } },
      },
    });
    if (!row) throw notShared();
    return { guestRowId: row.id, sessionId, ownerId: row.session.ownerId, guestName: row.user.name, openedAt: row.openedAt };
  }

  /** Shared with me: every session the caller is a live guest of, newest invitation first. */
  async sharedWithMe(guestId: string): Promise<{ sessions: GuestSessionSummary[] }> {
    const rows = await this.prisma.sessionGuest.findMany({
      where: { userId: guestId, removedAt: null, session: { deletedAt: null } },
      orderBy: { addedAt: 'desc' },
      select: {
        addedAt: true,
        session: {
          select: {
            id: true, title: true, status: true, endReason: true, completedAt: true, archivedAt: true, deletedAt: true,
            lastTurnAt: true, owner: { select: { name: true } },
          },
        },
      },
    });
    return {
      sessions: rows.map(({ addedAt, session }) => {
        const state = withSessionState(session);
        return {
          id: session.id,
          title: session.title,
          ownerName: session.owner.name,
          status: state.status,
          sessionState: state.sessionState,
          lifecycleState: state.lifecycleState,
          addedAt: addedAt.toISOString(),
          lastTurnAt: session.lastTurnAt?.toISOString() ?? null,
        };
      }),
    };
  }

  /**
   * The guest page's root: the session as its public page shows it with Tool calls and output on
   * (SessionsService.getSharedTranscript, the /shared projection), and who shared it. The first read stamps the
   * invitation opened, which the owner's People list shows.
   */
  async get(guestId: string, sessionId: string, query: { limit?: string; maxPayload?: string }) {
    const invitation = await this.invitation(guestId, sessionId);
    if (invitation.openedAt === null) {
      await this.prisma.sessionGuest.updateMany({
        where: { id: invitation.guestRowId, openedAt: null },
        data: { openedAt: new Date() },
      });
    }
    const owner = await this.prisma.user.findUniqueOrThrow({ where: { id: invitation.ownerId }, select: { name: true } });
    const transcript = await this.sessions.getSharedTranscript(sessionId, {
      limit: num(query.limit),
      maxPayload: parseMaxPayload(query.maxPayload),
    });
    return { ...transcript, ownerName: owner.name };
  }

  /** A page of the transcript, as `/shared/:token/events` pages it: after `after`, or before `before`, or the tail. */
  async events(guestId: string, sessionId: string, query: { before?: string; after?: string; limit?: string; maxPayload?: string }) {
    await this.invitation(guestId, sessionId);
    const opts = { limit: num(query.limit), maxPayload: parseMaxPayload(query.maxPayload) };
    const after = num(query.after);
    return after !== undefined
      ? this.sessions.getSharedEventsAfter(sessionId, { ...opts, after })
      : this.sessions.getSharedEventPage(sessionId, { ...opts, before: num(query.before) });
  }

  /** One event, whole: what an expanded `truncated` card fetches. */
  async event(guestId: string, sessionId: string, seq: string) {
    const n = Number(seq);
    if (!Number.isFinite(n)) throw new BadRequestException('seq must be a number');
    await this.invitation(guestId, sessionId);
    return this.sessions.getSharedEventFull(sessionId, Math.trunc(n));
  }

  /**
   * A guest's message: a turn of the owner's session (§5), written by SessionsService as the owner with the guest as
   * its external sender, and one `session.guest.turn` activity row beside it. A session that has ended is resumed
   * (D5) with its own mode, model and provider: only `clientTurnId` and `content` reach the service, so there is no
   * override to take. A message to a live session is queued or steered as the owner's would be.
   */
  async turn(guestId: string, sessionId: string, body: GuestTurnBody) {
    const invitation = await this.invitation(guestId, sessionId);
    const { clientTurnId, content } = body ?? {};
    if (typeof clientTurnId !== 'string' || clientTurnId.trim() === '') throw new BadRequestException('clientTurnId is required');
    if (typeof content !== 'string' || content.trim() === '') throw new BadRequestException('content is required');
    // A key is the session's, whoever chose it: one the owner (or another guest) already used is not this guest's
    // to replay, whatever its words.
    const taken = await this.prisma.conversationTurn.findUnique({
      where: { sessionId_clientTurnId: { sessionId, clientTurnId } },
      select: { externalSenderSource: true, externalSenderId: true },
    });
    if (taken && !(taken.externalSenderSource === 'ORBIT_GUEST' && taken.externalSenderId === guestId)) {
      throw new ConflictException('clientTurnId was already used in this session');
    }
    const externalSender: ExternalTurnSender = { source: 'ORBIT_GUEST', id: guestId, name: invitation.guestName };
    const dto = { clientTurnId, content };
    // Written with the turn, so a replay of this clientTurnId records nothing again.
    const onTurnWritten = (tx: Prisma.TransactionClient, turn: { id: string }) =>
      this.recordGuestTurn(tx, invitation.ownerId, sessionId, turn.id, guestId);
    const ended = await this.hasEnded(sessionId);
    if (!ended) {
      try {
        const sent = await this.sessions.createTurn(invitation.ownerId, sessionId, dto, { externalSender, onTurnWritten });
        return { ...answerOf(sent), revived: false };
      } catch (error) {
        // It ended between the read above and the turn's own lock: resume it, as below.
        if (!(error instanceof SessionNotSendable)) throw error;
      }
    }
    const resumed = await this.sessions.resume(invitation.ownerId, sessionId, dto, { externalSender, onTurnWritten });
    return { ...answerOf(resumed), revived: resumed.revived };
  }

  /** The one `session.guest.turn` activity row of a guest turn (§5 step 6), the owner's, naming the guest. */
  private async recordGuestTurn(tx: Prisma.TransactionClient, ownerId: string, sessionId: string, turnId: string, guestId: string) {
    await tx.activity.create({
      data: {
        actorId: ownerId,
        type: GUEST_TURN_ACTIVITY,
        payload: { sessionId, turnId, guestUserId: guestId },
        credentialKind: 'GUEST',
      },
    });
  }

  /** Whether the session is over (or being ended), so a message has to resume it. */
  private async hasEnded(sessionId: string): Promise<boolean> {
    const s = await this.prisma.session.findUniqueOrThrow({
      where: { id: sessionId },
      select: { status: true, cancelRequestedAt: true },
    });
    return SessionsService.TERMINAL.includes(s.status as RunStatus) || s.cancelRequestedAt !== null;
  }

  /** The guest's own queued turn, or 404: a guest withdraws and steers only what they sent. */
  private async ownTurn(guestId: string, sessionId: string, turnId: string): Promise<LiveInvitation> {
    const invitation = await this.invitation(guestId, sessionId);
    const turn = await this.prisma.conversationTurn.findFirst({
      where: { id: turnId, sessionId, externalSenderSource: 'ORBIT_GUEST', externalSenderId: guestId },
      select: { id: true },
    });
    if (!turn) throw new NotFoundException('turn not found');
    return invitation;
  }

  /** Withdraw one of the guest's own messages still waiting in the queue. */
  async cancelTurn(guestId: string, sessionId: string, turnId: string) {
    const invitation = await this.ownTurn(guestId, sessionId, turnId);
    return this.sessions.cancelQueuedTurn(invitation.ownerId, sessionId, turnId);
  }

  /** Send one of the guest's own queued messages into the turn running now. */
  async steerTurn(guestId: string, sessionId: string, turnId: string) {
    const invitation = await this.ownTurn(guestId, sessionId, turnId);
    return this.sessions.steerQueuedTurn(invitation.ownerId, sessionId, turnId);
  }

  /** The guest leaves: the session leaves their Shared with me, and their door answers 404. */
  async leave(guestId: string, sessionId: string) {
    const invitation = await this.invitation(guestId, sessionId);
    await this.prisma.sessionGuest.updateMany({
      where: { id: invitation.guestRowId, removedAt: null },
      data: { removedAt: new Date(), removedReason: 'LEFT' },
    });
    return { ok: true };
  }
}

/** What a guest is told of the turn they sent: the turn's id and placement, never the session's other ids. */
function answerOf(sent: { turnId: string; seq: number | null; kind: string; placement: unknown; targetTurnId?: string }) {
  return {
    turnId: sent.turnId,
    seq: sent.seq,
    kind: sent.kind,
    placement: sent.placement,
    ...(sent.targetTurnId ? { targetTurnId: sent.targetTurnId } : {}),
  };
}
