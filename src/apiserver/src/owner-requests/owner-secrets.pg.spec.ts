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
 *       own routes and a runner holding nothing pass;
 *   (j) the Secrets page's Saved section: Use saved links the grant (saved_secret_id) and stamps last_used_at; every
 *       grant names its runner, also once that runner is deleted; Add (409 on a taken label, 400 on a bad value or
 *       label); Replace; the list's lastUsedAt and liveCopies; Delete without revokeCopies leaves the copies, with it
 *       ends each live one REVOKED through the card's own revoke;
 *   (k) the Secrets page's copies: GET /account-secrets/grants lists each state with its fields, a copy on a deleted
 *       runner as REMOVED / RUNNER_DELETED under the runner's recorded name, removed ones only when asked and only
 *       for 30 days; a copy waiting for delivery says why (RUNNER_OFFLINE, NOT_FETCHED, FETCHED_NOT_ACKED) and since
 *       when; the label is the owner's translated title when there is one; Revoke by grant removes an ACTIVE copy,
 *       cancels an undelivered one, and is 409 on an ended one.
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to its own accounts.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { BadRequestException, ConflictException, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
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
          provider: 'claude', turnState: 'IN_FLIGHT', dispatchOrigin: SessionDispatchOrigin.USER, startedAt: new Date(),
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
    // What ends the key, as the card says it (§6.1): the session for a plain one, the task for a task's run.
    assert.equal((await requests.get(a.ownerId, filed.id)).secretScope, 'SESSION');
    const tasked = await fileSecret(await a.session({ taskId: await a.task() }));
    assert.equal((await requests.get(a.ownerId, tasked.id)).secretScope, 'TASK');
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

    // A delivered key the runner later cannot hold ends, rather than failing on every heartbeat.
    const lost = await deliver(await a.session());
    await secrets.ack(runnerA, lost.grantId, 'FAILED', 'SECRET_PATH_EXISTS', 'the path is taken');
    const ended = await db.ownerRequestSecret.findUniqueOrThrow({ where: { id: lost.grantId } });
    assert.deepEqual([ended.state, ended.endReason, ended.valueEnc], ['REMOVING', 'DELIVERY_FAILED', null]);
    assert.ok((await secrets.reconcileFor(a.runnerId)).secretGrantsRemoving.includes(lost.grantId));
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
    // A task that ended and was reopened before any sweep ran is a new epoch: its secret does not come back (§6.1).
    await removal('TASK_ENDED', async () => {
      const taskId = await a.task();
      return { sessionId: await a.session({ taskId }) };
    }, async ({ sessionId }) => {
      const { taskId } = await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { taskId: true } });
      await db.task.update({ where: { id: taskId! }, data: { status: 'DONE' } });
      await db.task.update({ where: { id: taskId! }, data: { status: 'IN_PROGRESS' } });
      assert.equal((await db.task.findUniqueOrThrow({ where: { id: taskId! } })).status, 'IN_PROGRESS', 'reopened');
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

  await t.test('(e2) an unreadable grant ends KEY_UNREADABLE at the write door, which then refuses to store unchecked text', async () => {
    const { grantId } = await deliver(await a.session());
    const other = await fileSecret(await a.session());
    await secrets.submit(a.ownerId, other.id, { value: canary() });
    const donor = await grantOf(other.id);
    // A ciphertext the key cannot open for this row (another row's): what a rotated key looks like to this grant.
    await db.ownerRequestSecret.update({ where: { id: grantId }, data: { valueEnc: donor.valueEnc } });
    const held = await secrets.valuesHeldBy(runnerA);
    assert.equal(held.unreadable, true);
    const ended = await db.ownerRequestSecret.findUniqueOrThrow({ where: { id: grantId } });
    assert.deepEqual([ended.state, ended.endReason, ended.valueEnc], ['REMOVING', 'KEY_UNREADABLE', null]);
    assert.ok((await secrets.reconcileFor(a.runnerId)).secretGrantsRemoving.includes(grantId));

    // A replica without the key ends nothing, and reports that it could not check.
    const key = process.env.PROVIDER_SECRET_KEY;
    delete process.env.PROVIDER_SECRET_KEY;
    try {
      const blind = await secrets.valuesHeldBy(runnerA);
      assert.equal(blind.unreadable, true);
      assert.equal((await grantOf(other.id)).state, 'PENDING_DELIVERY', 'a missing key ends no grant');
      const door = new SecretWriteDoorInterceptor(secrets);
      const context = {
        getType: () => 'http',
        switchToHttp: () => ({ getRequest: () => ({ method: 'POST', path: '/api/runner/tasks/x/comments', body: { body: 'some text to store' }, runner: runnerA }) }),
      } as never;
      await assert.rejects(lastValueFrom(door.intercept(context, { handle: () => of('stored') })),
        (e: unknown) => e instanceof ServiceUnavailableException);
    } finally {
      process.env.PROVIDER_SECRET_KEY = key;
    }
  });

  await t.test('(e3) a grant the runner fetched but never acknowledged waits for the runner when its request ends', async () => {
    for (const ending of ['WITHDRAWN', 'CANCELLED', 'EXPIRED'] as const) {
      const sessionId = await a.session();
      const request = await fileSecret(sessionId, { envVar: 'DEEPSEEK_API_KEY' }, new Date(Date.now() + 3_600_000).toISOString());
      await secrets.submit(a.ownerId, request.id, { value: canary() });
      const grant = await grantOf(request.id);
      await secrets.fetch(runnerA, grant.id); // fetched, the ack lost
      if (ending === 'WITHDRAWN') await requests.withdraw(a.ownerId, sessionId, request.id, undefined);
      if (ending === 'CANCELLED') await secrets.cancel(a.ownerId, request.id);
      if (ending === 'EXPIRED') {
        await db.ownerRequest.update({ where: { id: request.id }, data: { expiresAt: new Date(Date.now() - 1_000) } });
        await requests.expireDue(new Date());
      }
      const after = await db.ownerRequestSecret.findUniqueOrThrow({ where: { id: grant.id } });
      assert.equal(after.state, 'REMOVING', `${ending}: a fetched grant is not claimed removed before the runner says so`);
      assert.equal(after.valueEnc, null);
      assert.ok((await secrets.reconcileFor(a.runnerId)).secretGrantsRemoving.includes(grant.id));
      await secrets.removed(runnerA, grant.id, undefined);
      assert.equal((await db.ownerRequestSecret.findUniqueOrThrow({ where: { id: grant.id } })).state, 'REMOVED');
    }
  });

  await t.test('(e4) a key fetched before and then unreadable waits for its runner; one being removed refuses a new key', async () => {
    const sessionId = await a.session();
    const request = await fileSecret(sessionId);
    await secrets.submit(a.ownerId, request.id, { value: canary() });
    const grant = await grantOf(request.id);
    await secrets.fetch(runnerA, grant.id); // handed out; the ack lost
    const other = await fileSecret(await a.session());
    await secrets.submit(a.ownerId, other.id, { value: canary() });
    await db.ownerRequestSecret.update({ where: { id: grant.id }, data: { valueEnc: (await grantOf(other.id)).valueEnc } });
    await assert.rejects(secrets.fetch(runnerA, grant.id), NotFoundException);
    const ended = await db.ownerRequestSecret.findUniqueOrThrow({ where: { id: grant.id } });
    assert.deepEqual([ended.state, ended.endReason], ['REMOVING', 'KEY_UNREADABLE'], 'an earlier fetch handed it out: the runner confirms');
    assert.ok(ended.fetchedAt, 'the earlier stamp is kept');
    await assert.rejects(secrets.submit(a.ownerId, request.id, { value: canary() }),
      (e: unknown) => e instanceof ConflictException && /still being removed/.test(JSON.stringify((e as ConflictException).getResponse())));
  });

  await t.test('(e5) a fetched, unconfirmed key whose runner is deleted ends with the unconfirmed note', async () => {
    const doomed = await db.runner.create({
      data: {
        id: randomUUID(), ownerId: a.ownerId, name: 'doomed-fetched', tokenHash: `hash-${randomUUID()}`, status: RunnerStatus.ONLINE,
        capabilities: ['owner-secret/v1'], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
      },
    });
    const sessionId = await a.session({ on: doomed.id });
    const request = await fileSecret(sessionId);
    await secrets.submit(a.ownerId, request.id, { value: canary() });
    const grant = await grantOf(request.id);
    await secrets.fetch({ id: doomed.id, ownerId: a.ownerId }, grant.id);
    await sql.query(`UPDATE "session" SET "assigned_runner_id" = NULL WHERE "id" = $1`, [sessionId]);
    await sql.query(`DELETE FROM "runner" WHERE "id" = $1`, [doomed.id]);
    await secrets.sweep();
    const ended = await db.ownerRequestSecret.findUniqueOrThrow({ where: { id: grant.id } });
    assert.equal(ended.state, 'REMOVED');
    assert.equal(ended.endReason, 'RUNNER_DELETED');
    assert.match(ended.removalNote ?? '', /^Removal unconfirmed/);
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
    assert.deepEqual(Object.keys(listed.secrets[0]).sort(), ['createdAt', 'id', 'label', 'lastUsedAt', 'liveCopies', 'updatedAt']);
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

  await t.test('(j) the Saved section: last used, live copies, Add, Replace, Delete with or without its copies', async () => {
    const saveVia = async (label: string, value = canary()) => {
      const created = await secrets.createSaved(a.ownerId, label, value);
      assert.equal(JSON.stringify(created).includes(value), false, 'Add never echoes the value');
      assert.deepEqual(Object.keys(created).sort(), ['createdAt', 'id', 'label', 'lastUsedAt', 'updatedAt']);
      assert.equal(created.lastUsedAt, null);
      return { id: created.id, value };
    };
    const useSaved = async (savedSecretId: string, sessionId?: string) => {
      const request = await fileSecret(sessionId ?? await a.session());
      await secrets.submit(a.ownerId, request.id, { savedSecretId });
      return { request, grant: await grantOf(request.id) };
    };

    // Add: the label is trimmed and unique per owner; the value follows the card's rules.
    const one = await saveVia('  page one  ');
    assert.equal((await db.accountSecret.findUniqueOrThrow({ where: { id: one.id } })).label, 'page one');
    await assert.rejects(secrets.createSaved(a.ownerId, 'page one', canary()),
      (e: unknown) => e instanceof ConflictException && /SAVED_SECRET_LABEL_TAKEN/.test(JSON.stringify(e.getResponse())));
    await assert.rejects(secrets.createSaved(a.ownerId, 'too short', 'short'), BadRequestException);
    await assert.rejects(secrets.createSaved(a.ownerId, 'has nul', `nul\0inside-key`), BadRequestException);
    await assert.rejects(secrets.createSaved(a.ownerId, '   ', canary()), BadRequestException);
    await assert.rejects(secrets.createSaved(a.ownerId, 'x'.repeat(101), canary()), BadRequestException);
    assert.equal(await db.accountSecret.count({ where: { ownerId: a.ownerId, label: { in: ['too short', 'has nul'] } } }), 0);
    // Another account may use the same label.
    await secrets.createSaved(b.ownerId, 'page one', canary());

    // Use saved: the grant names the saved secret and the runner, and last_used_at moves, in the submit's transaction.
    const before = new Date();
    const used = await useSaved(one.id);
    assert.equal(used.grant.savedSecretId, one.id);
    assert.equal(used.grant.runnerName, 'a-main');
    const stamped = (await db.accountSecret.findUniqueOrThrow({ where: { id: one.id } })).lastUsedAt;
    assert.ok(stamped && stamped.getTime() >= before.getTime() - 1000, 'last_used_at is stamped');
    assert.equal((await secrets.fetch(runnerA, used.grant.id)).value, one.value);
    // A typed value names its runner too, and no saved secret; it does not touch any saved secret's last use.
    const typed = await fileSecret(await a.session());
    await secrets.submit(a.ownerId, typed.id, { value: canary() });
    assert.equal((await grantOf(typed.id)).runnerName, 'a-main');
    assert.equal((await grantOf(typed.id)).savedSecretId, null);
    assert.equal((await db.accountSecret.findUniqueOrThrow({ where: { id: one.id } })).lastUsedAt?.getTime(), stamped.getTime());

    // Replace: the next Use saved delivers the new value.
    const replacement = canary();
    await secrets.replaceSaved(a.ownerId, one.id, replacement);
    const afterReplace = await useSaved(one.id);
    assert.equal((await secrets.fetch(runnerA, afterReplace.grant.id)).value, replacement);
    await secrets.ack(runnerA, afterReplace.grant.id, 'DELIVERED', undefined, undefined);

    // A grant on a runner deleted since keeps the runner's name.
    const doomed = await db.runner.create({
      data: {
        id: randomUUID(), ownerId: a.ownerId, name: 'a-doomed-named', tokenHash: `hash-${randomUUID()}`, status: RunnerStatus.ONLINE,
        capabilities: ['owner-secret/v1'], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
      },
    });
    const onDoomed = await useSaved(one.id, await a.session({ on: doomed.id }));
    assert.equal(onDoomed.grant.runnerName, 'a-doomed-named');
    await sql.query(`UPDATE "session" SET "assigned_runner_id" = NULL WHERE "assigned_runner_id" = $1`, [doomed.id]);
    await sql.query(`DELETE FROM "runner" WHERE "id" = $1`, [doomed.id]);
    await secrets.sweep();
    const orphan = await db.ownerRequestSecret.findUniqueOrThrow({ where: { id: onDoomed.grant.id } });
    assert.equal(orphan.runnerId, null);
    assert.equal(orphan.runnerName, 'a-doomed-named', 'the name survives the runner');
    assert.equal(orphan.state, 'REMOVED');

    // The list: last used, and live copies (PENDING_DELIVERY, ACTIVE, REMOVING) with their runners' names.
    const two = await saveVia('page two');
    const twoOnSecond = await useSaved(two.id, await a.session({ on: a.secondRunnerId }));
    const twoOnMain = await useSaved(two.id);
    await secrets.fetch(runnerA, twoOnMain.grant.id);
    await secrets.ack(runnerA, twoOnMain.grant.id, 'DELIVERED', undefined, undefined);
    const twoRemoving = await useSaved(two.id);
    await secrets.fetch(runnerA, twoRemoving.grant.id);
    await secrets.ack(runnerA, twoRemoving.grant.id, 'DELIVERED', undefined, undefined);
    await secrets.revoke(a.ownerId, twoRemoving.request.id);
    const twoRemoved = await useSaved(two.id);
    await secrets.cancel(a.ownerId, twoRemoved.request.id);
    assert.equal((await grantOf(twoRemoved.request.id)).state, 'REMOVED');
    const listed = await secrets.listSaved(a.ownerId);
    for (const value of [one.value, replacement, two.value]) assert.equal(JSON.stringify(listed).includes(value), false);
    const rowOf = (id: string) => listed.secrets.find((s) => s.id === id)!;
    assert.deepEqual(rowOf(two.id).liveCopies, { count: 3, runnerNames: ['a-main', 'a-second'] });
    assert.ok(rowOf(two.id).lastUsedAt instanceof Date);
    // one: its first copy (fetched, PENDING_DELIVERY), the delivered replacement (ACTIVE); the removed one is not live.
    assert.deepEqual(rowOf(one.id).liveCopies, { count: 2, runnerNames: ['a-main'] });
    assert.ok(rowOf(one.id).lastUsedAt instanceof Date);
    assert.equal((await secrets.listSaved(b.ownerId)).secrets.every((s) => s.liveCopies.count === 0), true);

    // Delete without revokeCopies: the copies are untouched, only their link to the saved secret goes.
    const statesOf = async (requestIds: string[]) =>
      (await db.ownerRequestSecret.findMany({ where: { requestId: { in: requestIds } }, orderBy: { requestId: 'asc' } }))
        .map((g) => ({ id: g.id, state: g.state, endReason: g.endReason }));
    const oneCopies = [used.request.id, afterReplace.request.id];
    const oneBefore = await statesOf(oneCopies);
    await secrets.deleteSaved(a.ownerId, one.id);
    assert.deepEqual(await statesOf(oneCopies), oneBefore);
    assert.deepEqual(oneBefore.map((g) => g.state).sort(), ['ACTIVE', 'PENDING_DELIVERY']);
    assert.equal(await db.ownerRequestSecret.count({ where: { requestId: { in: oneCopies }, savedSecretId: { not: null } } }), 0);
    await assert.rejects(secrets.deleteSaved(a.ownerId, one.id), NotFoundException);
    // A Use saved of a deleted saved secret makes no grant.
    const late = await fileSecret(await a.session());
    await assert.rejects(secrets.submit(a.ownerId, late.id, { savedSecretId: one.id }), NotFoundException);

    // Delete with revokeCopies: each live copy ends REVOKED as its card's Revoke would; another saved secret's are left.
    const three = await saveVia('page three');
    const threeCopy = await useSaved(three.id);
    const unrelated = await statesOf([threeCopy.request.id]);
    await assert.rejects(secrets.deleteSaved(b.ownerId, two.id, true), NotFoundException);
    assert.equal((await grantOf(twoOnMain.request.id)).state, 'ACTIVE', 'another account\'s delete revokes nothing');
    await secrets.deleteSaved(a.ownerId, two.id, true);
    const ended = (id: string) => grantOf(id).then((g) => ({ state: g.state, endReason: g.endReason, valueEnc: g.valueEnc }));
    assert.deepEqual(await ended(twoOnSecond.request.id), { state: 'REMOVED', endReason: 'REVOKED', valueEnc: null },
      'not fetched yet: REMOVED at once');
    assert.deepEqual(await ended(twoOnMain.request.id), { state: 'REMOVING', endReason: 'REVOKED', valueEnc: null },
      'delivered: REMOVING until its runner confirms');
    assert.deepEqual(await ended(twoRemoving.request.id), { state: 'REMOVING', endReason: 'REVOKED', valueEnc: null });
    assert.deepEqual(await ended(twoRemoved.request.id), { state: 'REMOVED', endReason: 'REVOKED', valueEnc: null });
    assert.ok((await secrets.reconcileFor(a.runnerId)).secretGrantsRemoving.includes(twoOnMain.grant.id));
    assert.deepEqual(await statesOf([threeCopy.request.id]), unrelated);
    assert.equal(await db.accountSecret.count({ where: { id: two.id } }), 0);
  });

  await t.test('(k) the copies list: each state, why a copy waits and since when, the owner\'s label; revoke by grant', async () => {
    const k = await account('k');
    const runnerK = { id: k.runnerId, ownerId: k.ownerId };
    const fileK = (sessionId: string, title: string, spec: Record<string, string> = { envVar: 'K_API_KEY' }) =>
      requests.file(k.ownerId, sessionId, {
        kind: 'SECRET', title, why: 'the run calls the API', secretSpec: { name: 'K key', ...spec } as never,
      });
    const grantK = (requestId: string) => db.ownerRequestSecret.findUniqueOrThrow({ where: { requestId } });
    const values: string[] = [];
    const submitK = async (sessionId: string, title: string, spec?: Record<string, string>) => {
      const request = await fileK(sessionId, title, spec);
      const value = canary();
      values.push(value);
      await secrets.submit(k.ownerId, request.id, { value });
      return { request, grant: await grantK(request.id) };
    };
    const taskId = await k.task();
    const taskSession = await k.session({ taskId });
    const taskSessionRow = await db.session.findUniqueOrThrow({ where: { id: taskSession } });

    // NOT_FETCHED: on an online runner, never fetched; since the copy was made.
    const waiting = await submitK(await k.session(), 'Waiting key');
    // FETCHED_NOT_ACKED: fetched, no ack yet; since the fetch. A file copy, made for a task's run.
    const fetched = await submitK(taskSession, 'Fetched key', { filePath: '~/.config/k/key' });
    await secrets.fetch(runnerK, fetched.grant.id);
    const fetchedAt = (await grantK(fetched.request.id)).fetchedAt!;
    // RUNNER_OFFLINE: its runner signed off; since its last beat.
    const offlineBeat = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const offline = await submitK(await k.session({ on: k.secondRunnerId }), 'Offline key');
    await db.runner.update({ where: { id: k.secondRunnerId }, data: { status: RunnerStatus.OFFLINE, lastHeartbeatAt: offlineBeat } });
    // ACTIVE: delivered.
    const active = await submitK(await k.session(), 'Active key');
    await secrets.fetch(runnerK, active.grant.id);
    await secrets.ack(runnerK, active.grant.id, 'DELIVERED', undefined, undefined);
    // REMOVING: delivered, then revoked on its card.
    const removing = await submitK(await k.session(), 'Removing key');
    await secrets.fetch(runnerK, removing.grant.id);
    await secrets.ack(runnerK, removing.grant.id, 'DELIVERED', undefined, undefined);
    await secrets.revoke(k.ownerId, removing.request.id);
    // REMOVED: delivered, revoked, and the runner confirmed.
    const removed = await submitK(await k.session(), 'Removed key');
    await secrets.fetch(runnerK, removed.grant.id);
    await secrets.ack(runnerK, removed.grant.id, 'DELIVERED', undefined, undefined);
    await secrets.revoke(k.ownerId, removed.request.id);
    await secrets.removed(runnerK, removed.grant.id, undefined);
    // REMOVED 31 days ago: past the window.
    const old = await submitK(await k.session(), 'Old key');
    await secrets.cancel(k.ownerId, old.request.id);
    await sql.query(`UPDATE "owner_request_secret" SET "removed_at" = now() - interval '31 days' WHERE "id" = $1`, [old.grant.id]);
    // A copy on a runner deleted since: before the sweep it reads as ending RUNNER_DELETED (LIVE / END_REASON), after
    // it as REMOVED / RUNNER_DELETED, named by the runner's recorded name.
    const doomed = await db.runner.create({
      data: {
        id: randomUUID(), ownerId: k.ownerId, name: 'k-doomed', tokenHash: `hash-${randomUUID()}`, status: RunnerStatus.ONLINE,
        capabilities: ['owner-secret/v1'], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
      },
    });
    const orphan = await submitK(await k.session({ on: doomed.id }), 'Orphan key');
    await secrets.fetch({ id: doomed.id, ownerId: k.ownerId }, orphan.grant.id);
    await secrets.ack({ id: doomed.id, ownerId: k.ownerId }, orphan.grant.id, 'DELIVERED', undefined, undefined);
    await sql.query(`UPDATE "session" SET "assigned_runner_id" = NULL WHERE "assigned_runner_id" = $1`, [doomed.id]);
    await sql.query(`DELETE FROM "runner" WHERE "id" = $1`, [doomed.id]);
    const beforeSweep = (await secrets.listGrants(k.ownerId, false)).grants.find((g) => g.id === orphan.grant.id)!;
    assert.equal(beforeSweep.state, 'ACTIVE');
    assert.equal(beforeSweep.endReason, 'RUNNER_DELETED', 'a copy whose scope ended reads the reason the sweep will give');
    assert.deepEqual(beforeSweep.runner, { id: null, name: 'k-doomed', online: false, lastHeartbeatAt: null });
    await secrets.sweep();

    // The owner's language: one request carries a title translated for the owner, the other cards do not.
    await db.ownerRequest.update({
      where: { id: waiting.request.id },
      data: { translation: { lang: 'zh-Hans', title: 'Translated waiting key' } },
    });
    await db.user.update({ where: { id: k.ownerId }, data: { preferences: { translationEnabled: true, translationLanguage: 'zh-Hans' } } });
    const savedDeepSeek = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = 'owner-secrets-pg-spec-translation-on';
    let listed: Awaited<ReturnType<OwnerSecretsService['listGrants']>>;
    let liveOnly: Awaited<ReturnType<OwnerSecretsService['listGrants']>>;
    try {
      listed = await secrets.listGrants(k.ownerId, true);
      liveOnly = await secrets.listGrants(k.ownerId, false);
    } finally {
      if (savedDeepSeek === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = savedDeepSeek;
    }
    // Translation off: the title as filed.
    await db.user.update({ where: { id: k.ownerId }, data: { preferences: { translationEnabled: false } } });
    const untranslated = await secrets.listGrants(k.ownerId, false);

    // Never the value, nor anything that is not a label, place, state or date.
    const body = JSON.stringify([listed, liveOnly, untranslated, beforeSweep]);
    for (const value of values) assert.equal(body.includes(value), false, 'no value in the list');
    assert.equal(body.includes('valueEnc') || body.includes('value_enc'), false);

    const row = (grantId: string) => listed.grants.find((g) => g.id === grantId)!;
    const ids = (l: typeof listed) => l.grants.map((g) => g.id).sort();
    assert.deepEqual(ids(listed), [waiting, fetched, offline, active, removing, removed, orphan].map((g) => g.grant.id).sort(),
      'live and recently removed copies; the one removed 31 days ago is not listed');
    assert.deepEqual(ids(liveOnly), [waiting, fetched, offline, active, removing].map((g) => g.grant.id).sort(),
      'without removed=30d only the live states');
    assert.equal((await secrets.listGrants(b.ownerId, true)).grants.some((g) => listed.grants.some((m) => m.id === g.id)), false,
      'another account sees none of them');

    // Labels: the owner-facing translation, else the stored title.
    assert.equal(row(waiting.grant.id).label, 'Translated waiting key');
    assert.equal(row(active.grant.id).label, 'Active key');
    assert.equal(untranslated.grants.find((g) => g.id === waiting.grant.id)!.label, 'Waiting key', 'translation off: as filed');

    // Each delivery hint, with its since.
    const waitingRow = row(waiting.grant.id);
    assert.deepEqual(waitingRow.deliveryHint, { reason: 'NOT_FETCHED', since: waiting.grant.createdAt });
    assert.deepEqual(row(fetched.grant.id).deliveryHint, { reason: 'FETCHED_NOT_ACKED', since: fetchedAt });
    assert.deepEqual(row(offline.grant.id).deliveryHint, { reason: 'RUNNER_OFFLINE', since: offlineBeat });
    for (const g of [active, removing, removed, orphan]) assert.equal(row(g.grant.id).deliveryHint, null);

    // The full row of a waiting copy (session scope, env), and of a task's file copy.
    const { createdAt: _c, runner: waitingRunner, ...waitingRest } = waitingRow;
    assert.equal(waitingRunner.id, k.runnerId);
    assert.equal(waitingRunner.name, 'k-main');
    assert.equal(waitingRunner.online, true);
    assert.ok(waitingRunner.lastHeartbeatAt instanceof Date);
    assert.deepEqual(waitingRest, {
      id: waiting.grant.id, requestId: waiting.request.id, label: 'Translated waiting key', exposure: 'ENV', envName: 'K_API_KEY',
      filePath: null, sessionId: waiting.grant.sessionId, sessionTitle: 'asks', taskId: null, taskTitle: null, taskScoped: false,
      state: 'PENDING_DELIVERY', endReason: null, removalNote: null, fetchedAt: null, deliveredAt: null,
      expiresAt: waiting.grant.expiresAt, removedAt: null, savedSecretId: null,
      deliveryHint: { reason: 'NOT_FETCHED', since: waiting.grant.createdAt },
    });
    assert.deepEqual(
      (({ exposure, envName, filePath, sessionId, taskId, taskTitle, taskScoped, state, fetchedAt: f }) =>
        ({ exposure, envName, filePath, sessionId, taskId, taskTitle, taskScoped, state, fetchedAt: f }))(row(fetched.grant.id)),
      { exposure: 'FILE', envName: null, filePath: '~/.config/k/key', sessionId: taskSessionRow.id, taskId, taskTitle: 'work (k)',
        taskScoped: true, state: 'PENDING_DELIVERY', fetchedAt },
    );
    assert.deepEqual(row(offline.grant.id).runner, { id: k.secondRunnerId, name: 'k-second', online: false, lastHeartbeatAt: offlineBeat });
    const activeRow = row(active.grant.id);
    assert.equal(activeRow.state, 'ACTIVE');
    assert.equal(activeRow.endReason, null);
    assert.ok(activeRow.deliveredAt instanceof Date && activeRow.fetchedAt instanceof Date);
    assert.equal(activeRow.removedAt, null);
    assert.deepEqual([row(removing.grant.id).state, row(removing.grant.id).endReason, row(removing.grant.id).removedAt],
      ['REMOVING', 'REVOKED', null]);
    assert.equal(row(removed.grant.id).state, 'REMOVED');
    assert.equal(row(removed.grant.id).endReason, 'REVOKED');
    assert.ok(row(removed.grant.id).removedAt instanceof Date);
    const orphanRow = row(orphan.grant.id);
    assert.deepEqual([orphanRow.state, orphanRow.endReason, orphanRow.removalNote], ['REMOVED', 'RUNNER_DELETED',
      'Removal unconfirmed: the runner was deleted before it could confirm.']);
    assert.deepEqual(orphanRow.runner, { id: null, name: 'k-doomed', online: false, lastHeartbeatAt: null });

    // Revoke by grant: through the card's own revoke.
    await assert.rejects(secrets.revokeGrant(b.ownerId, active.grant.id), NotFoundException, 'another account\'s grant is 404');
    assert.equal((await grantK(active.request.id)).state, 'ACTIVE');
    await assert.rejects(secrets.revokeGrant(k.ownerId, randomUUID()), NotFoundException);
    await secrets.revokeGrant(k.ownerId, active.grant.id);
    assert.deepEqual((({ state, endReason, valueEnc }) => ({ state, endReason, valueEnc }))(await grantK(active.request.id)),
      { state: 'REMOVING', endReason: 'REVOKED', valueEnc: null }, 'an ACTIVE copy is REMOVING until its runner confirms');
    await secrets.revokeGrant(k.ownerId, waiting.grant.id);
    assert.deepEqual((({ state, endReason, valueEnc }) => ({ state, endReason, valueEnc }))(await grantK(waiting.request.id)),
      { state: 'REMOVED', endReason: 'REVOKED', valueEnc: null }, 'an undelivered, unfetched copy is cancelled');
    assert.equal((await db.ownerRequest.findUniqueOrThrow({ where: { id: waiting.request.id } })).state, 'PENDING',
      'cancelling leaves the card open for another key');
    await secrets.revokeGrant(k.ownerId, fetched.grant.id);
    assert.equal((await grantK(fetched.request.id)).state, 'REMOVING', 'a fetched, unacknowledged copy waits for its runner');
    for (const ended of [removed, removing, orphan, active]) {
      await assert.rejects(secrets.revokeGrant(k.ownerId, ended.grant.id), ConflictException, 'an ended copy is 409');
    }
  });
});
