/**
 * OWNER REQUEST SECRETS: THE OWNER'S KEY REACHES ONE RUNNER, AND LEAVES WHEN ITS SCOPE ENDS.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/owner-requests/owner-secrets.pg.spec.ts
 *
 * Design docs/design/owner-request-secrets.md. The runner side is runner-go's; this holds the server to its half.
 *
 * THE CASES
 * =========
 *   (a) filing: the runner is the session's own; a runner without owner-secret/v1, or a server without
 *       PROVIDER_SECRET_KEY, is refused; a non-orchestration session can file one;
 *   (b) one runner: the heartbeat lists the grant to its runner alone; the fetch hands the value to that runner and is
 *       the same 404 to the owner's second runner and to another account's runner (§8 #2, #3);
 *   (c) DONE only on ack: the request stays PENDING until the runner acknowledges; then one resolution delivery; a
 *       repeated ack writes nothing; a failed delivery puts the card back at input;
 *   (d) removal, one per §6.1 trigger: TASK_ENDED, SESSION_ENDED, EXPIRED (grant), EXPIRED (request before delivery),
 *       WITHDRAWN (pending, and released after DONE), REVOKED, MOVED, RUNNER_DELETED — each clears the ciphertext,
 *       a delivered one waits in REMOVING for the runner's `removed`, which the reconcile lists;
 *   (e) the value at rest: only value_enc holds it, encrypted; a ciphertext copied to another runner's row does not
 *       decrypt (associated data, §8 #11), and an unreadable one ends KEY_UNREADABLE;
 *   (f) submit rules: 8 B..16 KiB, no NUL; a resubmit before delivery replaces the grant (new id, old ack 404);
 *       after delivery 409;
 *   (g) saved secrets: write-only list; saveAs then Use saved; deleting one leaves grants alone;
 *   (h) tenant isolation of the owner doors: another account's request, grant or saved secret is the 404 of one that
 *       does not exist, and writes nothing;
 *   (i) the write door: a body carrying the value, raw or encoded, is refused SECRET_IN_TEXT; the runner protocol's
 *       own routes and a runner holding nothing pass.
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to its own accounts.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { BadRequestException, ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';
import { lastValueFrom, of } from 'rxjs';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { OwnerRequestsService } from './owner-requests.service';
import { OwnerSecretsService } from './owner-secrets.service';
import { SECRET_IN_TEXT, SecretWriteDoorInterceptor } from './secret-write-door.interceptor';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
process.env.PROVIDER_SECRET_KEY ??= 'owner-secrets-pg-spec-key';

/** A canary no ordinary text contains. */
const canary = (): string => `sk-canary-${randomUUID()}-orbit`;

test('owner request secrets: one runner, removed when the scope ends', { skip, concurrency: 1, timeout: 300_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(url);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const prisma = db as unknown as PrismaService;
  const secrets = new OwnerSecretsService(prisma);
  const requests = new OwnerRequestsService(prisma, secrets);

  /** An account with a runner that can hold secrets, a second one, and a task. */
  const account = async (label: string) => {
    const ownerId = randomUUID();
    await db.user.create({ data: { id: ownerId, email: `owner-secrets-${ownerId}@owner-secrets.invalid`, name: label, passwordHash: 'x' } });
    const runner = async (name: string, capabilities = ['owner-secret/v1']) => (await db.runner.create({
      data: {
        id: randomUUID(), ownerId, name: `${label}-${name}`, tokenHash: `hash-${randomUUID()}`, status: RunnerStatus.ONLINE,
        capabilities, capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
      },
    })).id;
    const runnerId = await runner('main');
    const secondRunnerId = await runner('second');
    const plainRunnerId = await runner('plain', []);
    const workspaceId = randomUUID();
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `owner-secrets-${label}`, enabled: true } });
    const task = async (): Promise<string> => {
      const id = randomUUID();
      await db.task.create({
        data: {
          id, ownerId, title: `work (${label})`, creatorType: 'USER', creatorId: ownerId, assigneeId: workspaceId,
          status: 'IN_PROGRESS', completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
        },
      });
      return id;
    };
    const session = async (opts: { taskId?: string; on?: string } = {}): Promise<string> => {
      const id = randomUUID();
      await db.session.create({
        data: {
          id, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: opts.on ?? runnerId, title: 'asks', prompt: 'asks',
          provider: 'claude', status: RunStatus.RUNNING, dispatchOrigin: SessionDispatchOrigin.USER, startedAt: new Date(),
          taskId: opts.taskId ?? null,
        },
      });
      return id;
    };
    return { ownerId, runnerId, secondRunnerId, plainRunnerId, task, session };
  };

  const a = await account('a');
  const b = await account('b');
  const runnerA = { id: a.runnerId, ownerId: a.ownerId };

  const fileSecret = async (sessionId: string, spec: Record<string, string> = { envVar: 'DEEPSEEK_API_KEY' }, expiresAt?: string) =>
    requests.file(a.ownerId, sessionId, {
      kind: 'SECRET', title: 'DeepSeek key', why: 'the experiment calls the API',
      secretSpec: { name: 'DeepSeek API key', ...spec } as never, ...(expiresAt ? { expiresAt } : {}),
    });
  const grantOf = (requestId: string) => db.ownerRequestSecret.findUniqueOrThrow({ where: { requestId } });
  /** Submit, fetch and ack: a delivered key. */
  const deliver = async (sessionId: string, value = canary()) => {
    const request = await fileSecret(sessionId);
    await secrets.submit(a.ownerId, request.id, { value });
    const grant = await grantOf(request.id);
    const fetched = await secrets.fetch(runnerA, grant.id);
    assert.equal(fetched.value, value);
    await secrets.ack(runnerA, grant.id, 'DELIVERED', undefined, undefined);
    return { request, grantId: grant.id, value };
  };

  await t.test('(a) filing takes the session\'s runner; refuses a runner or a server that cannot keep it', async () => {
    const plain = await a.session();
    const filed = await fileSecret(plain);
    assert.deepEqual(filed.secretSpec, { name: 'DeepSeek API key', runnerId: a.runnerId, envVar: 'DEEPSEEK_API_KEY' });
    await assert.rejects(fileSecret(await a.session({ on: a.plainRunnerId })), ConflictException);
    await assert.rejects(fileSecret(plain, { envVar: 'K_ONE', runnerId: a.secondRunnerId }), BadRequestException);
    const key = process.env.PROVIDER_SECRET_KEY;
    delete process.env.PROVIDER_SECRET_KEY;
    try {
      await assert.rejects(fileSecret(plain), (e: unknown) => e instanceof ConflictException
        && (e.getResponse() as { code?: string }).code === 'SECRET_STORE_UNAVAILABLE');
    } finally {
      process.env.PROVIDER_SECRET_KEY = key;
    }
  });

  await t.test('(b) the heartbeat and the fetch reach the named runner and no other', async () => {
    const request = await fileSecret(await a.session());
    const value = canary();
    await secrets.submit(a.ownerId, request.id, { value });
    const grant = await grantOf(request.id);
    assert.ok((await secrets.reconcileFor(a.runnerId)).secretGrants.some((g) => g.id === grant.id));
    assert.equal((await secrets.reconcileFor(a.secondRunnerId)).secretGrants.some((g) => g.id === grant.id), false);
    assert.equal((await secrets.reconcileFor(b.runnerId)).secretGrants.some((g) => g.id === grant.id), false);
    await assert.rejects(secrets.fetch({ id: a.secondRunnerId, ownerId: a.ownerId }, grant.id), NotFoundException);
    await assert.rejects(secrets.fetch({ id: b.runnerId, ownerId: b.ownerId }, grant.id), NotFoundException);
    await assert.rejects(secrets.fetch({ id: a.runnerId, ownerId: b.ownerId }, grant.id), NotFoundException);
    await assert.rejects(secrets.ack({ id: a.secondRunnerId, ownerId: a.ownerId }, grant.id, 'DELIVERED', undefined, undefined), NotFoundException);
    const fetched = await secrets.fetch(runnerA, grant.id);
    assert.equal(fetched.value, value);
    assert.equal(fetched.exposure, 'ENV');
    assert.equal(fetched.name, 'DEEPSEEK_API_KEY');
  });

  await t.test('(c) the request is DONE only when the runner acknowledges, and a failure puts the card back', async () => {
    const request = await fileSecret(await a.session());
    await secrets.submit(a.ownerId, request.id, { value: canary() });
    assert.equal((await requests.get(a.ownerId, request.id)).state, 'PENDING');
    assert.equal((await requests.get(a.ownerId, request.id)).secretGrant?.state, 'PENDING_DELIVERY');
    const grant = await grantOf(request.id);
    await secrets.ack(runnerA, grant.id, 'DELIVERED', undefined, undefined);
    await secrets.ack(runnerA, grant.id, 'DELIVERED', undefined, undefined);
    const done = await requests.get(a.ownerId, request.id);
    assert.equal(done.state, 'DONE');
    assert.equal(done.secretGrant?.state, 'ACTIVE');
    const { rows } = await sql.query(`SELECT 1 FROM "watch_delivery" WHERE "owner_request_id" = $1`, [request.id]);
    assert.equal(rows.length, 1, 'one resolution delivery, however often the runner acknowledges');

    const failing = await fileSecret(await a.session(), { filePath: '~/.config/deepseek/key' });
    await secrets.submit(a.ownerId, failing.id, { value: canary() });
    const failed = await grantOf(failing.id);
    assert.equal(failed.exposure, 'FILE');
    await secrets.ack(runnerA, failed.id, 'FAILED', 'PATH_EXISTS', 'the file already exists');
    const back = await requests.get(a.ownerId, failing.id);
    assert.equal(back.state, 'PENDING');
    assert.equal(back.secretGrant?.endReason, 'DELIVERY_FAILED');
    assert.equal(back.secretGrant?.removalNote, 'PATH_EXISTS: the file already exists');
    assert.equal((await grantOf(failing.id)).valueEnc, null);
    await secrets.submit(a.ownerId, failing.id, { value: canary() });
    assert.equal((await grantOf(failing.id)).state, 'PENDING_DELIVERY', 'the owner can enter it again');
  });

  /** A delivered key, ended by `trigger`, swept, and confirmed removed by its runner. */
  const removal = async (reason: string, setup: () => Promise<{ sessionId: string }>, trigger: (ctx: { sessionId: string; requestId: string; grantId: string }) => Promise<void>) => {
    const { sessionId } = await setup();
    const { request, grantId } = await deliver(sessionId);
    await trigger({ sessionId, requestId: request.id, grantId });
    await secrets.sweep();
    const grant = await db.ownerRequestSecret.findUniqueOrThrow({ where: { id: grantId } });
    assert.equal(grant.endReason, reason, `${reason}: the end reason`);
    assert.equal(grant.valueEnc, null, `${reason}: the ciphertext is gone at once`);
    if (reason === 'RUNNER_DELETED') {
      assert.equal(grant.state, 'REMOVED');
      assert.match(grant.removalNote ?? '', /unconfirmed/);
      return;
    }
    assert.equal(grant.state, 'REMOVING', `${reason}: waits for the runner`);
    const reconcile = await secrets.reconcileFor(a.runnerId);
    assert.equal(reconcile.secretGrants.some((g) => g.id === grantId), false, `${reason}: no longer listed as held`);
    assert.ok(reconcile.secretGrantsRemoving.includes(grantId), `${reason}: listed for removal`);
    await assert.rejects(secrets.fetch(runnerA, grantId), NotFoundException);
    await secrets.removed(runnerA, grantId, undefined);
    await secrets.removed(runnerA, grantId, undefined);
    assert.equal((await db.ownerRequestSecret.findUniqueOrThrow({ where: { id: grantId } })).state, 'REMOVED');
  };

  await t.test('(d) each trigger of §6.1 removes the key', async () => {
    await removal('TASK_ENDED', async () => {
      const taskId = await a.task();
      return { sessionId: await a.session({ taskId }) };
    }, async ({ sessionId }) => {
      const { taskId } = await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { taskId: true } });
      await db.task.update({ where: { id: taskId! }, data: { status: 'DONE' } });
    });
    await removal('SESSION_ENDED', async () => ({ sessionId: await a.session() }), async ({ sessionId }) => {
      await db.session.update({ where: { id: sessionId }, data: { completedAt: new Date() } });
    });
    await removal('EXPIRED', async () => ({ sessionId: await a.session() }), async ({ grantId }) => {
      await db.ownerRequestSecret.update({ where: { id: grantId }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    });
    await removal('WITHDRAWN', async () => ({ sessionId: await a.session() }), async ({ sessionId, requestId }) => {
      const released = await requests.withdraw(a.ownerId, sessionId, requestId, 'done with it');
      assert.equal(released.state, 'DONE', 'releasing a delivered key leaves the request DONE');
    });
    await removal('REVOKED', async () => ({ sessionId: await a.session() }), async ({ requestId }) => {
      await secrets.revoke(a.ownerId, requestId);
    });
    await removal('MOVED', async () => ({ sessionId: await a.session() }), async ({ sessionId }) => {
      await db.session.update({ where: { id: sessionId }, data: { assignedRunnerId: a.secondRunnerId } });
    });
    // A runner deleted with a delivered grant: its own runner, so the others' grants stay.
    const doomed = await db.runner.create({
      data: {
        id: randomUUID(), ownerId: a.ownerId, name: 'doomed', tokenHash: `hash-${randomUUID()}`, status: RunnerStatus.ONLINE,
        capabilities: ['owner-secret/v1'], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
      },
    });
    const doomedSession = await a.session({ on: doomed.id });
    const doomedRequest = await fileSecret(doomedSession);
    await secrets.submit(a.ownerId, doomedRequest.id, { value: canary() });
    const doomedGrant = await grantOf(doomedRequest.id);
    await secrets.ack({ id: doomed.id, ownerId: a.ownerId }, doomedGrant.id, 'DELIVERED', undefined, undefined);
    await sql.query(`UPDATE "session" SET "assigned_runner_id" = NULL WHERE "id" = $1`, [doomedSession]);
    await sql.query(`DELETE FROM "runner" WHERE "id" = $1`, [doomed.id]);
    await secrets.sweep();
    const orphan = await db.ownerRequestSecret.findUniqueOrThrow({ where: { id: doomedGrant.id } });
    assert.deepEqual([orphan.state, orphan.endReason, orphan.valueEnc], ['REMOVED', 'RUNNER_DELETED', null]);
    assert.match(orphan.removalNote ?? '', /unconfirmed/);

    // Before delivery: the request's own endings take the key with them at once.
    for (const [ending, reason] of [['WITHDRAWN', 'WITHDRAWN'], ['EXPIRED', 'EXPIRED'], ['DECLINED', 'REVOKED']] as const) {
      const sessionId = await a.session();
      const request = await fileSecret(sessionId, { envVar: 'DEEPSEEK_API_KEY' }, new Date(Date.now() + 3_600_000).toISOString());
      await secrets.submit(a.ownerId, request.id, { value: canary() });
      if (ending === 'WITHDRAWN') await requests.withdraw(a.ownerId, sessionId, request.id, undefined);
      if (ending === 'DECLINED') await requests.decline(a.ownerId, request.id, 'not now');
      if (ending === 'EXPIRED') {
        await db.ownerRequest.update({ where: { id: request.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
        await requests.expireDue(new Date());
      }
      const grant = await grantOf(request.id);
      assert.deepEqual([grant.state, grant.endReason, grant.valueEnc], ['REMOVED', reason, null], `${ending} before delivery`);
    }
    // A key the owner cancels before delivery, and a request that expires with no sweep yet: never fetched.
    const cancelled = await fileSecret(await a.session());
    await secrets.submit(a.ownerId, cancelled.id, { value: canary() });
    const cancelledGrant = await grantOf(cancelled.id);
    await secrets.cancel(a.ownerId, cancelled.id);
    await assert.rejects(secrets.fetch(runnerA, cancelledGrant.id), NotFoundException);
    await assert.rejects(secrets.ack(runnerA, cancelledGrant.id, 'DELIVERED', undefined, undefined), NotFoundException);
    const late = await fileSecret(await a.session(), { envVar: 'DEEPSEEK_API_KEY' }, new Date(Date.now() + 3_600_000).toISOString());
    await secrets.submit(a.ownerId, late.id, { value: canary() });
    await db.ownerRequest.update({ where: { id: late.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    await assert.rejects(secrets.fetch(runnerA, (await grantOf(late.id)).id), NotFoundException, 'a request past its deadline delivers nothing');
  });

  await t.test('(e) only value_enc holds the value, bound to its row', async () => {
    const { request, grantId, value } = await deliver(await a.session());
    // Every text column of the two new tables and the request, searched for the canary.
    const { rows } = await sql.query(
      `SELECT to_jsonb(g)::text AS g, to_jsonb(r)::text AS r FROM "owner_request_secret" g JOIN "owner_request" r ON r."id" = g."request_id" WHERE g."id" = $1`,
      [grantId],
    );
    assert.equal(rows[0].g.includes(value), false);
    assert.equal(rows[0].r.includes(value), false);
    assert.equal(Buffer.from(value).toString('base64').length > 0 && rows[0].g.includes(Buffer.from(value).toString('base64')), false);
    // The ciphertext moved to another grant of another runner fails authentication: nothing is delivered there.
    const other = await fileSecret(await a.session({ on: a.secondRunnerId }));
    await secrets.submit(a.ownerId, other.id, { value: canary() });
    const otherGrant = await grantOf(other.id);
    const stolen = await grantOf(request.id);
    await db.ownerRequestSecret.update({ where: { id: otherGrant.id }, data: { valueEnc: stolen.valueEnc } });
    await assert.rejects(secrets.fetch({ id: a.secondRunnerId, ownerId: a.ownerId }, otherGrant.id), NotFoundException);
    const ended = await db.ownerRequestSecret.findUniqueOrThrow({ where: { id: otherGrant.id } });
    assert.deepEqual([ended.state, ended.endReason, ended.valueEnc], ['REMOVED', 'KEY_UNREADABLE', null]);
  });

  await t.test('(f) what a submit takes, and when it may replace', async () => {
    const request = await fileSecret(await a.session());
    for (const value of ['short', 'x'.repeat(16 * 1024 + 1), `has\0nul-byte-inside`]) {
      await assert.rejects(secrets.submit(a.ownerId, request.id, { value }), BadRequestException);
    }
    assert.equal(await db.ownerRequestSecret.count({ where: { requestId: request.id } }), 0);
    await secrets.submit(a.ownerId, request.id, { value: canary() });
    const first = await grantOf(request.id);
    await secrets.submit(a.ownerId, request.id, { value: canary() });
    const second = await grantOf(request.id);
    assert.notEqual(second.id, first.id, 'a resubmit before delivery is a new grant');
    await assert.rejects(secrets.ack(runnerA, first.id, 'DELIVERED', undefined, undefined), NotFoundException, 'the old ack is 404: drop it');
    await secrets.ack(runnerA, second.id, 'DELIVERED', undefined, undefined);
    await assert.rejects(secrets.submit(a.ownerId, request.id, { value: canary() }), ConflictException);
    const decision = await requests.file(a.ownerId, await a.session(), { kind: 'CONFIRM', title: 'ok?', why: 'w' });
    await assert.rejects(secrets.submit(a.ownerId, decision.id, { value: canary() }), BadRequestException);
    await assert.rejects(requests.complete(a.ownerId, (await fileSecret(await a.session())).id, {}), BadRequestException,
      'a SECRET is not marked done by hand');
  });

  await t.test('(g) saved secrets are write-only, and used only by the owner\'s choice', async () => {
    const value = canary();
    const first = await fileSecret(await a.session());
    await secrets.submit(a.ownerId, first.id, { value, saveAs: 'DeepSeek' });
    const listed = await secrets.listSaved(a.ownerId);
    assert.deepEqual(listed.secrets.map((s) => s.label), ['DeepSeek']);
    assert.equal(JSON.stringify(listed).includes(value), false);
    assert.deepEqual(Object.keys(listed.secrets[0]).sort(), ['createdAt', 'id', 'label', 'updatedAt']);
    const saved = await db.accountSecret.findFirstOrThrow({ where: { ownerId: a.ownerId } });
    assert.equal(saved.valueEnc.includes(value), false);
    const second = await fileSecret(await a.session());
    await secrets.submit(a.ownerId, second.id, { savedSecretId: saved.id });
    assert.equal((await secrets.fetch(runnerA, (await grantOf(second.id)).id)).value, value);
    await assert.rejects(secrets.submit(a.ownerId, second.id, { savedSecretId: saved.id, value }), BadRequestException);
    await secrets.deleteSaved(a.ownerId, saved.id);
    assert.equal((await grantOf(second.id)).state, 'PENDING_DELIVERY', 'deleting a saved secret leaves its grants');
  });

  await t.test('(h) another account\'s request, grant or saved secret is one that does not exist', async () => {
    const mine = await fileSecret(await a.session());
    await secrets.submit(a.ownerId, mine.id, { value: canary(), saveAs: 'mine' });
    const saved = await db.accountSecret.findFirstOrThrow({ where: { ownerId: a.ownerId, label: 'mine' } });
    const before = await sql.query(`SELECT to_jsonb(g)::text AS g FROM "owner_request_secret" g WHERE "request_id" = $1`, [mine.id]);
    await assert.rejects(secrets.submit(b.ownerId, mine.id, { value: canary() }), NotFoundException);
    await assert.rejects(secrets.cancel(b.ownerId, mine.id), NotFoundException);
    await assert.rejects(secrets.revoke(b.ownerId, mine.id), NotFoundException);
    await assert.rejects(secrets.replaceSaved(b.ownerId, saved.id, canary()), NotFoundException);
    await assert.rejects(secrets.deleteSaved(b.ownerId, saved.id), NotFoundException);
    const theirs = await requests.file(b.ownerId, await b.session(), {
      kind: 'SECRET', title: 'k', why: 'w', secretSpec: { name: 'k', envVar: 'THEIR_KEY' } as never,
    });
    await assert.rejects(secrets.submit(b.ownerId, theirs.id, { savedSecretId: saved.id }), NotFoundException);
    assert.equal(await db.ownerRequestSecret.count({ where: { requestId: theirs.id } }), 0);
    assert.equal((await secrets.listSaved(b.ownerId)).secrets.length, 0);
    const after = await sql.query(`SELECT to_jsonb(g)::text AS g FROM "owner_request_secret" g WHERE "request_id" = $1`, [mine.id]);
    assert.equal(after.rows[0].g, before.rows[0].g, 'nothing of A\'s was written');
  });

  await t.test('(i) the write door refuses a body carrying a held value, in any of its forms', async () => {
    const { value } = await deliver(await a.session());
    const door = new SecretWriteDoorInterceptor(secrets);
    const send = (path: string, body: unknown, runner: { id: string; ownerId: string } | undefined = runnerA) => {
      const context = {
        getType: () => 'http',
        switchToHttp: () => ({ getRequest: () => ({ method: 'POST', path, body, runner }) }),
      } as never;
      return lastValueFrom(door.intercept(context, { handle: () => of('stored') }));
    };
    const refused = (e: unknown) => e instanceof UnprocessableEntityException
      && (e.getResponse() as { code?: string }).code === SECRET_IN_TEXT
      && (e.getResponse() as { message?: string }).message?.includes('DEEPSEEK_API_KEY') === true
      && (e.getResponse() as { message?: string }).message?.includes(value) === false;
    const buf = Buffer.from(value);
    for (const form of [value, buf.toString('base64'), buf.toString('base64url'), buf.toString('hex'), buf.toString('hex').toUpperCase(), encodeURIComponent(value)]) {
      await assert.rejects(send('/api/runner/tasks/x/comments', { body: `here: ${form}` }), refused);
    }
    await assert.rejects(send('/api/runner/tasks/x/evidence', { evidence: { claim: 'ok', checks: [{ ref: value }] } }), refused);
    await assert.rejects(send('/api/runner/notify', { message: value }), refused);
    assert.equal(await send('/api/runner/tasks/x/comments', { body: 'nothing secret here' }), 'stored');
    assert.equal(await send('/api/runner/heartbeat', { anything: value }), 'stored', 'the protocol\'s own routes pass');
    // A turn completion is not refused (that would wedge the turn); what it carries has the value redacted.
    const completion = { result: `final answer: ${value}`, error: `failed with ${buf.toString('base64')}`, nested: [{ text: value }] };
    assert.equal(await send('/api/runner/sessions/s/turn-complete', completion), 'stored');
    assert.equal(JSON.stringify(completion).includes(value), false);
    assert.equal(JSON.stringify(completion).includes(buf.toString('base64')), false);
    assert.equal(completion.result, 'final answer: [redacted]');
    assert.equal(await send('/api/runner/tasks/x/comments', { body: value }, { id: b.runnerId, ownerId: b.ownerId }), 'stored',
      'a runner holding no grant is not searched');
  });
});
