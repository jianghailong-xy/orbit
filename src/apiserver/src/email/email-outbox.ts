import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { MANAGED_RUNNER_GATE, MANAGED_RUNNERS_OFF, type ManagedRunnerGate } from '../managed-runners/managed-runner-gate';
import { PrismaService } from '../prisma/prisma.service';
import { uuidToBase62 } from '@orbit/shared';
import { EmailSettingsService, inviteQueued, publicOrigin, readEmailSettings, welcomeQueued, type EmailChannel } from './email-settings.service';
import { sendViaResend } from './resend.client';
import { ownerNameOf, renderSessionInviteEmail } from './session-invite-email.template';
import { firstNameOf, renderWelcomeEmail, type RenderedEmail, type WelcomeSignIn } from './welcome-email.template';

/**
 * The email outbox (docs/welcome-email-design.md §3.3, migration 0517).
 *
 * A WELCOME row is written in the same transaction that creates the account (`enqueueWelcome`), so an
 * account and its row exist together or not at all, and `UNIQUE (kind, user_id)` keeps it to one. The
 * worker below claims due PENDING rows one at a time with `FOR UPDATE SKIP LOCKED` and holds that row
 * lock while it renders and sends: a second worker, on this replica or another, skips the row, so no
 * two send it. A worker that dies mid-send rolls its transaction back, the row stays PENDING with the
 * same Idempotency-Key, and Resend answers the next try with the first result instead of a second email.
 *
 * A SESSION_INVITE row (migration 0618, owner decision D7 = A) is written with a session guest's new invitation
 * (`enqueueSessionInvite`); `UNIQUE NULLS NOT DISTINCT (kind, user_id, session_id)` keeps it to one per person and
 * session, so inviting again, after a Remove too, sends nothing more.
 */

export const WELCOME = 'WELCOME';
export const SESSION_INVITE = 'SESSION_INVITE';
/** What a SESSION_INVITE row SKIPPED at send time says: the invitation ended, or the session went to the Trash, first. */
export const INVITE_NO_LONGER_LIVE = 'The invitation ended before the email was sent.';
export const EMAIL_SENT_ACTIVITY = 'EMAIL_SENT';
export const EMAIL_FAILED_ACTIVITY = 'EMAIL_FAILED';
/** After the 1st, 2nd and 3rd failure; the 4th is FAILED (decision D4). */
export const RETRY_DELAYS_MS = [60_000, 10 * 60_000, 60 * 60_000] as const;
export const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;
export const EMAIL_OUTBOX_POLL_MS = 15_000;
/** Longest a claim may hold its row: the send's 10-second timeout and the writes around it. */
const CLAIM_TX_TIMEOUT_MS = 60_000;

/** The Idempotency-Key of one attempt (resend.client.ts says why `keyAttempt` is in it). */
export function idempotencyKey(row: { id: string; kind: string; userId: string; generation: number; keyAttempt: number }): string {
  if (row.kind === SESSION_INVITE) return `session-invite/${row.id}/${row.generation}/${row.keyAttempt}`;
  return `welcome/${row.userId}/${row.generation}/${row.keyAttempt}`;
}

/**
 * Writes the new account's welcome row inside the transaction that creates the account: PENDING when
 * the channel and the welcome toggle are on, SKIPPED otherwise (never sent later on its own).
 * `createdById` is the administrator who created it, null for a Google sign-up.
 */
export async function enqueueWelcome(
  tx: Prisma.TransactionClient,
  account: { id: string; email: string },
  createdById: string | null,
): Promise<void> {
  const settings = await readEmailSettings(tx);
  await tx.emailOutbox.create({
    data: {
      kind: WELCOME,
      userId: account.id,
      toAddress: account.email,
      createdById,
      status: welcomeQueued(settings) ? 'PENDING' : 'SKIPPED',
    },
  });
}

/**
 * Writes a session invitation's row inside the transaction that writes the guest's new live invitation: PENDING
 * when the channel is on (the welcome toggle aside), SKIPPED otherwise. ON CONFLICT DO NOTHING: a person already
 * sent (or skipped) an invitation to this session gets no second row. `ownerId` is the owner who invited them.
 */
export async function enqueueSessionInvite(
  tx: Prisma.TransactionClient,
  invite: { guestId: string; toAddress: string; sessionId: string; ownerId: string },
): Promise<void> {
  const status = inviteQueued(await readEmailSettings(tx)) ? 'PENDING' : 'SKIPPED';
  await tx.$executeRaw`
    INSERT INTO "email_outbox" ("id", "kind", "user_id", "session_id", "to_address", "created_by_id", "status")
    VALUES (gen_random_uuid(), ${SESSION_INVITE}, ${invite.guestId}::uuid, ${invite.sessionId}::uuid, ${invite.toAddress},
            ${invite.ownerId}::uuid, ${status})
    ON CONFLICT DO NOTHING`;
}

/** The row a claim locks. */
interface ClaimedRow {
  id: string;
  kind: string;
  userId: string;
  sessionId: string | null;
  toAddress: string;
  createdById: string | null;
  attempts: number;
  generation: number;
  keyAttempt: number;
}

export interface EmailOutboxOptions {
  pollMs?: number;
  /** False: no loop; a spec calls `drain` itself. */
  loop?: boolean;
}
export const EMAIL_OUTBOX_OPTIONS = Symbol('EMAIL_OUTBOX_OPTIONS');

/** One loop per replica, sending what the outbox holds. */
@Injectable()
export class EmailOutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('EmailOutbox');
  private readonly options: EmailOutboxOptions;
  private readonly managedRunners: ManagedRunnerGate;
  private running = false;
  private timer?: ReturnType<typeof setTimeout>;
  private pass?: Promise<unknown>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: EmailSettingsService,
    @Optional() @Inject(EMAIL_OUTBOX_OPTIONS) options?: EmailOutboxOptions,
    @Optional() @Inject(MANAGED_RUNNER_GATE) managedRunners?: ManagedRunnerGate,
  ) {
    this.options = options ?? {};
    this.managedRunners = managedRunners ?? MANAGED_RUNNERS_OFF;
  }

  onModuleInit(): void {
    if (this.options.loop === false) return;
    this.running = true;
    this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.pass;
  }

  private tick(): void {
    if (!this.running || this.pass) return;
    this.pass = this.drain()
      .catch((error) => this.log.error(`email outbox pass failed: ${(error as Error)?.message ?? String(error)}`))
      .finally(() => {
        this.pass = undefined;
        if (!this.running) return;
        this.timer = setTimeout(() => this.tick(), this.options.pollMs ?? EMAIL_OUTBOX_POLL_MS);
        this.timer.unref();
      });
  }

  /**
   * One pass: while the channel is on, send every due row, one claim at a time. While it is off — not
   * switched on, incomplete, or its key unreadable — rows wait as they are, spending no attempt. The
   * settings are read once per pass, so a save takes effect on the next one. Answers how many rows it
   * settled (sent, retried or failed).
   */
  async drain(now: () => Date = () => new Date()): Promise<number> {
    let channel: EmailChannel | null;
    try {
      channel = await this.settings.channel();
    } catch (error) {
      this.log.warn(`email channel unreadable: ${(error as Error).message}`);
      return 0;
    }
    if (!channel) return 0;
    let settled = 0;
    while (await this.sendOne(channel, now())) settled += 1;
    return settled;
  }

  /** Claims one due row, sends it, records what came of it. False when nothing was due. */
  async sendOne(channel: EmailChannel, now: Date): Promise<boolean> {
    return this.prisma.$transaction(
      async (tx) => {
        const [row] = await tx.$queryRaw<ClaimedRow[]>`
          SELECT "id", "kind", "user_id" AS "userId", "session_id" AS "sessionId", "to_address" AS "toAddress", "created_by_id" AS "createdById",
                 "attempts", "generation", "key_attempt" AS "keyAttempt"
          FROM "email_outbox"
          WHERE "status" = 'PENDING' AND "next_attempt_at" <= ${now}
          ORDER BY "next_attempt_at"
          LIMIT 1
          FOR UPDATE SKIP LOCKED`;
        if (!row) return false;

        const mail = row.kind === SESSION_INVITE ? await this.renderInvite(tx, row) : await this.renderWelcome(tx, row);
        if (!mail) {
          // The invitation ended (Remove, Leave) or the session went to the Trash before the email went out.
          await tx.emailOutbox.update({
            where: { id: row.id },
            data: { status: 'SKIPPED', lastError: INVITE_NO_LONGER_LIVE, lastAttemptAt: now },
          });
          return true;
        }

        const result = await sendViaResend(
          channel.apiKey,
          { from: channel.from, to: row.toAddress, replyTo: channel.replyTo, ...mail },
          { idempotencyKey: idempotencyKey(row) },
        );

        if (result.outcome === 'SENT') {
          await tx.emailOutbox.update({
            where: { id: row.id },
            data: { status: 'SENT', sentAt: now, lastAttemptAt: now, lastError: null, providerMessageId: result.id || null },
          });
          await tx.activity.create({
            data: { actorId: null, type: EMAIL_SENT_ACTIVITY, payload: { kind: row.kind, userId: row.userId, ...sessionOf(row), to: row.toAddress, providerMessageId: result.id } },
          });
          return true;
        }

        const attempts = row.attempts + 1;
        const final = result.outcome === 'FAILED' || attempts >= MAX_ATTEMPTS;
        if (result.outcome === 'RETRY' && (result.status === 401 || result.status === 403)) {
          const what = row.kind === SESSION_INVITE ? 'session invitation email' : 'welcome email';
          this.log.error(`Resend refused the ${what} to user ${row.userId}: ${result.error} — check the API key and the From domain on Admin → Email`);
        }
        await tx.emailOutbox.update({
          where: { id: row.id },
          data: {
            attempts,
            status: final ? 'FAILED' : 'PENDING',
            lastError: result.error,
            lastAttemptAt: now,
            nextAttemptAt: final ? now : new Date(now.getTime() + RETRY_DELAYS_MS[attempts - 1]),
            // An answered failure sent nothing, so the next try may use a new key; an unanswered one keeps it.
            keyAttempt: result.outcome === 'RETRY' && !result.answered ? row.keyAttempt : row.keyAttempt + 1,
          },
        });
        if (final) {
          await tx.activity.create({
            data: { actorId: null, type: EMAIL_FAILED_ACTIVITY, payload: { kind: row.kind, userId: row.userId, ...sessionOf(row), to: row.toAddress, attempts, error: result.error } },
          });
        }
        return true;
      },
      { timeout: CLAIM_TX_TIMEOUT_MS, maxWait: 10_000 },
    );
  }

  /** The welcome email of the row's account, as it reads now. */
  private async renderWelcome(tx: Prisma.TransactionClient, row: ClaimedRow): Promise<RenderedEmail> {
    const user = await tx.user.findUnique({ where: { id: row.userId }, select: { name: true, passwordHash: true } });
    const admin = row.createdById
      ? await tx.user.findUnique({ where: { id: row.createdById }, select: { name: true, email: true } })
      : null;
    const adminName = admin ? admin.name?.trim() || admin.email : 'An administrator';
    const signIn: WelcomeSignIn = !row.createdById
      ? { kind: 'GOOGLE_SIGNUP' }
      : user?.passwordHash
        ? { kind: 'ADMIN_PASSWORD', admin: adminName }
        : { kind: 'ADMIN_PASSWORDLESS', admin: adminName };
    return renderWelcomeEmail({
      firstName: firstNameOf(user?.name, row.toAddress),
      email: row.toAddress,
      origin: publicOrigin(),
      signIn,
      managedRunner: this.managedRunners.enabled,
    });
  }

  /**
   * The invitation email, with the session's title and its owner's name as they read now; null when the person's
   * invitation is no longer live or the session is in the Trash, so nothing is sent.
   */
  private async renderInvite(tx: Prisma.TransactionClient, row: ClaimedRow): Promise<RenderedEmail | null> {
    const invitation = await tx.sessionGuest.findFirst({
      where: { sessionId: row.sessionId!, userId: row.userId, removedAt: null, session: { deletedAt: null } },
      select: { session: { select: { title: true, owner: { select: { name: true, email: true } } } } },
    });
    if (!invitation) return null;
    return renderSessionInviteEmail({
      ownerName: ownerNameOf(invitation.session.owner),
      sessionTitle: invitation.session.title,
      guestEmail: row.toAddress,
      origin: publicOrigin(),
      sessionPublicId: uuidToBase62(row.sessionId!),
    });
  }
}

/** The session an activity row names, for a SESSION_INVITE row. */
function sessionOf(row: ClaimedRow): { sessionId?: string } {
  return row.sessionId ? { sessionId: row.sessionId } : {};
}

/**
 * An administrator's Send welcome email (§3.5): a FAILED or SKIPPED row back to PENDING, due now, with
 * its attempts cleared and a new generation, so it is sent under a new Idempotency-Key. A SENT or PENDING
 * row, and an account with no row (it existed before the outbox), are answered unchanged.
 */
export async function resendWelcome(prisma: PrismaService, userId: string): Promise<{ status: string } | null> {
  const { count } = await prisma.emailOutbox.updateMany({
    where: { kind: WELCOME, userId, status: { in: ['FAILED', 'SKIPPED'] } },
    data: {
      status: 'PENDING',
      attempts: 0,
      generation: { increment: 1 },
      keyAttempt: 0,
      nextAttemptAt: new Date(),
      lastError: null,
    },
  });
  const row = await prisma.emailOutbox.findFirst({ where: { kind: WELCOME, userId }, select: { status: true } });
  if (!row) return null;
  return { status: count === 1 ? 'PENDING' : row.status };
}
