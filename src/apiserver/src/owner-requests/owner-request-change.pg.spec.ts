/**
 * OWNER REQUEST CHANGE: AN AGENT PROPOSES A RUNNER'S MAX CONCURRENT, THE OWNER APPLIES IT WITH ONE PRESS
 * (docs/design/owner-request-change.md, migration 1538).
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/owner-requests/owner-request-change.pg.spec.ts
 *
 * Filed through the runner door `POST /runner/owner-requests` by a session the runner hosts, answered through the
 * owner's doors, and delivered by the real Watch delivery worker into the asking session's queue.
 *
 * THE CASES
 * =========
 *   (1) file then apply: change_spec `{ runnerId, field, requested, before }` is written by the server and read back on
 *       GET /owner-requests and on the runner-side read; Apply writes the runner, ends the request DONE with
 *       `{ applied, actualBefore }`, and exactly one resolution turn reaches the asking session, carrying `change`;
 *   (2) the owner applies a different number than requested, after the value moved since filing: `applied` is the
 *       owner's number and `actualBefore` the value it replaced, both in the turn;
 *   (3) decline: the runner is untouched, and the turn carries `change` without `applied`;
 *   (4) a second filing for the same runner setting ends the first WITHDRAWN with 'Replaced by a newer request', in
 *       the same transaction, with its own turn to its asker; a filing for another runner replaces nothing;
 *   (5) two filings that race leave exactly one PENDING, and the other WITHDRAWN;
 *   (6) another owner's runner, or an id that names none, is refused as not found, and nothing is filed;
 *   (7) the value the runner already has is refused 409 OWNER_REQUEST_CHANGE_NOOP, and nothing is filed;
 *   (8) the filing rules: `change` refused on another kind; options, steps and secretSpec refused on CHANGE; `change`
 *       missing, a value under 1 or not an integer, or a setting v1 does not allow, refused 400; nothing is filed;
 *   (9) POST /:id/done is refused for a CHANGE, which stays PENDING;
 *  (10) the runner removed while the request is pending: Apply answers 404 and writes nothing; the owner can decline;
 *  (11) Apply on an ended request is refused OWNER_REQUEST_NOT_PENDING, past its deadline OWNER_REQUEST_EXPIRED, on
 *       another kind 400 and on another account's request 404 — each writing nothing;
 *  (12) over HTTP against the production apiserver: a personal access token holding every scope is refused at
 *       POST /owner-requests/:id/apply, 403 PAT_FORBIDDEN (RUNNER_CONTROL), and writes nothing; the owner's sign-in on
 *       the same request applies it.
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to its own accounts.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { BadRequestException, ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import { PrismaClient, RunnerStatus, SessionDispatchOrigin, type Runner } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { PAT_FORBIDDEN_REASONS } from '../auth/pat-scope.decorator';
import { PAT_SCOPES, PatService } from '../auth/pat.service';
import { call, startApiserver, type Apiserver } from '../auth/pat-test-apiserver';
import { hashPassword } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { PushService } from '../push/push.service';
import { RunnerOwnerRequestsController } from '../runner-api/runner-owner-requests.controller';
import { SessionsService } from '../sessions/sessions.service';
import { WatchDeliveryService } from '../watches/watch-delivery.service';
import type { FileOwnerRequestDto } from './dto';
import { ownerRequestTurnClientId } from './owner-request';
import { OwnerRequestsController } from './owner-requests.controller';
import { OwnerRequestsService } from './owner-requests.service';
import { OwnerSecretsService } from './owner-secrets.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const HOUR = 3_600_000;

interface Account {
  ownerId: string;
  runner: Runner;
  /** A second runner of the same account. */
  otherRunner: Runner;
  /** Two sessions the runner hosts: an asker and a second asker. */
  sessionId: string;
  secondSessionId: string;
}

test('owner request CHANGE: an agent proposes a runner\'s Max Concurrent, the owner applies it', {
  skip, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const clients: PrismaClient[] = [];
  const pool = (): PrismaClient => {
    const client = prismaClientFor(url);
    clients.push(client);
    return client;
  };
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    for (const client of clients) await client.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const db = pool();
  const prisma = db as unknown as PrismaService;
  const told: string[] = [];
  const push = {
    notifyOwnerRequest: async (id: string) => { told.push(id); },
    notifyWatchMatched: async () => undefined,
  } as unknown as PushService;
  const queue = { notifySessionQueued: () => undefined };
  const realtime = new Proxy({}, { get: (_t, p) => (p === 'then' ? undefined : () => undefined) });
  const secrets = new OwnerSecretsService(prisma);
  const service = new OwnerRequestsService(prisma, secrets, push);
  const owner = new OwnerRequestsController(service, secrets);
  const door = new RunnerOwnerRequestsController(prisma, service);
  /** One replica's delivery worker on its own pool. Never started: a case drains it. */
  const worker = (): WatchDeliveryService => {
    const client = pool() as unknown as PrismaService;
    return new WatchDeliveryService(client, new SessionsService(client, queue as never, realtime as never), push, {
      retryBaseMs: 0, retryMaxMs: 0, pollIntervalMs: HOUR,
    });
  };
  const delivery = worker();

  const a = await account(db, 'a');
  const b = await account(db, 'b');

  const code = (error: unknown): string | undefined =>
    ((error as HttpException).getResponse?.() as { code?: string } | undefined)?.code;

  /** A CHANGE filed by a session through the runner door, which is how an agent reaches it. */
  const fileChange = (
    change: Record<string, unknown>,
    acc: Account = a,
    sessionId: string = acc.sessionId,
    extra: Partial<FileOwnerRequestDto> = {},
  ) => door.file(acc.runner, sessionId, {
    kind: 'CHANGE',
    title: 'Lower the runner to fewer concurrent sessions',
    why: 'it has run at its limit for 40 minutes; the rehearsal needs headroom',
    change,
    ...extra,
  } as unknown as FileOwnerRequestDto);

  const setMax = async (runnerId: string, value: number) => {
    await db.runner.update({ where: { id: runnerId }, data: { maxConcurrent: value } });
  };
  const maxOf = async (runnerId: string) =>
    (await db.runner.findUniqueOrThrow({ where: { id: runnerId }, select: { maxConcurrent: true } })).maxConcurrent;
  const requestRow = (id: string) => db.ownerRequest.findUniqueOrThrow({ where: { id } });
  const deliveriesOf = (id: string) => db.watchDelivery.findMany({ where: { ownerRequestId: id } });
  const changeRequestsOf = (ownerId: string) => db.ownerRequest.findMany({ where: { ownerId, kind: 'CHANGE' } });

  /** The resolution turns on a session for one request, after draining the delivery worker. */
  const turnsFor = async (sessionId: string, requestId: string) => {
    await delivery.drain();
    const turns = await db.conversationTurn.findMany({
      where: { sessionId, clientTurnId: ownerRequestTurnClientId(requestId) },
      select: { content: true },
    });
    return turns;
  };
  /** The JSON block a resolution turn ends with. */
  const payloadOf = (content: string | null): Record<string, unknown> => {
    const match = /```json\n([\s\S]*)\n```$/.exec(content ?? '');
    assert.ok(match, `the turn carries a JSON payload: ${content}`);
    return JSON.parse(match[1]) as Record<string, unknown>;
  };
  const theOneTurnPayload = async (sessionId: string, requestId: string) => {
    const turns = await turnsFor(sessionId, requestId);
    assert.equal(turns.length, 1, `exactly one resolution turn: ${JSON.stringify(turns)}`);
    return { content: turns[0].content ?? '', payload: payloadOf(turns[0].content) };
  };

  await t.test('(1) file then apply: the runner is written, the request ends DONE, and exactly one turn carries change', async () => {
    await setMax(a.runner.id, 12);
    told.length = 0;
    // The agent names the runner by the public id runner_list hands it.
    const filed = await fileChange({ runnerId: uuidToBase62(a.runner.id), maxConcurrent: 6 });
    assert.equal(filed.kind, 'CHANGE');
    assert.equal(filed.state, 'PENDING');
    const spec = { runnerId: a.runner.id, field: 'maxConcurrent', requested: 6, before: 12 };
    assert.deepEqual(filed.changeSpec, spec, 'before is read by the server');
    assert.deepEqual(told, [filed.id], 'the owner is told once');

    const listed = (await owner.list({ userId: a.ownerId } as never, 'open')).requests.find((r) => r.id === filed.id);
    assert.deepEqual(listed?.changeSpec, spec, 'GET /owner-requests carries change_spec');
    assert.deepEqual((await door.get(a.runner, filed.id)).changeSpec, spec, 'the runner-side read carries change_spec');
    assert.deepEqual(await deliveriesOf(filed.id), [], 'nothing is delivered while it is PENDING');

    const applied = await owner.applyChange({ userId: a.ownerId } as never, filed.id, { maxConcurrent: 6 }, 'ios/1.0');
    assert.equal(applied.state, 'DONE');
    assert.deepEqual(applied.answer, { applied: 6, actualBefore: 12 });
    assert.equal(applied.resolvedByUserId, a.ownerId);
    assert.equal(applied.resolvedClient, 'ios');
    assert.equal(await maxOf(a.runner.id), 6, 'the runner is written');
    assert.equal((await deliveriesOf(filed.id)).length, 1, 'one delivery is written with the ending');

    const { content, payload } = await theOneTurnPayload(a.sessionId, filed.id);
    assert.match(content, new RegExp(`^Orbit owner request ${filed.id} \\(CHANGE\\) ended DONE: `));
    assert.equal(payload.outcome, 'DONE');
    assert.deepEqual(payload.change, { ...spec, applied: 6, actualBefore: 12 });
    assert.equal((await turnsFor(a.sessionId, filed.id)).length, 1, 'draining again leaves it at one');

    // A second press is refused with nothing written.
    await assert.rejects(
      service.applyChange(a.ownerId, filed.id, 4),
      (e) => e instanceof ConflictException && code(e) === 'OWNER_REQUEST_NOT_PENDING',
    );
    assert.equal(await maxOf(a.runner.id), 6);
    assert.equal((await deliveriesOf(filed.id)).length, 1);
  });

  await t.test('(2) the owner applies another number, after the value moved: applied and actualBefore say so', async () => {
    await setMax(a.runner.id, 12);
    const filed = await fileChange({ runnerId: a.runner.id, maxConcurrent: 6 });
    await setMax(a.runner.id, 9); // changed on the runner page since the agent asked
    const applied = await service.applyChange(a.ownerId, filed.id, 8, 'web');
    assert.deepEqual(applied.answer, { applied: 8, actualBefore: 9 });
    assert.equal(await maxOf(a.runner.id), 8, "the owner's number is written, not the requested one");
    const { payload } = await theOneTurnPayload(a.sessionId, filed.id);
    assert.deepEqual(payload.change, {
      runnerId: a.runner.id, field: 'maxConcurrent', requested: 6, applied: 8, before: 12, actualBefore: 9,
    });
  });

  await t.test('(3) decline: the runner is untouched, and the turn carries change without applied', async () => {
    await setMax(a.runner.id, 12);
    const filed = await fileChange({ runnerId: a.runner.id, maxConcurrent: 3 });
    const declined = await service.decline(a.ownerId, filed.id, 'the rehearsal is cancelled');
    assert.equal(declined.state, 'DECLINED');
    assert.equal(await maxOf(a.runner.id), 12);
    const { payload } = await theOneTurnPayload(a.sessionId, filed.id);
    assert.equal(payload.outcome, 'DECLINED');
    assert.equal(payload.reason, 'the rehearsal is cancelled');
    assert.deepEqual(payload.change, { runnerId: a.runner.id, field: 'maxConcurrent', requested: 3, before: 12 });
  });

  await t.test('(4) a second filing for the same runner setting replaces the first, which ends WITHDRAWN', async () => {
    await setMax(a.runner.id, 12);
    const first = await fileChange({ runnerId: a.runner.id, maxConcurrent: 6 });
    const elsewhere = await fileChange({ runnerId: a.otherRunner.id, maxConcurrent: 2 });
    const second = await fileChange({ runnerId: a.runner.id, maxConcurrent: 4 }, a, a.secondSessionId);

    const replaced = await requestRow(first.id);
    assert.equal(replaced.state, 'WITHDRAWN');
    assert.equal(replaced.resolutionNote, 'Replaced by a newer request');
    assert.equal(replaced.resolvedBySessionId, a.secondSessionId);
    assert.equal((await requestRow(second.id)).state, 'PENDING');
    assert.equal((await requestRow(elsewhere.id)).state, 'PENDING', "another runner's request is not replaced");
    assert.equal((await deliveriesOf(first.id)).length, 1, 'the replaced request is delivered to its asker');

    const { content, payload } = await theOneTurnPayload(a.sessionId, first.id);
    assert.match(content, /ended WITHDRAWN\. A newer request for the same runner setting replaced it/);
    assert.equal(payload.reason, 'Replaced by a newer request');
    assert.deepEqual(payload.change, { runnerId: a.runner.id, field: 'maxConcurrent', requested: 6, before: 12 });

    // The same clientRequestId again is the same request, and replaces nothing.
    const keyed = await fileChange({ runnerId: a.runner.id, maxConcurrent: 5 }, a, a.sessionId, { clientRequestId: 'change-1' });
    const again = await fileChange({ runnerId: a.runner.id, maxConcurrent: 5 }, a, a.sessionId, { clientRequestId: 'change-1' });
    assert.equal(again.id, keyed.id);
    assert.equal(again.created, false);
    assert.equal((await requestRow(keyed.id)).state, 'PENDING', 'a retried filing does not replace itself');
    assert.equal((await requestRow(second.id)).state, 'WITHDRAWN');

    for (const id of [keyed.id, elsewhere.id]) await service.decline(a.ownerId, id, 'clearing the case');
  });

  await t.test('(5) two filings that race leave exactly one PENDING', async () => {
    await setMax(a.runner.id, 12);
    // Each on its own pool, so the two transactions really overlap.
    const racer = () => {
      const client = pool() as unknown as PrismaService;
      return new RunnerOwnerRequestsController(client, new OwnerRequestsService(client, new OwnerSecretsService(client), push));
    };
    const body = (maxConcurrent: number) => ({
      kind: 'CHANGE', title: `race to ${maxConcurrent}`, why: 'racing', change: { runnerId: a.runner.id, maxConcurrent },
    } as unknown as FileOwnerRequestDto);
    for (let round = 0; round < 5; round += 1) {
      const [one, two] = await Promise.all([
        racer().file(a.runner, a.sessionId, body(5)),
        racer().file(a.runner, a.secondSessionId, body(7)),
      ]);
      const rows = await db.ownerRequest.findMany({ where: { id: { in: [one.id, two.id] } } });
      assert.deepEqual(rows.map((r) => r.state).sort(), ['PENDING', 'WITHDRAWN'], `round ${round}: one stays pending`);
      const pending = (await changeRequestsOf(a.ownerId)).filter(
        (r) => r.state === 'PENDING' && (r.changeSpec as { runnerId: string }).runnerId === a.runner.id,
      );
      assert.equal(pending.length, 1, `round ${round}: one PENDING change for the runner setting`);
      await service.decline(a.ownerId, pending[0].id, 'clearing the race');
    }
  });

  await t.test("(6) another owner's runner, or an id that names none, is not found, and nothing is filed", async () => {
    const before = (await changeRequestsOf(a.ownerId)).length;
    for (const runnerId of [b.runner.id, uuidToBase62(b.runner.id), randomUUID(), 'not-a-runner']) {
      await assert.rejects(fileChange({ runnerId, maxConcurrent: 3 }), NotFoundException, runnerId);
    }
    assert.equal((await changeRequestsOf(a.ownerId)).length, before);
    assert.equal(await maxOf(b.runner.id), 1, "the other account's runner is untouched");
  });

  await t.test('(7) the value the runner already has is refused OWNER_REQUEST_CHANGE_NOOP', async () => {
    await setMax(a.runner.id, 12);
    const before = (await changeRequestsOf(a.ownerId)).length;
    await assert.rejects(
      fileChange({ runnerId: a.runner.id, maxConcurrent: 12 }),
      (e) => e instanceof ConflictException && code(e) === 'OWNER_REQUEST_CHANGE_NOOP',
    );
    assert.equal((await changeRequestsOf(a.ownerId)).length, before, 'nothing is filed');
  });

  await t.test('(8) the filing rules per kind', async () => {
    await setMax(a.runner.id, 12);
    const before = await db.ownerRequest.count({ where: { ownerId: a.ownerId } });
    const refused = async (body: Record<string, unknown>, message: RegExp) => {
      await assert.rejects(
        door.file(a.runner, a.sessionId, { title: 'a request', why: 'because', ...body } as unknown as FileOwnerRequestDto),
        (e) => e instanceof BadRequestException && message.test((e.getResponse() as { message: string }).message),
        JSON.stringify(body),
      );
    };
    const change = { runnerId: a.runner.id, maxConcurrent: 6 };
    await refused({ kind: 'CONFIRM', change }, /change is only for a CHANGE request/);
    await refused({ kind: 'DECISION', change, options: [{ label: 'yes' }] }, /change is only for a CHANGE request/);
    await refused({ kind: 'CHANGE', change, options: [{ label: 'yes' }] }, /options is only for a DECISION request/);
    await refused({ kind: 'CHANGE', change, steps: [{ text: 'do it' }] }, /steps is only for a MANUAL_STEP request/);
    await refused({ kind: 'CHANGE', change, secretSpec: { name: 'k', envVar: 'K' } }, /secretSpec is only for a SECRET request/);
    await refused({ kind: 'CHANGE' }, /a CHANGE request needs change/);
    await refused({ kind: 'CHANGE', change: { runnerId: a.runner.id } }, /change\.maxConcurrent is required/);
    await refused({ kind: 'CHANGE', change: { maxConcurrent: 6 } }, /change\.runnerId is required/);
    await refused({ kind: 'CHANGE', change: { ...change, maxConcurrent: 0 } }, /integer of at least 1/);
    await refused({ kind: 'CHANGE', change: { ...change, maxConcurrent: 2.5 } }, /integer of at least 1/);
    await refused({ kind: 'CHANGE', change: { ...change, minFreeDiskMb: 100 } }, /change\.minFreeDiskMb is not a setting/);
    assert.equal(await db.ownerRequest.count({ where: { ownerId: a.ownerId } }), before, 'nothing is filed');
  });

  await t.test('(9) POST /:id/done is refused for a CHANGE', async () => {
    await setMax(a.runner.id, 12);
    const filed = await fileChange({ runnerId: a.runner.id, maxConcurrent: 6 });
    await assert.rejects(
      owner.complete({ userId: a.ownerId } as never, filed.id, { text: 'done it' }),
      (e) => e instanceof BadRequestException && /POST \/owner-requests\/:id\/apply/.test((e.getResponse() as { message: string }).message),
    );
    assert.equal((await requestRow(filed.id)).state, 'PENDING');
    assert.equal(await maxOf(a.runner.id), 12);
    assert.deepEqual(await deliveriesOf(filed.id), []);
    await service.decline(a.ownerId, filed.id, 'clearing the case');
  });

  await t.test('(10) the runner removed while the request is pending: Apply is 404 and writes nothing', async () => {
    const doomed = await db.runner.create({
      data: { id: randomUUID(), ownerId: a.ownerId, name: 'doomed', tokenHash: `hash-${randomUUID()}`, maxConcurrent: 4 },
    });
    const filed = await fileChange({ runnerId: doomed.id, maxConcurrent: 2 });
    await db.runner.delete({ where: { id: doomed.id } });
    await assert.rejects(service.applyChange(a.ownerId, filed.id, 2), NotFoundException);
    const row = await requestRow(filed.id);
    assert.equal(row.state, 'PENDING');
    assert.equal(row.answer, null);
    assert.deepEqual(await deliveriesOf(filed.id), []);
    assert.equal((await service.decline(a.ownerId, filed.id, 'the runner is gone')).state, 'DECLINED', 'the owner can decline');
  });

  await t.test('(11) Apply is refused when the request is expired, of another kind or another account\'s', async () => {
    await setMax(a.runner.id, 12);
    const filed = await fileChange({ runnerId: a.runner.id, maxConcurrent: 6 });

    await assert.rejects(service.applyChange(b.ownerId, filed.id, 6), NotFoundException, "another account's request");
    await sql.query(`UPDATE owner_request SET expires_at = now() - interval '1 second' WHERE id = $1`, [filed.id]);
    await assert.rejects(
      service.applyChange(a.ownerId, filed.id, 6),
      (e) => e instanceof ConflictException && code(e) === 'OWNER_REQUEST_EXPIRED',
    );
    assert.equal((await requestRow(filed.id)).state, 'PENDING');
    assert.equal(await maxOf(a.runner.id), 12);
    assert.deepEqual(await deliveriesOf(filed.id), []);
    assert.ok((await service.expireDue(new Date())).includes(filed.id));

    const confirm = await door.file(a.runner, a.sessionId, { kind: 'CONFIRM', title: 'Ship it?', why: 'release' } as FileOwnerRequestDto);
    await assert.rejects(service.applyChange(a.ownerId, confirm.id, 6), BadRequestException);
    assert.equal((await requestRow(confirm.id)).state, 'PENDING');
    assert.equal(await maxOf(a.runner.id), 12);
    await service.decline(a.ownerId, confirm.id, 'clearing the case');
  });

  await t.test('(12) over HTTP: a personal access token is refused at /apply, the owner\'s sign-in applies', async () => {
    const email = `owner-request-change-${randomUUID()}@owner-request-change.invalid`;
    const userId = randomUUID();
    await db.user.create({ data: { id: userId, email, name: 'Owner', passwordHash: hashPassword('a-password') } });
    const runnerId = randomUUID();
    await db.runner.create({ data: { id: runnerId, ownerId: userId, name: 'http runner', tokenHash: `hash-${runnerId}`, maxConcurrent: 12 } });
    const sessionId = randomUUID();
    await db.session.create({
      data: {
        id: sessionId, ownerId: userId, creatorId: userId, assignedRunnerId: runnerId, title: 'asker', prompt: 'asker',
        provider: 'claude', turnState: 'IN_FLIGHT', dispatchOrigin: SessionDispatchOrigin.USER, startedAt: new Date(),
      },
    });
    const filed = await service.file(userId, sessionId, {
      kind: 'CHANGE', title: 'Lower to 6', why: 'headroom', change: { runnerId, maxConcurrent: 6 },
    });

    const token = (await new PatService(prisma).issue(userId, {
      name: 'every scope', scopes: [...PAT_SCOPES], expiresInDays: 90, createdVia: 'WEB',
    })).token;
    const jwtSecret = `owner-request-change-${randomUUID()}`;
    const login = await new JwtService({ secret: jwtSecret }).signAsync({ sub: userId, email });
    server = await startApiserver(url, jwtSecret);
    const path = `/api/owner-requests/${uuidToBase62(filed.id)}/apply`;

    const refused = await call(server, 'POST', path, token, { maxConcurrent: 6 });
    assert.equal(refused.status, 403, refused.text);
    assert.deepEqual(
      { code: refused.json.code, reason: refused.json.reason, message: refused.json.message },
      { code: 'PAT_FORBIDDEN', reason: 'RUNNER_CONTROL', message: PAT_FORBIDDEN_REASONS.RUNNER_CONTROL },
    );
    assert.equal((await requestRow(filed.id)).state, 'PENDING', 'the token wrote nothing');
    assert.equal(await maxOf(runnerId), 12);
    assert.deepEqual(await deliveriesOf(filed.id), []);

    const invalid = await call(server, 'POST', path, login, { maxConcurrent: 0 });
    assert.equal(invalid.status, 400, 'the door holds the floor of 1, as PATCH /runners/:id does');
    assert.equal(await maxOf(runnerId), 12);

    const applied = await call(server, 'POST', path, login, { maxConcurrent: 7 }, { 'x-orbit-client': 'web/1.0' });
    assert.equal(applied.status, 200, applied.text);
    assert.equal(applied.json.state, 'DONE');
    assert.deepEqual(applied.json.answer, { applied: 7, actualBefore: 12 });
    assert.equal(toUuid(applied.json.changeSpec.runnerId), runnerId, 'change_spec.runnerId is an address the client hands back');
    assert.equal(await maxOf(runnerId), 7);
    assert.equal((await deliveriesOf(filed.id)).length, 1);
  });
});

async function account(db: PrismaClient, label: string): Promise<Account> {
  const ownerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `owner-request-change-${ownerId}@owner-request-change.invalid`, name: 'Owner', passwordHash: 'x' },
  });
  const runnerOf = (name: string) => db.runner.create({
    data: {
      id: randomUUID(),
      ownerId,
      name,
      tokenHash: `hash-${randomUUID()}`,
      status: RunnerStatus.ONLINE,
      lastHeartbeatAt: new Date(),
    },
  });
  const runner = await runnerOf(`owner-request-change-${label}`);
  const otherRunner = await runnerOf(`owner-request-change-${label}-2`);
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId: runner.id, name: `owner-request-change-${label}`, enabled: true } });
  const session = async (title: string): Promise<string> => {
    const id = randomUUID();
    await db.session.create({
      data: {
        id,
        ownerId,
        creatorId: ownerId,
        workspaceId,
        assignedRunnerId: runner.id,
        title,
        prompt: title,
        provider: 'claude',
        turnState: 'IN_FLIGHT',
        dispatchOrigin: SessionDispatchOrigin.USER,
        startedAt: new Date(),
        runtimeSessionId: `runtime-${id}`,
      },
    });
    return id;
  };
  return {
    ownerId,
    runner,
    otherRunner,
    sessionId: await session(`asker ${label}`),
    secondSessionId: await session(`second asker ${label}`),
  };
}
