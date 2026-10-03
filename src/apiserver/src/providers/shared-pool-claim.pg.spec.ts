/**
 * What a runner is handed for a session on a shared Codex pool (migration 0321), on real PostgreSQL:
 *
 *  (1) The claim hands the runner the pool gateway as OPENAI_BASE_URL and a session token as
 *      OPENAI_API_KEY, on the codex runtime — and nothing of any key: the token equals no key of the pool
 *      in the clear or as stored, the payload carries none of them, and the database keeps only the
 *      token's hash, bound to the pool, the person and the session.
 *  (2) The key the session's requests go out on is chosen as pool-key-select.ts chooses — the person's
 *      own key first, then the most room, none spent to its share cap by the others, none switched off or
 *      refused by OpenAI — recorded as `session.pool_key_id`, and kept while it can run.
 *  (3) Every build of the engine's environment mints its own token — a restarted runner's reclaim, and
 *      the reload a switch onto the pool re-spawns with — and the earlier tokens of a session stay good,
 *      their expiry moved with the new one, since a warm engine may still be running on one.
 *  (4) A session of somebody not in the pool is handed nothing of it: no gateway, no token, no key.
 *  (5) The sign-in preflight counts the pool's token as the session's own credential: a runner whose own
 *      Codex login is signed out takes a pool session, and still refuses a built-in Codex one.
 *  (6) Removing a person, and deleting the pool, ends their tokens in the same statement.
 *  (7) A pool of one's own ChatGPT accounts takes people and API keys too (migration 0358), through the same
 *      doors: its owner is in it as its only admin, adds a person by the email of their Orbit account and
 *      adds a key. Every session of it runs on the account while it can and on a key when it cannot — the
 *      owner's on a login pool's token, the person added on a person's, no login pool token of theirs
 *      anywhere — and back on the account at the claim after it can again, each move saying so; the
 *      person's move names the account, since it is theirs to run on too (2026-10-03). Everyone taken out,
 *      it is "Just me" again: their keys and tokens are gone, and their session is handed nothing of the
 *      pool.
 *
 * Production code throughout: QueueService's claim, RunnerApiController's reclaim and inbox,
 * SessionsService, SharedPoolsService and ProvidersService. It only adds rows, and refuses to run anywhere
 * but the disposable server `coordinator-pg-test-safety` identifies.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus } from '@prisma/client';
import type { ClaimedSession } from '@orbit/shared';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { PrismaService } from '../prisma/prisma.service';
import { prismaClientFor } from '../prisma/prisma-client';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { EngineSignedOutConflict } from '../sessions/engine-signin-preflight';
import { SessionsService } from '../sessions/sessions.service';
import { ProviderPlanUsageService } from './plan-usage.service';
import { encryptSecret } from './provider-crypto';
import { ProvidersService } from './providers.service';
import { POOL_GATEWAY_TOKEN_TTL_MS } from './shared-pool';
import { SharedPoolsService } from './shared-pools.service';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'shared-pool-claim-spec';
// Where runners reach this deployment; the gateway lives under it.
process.env.PUBLIC_ORIGIN = 'https://orbit.shared-pool-claim.invalid/';
const GATEWAY = 'https://orbit.shared-pool-claim.invalid/api/gw/codex';

const realtime = new Proxy(
  {},
  { get: (_target, key) => (key === 'then' ? undefined : () => undefined) },
) as RealtimeService;

const hex = () => randomUUID().replace(/-/g, '');
/** Every key this spec puts in a pool, in the clear. */
const KEYS: string[] = [];
const openaiKey = () => {
  const key = `sk-proj-${hex()}${hex()}`;
  KEYS.push(key);
  return key;
};

interface Person {
  name: string;
  id: string;
  email: string;
  runnerId: string;
  workspaceId: string;
  /** What this person's agent was configured with: the whole env a claim may hand out beside the pool's. */
  env: Record<string, string>;
}

async function person(db: PrismaClient, name: string, engines?: unknown): Promise<Person> {
  const id = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const email = `${name}-${id}@shared-pool-claim.invalid`;
  const env = { ORBIT_SHARED_POOL_CLAIM_AGENT: name };
  await db.user.create({ data: { id, email, name, passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId: id, name: `${name}-runner`, tokenHash: `x-${runnerId}`,
      status: RunnerStatus.ONLINE, maxConcurrent: 4, lastHeartbeatAt: new Date(),
      ...(engines ? { engines: engines as never } : {}),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId: id, runnerId, name: `${name}-agent`, enabled: true, workDir: `/tmp/${name}`, env },
  });
  return { name, id, email, runnerId, workspaceId, env };
}

/** A session row written straight into the table, on `provider`. */
async function sessionOn(db: PrismaClient, owner: Person, provider: string, status: RunStatus): Promise<string> {
  const builtin = provider === 'codex' || provider === 'claude';
  const session = await db.session.create({
    data: {
      title: 'shared pool claim',
      prompt: 'hello',
      status,
      ownerId: owner.id,
      creatorId: owner.id,
      workspaceId: owner.workspaceId,
      assignedRunnerId: owner.runnerId,
      provider,
      providerBuiltin: builtin,
      model: 'gpt-5.5',
      permissionMode: 'default',
      usesRuntimeDefaultModel: true,
      ...(status === RunStatus.PENDING ? {} : { numTurns: 1, runtimeSessionId: randomUUID(), startedAt: new Date() }),
    },
    select: { id: true },
  });
  return session.id;
}

/** `value` as the text it goes over the wire as. */
const wire = (value: unknown) =>
  JSON.stringify(value ?? null, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

const suite = URL ? test : test.skip;

suite('a shared pool at the claim: the gateway and a session token, nothing of any key — on real PostgreSQL', { timeout: 600_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const client = new Client({ connectionString: URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  const usage = new ProviderPlanUsageService(realtime);
  const queue = new QueueService(prisma, realtime, usage);
  const sessions = new SessionsService(prisma, queue, realtime);
  const providers = new ProvidersService(prisma, realtime, usage);
  const pools = new SharedPoolsService(prisma, realtime, providers);
  const runnerApi = new RunnerApiController(
    db as never, queue as never, realtime as never, {} as never, {} as never, {} as never,
  );
  t.after(async () => {
    await db.$disconnect();
    await client.end();
  });

  /** The runner asking for work — which has to be `sessionId` — and the session parked again after. */
  async function claim(who: Person, sessionId: string): Promise<ClaimedSession> {
    await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.PENDING } });
    const claimed = await queue.claimSessionForRunner({ id: who.runnerId }, 0, false, false);
    assert.ok(claimed, 'the runner was offered no session');
    assert.equal(claimed.sessionId, sessionId);
    await db.session.update({ where: { id: sessionId }, data: { status: RunStatus.AWAITING_INPUT } });
    return claimed;
  }
  /** The runner's inbox poll, until it is handed the reload a provider switch queued. */
  async function dequeueReload(who: Person, sessionId: string) {
    const dequeue = (runnerApi as unknown as {
      dequeueTurn(sessionId: string, runnerId: string, leaseGeneration: string | null): Promise<
        { kind: string; env?: Record<string, string> } | null
      >;
    }).dequeueTurn.bind(runnerApi);
    for (let polls = 0; polls < 4; polls += 1) {
      const turn = await dequeue(sessionId, who.runnerId, null);
      assert.ok(turn, 'the inbox handed out nothing');
      if (turn.kind === 'reload') return turn;
    }
    throw new Error('the inbox never handed out the reload');
  }
  const keyOn = async (sessionId: string) =>
    (await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { poolKeyId: true } })).poolKeyId;
  const tokensOf = (sessionId: string) =>
    db.poolGatewayToken.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } });
  /** Every key's secret as the table stores it. */
  const ciphertexts = async () => (await db.poolApiKey.findMany({ select: { secretEncrypted: true } })).map((k) => k.secretEncrypted);
  /** What of any key a value carries: a key in the clear, a stored ciphertext, a fingerprint. */
  const keysIn = async (value: unknown) => {
    const text = wire(value);
    const stored = await db.poolApiKey.findMany({ select: { secretEncrypted: true, keyFingerprint: true } });
    return [
      ...KEYS.filter((key) => text.includes(key)).map(() => 'a key in the clear'),
      ...stored.filter((row) => text.includes(row.secretEncrypted)).map(() => 'a stored ciphertext'),
      ...stored.filter((row) => text.includes(row.keyFingerprint)).map(() => 'a fingerprint'),
      ...(/sk-proj-/.test(text) ? ['an sk- key'] : []),
    ];
  };

  const ann = await person(db, 'Ann');
  const mia = await person(db, 'Mia');
  const max = await person(db, 'Max');
  const otto = await person(db, 'Otto');
  const made = await pools.create(ann.id, { label: 'Team Codex' });
  const pool = { id: made.id, slug: made.slug };
  await pools.addPerson(ann.id, pool.id, { email: mia.email });
  await pools.addPerson(ann.id, pool.id, { email: max.email });
  // Ann's key has no cap; Mia's lets the others spend $10 a month on it.
  await pools.addKey(ann.id, pool.id, { label: 'Ann', apiKey: openaiKey() });
  await pools.addKey(mia.id, pool.id, { label: 'Mia', apiKey: openaiKey(), shareCap: 10 });
  const keyOf = async (who: Person) =>
    (await db.poolApiKey.findFirstOrThrow({ where: { poolId: pool.id, contributorId: who.id }, select: { id: true } })).id;
  const annKey = await keyOf(ann);
  const miaKey = await keyOf(mia);

  const miaSession = (await sessions.create(mia.id, {
    prompt: 'hello', title: 'on the pool', workspaceId: mia.workspaceId, provider: pool.slug,
  })).id;

  await t.test('(1) the claim hands the runner the gateway and a session token on codex — nothing of any key, and only its hash is kept', async () => {
    const claimed = await claim(mia, miaSession);
    assert.equal(claimed.provider, 'codex');
    assert.equal(claimed.agent.provider, 'codex');
    const token = claimed.agent.env?.OPENAI_API_KEY;
    assert.ok(token, 'no session token was handed out');
    assert.deepEqual(claimed.agent.env, { ...mia.env, OPENAI_BASE_URL: GATEWAY, OPENAI_API_KEY: token });
    assert.match(token, /^orbit-gw-[A-Za-z0-9_-]{43}$/);

    // It is no key of the pool's, in the clear or as stored, and the payload carries none of them.
    for (const key of KEYS) assert.notEqual(token, key);
    for (const stored of await ciphertexts()) assert.notEqual(token, stored);
    assert.deepEqual(await keysIn(claimed), []);

    // Only its hash is kept, bound to the pool, the person and the session.
    const [row, ...more] = await tokensOf(miaSession);
    assert.deepEqual(more, []);
    assert.deepEqual(
      { hash: row.tokenHash, poolId: row.poolId, userId: row.userId, revokedAt: row.revokedAt },
      { hash: sha256(token), poolId: pool.id, userId: mia.id, revokedAt: null },
    );
    assert.ok(Math.abs(row.expiresAt.getTime() - (row.createdAt.getTime() + POOL_GATEWAY_TOKEN_TTL_MS)) < 5_000);
    const handedOut: string = token;
    const { rows: tables } = await client.query<{ name: string }>(
      `SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY 1`,
    );
    assert.ok(tables.some((table) => table.name === 'pool_gateway_token'), 'the sweep did not read pool_gateway_token');
    for (const { name } of tables) {
      const found = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM "${name.replace(/"/g, '""')}" AS r WHERE strpos(r::text, $1) > 0`,
        [handedOut],
      );
      assert.equal(found.rows[0].n, 0, `${name} holds the session token in the clear`);
    }

    // Her own key first: the pool says so, and it can run.
    assert.equal(await keyOn(miaSession), miaKey);
  });

  await t.test('(2) the key: own first, then the most room, none spent to its cap by the others, none off or refused — and kept while it can run', async () => {
    const maxSession = await sessionOn(db, max, pool.slug, RunStatus.PENDING);
    // Max has no key: Ann's has no cap, all the room there is.
    await claim(max, maxSession);
    assert.equal(await keyOn(maxSession), annKey);

    // Ann switches hers off: the next claim moves to Mia's, $10 of room.
    await pools.updateKey(ann.id, pool.id, annKey, { enabled: false });
    await claim(max, maxSession);
    assert.equal(await keyOn(maxSession), miaKey);

    // The others spend Mia's cap: nothing is left for Max — but Mia's own use is never capped.
    await db.poolUsage.create({
      data: {
        poolId: pool.id, keyId: miaKey, userId: max.id,
        windowStart: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)),
        inputTokens: 1_000_000n, outputTokens: 100_000n, costMicros: 10_000_000n,
      },
    });
    // No key can run for him now: the session stays on the one it had, which the gateway refuses with
    // the reason, so the claim that later moves it can say which key it left.
    const empty = await claim(max, maxSession);
    assert.equal(await keyOn(maxSession), miaKey);
    assert.equal(empty.agent.env?.OPENAI_BASE_URL, GATEWAY, 'with no key for him, the session still goes to the gateway, which answers');
    await claim(mia, miaSession);
    assert.equal(await keyOn(miaSession), miaKey);

    // Ann's back on: it is Max's again. Refused by OpenAI (a 401), it is nobody's until replaced.
    await pools.updateKey(ann.id, pool.id, annKey, { enabled: true });
    await claim(max, maxSession);
    assert.equal(await keyOn(maxSession), annKey);
    assert.equal(await pools.markKeyInvalid(annKey), true);
    await claim(max, maxSession);
    assert.equal(await keyOn(maxSession), annKey, 'nothing else can run for him: he stays, refused by the gateway');
    await pools.replaceKey(ann.id, pool.id, annKey, { apiKey: openaiKey() });
    await claim(max, maxSession);
    assert.equal(await keyOn(maxSession), annKey);

    // Kept while it can run: with "own key first" off, Mia's session stays on her key, although Ann's has
    // more room for her now — and with it on, a session already on somebody else's key stays there too.
    await pools.update(ann.id, pool.id, { ownKeyFirst: false });
    await claim(mia, miaSession);
    assert.equal(await keyOn(miaSession), miaKey);
    const miaOther = await sessionOn(db, mia, pool.slug, RunStatus.PENDING);
    await claim(mia, miaOther);
    // No own-first: the most room, and both have all of it for her — the lower id.
    assert.equal(await keyOn(miaOther), [annKey, miaKey].sort()[0]);
    await pools.update(ann.id, pool.id, { ownKeyFirst: true });
    await claim(mia, miaOther);
    assert.equal(await keyOn(miaOther), [annKey, miaKey].sort()[0]);
  });

  await t.test('(3) a reclaim and a switch onto the pool each mint their own token; earlier ones stay good, moved out with the newest', async () => {
    const before = await tokensOf(miaSession);
    assert.ok(before.length >= 1);
    const reclaimed = (await runnerApi.reclaim({ id: mia.runnerId, ownerId: mia.id })).sessions.find((s) => s.sessionId === miaSession);
    assert.ok(reclaimed, 'the session on the pool was left out of the reclaim');
    const token = reclaimed.agent.env?.OPENAI_API_KEY;
    assert.deepEqual(reclaimed.agent.env, { ...mia.env, OPENAI_BASE_URL: GATEWAY, OPENAI_API_KEY: token });
    assert.deepEqual(await keysIn(reclaimed), []);
    const after = await tokensOf(miaSession);
    assert.equal(after.length, before.length + 1);
    assert.equal(after.at(-1)!.tokenHash, sha256(token!));
    assert.ok(!before.some((row) => row.tokenHash === sha256(token!)), 'the reclaim handed out a token already handed out');
    const expiry = after.at(-1)!.expiresAt.getTime();
    assert.deepEqual(after.map((row) => row.expiresAt.getTime()), after.map(() => expiry), 'an earlier token was left to expire first');

    // A live built-in Codex session switched onto the pool re-spawns on the gateway, with a token of its own.
    const live = await sessionOn(db, mia, 'codex', RunStatus.AWAITING_INPUT);
    await sessions.updateConfig(mia.id, live, { provider: pool.slug });
    const reload = await dequeueReload(mia, live);
    assert.deepEqual(reload.env, { ...mia.env, OPENAI_BASE_URL: GATEWAY, OPENAI_API_KEY: reload.env?.OPENAI_API_KEY });
    assert.deepEqual(await keysIn(reload), []);
    const [minted] = await tokensOf(live);
    assert.equal(minted.tokenHash, sha256(reload.env!.OPENAI_API_KEY!));
    assert.equal(await keyOn(live), miaKey);
  });

  await t.test('(4) a session of somebody not in the pool is handed nothing of it — whatever names the slug', async () => {
    const forged = await sessionOn(db, otto, pool.slug, RunStatus.PENDING);
    const claimed = await claim(otto, forged);
    assert.deepEqual(claimed.agent.env, otto.env, 'his runner was handed something of the pool');
    assert.deepEqual(await keysIn(claimed), []);
    assert.deepEqual(await tokensOf(forged), []);
    assert.equal(await db.poolGatewayToken.count({ where: { userId: otto.id } }), 0);
    assert.equal(await keyOn(forged), null);
    const reclaimed = (await runnerApi.reclaim({ id: otto.runnerId, ownerId: otto.id })).sessions.find((s) => s.sessionId === forged);
    assert.deepEqual(reclaimed?.agent.env, otto.env);
    assert.deepEqual(await tokensOf(forged), []);
  });

  await t.test("(5) the sign-in preflight counts the pool's token as the session's own credential", async () => {
    // A machine of Mia's whose own Codex login is signed out.
    const signedOut = await person(db, 'Mia-laptop', [{ engine: 'codex', installed: true, auth: 'no' }]);
    await db.workspace.update({ where: { id: signedOut.workspaceId }, data: { ownerId: mia.id } });
    await db.runner.update({ where: { id: signedOut.runnerId }, data: { ownerId: mia.id } });
    const onPool = await sessions.create(mia.id, {
      prompt: 'hello', title: 'on the pool, signed out', workspaceId: signedOut.workspaceId, provider: pool.slug,
    });
    assert.equal((await db.session.findUniqueOrThrow({ where: { id: onPool.id } })).provider, pool.slug);
    await assert.rejects(
      sessions.create(mia.id, { prompt: 'hello', title: 'on her login', workspaceId: signedOut.workspaceId, provider: 'codex' }),
      (e: unknown) => e instanceof EngineSignedOutConflict,
    );
  });

  await t.test('(6) a person removed, and the pool deleted, end their tokens at once; the sessions stay, and are handed nothing more', async () => {
    const maxSessions = await db.session.findMany({ where: { ownerId: max.id, provider: pool.slug }, select: { id: true } });
    assert.ok(await db.poolGatewayToken.count({ where: { userId: max.id } }) > 0);
    await pools.removePerson(ann.id, pool.id, max.id);
    assert.equal(await db.poolGatewayToken.count({ where: { userId: max.id } }), 0);
    const [first] = maxSessions;
    assert.deepEqual((await claim(max, first.id)).agent.env, max.env);

    assert.ok(await db.poolGatewayToken.count({ where: { poolId: pool.id } }) > 0);
    await pools.remove(ann.id, pool.id);
    assert.equal(await db.poolGatewayToken.count({ where: { poolId: pool.id } }), 0);
    assert.equal(await db.session.count({ where: { id: miaSession } }), 1);
    assert.deepEqual((await claim(mia, miaSession)).agent.env, mia.env);
  });

  await t.test("(7) a pool of one's own ChatGPT accounts takes people and keys: everyone in it runs on an account while one can and on a key when none can; everyone out is Just me again", async () => {
    const olga = await person(db, 'Olga');
    const pia = await person(db, 'Pia');
    const made = await providers.createPool(olga.id, { label: 'Olga Codex', engine: 'codex' });
    const own = { id: made.id, slug: made.slug };
    // Its owner is in it from the start, as its admin — the row the pool page's doors find them by.
    const peopleOf = async () =>
      (await db.providerPoolPerson.findMany({ where: { poolId: own.id }, orderBy: { createdAt: 'asc' } }))
        .map((row) => ({ userId: row.userId, role: row.role }));
    assert.deepEqual(await peopleOf(), [{ userId: olga.id, role: 'ADMIN' }]);
    // Her ChatGPT account, as the sign-in stores one.
    const accountId = `acct-${randomUUID()}`;
    const login = { access: `codex-access-${randomUUID()}`, refresh: `codex-refresh-${randomUUID()}` };
    await db.poolCodexLogin.create({
      data: {
        poolId: own.id, userId: olga.id, accountId, email: 'olga@codex-login.invalid', plan: 'plus',
        accessTokenEnc: encryptSecret(login.access), refreshTokenEnc: encryptSecret(login.refresh),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });

    // Pia added by the email of her Orbit account — a member: nobody but the owner is an admin of it.
    await pools.addPerson(olga.id, own.id, { email: pia.email });
    await assert.rejects(pools.addPerson(olga.id, own.id, { email: max.email, role: 'ADMIN' }), /one admin/);
    await assert.rejects(pools.setRole(olga.id, own.id, pia.id, { role: 'ADMIN' }), /one admin/);
    assert.deepEqual(await peopleOf(), [{ userId: olga.id, role: 'ADMIN' }, { userId: pia.id, role: 'MEMBER' }]);
    // A key from each of them: the owner's, and Pia's own while members may add one.
    await pools.addKey(olga.id, own.id, { label: 'olga-org', apiKey: openaiKey() });
    await pools.addKey(pia.id, own.id, { label: 'pia-proj', apiKey: openaiKey() });
    const keyOfOwn = async (who: Person) =>
      (await db.poolApiKey.findFirstOrThrow({ where: { poolId: own.id, contributorId: who.id }, select: { id: true } })).id;
    const olgaKey = await keyOfOwn(olga);
    const piaKey = await keyOfOwn(pia);
    // Pia sees it among the pools she runs on, and may pick it; Olga reads it as her own pool's people and keys.
    assert.ok((await pools.list(pia.id)).some((listed) => listed.id === own.id));
    assert.ok(!(await pools.list(olga.id)).some((listed) => listed.id === own.id), 'her own pool is on her providers page');
    const page = await pools.get(olga.id, own.id);
    assert.deepEqual(page.people.map((p) => [p.userId, p.role, p.creator]), [[olga.id, 'ADMIN', true], [pia.id, 'MEMBER', false]]);
    assert.deepEqual(page.keys.map((k) => k.label).sort(), ['olga-org', 'pia-proj']);
    // The page names her account to everyone in the pool (2026-10-03: it runs their sessions too), by its
    // email and `…AB12` — never by OpenAI's own id of it.
    assert.ok(wire(page).includes('olga@codex-login.invalid'), 'the page does not name her account');
    assert.ok(!wire(page).includes(accountId), "the page names OpenAI's account id");
    const usable = await providers.listUsable(pia.id);
    assert.deepEqual(usable.filter((p) => p.slug === own.slug).map((p) => p.runtime), ['codex']);

    // The doors that take a provider: neither of them refuses her the pool. With both keys switched off the
    // account can still run her sessions (2026-10-03), so it is still taken; with the account signed out
    // too it is refused in the words of somebody who can only ask its owner to sign in again.
    await db.poolApiKey.updateMany({ where: { poolId: own.id }, data: { enabled: false } });
    assert.equal(await queue.accountPoolRefusal(pia.id, own.slug), null, 'its account runs her sessions');
    assert.equal(await queue.accountPoolRefusal(olga.id, own.slug), null, "its owner's too");
    await db.poolCodexLogin.update({
      where: { poolId_accountId: { poolId: own.id, accountId } },
      data: { state: 'SIGNED_OUT' },
    });
    assert.equal(
      await queue.accountPoolRefusal(pia.id, own.slug),
      'the ChatGPT account olga@codex-login.invalid on the pool "Olga Codex" was rejected by OpenAI — '
        + "ask its owner to sign in again, on the pool's page, or pick another provider",
    );
    await db.poolCodexLogin.update({
      where: { poolId_accountId: { poolId: own.id, accountId } },
      data: { state: 'ACTIVE' },
    });
    await db.poolApiKey.updateMany({ where: { poolId: own.id }, data: { enabled: true } });

    const accountOn = async (sessionId: string) =>
      db.session.findUniqueOrThrow({
        where: { id: sessionId },
        select: { poolCodexAccountId: true, poolKeyId: true, poolSwitchNotice: true },
      });

    // Pia's session: on Olga's ChatGPT account — since 2026-10-03 the pool's accounts run the people its
    // owner added too — on a person's token; no login pool token of hers, and nothing of the account in
    // what her runner was handed (the credential itself never leaves the gateway).
    const piaSession = (await sessions.create(pia.id, {
      prompt: 'hello', title: "on Olga's pool", workspaceId: pia.workspaceId, provider: own.slug,
    })).id;
    const piaClaim = await claim(pia, piaSession);
    const piaToken = piaClaim.agent.env?.OPENAI_API_KEY;
    assert.match(piaToken ?? '', /^orbit-gw-[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(piaClaim.agent.env, { ...pia.env, OPENAI_BASE_URL: GATEWAY, OPENAI_API_KEY: piaToken });
    assert.deepEqual(await accountOn(piaSession), { poolCodexAccountId: accountId, poolKeyId: null, poolSwitchNotice: null });
    assert.equal(await db.poolLoginToken.count({ where: { OR: [{ userId: pia.id }, { sessionId: piaSession }] } }), 0);
    assert.deepEqual((await tokensOf(piaSession)).map((row) => [row.poolId, row.userId]), [[own.id, pia.id]]);
    for (const secret of [accountId, login.access, login.refresh, 'olga@codex-login.invalid']) {
      assert.ok(!wire(piaClaim).includes(secret), 'her claim carried something of the account');
    }
    assert.deepEqual(await keysIn(piaClaim), []);

    // Olga's session: on her account, on a login pool token.
    const olgaSession = (await sessions.create(olga.id, {
      prompt: 'hello', title: 'on my pool', workspaceId: olga.workspaceId, provider: own.slug,
    })).id;
    const olgaToken = (await claim(olga, olgaSession)).agent.env?.OPENAI_API_KEY;
    assert.match(olgaToken ?? '', /^orbit-gwl-/);
    assert.deepEqual(await accountOn(olgaSession), { poolCodexAccountId: accountId, poolKeyId: null, poolSwitchNotice: null });
    assert.equal(await db.poolLoginToken.count({ where: { sessionId: olgaSession, userId: olga.id } }), 1);

    // Her account's limit reached: the next claim puts her on a key — her own first — and says why; the
    // token is a login pool's still.
    await db.poolCodexLogin.update({
      where: { poolId_accountId: { poolId: own.id, accountId } },
      data: { spentUntil: new Date(Date.now() + 60 * 60 * 1000) },
    });
    assert.match((await claim(olga, olgaSession)).agent.env?.OPENAI_API_KEY ?? '', /^orbit-gwl-/);
    assert.deepEqual(await accountOn(olgaSession), {
      poolCodexAccountId: null,
      poolKeyId: olgaKey,
      poolSwitchNotice: 'Switched to olga-org — the usage limit on olga@codex-login.invalid is reached',
    });
    // While a key can run for her, a retry of a turn that failed there waits for nothing; the pool resumes now.
    assert.equal(await queue.loginPoolRetryAt(db, { ownerId: olga.id, provider: own.slug, poolCodexAccountId: null, poolKeyId: olgaKey }, new Date()), null);
    assert.ok((await queue.accountPoolResumesAt(olga.id, own.slug, new Date()))!.getTime() <= Date.now());
    // Pia's session was on the same account — it runs hers too — so the same limit moves her off it, onto a
    // key of her own and on her own token; the line names the account, as hers did.
    assert.match((await claim(pia, piaSession)).agent.env?.OPENAI_API_KEY ?? '', /^orbit-gw-/);
    assert.deepEqual(await accountOn(piaSession), {
      poolCodexAccountId: null,
      poolKeyId: piaKey,
      poolSwitchNotice: 'Switched to pia-proj — the usage limit on olga@codex-login.invalid is reached',
    });
    // For her too, a retry of a turn that failed on that account waits for nothing: her key can run.
    assert.equal(await queue.sharedPoolRetryAt(db, { ownerId: pia.id, provider: own.slug, poolCodexAccountId: null, poolKeyId: piaKey }, new Date()), null);
    assert.ok((await queue.accountPoolResumesAt(pia.id, own.slug, new Date()))!.getTime() <= Date.now());
    await db.session.updateMany({ where: { id: { in: [olgaSession, piaSession] } }, data: { poolSwitchNotice: null } });
    // The account can run again: back on it at the next claim — both of them, each on their own token.
    await db.poolCodexLogin.update({ where: { poolId_accountId: { poolId: own.id, accountId } }, data: { spentUntil: null } });
    await claim(olga, olgaSession);
    assert.deepEqual(await accountOn(olgaSession), {
      poolCodexAccountId: accountId,
      poolKeyId: null,
      poolSwitchNotice: 'Switched to olga@codex-login.invalid — your ChatGPT accounts come first',
    });
    await claim(pia, piaSession);
    assert.deepEqual(await accountOn(piaSession), {
      poolCodexAccountId: accountId,
      poolKeyId: null,
      poolSwitchNotice: "Switched to olga@codex-login.invalid — the pool's ChatGPT accounts come first",
    });
    assert.equal(await db.poolLoginToken.count({ where: { userId: pia.id } }), 0);

    // Everyone taken out: Just me again. Her key and her tokens go with her; the owner's key stays.
    assert.ok((await tokensOf(piaSession)).length > 0);
    await pools.removePerson(olga.id, own.id, pia.id);
    assert.deepEqual(await peopleOf(), [{ userId: olga.id, role: 'ADMIN' }]);
    assert.deepEqual(
      (await db.poolApiKey.findMany({ where: { poolId: own.id }, select: { id: true } })).map((row) => row.id),
      [olgaKey],
    );
    assert.equal(await db.poolGatewayToken.count({ where: { poolId: own.id, userId: pia.id } }), 0);
    assert.ok(!(await pools.list(pia.id)).some((listed) => listed.id === own.id));
    assert.deepEqual((await claim(pia, piaSession)).agent.env, pia.env, 'her runner was handed something of the pool');
    assert.deepEqual(await tokensOf(piaSession), []);
    // The owner's own session runs on as before.
    assert.match((await claim(olga, olgaSession)).agent.env?.OPENAI_API_KEY ?? '', /^orbit-gwl-/);
    assert.equal((await accountOn(olgaSession)).poolCodexAccountId, accountId);
  });
});
