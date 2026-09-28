/**
 * What a shared pool's page reads beside its rows (SharedPoolsService, migration 0320), on real
 * PostgreSQL:
 *
 *  (a) `next` marks the key a session the viewer starts now would run on — the claim's own choice
 *      (choosePoolKey over sharedPoolKeyCandidates), so it is the viewer's own key first, a key
 *      somebody else capped only while it has room left for them, never one switched off or refused
 *      by OpenAI, and no key at all when none can run for them.
 *  (b) `running` marks a key a session on the pool is generating on right now.
 *  (c) `sessions` counts the sessions each person started on the pool this month.
 *  (d) A second add of one key says who put it in: by name, and whether that was the one adding.
 *  (e) A key OpenAI put out of budget (`spentUntil`, migration 0322) is nobody's next while the mark
 *      runs, is sent with the mark, and is the next again once the mark is behind — the page's
 *      "Out of budget · resets …" reads exactly this.
 *
 * Production code throughout: SharedPoolsService and ProvidersService over a real client. It only adds
 * rows, and refuses to run anywhere but the disposable server `coordinator-pg-test-safety` identifies.
 */

import 'reflect-metadata';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { ConflictException } from '@nestjs/common';
import { PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import { Client } from 'pg';

import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { RealtimeService } from '../realtime/realtime.service';
import { ProviderPlanUsageService } from './plan-usage.service';
import { choosePoolKey } from './pool-key-select';
import { ProvidersService } from './providers.service';
import { sharedPoolKeyCandidates, usageWindowStart } from './shared-pool';
import { SharedPoolsService } from './shared-pools.service';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'shared-pool-view-spec';

const realtime = new Proxy({}, { get: (_target, key) => (key === 'then' ? undefined : () => undefined) }) as RealtimeService;

const hex = () => randomUUID().replace(/-/g, '');
const openaiKey = () => `sk-proj-${hex()}${hex()}`;

interface Person {
  name: string;
  id: string;
  email: string;
  runnerId: string;
  workspaceId: string;
}

async function person(db: PrismaClient, name: string): Promise<Person> {
  const id = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const email = `${name}-${id}@shared-pool-view.invalid`;
  await db.user.create({ data: { id, email, name, passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId: id, name: `${name}-runner`, tokenHash: `x-${runnerId}`,
      status: RunnerStatus.ONLINE, maxConcurrent: 4, lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId: id, runnerId, name: `${name}-agent`, enabled: true, workDir: `/tmp/${name}` },
  });
  return { name, id, email, runnerId, workspaceId };
}

/** A session row written straight into the table: `owner`'s, on `provider`, and on `poolKeyId` if given. */
async function sessionOn(
  db: PrismaClient,
  owner: Person,
  provider: string,
  status: RunStatus,
  extra: { poolKeyId?: string; engineTurnActive?: boolean; createdAt?: Date } = {},
): Promise<string> {
  const session = await db.session.create({
    data: {
      title: 'shared pool view',
      prompt: 'hello',
      status,
      ownerId: owner.id,
      creatorId: owner.id,
      workspaceId: owner.workspaceId,
      assignedRunnerId: owner.runnerId,
      provider,
      providerBuiltin: provider === 'codex' || provider === 'claude',
      model: 'gpt-5.5',
      permissionMode: 'default',
      usesRuntimeDefaultModel: true,
      numTurns: 1,
      runtimeSessionId: randomUUID(),
      startedAt: new Date(),
      ...extra,
    },
    select: { id: true },
  });
  return session.id;
}

const suite = URL ? test : test.skip;

suite("a shared pool page's next key, running keys and session counts — on real PostgreSQL", { timeout: 600_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const providers = new ProvidersService(prisma, realtime, new ProviderPlanUsageService(realtime));
  const pools = new SharedPoolsService(prisma, realtime, providers);
  t.after(async () => {
    await db.$disconnect();
    await client.end();
  });

  const ann = await person(db, 'Ann');
  const mia = await person(db, 'Mia');
  // Max puts no key in: a member with none of their own runs on everybody else's.
  const max = await person(db, 'Max');
  const created = await pools.create(ann.id, { label: 'Team Codex' });
  const poolId = created.id;
  const slug = created.slug;
  for (const who of [mia, max]) await pools.addPerson(ann.id, poolId, { email: who.email });
  await pools.addKey(ann.id, poolId, { label: 'ann-org', apiKey: openaiKey(), shareCap: 20 });
  await pools.addKey(mia.id, poolId, { label: 'mia-org', apiKey: openaiKey(), shareCap: 30 });
  const keyIds = new Map(
    (await db.poolApiKey.findMany({ where: { poolId }, select: { id: true, label: true } })).map((key) => [key.label, key.id]),
  );
  const keyId = (label: string) => keyIds.get(label) ?? assert.fail(`no key ${label}`);
  const view = (who: Person) => pools.get(who.id, poolId);

  /** The labels `next` marks for `who` — and the claim's own choice for them, which it must equal. */
  async function next(who: Person): Promise<string[]> {
    const marked = (await view(who)).keys.filter((key) => key.next).map((key) => key.label);
    const { ownKeyFirst } = await db.providerPool.findUniqueOrThrow({ where: { id: poolId } });
    const now = new Date();
    const candidates = await sharedPoolKeyCandidates(db, poolId, now);
    const chosen = choosePoolKey(candidates, who.id, ownKeyFirst, null, now);
    assert.deepEqual(marked, chosen ? [chosen.label] : [], `${who.name}'s next is not the claim's choice`);
    return marked;
  }
  /** What `spender` ran on `label` this month, in dollars, as the gateway's ledger records it. */
  const spent = (spender: Person, label: string, dollars: number) =>
    db.poolUsage.create({
      data: {
        poolId,
        keyId: keyId(label),
        userId: spender.id,
        windowStart: usageWindowStart(new Date()),
        costMicros: BigInt(dollars * 1_000_000),
      },
    });

  await t.test("(a) next is the key a session the viewer starts now runs on: the claim's own choice, asked for them", async () => {
    // Own key first; somebody with none gets the roomiest of the others' ($30 of cap beats $20).
    assert.deepEqual(await next(ann), ['ann-org']);
    assert.deepEqual(await next(mia), ['mia-org']);
    assert.deepEqual(await next(max), ['mia-org']);

    // Max spends mia-org's whole cap: it is out for everyone but Mia, whose own use no cap limits.
    await spent(max, 'mia-org', 30);
    assert.deepEqual(await next(max), ['ann-org']);
    assert.deepEqual(await next(ann), ['ann-org']);
    assert.deepEqual(await next(mia), ['mia-org']);

    // ann-org spent to its cap too: nothing is left that Max may run on, so no key is his next.
    await spent(max, 'ann-org', 20);
    assert.deepEqual(await next(max), []);

    // A key its contributor switched off, or one OpenAI refused, is nobody's next — not even theirs.
    await pools.updateKey(mia.id, poolId, keyId('mia-org'), { enabled: false });
    assert.deepEqual(await next(mia), []);
    assert.equal(await pools.markKeyInvalid(keyId('ann-org')), true);
    assert.deepEqual(await next(ann), []);
    // A key back on is the next again.
    await pools.updateKey(mia.id, poolId, keyId('mia-org'), { enabled: true });
    assert.deepEqual(await next(mia), ['mia-org']);
  });

  await t.test('(b) running marks the keys a session on the pool is generating on now, and no other', async () => {
    const running = async (who: Person) =>
      (await view(who)).keys.filter((key) => key.running).map((key) => key.label);
    assert.deepEqual(await running(ann), []);

    const onMia = await sessionOn(db, max, slug, RunStatus.RUNNING, { poolKeyId: keyId('mia-org') });
    // What every person of the pool sees: it is the key's state, not the viewer's.
    for (const who of [ann, mia, max]) assert.deepEqual(await running(who), ['mia-org'], `${who.name}'s view`);

    // A session that finished is on the key no longer; a turn the engine started for itself is.
    await db.session.update({ where: { id: onMia }, data: { status: RunStatus.SUCCEEDED } });
    assert.deepEqual(await running(ann), []);
    await db.session.update({ where: { id: onMia }, data: { status: RunStatus.AWAITING_INPUT, engineTurnActive: true } });
    assert.deepEqual(await running(ann), ['mia-org']);
    await db.session.update({ where: { id: onMia }, data: { engineTurnActive: false } });
    assert.deepEqual(await running(ann), []);

    // Waiting to be dispatched is not running; nor is a session in the trash, nor one that moved off
    // the pool while the key it last ran on is still recorded for it.
    await sessionOn(db, mia, slug, RunStatus.PENDING, { poolKeyId: keyId('ann-org') });
    const trashed = await sessionOn(db, mia, slug, RunStatus.RUNNING, { poolKeyId: keyId('ann-org') });
    await db.session.update({ where: { id: trashed }, data: { deletedAt: new Date() } });
    await sessionOn(db, mia, 'codex', RunStatus.RUNNING, { poolKeyId: keyId('ann-org') });
    assert.deepEqual(await running(ann), []);
  });

  await t.test('(c) sessions counts what each person started on the pool this month', async () => {
    const counts = async (who: Person) =>
      Object.fromEntries((await view(who)).people.map((row) => [row.name, row.sessions]));
    const before = await counts(ann);
    await sessionOn(db, ann, slug, RunStatus.SUCCEEDED);
    await sessionOn(db, ann, slug, RunStatus.AWAITING_INPUT);
    // Another provider's session, and one of last month, are not this month's on the pool.
    await sessionOn(db, ann, 'codex', RunStatus.SUCCEEDED);
    const lastMonth = new Date(usageWindowStart(new Date()).getTime() - 24 * 60 * 60 * 1000);
    await sessionOn(db, ann, slug, RunStatus.SUCCEEDED, { createdAt: lastMonth });
    const after = await counts(mia);
    assert.deepEqual(after, { ...before, Ann: before.Ann + 2 });
    // (b) left one session of Max's on the pool and two of Mia's (one of them trashed — it still ran).
    assert.deepEqual(after, { Ann: 2, Mia: 2, Max: 1 });
  });

  await t.test('(d) a second add of one key says who put it in, and whether that was the one adding', async () => {
    const key = openaiKey();
    await pools.addKey(mia.id, poolId, { label: 'mia-second', apiKey: key });
    for (const [who, you] of [[max, false], [ann, false], [mia, true]] as const) {
      const refused = await pools
        .addKey(who.id, poolId, { label: 'again', apiKey: key })
        .then(() => assert.fail(`${who.name} put the same key in twice`))
        .catch((e: unknown) => e);
      assert.ok(refused instanceof ConflictException, String(refused));
      const body = refused.getResponse() as { code: string; message: string; addedBy: unknown };
      assert.equal(body.code, 'POOL_KEY_DUPLICATE');
      assert.deepEqual(body.addedBy, { name: 'Mia', you }, `${who.name}'s refusal`);
      assert.equal(JSON.stringify(body).includes(key), false, 'the refusal repeated the key');
    }
  });

  await t.test('(e) a key OpenAI put out of budget is nobody’s next while the mark runs, and carries it', async () => {
    // Mia's own key is the one she runs on — a contributor's own use is never capped — and the other one
    // of hers is Max's and Ann's next.
    assert.deepEqual(await next(mia), ['mia-org']);
    assert.deepEqual(await next(max), ['mia-second']);
    const until = new Date(Date.now() + 6 * 60 * 60 * 1000);
    assert.equal(await pools.markKeySpent(keyId('mia-org'), until), true);

    // The mark is the key's, not the viewer's: every person of the pool reads the same instant, which
    // is what the page's "Out of budget · resets …" is drawn from.
    for (const who of [ann, mia, max]) {
      const key = (await view(who)).keys.find((row) => row.label === 'mia-org');
      assert.equal(key?.spentUntil?.toISOString(), until.toISOString(), `${who.name}'s view`);
    }

    // Out of budget stops a person's own key, which no share cap does, so "own key first" gives way: Mia
    // moves off mia-org. Max and Ann were on mia-second already and stay.
    assert.deepEqual(await next(mia), ['mia-second']);
    assert.deepEqual(await next(max), ['mia-second']);

    // A mark already behind us is sent as none at all: what the page shows a key out of budget for is a
    // mark still running, and the claim takes the key back at once.
    assert.equal(await pools.markKeySpent(keyId('mia-org'), new Date(Date.now() - 60_000)), true);
    assert.equal((await view(mia)).keys.find((row) => row.label === 'mia-org')?.spentUntil, null);
    assert.deepEqual(await next(mia), ['mia-org']);

    // And a mark cleared — OpenAI's organization has budget again, which the gateway does on a request
    // that gets through — puts the key back the same way.
    assert.equal(await pools.markKeySpent(keyId('mia-org'), until), true);
    assert.equal(await pools.clearKeySpent(keyId('mia-org')), true);
    assert.equal((await view(mia)).keys.find((row) => row.label === 'mia-org')?.spentUntil, null);
    assert.deepEqual(await next(mia), ['mia-org']);
  });
});
