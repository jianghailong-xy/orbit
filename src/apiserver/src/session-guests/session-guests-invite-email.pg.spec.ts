/**
 * The session invitation email (owner decision D7 = A, migration 0618) against a real PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty: the real SessionGuestsService (invite, remove, list),
 * EmailSettingsService and EmailOutboxWorker over that database. Resend is a fake HTTP server this spec runs,
 * reached through ORBIT_RESEND_API_URL. What it is held to:
 *
 *   (1) 0618: the column, the constraints and the unique index; it runs again without changing anything; one
 *       WELCOME per account still, and one SESSION_INVITE per (account, session);
 *   (2) the channel off: an invitation writes one SKIPPED row, and nothing is sent;
 *   (3) the channel on (the welcome toggle off): an invitation queues exactly one row; inviting again, and removing
 *       and inviting again, add none; the worker sends ONE email with the subject and the link to
 *       /sessions/<base62 id>; the People list answers emailSentAt;
 *   (4) an email no account uses writes nothing;
 *   (5) removed before the send, or the session in the Trash: SKIPPED, not sent.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/session-guests/session-guests-invite-email.pg.spec.ts
 *
 * Not destructive: every row belongs to users this run creates.
 */
process.env.PROVIDER_SECRET_KEY = `session-invite-pg-${Math.random()}`;
process.env.PUBLIC_ORIGIN = 'https://orbit.example.test';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';

import { uuidToBase62 } from '@orbit/shared';
import { type PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';

import { EMAIL_SENT_ACTIVITY, EmailOutboxWorker, INVITE_NO_LONGER_LIVE } from '../email/email-outbox';
import { EmailSettingsService } from '../email/email-settings.service';
import { RESEND_API_URL_ENV } from '../email/resend.client';
import { renderSessionInviteEmail } from '../email/session-invite-email.template';
import { MANAGED_RUNNERS_OFF } from '../managed-runners/managed-runner-gate';
import type { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import type { SessionsService } from '../sessions/sessions.service';
import { GUEST_NO_ACCOUNT, SessionGuestsService } from './session-guests.service';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const RESEND_KEY = `re_${RUN}_secret_key`;
const FROM = 'Orbit <orbit@example.test>';
const migration = (name: string) => readFileSync(path.resolve(__dirname, `../../prisma/migrations/${name}/migration.sql`), 'utf8');

interface ResendRequest {
  headers: IncomingHttpHeaders;
  body: { from: string; to: string[]; subject: string; html: string; text: string };
}

test('session invitation email on PostgreSQL: 0618, one email per person and session, removed before the send', {
  skip: !URL_, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  const db: PrismaClient = prismaClientFor(url);

  const received: ResendRequest[] = [];
  const resend = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      received.push({ headers: req.headers, body: JSON.parse(raw) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: randomUUID() }));
    });
  });
  await new Promise<void>((resolve) => resend.listen(0, '127.0.0.1', resolve));
  process.env[RESEND_API_URL_ENV] = `http://127.0.0.1:${(resend.address() as AddressInfo).port}/emails`;
  t.after(async () => {
    resend.closeAllConnections();
    resend.close();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = async (query: string, values: unknown[] = []): Promise<any[]> => (await sql.query(query, values)).rows;

  const prisma = db as unknown as PrismaService;
  const settings = new EmailSettingsService(prisma);
  const worker = new EmailOutboxWorker(prisma, settings, { loop: false }, MANAGED_RUNNERS_OFF);
  // remove() announces withdrawn turns; none are queued here.
  const guests = new SessionGuestsService(prisma, { announceQueuedTurnsChanged: () => undefined } as unknown as SessionsService);

  const person = async (label: string, name: string) => {
    const id = randomUUID();
    const email = `invite-${label}-${RUN}@session-invite.invalid`;
    await db.user.create({ data: { id, email, name, passwordHash: 'x' } });
    return { id, email, name };
  };
  const owner = await person('owner', 'Alex Rivera');
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.runner.create({
    data: {
      id: runnerId, ownerId: owner.id, name: 'invite-runner', tokenHash: `invite-${runnerId}`,
      status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(), capabilities: [], capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId: owner.id, runnerId, name: `invite ${RUN}`, enabled: true } });
  const session = async (title: string) => {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, ownerId: owner.id, creatorId: owner.id, workspaceId, assignedRunnerId: runnerId, title, prompt: title,
        provider: 'claude', providerBuiltin: true, model: 'claude-opus-4-1', permissionMode: 'acceptEdits',
        dispatchOrigin: SessionDispatchOrigin.USER, status: RunStatus.AWAITING_INPUT, numTurns: 1, engineTurnActive: false,
        runtimeSessionId: randomUUID(), startedAt: new Date(),
      },
    });
    return id;
  };
  const invitesOf = (sessionId: string) => rows(
    `SELECT id, user_id, status, to_address, created_by_id, last_error, sent_at FROM email_outbox
      WHERE kind = 'SESSION_INVITE' AND session_id = $1 ORDER BY created_at`, [sessionId],
  );

  await t.test('(1) 0618: column, constraints, unique index; runs again unchanged; one WELCOME per account', async () => {
    const shape = async () => (await rows(
      `SELECT column_name, udt_name, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'email_outbox' ORDER BY ordinal_position`,
    )).map((c) => `${c.column_name} ${c.udt_name} ${c.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`);
    const constraints = async () => (await rows(
      `SELECT conname FROM pg_constraint WHERE conrelid = '"email_outbox"'::regclass ORDER BY conname`,
    )).map((c) => c.conname);
    const indexes = async () => (await rows(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'email_outbox' ORDER BY indexname`,
    )).map((i) => `${i.indexname}: ${i.indexdef.replace(/^.* USING /, '')}`);
    const before = { shape: await shape(), constraints: await constraints(), indexes: await indexes() };
    assert.ok(before.shape.includes('session_id uuid NULL'));
    for (const name of ['email_outbox_kind_chk', 'email_outbox_session_id_chk', 'email_outbox_session_id_fkey']) {
      assert.ok(before.constraints.includes(name), name);
    }
    assert.ok(before.indexes.includes('email_outbox_kind_user_session_key: btree (kind, user_id, session_id) NULLS NOT DISTINCT'), before.indexes.join('\n'));
    assert.ok(!before.indexes.some((i) => i.startsWith('email_outbox_kind_user_id_key')), '0517’s index is gone');
    await sql.query(migration('0618_email_outbox_session_invite'));
    assert.deepEqual({ shape: await shape(), constraints: await constraints(), indexes: await indexes() }, before, 'a second run changes nothing');

    const someone = await person('schema', 'Schema Person');
    const sessionId = await session('schema check');
    const insert = (kind: string, sessionOf: string | null) => sql.query(
      `INSERT INTO email_outbox (id, kind, user_id, session_id, to_address, status) VALUES (gen_random_uuid(), $1, $2, $3, 'x@example.test', 'SKIPPED')`,
      [kind, someone.id, sessionOf],
    );
    await insert('WELCOME', null);
    await assert.rejects(insert('WELCOME', null), { constraint: 'email_outbox_kind_user_session_key' }, 'one WELCOME per account');
    await assert.rejects(insert('WELCOME', sessionId), { constraint: 'email_outbox_session_id_chk' });
    await assert.rejects(insert('SESSION_INVITE', null), { constraint: 'email_outbox_session_id_chk' });
    await assert.rejects(insert('OTHER', null), { constraint: 'email_outbox_kind_chk' });
    await insert('SESSION_INVITE', sessionId);
    await assert.rejects(insert('SESSION_INVITE', sessionId), { constraint: 'email_outbox_kind_user_session_key' });
    await insert('SESSION_INVITE', await session('another session'));
    assert.equal((await rows(`SELECT count(*)::int AS n FROM email_outbox WHERE user_id = $1`, [someone.id]))[0].n, 3);
    // The row goes with its session.
    await db.session.delete({ where: { id: sessionId } });
    assert.equal((await rows(`SELECT count(*)::int AS n FROM email_outbox WHERE user_id = $1`, [someone.id]))[0].n, 2);
  });

  await t.test('(2) the channel off: one SKIPPED row, nothing sent', async () => {
    const sessionId = await session('off session');
    const guest = await person('off', 'Olive Off');
    await guests.invite(owner.id, sessionId, guest.email);
    assert.deepEqual((await invitesOf(sessionId)).map((r) => r.status), ['SKIPPED']);
    assert.equal(await worker.drain(), 0);
    assert.equal(received.length, 0);
  });

  await t.test('(3) the channel on: one row, one email with the link; again and after Remove, none', async () => {
    // The welcome toggle off: the invitation email does not follow it.
    await settings.update(owner.id, { enabled: true, apiKey: RESEND_KEY, fromAddress: FROM, replyTo: '', welcomeEnabled: false });
    const title = 'Fix the flaky login test\nand the cache';
    const sessionId = await session(title);
    const guest = await person('maya', 'Maya Chen');

    await guests.invite(owner.id, sessionId, guest.email.toUpperCase());
    let invites = await invitesOf(sessionId);
    assert.equal(invites.length, 1);
    assert.deepEqual(
      [invites[0].status, invites[0].user_id, invites[0].to_address, invites[0].created_by_id],
      ['PENDING', guest.id, guest.email, owner.id],
    );
    await guests.invite(owner.id, sessionId, guest.email);
    assert.equal((await invitesOf(sessionId)).length, 1, 'inviting again queues nothing');
    let list = await guests.list(owner.id, sessionId);
    assert.equal(list.guests[0].emailSentAt, null, 'not sent yet');

    assert.equal(await worker.drain(), 1);
    assert.equal(received.length, 1, 'exactly one request to Resend');
    const [request] = received;
    const rowId = invites[0].id;
    assert.equal(request.headers['idempotency-key'], `session-invite/${rowId}/0/0`);
    assert.deepEqual(request.body.to, [guest.email]);
    assert.equal(request.body.from, FROM);
    assert.equal(request.body.subject, 'Alex Rivera invited you to reply in “Fix the flaky login test”');
    const link = `https://orbit.example.test/sessions/${uuidToBase62(sessionId)}`;
    assert.ok(request.body.text.includes(`Open conversation: ${link}`), request.body.text);
    assert.ok(request.body.text.includes(`Sign in as ${guest.email} to open it.`));
    assert.match(request.body.html, new RegExp(`href="${link.replace(/[.]/g, '\\.')}"[^>]*>Open conversation</a>`));
    const expected = renderSessionInviteEmail({
      ownerName: 'Alex Rivera', sessionTitle: title, guestEmail: guest.email, origin: 'https://orbit.example.test',
      sessionPublicId: uuidToBase62(sessionId),
    });
    assert.equal(request.body.html, expected.html);
    assert.equal(request.body.text, expected.text);
    assert.doesNotMatch(request.body.text + request.body.html, /claude|opus|invite-runner|acceptEdits/i, 'no runner, model or mode');

    invites = await invitesOf(sessionId);
    assert.equal(invites[0].status, 'SENT');
    const activity = await rows(`SELECT payload FROM activity WHERE type = $1 AND payload->>'sessionId' = $2`, [EMAIL_SENT_ACTIVITY, sessionId]);
    assert.equal(activity.length, 1);
    assert.equal(activity[0].payload.kind, 'SESSION_INVITE');
    assert.equal(activity[0].payload.userId, guest.id);
    list = await guests.list(owner.id, sessionId);
    assert.equal(list.guests[0].emailSentAt, (invites[0].sent_at as Date).toISOString());

    assert.equal(await worker.drain(), 0, 'nothing left to send');
    await guests.remove(owner.id, sessionId, guest.id);
    await guests.invite(owner.id, sessionId, guest.email);
    assert.equal((await invitesOf(sessionId)).length, 1, 'removed and invited again: no second row');
    assert.equal(await worker.drain(), 0);
    assert.equal(received.length, 1, 'and no second email');
    list = await guests.list(owner.id, sessionId);
    assert.equal(list.guests[0].emailSentAt, (invites[0].sent_at as Date).toISOString(), 'the live invitation still reads the one email');

    // Another session of the same person is another email.
    const second = await session('');
    await guests.invite(owner.id, second, guest.email);
    assert.equal(await worker.drain(), 1);
    assert.equal(received.at(-1)!.body.subject, 'Alex Rivera invited you to reply in “Untitled session”');
    received.length = 0;
  });

  await t.test('(4) an email no account uses writes nothing', async () => {
    const sessionId = await session('unknown session');
    await assert.rejects(guests.invite(owner.id, sessionId, `nobody-${RUN}@session-invite.invalid`), { message: GUEST_NO_ACCOUNT });
    assert.deepEqual(await invitesOf(sessionId), []);
  });

  await t.test('(5) removed before the send, or the session in the Trash: SKIPPED, not sent', async () => {
    const sessionId = await session('removed session');
    const guest = await person('removed', 'Rory Removed');
    await guests.invite(owner.id, sessionId, guest.email);
    await guests.remove(owner.id, sessionId, guest.id);
    const trashed = await session('trashed session');
    const other = await person('trashed', 'Tess Trashed');
    await guests.invite(owner.id, trashed, other.email);
    await db.session.update({ where: { id: trashed }, data: { deletedAt: new Date() } });

    assert.equal(await worker.drain(), 2);
    assert.equal(received.length, 0, 'nothing sent');
    for (const id of [sessionId, trashed]) {
      const [row] = await invitesOf(id);
      assert.deepEqual([row.status, row.last_error, row.sent_at], ['SKIPPED', INVITE_NO_LONGER_LIVE, null]);
    }
    // Invited again later: the row is spent, so still nothing.
    await guests.invite(owner.id, sessionId, guest.email);
    assert.equal(await worker.drain(), 0);
    assert.equal(received.length, 0);
    assert.equal((await guests.list(owner.id, sessionId)).guests[0].emailSentAt, null);
  });
});
