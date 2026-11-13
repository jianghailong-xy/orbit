import {
  BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, Logger, NotFoundException,
} from '@nestjs/common';
import { Prisma, RunStatus } from '@prisma/client';
import type { GuestSessionSummary, SessionGuestPerson } from '@orbit/shared';
import { loggedRetry, withTransactionRetry } from '../common/transaction-retry';
import { PrismaService } from '../prisma/prisma.service';
import { SessionNotSendable, SessionsService } from '../sessions/sessions.service';
import type { ExternalTurnSender } from '../sessions/session-message';
import { assertEngineSession } from '../sessions/engine-session';
import { withSessionState } from '../sessions/session-state';
import { readSessionActivities } from '../sessions/task-work-carrier';
import { parseMaxPayload } from '../sessions/truncate-payload';
import { visibleQuestions } from '../sessions/run-question';

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

/** How many messages a guest may send to one session in a UTC day (§6 rule 5): a constant, not a setting. */
export const GUEST_DAILY_TURNS = 50;
/** What the message past the day's last answers, 429. */
export const GUEST_DAILY_CAP_REACHED =
  `You’ve sent ${GUEST_DAILY_TURNS} messages to this session today, the most a guest can. Try again after midnight UTC.`;

/**
 * The fields a guest's turn may carry: the key, the words, and the routing an owner's composer leaves to the server.
 * Anything else — `kind` (a shell turn), `attachmentIds`, and every override a resume would apply (model,
 * permissionMode, effort, provider, fastMode, engine, account, ...) — is refused by name, 400, before anything is
 * written. A whitelist, so a field SessionTurnDto or SessionResumeDto gains later is refused here too.
 */
const GUEST_TURN_FIELDS: ReadonlySet<string> = new Set(['clientTurnId', 'content', 'intent']);
/** The only `intent` a guest may name: a message queued for the next turn, which is also what omitting it may route to. */
const GUEST_TURN_INTENTS: ReadonlySet<unknown> = new Set([undefined, 'NEXT_TURN']);
export const guestFieldRefused = (field: string) => `A guest can't set ${field} on a message.`;

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

/** The body of `POST /guest-sessions/:id/turns`: `clientTurnId`, `content` and `intent`; anything else is refused by name. */
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
  private readonly logger = new Logger(SessionGuestsService.name);

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

  /**
   * Take a guest out: their door answers 404 from now on, and every message of theirs still queued, undelivered, is
   * withdrawn with it (§6 rule 6), in the one transaction.
   */
  async remove(ownerId: string, sessionId: string, userId: string) {
    await this.ownedSession(ownerId, sessionId, { live: false, write: true });
    const ended = await this.endInvitation(sessionId, userId, 'REMOVED');
    if (!ended) throw new NotFoundException('guest not found');
    return this.list(ownerId, sessionId);
  }

  /**
   * Stamp the guest's live invitation removed (REMOVED by the owner, or LEFT), and withdraw in the same transaction
   * the guest's turns still queued and undelivered on the session, matched on `external_sender_id`: PENDING messages
   * and PENDING steers no runner holds yet. Taken under the session lock createTurn and the runner's claim take, so a
   * turn is either withdrawn here or already on its way, never both. False when there was no live invitation.
   */
  private async endInvitation(sessionId: string, guestId: string, reason: 'REMOVED' | 'LEFT'): Promise<boolean> {
    const withdrawn = await withTransactionRetry(this.prisma, async (tx) => {
      await tx.$queryRaw`SELECT id FROM "session" WHERE id = ${sessionId}::uuid FOR UPDATE`;
      const { count } = await tx.sessionGuest.updateMany({
        where: { sessionId, userId: guestId, removedAt: null },
        data: { removedAt: new Date(), removedReason: reason },
      });
      if (count === 0) return null;
      const session = await tx.session.findUniqueOrThrow({ where: { id: sessionId }, select: { status: true } });
      const queued = await tx.conversationTurn.findMany({
        where: {
          sessionId,
          externalSenderSource: 'ORBIT_GUEST',
          externalSenderId: guestId,
          kind: { in: ['message', 'steer'] },
          status: 'PENDING',
        },
        orderBy: { seq: 'asc' },
        select: { id: true, kind: true },
      });
      let take = queued;
      // A RUNNING session whose runner has claimed it but not yet leased a turn holds a runner permit only a
      // /turn-complete releases (cancelQueuedTurn's own rule): its next message has crossed the "started" line,
      // so when the guest's is the only one left, that one stays and the rest go.
      if (session.status === RunStatus.RUNNING) {
        const others = await tx.conversationTurn.count({
          where: {
            sessionId,
            kind: { in: ['message', 'shell'] },
            status: { in: ['PENDING', 'IN_FLIGHT'] },
            id: { notIn: queued.map((t) => t.id) },
          },
        });
        const firstMessage = queued.find((t) => t.kind === 'message');
        if (others === 0 && firstMessage) take = queued.filter((t) => t.id !== firstMessage.id);
      }
      if (take.length > 0) {
        await tx.conversationTurn.deleteMany({ where: { id: { in: take.map((t) => t.id) }, sessionId, status: 'PENDING' } });
      }
      // The last queued message gone from a session that was only waiting for it: back to waiting for the next.
      if (session.status === RunStatus.PENDING) {
        const executable = await tx.conversationTurn.count({
          where: { sessionId, kind: { in: ['message', 'shell'] }, status: { in: ['PENDING', 'IN_FLIGHT'] } },
        });
        if (executable === 0) {
          await tx.session.update({ where: { id: sessionId }, data: { status: RunStatus.AWAITING_INPUT, lastTurnAt: new Date() } });
        }
      }
      return take.length;
    }, loggedRetry(this.logger, 'sessionGuests.endInvitation'));
    if (withdrawn === null) return false;
    if (withdrawn > 0) this.sessions.announceQueuedTurnsChanged(sessionId);
    return true;
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
    const activities = await readSessionActivities(this.prisma, rows.map(({ session }) => session.id));
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
          activity: activities.get(session.id) ?? null,
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
    return { ...transcript, ownerName: owner.name, waitingOnOwner: await this.waitingOnOwner(sessionId) };
  }

  /** A page of the transcript, as `/shared/:token/events` pages it: after `after`, or before `before`, or the tail. */
  async events(guestId: string, sessionId: string, query: { before?: string; after?: string; limit?: string; maxPayload?: string }) {
    await this.invitation(guestId, sessionId);
    const opts = { limit: num(query.limit), maxPayload: parseMaxPayload(query.maxPayload) };
    const after = num(query.after);
    if (after === undefined) return this.sessions.getSharedEventPage(sessionId, { ...opts, before: num(query.before) });
    const page = await this.sessions.getSharedEventsAfter(sessionId, { ...opts, after });
    return { ...page, waitingOnOwner: await this.waitingOnOwner(sessionId) };
  }

  /**
   * Whether the agent is waiting on the owner — a permission card or a question still pending — which the guest page
   * says as `Waiting for <owner> to approve` (§4). Only that it waits: what the card asks is the owner's alone.
   */
  private async waitingOnOwner(sessionId: string): Promise<boolean> {
    const cards = await this.prisma.approval.findMany({
      where: { sessionId, status: 'PENDING' },
      select: { id: true, toolName: true },
    });
    return cards.length > 0 && (await visibleQuestions(this.prisma, cards)).length > 0;
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
    const fields = body !== null && typeof body === 'object' ? body : {};
    for (const field of Object.keys(fields)) {
      if (!GUEST_TURN_FIELDS.has(field)) throw new BadRequestException(guestFieldRefused(field));
    }
    if (!GUEST_TURN_INTENTS.has(fields.intent)) throw new BadRequestException(guestFieldRefused('intent'));
    const { clientTurnId, content } = fields;
    const intent = fields.intent as 'NEXT_TURN' | undefined;
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
    const dto = { clientTurnId, content, ...(intent ? { intent } : {}) };
    // Written with the turn, so a replay of this clientTurnId neither counts nor records anything again.
    const onTurnWritten = async (tx: Prisma.TransactionClient, turn: { id: string }) => {
      await this.countGuestTurn(tx, invitation.guestRowId);
      await this.recordGuestTurn(tx, invitation.ownerId, sessionId, turn.id, guestId);
    };
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

  /**
   * Count one message against the guest's day (§6 rule 5), in the transaction that writes the turn: one conditional
   * UPDATE of the guest's live session_guest row, which moves to today and adds one only while today's count is under
   * the cap. Two requests at 49 meet on that row — the second waits for the first to commit, then re-reads it at 50
   * and matches nothing — so only one of them passes. Matching nothing refuses the message, and the turn written just
   * before rolls back with it: 404 if the invitation ended meanwhile, else 429.
   */
  private async countGuestTurn(tx: Prisma.TransactionClient, guestRowId: string) {
    const counted = await tx.$executeRaw`
      UPDATE "session_guest"
      SET "turns_on_day" = CASE WHEN "turn_day" = (now() AT TIME ZONE 'UTC')::date THEN "turns_on_day" + 1 ELSE 1 END,
          "turn_day" = (now() AT TIME ZONE 'UTC')::date
      WHERE "id" = ${guestRowId}::uuid
        AND "removed_at" IS NULL
        AND ("turn_day" IS DISTINCT FROM (now() AT TIME ZONE 'UTC')::date OR "turns_on_day" < ${GUEST_DAILY_TURNS})`;
    if (counted === 1) return;
    const live = await tx.sessionGuest.count({ where: { id: guestRowId, removedAt: null } });
    if (live === 0) throw notShared();
    throw new HttpException(GUEST_DAILY_CAP_REACHED, HttpStatus.TOO_MANY_REQUESTS);
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
    await this.invitation(guestId, sessionId);
    // Their messages still queued go with them, as a removal's do (§6 rule 6).
    if (!(await this.endInvitation(sessionId, guestId, 'LEFT'))) throw notShared();
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
