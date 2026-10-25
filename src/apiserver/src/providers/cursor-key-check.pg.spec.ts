/**
 * A Cursor API key checked on a runner while somebody waits, on a real PostgreSQL (project P2 follow-up;
 * docs/cursor-runtime-contract.md §9; cursor-key-check-relay.ts). Connecting a Cursor key asks a runner of
 * the owner's that can check one — online, declaring cursor-key-check/v1, the pinned Cursor CLI installed —
 * through its own heartbeat, and answers what Cursor said: VALID, INVALID or UNREACHABLE, or NO_RUNNER when
 * no runner can ask or the one asked does not answer in time, after which the key can still be saved. Check
 * Again keeps the answer on a saved key, by compare-and-set on the key it read, so an answer about a key
 * replaced meanwhile is kept on nothing. The doors provider_create, provider_update and `orbit provider
 * create|update --runtime cursor` reach take a Cursor key. And no log line, event, database row, error or
 * API response holds a key being checked: the heartbeat of the runner that checks it is the one place it
 * goes. Named in scripts/test-cursor-key-check.mjs; a missing server is a failure, not a skip.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import { RunnerStatus } from '@prisma/client';
import { AgentProvider, type CursorKeyCheckAnswer, type CursorKeyRecheckAnswer, type RunnerHeartbeatResponse } from '@orbit/shared';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { RunnerProvidersController } from '../runner-api/runner-providers.controller';
import { CURSOR_KEY_CHECK_V1, cursorKeyCheckRelay } from './cursor-key-check-relay';
import { CreateModelProviderDto, UpdateModelProviderDto } from './dto';
import { decryptSecret } from './provider-crypto';
import { ProvidersService } from './providers.service';

const URL = process.env.COORDINATOR_PG_URL;
process.env.PROVIDER_SECRET_KEY ??= 'cursor-key-check-pg-spec';

/** A key shaped like a Cursor User API Key, and nothing else's: found anywhere, it leaked. */
const newKey = () => `key_p2fpg${randomUUID().replace(/-/g, '')}`;
const fingerprint = (key: string) => createHash('sha256').update(key.trim()).digest('hex').slice(0, 16);
/** A value as JSON, the way it goes over the wire: a BigInt column as its digits. */
const serialize = (value: unknown) => JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? String(v) : v));

/** Cursor CLI as a runner reports it: the pinned build, installed; another build; none. */
const PINNED = [{ engine: 'cursor', installed: true, version: '2026.10.14-941492e', auth: 'unknown' }];
const ANOTHER_BUILD = [{ ...PINNED[0], version: '2026.10.16-e3cb207',
  installationError: 'CURSOR_VERSION_INCOMPATIBLE: Cursor CLI 2026.10.16-e3cb207 is installed, and Orbit runs exactly 2026.10.14-941492e' }];
const NOT_INSTALLED = [{ engine: 'cursor', installed: false, auth: 'unknown',
  installationError: 'CURSOR_NOT_INSTALLED: Cursor CLI 2026.10.14-941492e is not installed in Orbit\'s version directory' }];
/** What a runner of this release declares; and one a release older than the check declares. */
const DECLARES = `session-worktree-ops-v1,${CURSOR_KEY_CHECK_V1}`;
const OLDER = 'session-worktree-ops-v1,cursor-account-login/v1';
const CURSOR_API = 'https://api2.cursor.sh';

test('P2 follow-up Cursor key check on PostgreSQL', { timeout: 600_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(URL);

  // Everything this process prints — every Nest logger and console line of every service the doors, the
  // heartbeat and the answers go through — is kept, so the last case can read it all for a key.
  const printed: string[] = [];
  const writes = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    printed.push(String(chunk));
    return (writes.out as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    printed.push(String(chunk));
    return (writes.err as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  const wait = cursorKeyCheckRelay.waitMs;
  t.after(async () => {
    cursorKeyCheckRelay.waitMs = wait;
    process.stdout.write = writes.out as typeof process.stdout.write;
    process.stderr.write = writes.err as typeof process.stderr.write;
    await db.$disconnect();
    await sql.end();
  });
  const SENTINEL = '[cursor-key-check] reading everything this process prints';
  console.log(SENTINEL);

  // Every realtime publication is kept the same way — a runner's wake among them; the drains answer nothing.
  const published: string[] = [];
  const drains: Record<string, unknown> = {
    drainCancellations: async () => [], drainMergeRequests: async () => [],
    drainCommitRequests: async () => [], drainArtifactRequests: async () => [],
  };
  const realtime = new Proxy(drains, {
    get: (target, name: string) => target[name] ?? ((...args: unknown[]) => {
      try {
        published.push(`${name} ${serialize(args)}`);
      } catch {
        published.push(`${name} ${String(args)}`);
      }
    }),
  }) as unknown as RealtimeService;
  const prisma = db as unknown as PrismaService;
  const queue = new QueueService(prisma, realtime);
  const providers = new ProvidersService(prisma, realtime, { snapshot: () => null } as never);
  const runnerProviders = new RunnerProvidersController(providers);
  const api = new RunnerApiController(prisma, queue, realtime, { notifyEngineSignedOut: async () => undefined } as never, {} as never, {} as never);

  /** Every answer a door gave, as its caller reads it — refusals included. */
  const responses: string[] = [];
  const answered = <T>(value: T): T => {
    responses.push(serialize(value));
    return value;
  };
  /** Every heartbeat a runner read: the one place a key being checked goes. */
  const beats: string[] = [];
  /** Every key used here; and those a runner was handed, each of which a heartbeat must hold. */
  const keys: string[] = [];
  const handed: string[] = [];
  const key = () => {
    const made = newKey();
    keys.push(made);
    return made;
  };

  async function refusal(operation: Promise<unknown>): Promise<{ status: number; code?: string; message: string }> {
    try {
      await operation;
    } catch (error) {
      const e = error as { getStatus?: () => number; getResponse?: () => unknown; message: string };
      assert.ok(e.getStatus, `not an HTTP refusal: ${String(error)}`);
      const body = (typeof e.getResponse?.() === 'object' ? e.getResponse!() : {}) as Record<string, unknown>;
      responses.push(serialize({ message: e.message, body }));
      return { status: e.getStatus(), code: body.code as string | undefined, message: e.message };
    }
    assert.fail('the door accepted what it should have refused');
  }
  async function account(label: string) {
    const id = randomUUID();
    await db.user.create({ data: { id, email: `${label}-${id}@cursor-key-check.invalid`, name: label, passwordHash: 'x' } });
    return id;
  }
  type Machine = { id: string; ownerId: string };
  /** A runner of `ownerId`'s, as its last heartbeat left it. */
  async function machine(ownerId: string, opts: { capabilities?: string[]; engines?: unknown; online?: boolean } = {}): Promise<Machine> {
    const id = randomUUID();
    await db.runner.create({ data: {
      id, ownerId, name: 'cursor-key-check', tokenHash: `x-${id}`,
      status: opts.online === false ? RunnerStatus.OFFLINE : RunnerStatus.ONLINE, maxConcurrent: 4,
      capabilities: opts.capabilities ?? DECLARES.split(','), capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: opts.online === false ? new Date(Date.now() - 3_600_000) : new Date(),
      engines: (opts.engines ?? PINNED) as never,
    } });
    return { id, ownerId };
  }
  /** One heartbeat of the machine's, declaring what `declares` says and reporting Cursor CLI as `engines` does. */
  async function beat(at: Machine, declares: string | undefined = DECLARES, engines: unknown = PINNED): Promise<RunnerHeartbeatResponse> {
    const response = await api.heartbeat(
      { id: at.id, version: null },
      { status: 'ONLINE', idleCapacity: 1, engines } as never,
      declares,
      'claude,codex,kimi,opencode,antigravity,dsh',
    );
    beats.push(serialize(response));
    for (const check of response.cursorKeyChecks ?? []) handed.push(check.apiKey);
    return response;
  }
  const wakes = (at: Machine) => published.filter((line) => line === `notifyRunnerWake ${JSON.stringify([at.id])}`).length;
  /** Waits until this machine has been woken `count` times in all. */
  async function woken(at: Machine, count: number): Promise<void> {
    for (let i = 0; i < 1_000 && wakes(at) < count; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(wakes(at), count, 'the runner was not woken to heartbeat now');
  }
  /** The runner's answer about a check it was handed (POST /runner/cursor-key-check-result). */
  const answer = (at: Machine, check: { checkId: string; apiKey: string }, state: string, about = check.apiKey) =>
    answered(runnerProviders.cursorKeyCheckResult(at as never, { checkId: check.checkId, state, keyFingerprint: fingerprint(about) }));
  /** Connects `apiKey` as `ownerId` (POST /providers/test). */
  const connect = async (ownerId: string, apiKey: string) =>
    answered(await providers.testConnection({ baseUrl: CURSOR_API, apiKey, runtime: 'cursor' }, ownerId)) as CursorKeyCheckAnswer;
  /** Saves `apiKey` as `ownerId`'s Cursor key, the way the connect page does. */
  const save = async (ownerId: string, apiKey: string) =>
    answered(await providers.create(ownerId, { label: 'Cursor', presetSlug: 'cursor-api', baseUrl: CURSOR_API, apiKey } as never)) as unknown as {
      id: string; slug: string;
    };
  const stored = (id: string) => db.modelProvider.findUniqueOrThrow({ where: { id }, select: { keyCheckState: true, keyCheckedAt: true, apiKeyEnc: true } });

  await t.test('P2 follow-up connecting a Cursor key answers VALID, INVALID or UNREACHABLE as Cursor said on a runner of the owner’s', async () => {
    const owner = await account('connect');
    const at = await machine(owner);
    for (const [i, said] of ['VALID', 'INVALID', 'UNREACHABLE'].entries()) {
      const typed = key();
      const pending = connect(owner, typed);
      await woken(at, i + 1);
      const { cursorKeyChecks } = await beat(at);
      assert.equal(cursorKeyChecks?.length, 1, 'the runner was not handed the key');
      assert.equal(cursorKeyChecks![0].apiKey, typed);
      assert.deepEqual(answer(at, cursorKeyChecks![0], said), { accepted: true });
      const result = await pending;
      assert.deepEqual({ ok: result.ok, keyCheck: result.keyCheck }, { ok: said === 'VALID', keyCheck: said });
      assert.ok(result.message.length > 0);
    }
    assert.equal(await db.modelProvider.count({ where: { ownerId: owner } }), 0, 'checking a key saved it');
  });

  await t.test('P2 follow-up with no runner that can check, connecting answers NO_RUNNER at once, and the key can still be saved', async () => {
    const owner = await account('no-runner');
    const typed = key();
    const started = Date.now();
    const none = await connect(owner, typed);
    assert.deepEqual({ ok: none.ok, keyCheck: none.keyCheck }, { ok: false, keyCheck: 'NO_RUNNER' });
    assert.match(none.message, /^No runner of yours can check Cursor keys right now/);
    assert.ok(Date.now() - started < 5_000, 'an answer with no runner to ask waited');

    // Runners that cannot: offline, a release older than the check, another build, none installed.
    const offline = await machine(owner, { online: false });
    const older = await machine(owner, { capabilities: OLDER.split(',') });
    const anotherBuild = await machine(owner, { engines: ANOTHER_BUILD });
    const notInstalled = await machine(owner, { engines: NOT_INSTALLED });
    await beat(older, OLDER);
    await beat(anotherBuild, DECLARES, ANOTHER_BUILD);
    await beat(notInstalled, DECLARES, NOT_INSTALLED);
    assert.equal(
      ((await db.runner.findUniqueOrThrow({ where: { id: anotherBuild.id } })).engines as Array<{ installationError?: string }>)[0].installationError,
      'CURSOR_VERSION_INCOMPATIBLE',
      'the heartbeat did not keep why the build there is not the pinned one',
    );
    const cannot = await connect(owner, typed);
    assert.equal(cannot.keyCheck, 'NO_RUNNER');
    assert.equal(wakes(offline), 0, 'an offline runner was woken');
    for (const [at, declares, engines] of [[older, OLDER, PINNED], [anotherBuild, DECLARES, ANOTHER_BUILD], [notInstalled, DECLARES, NOT_INSTALLED]] as const) {
      assert.equal(wakes(at), 0, 'a runner that cannot check was woken');
      assert.equal('cursorKeyChecks' in await beat(at, declares, engines), false, 'a runner that cannot check was handed a key');
    }

    // One that can, and never answers.
    const silent = await machine(owner);
    cursorKeyCheckRelay.waitMs = 300;
    try {
      const unanswered = await connect(owner, typed);
      assert.deepEqual({ keyCheck: unanswered.keyCheck, message: unanswered.message }, {
        keyCheck: 'NO_RUNNER',
        message: 'The runner asked to check this key didn’t answer in time. Save the key anyway, or try again.',
      });
    } finally {
      cursorKeyCheckRelay.waitMs = wait;
    }
    assert.equal(wakes(silent), 1);
    assert.equal('cursorKeyChecks' in await beat(silent), false, 'a key outlived the wait for its answer');

    // Saved anyway: the key is the owner's, unchecked until a runner checks it.
    const saved = await save(owner, typed);
    const row = await stored(saved.id);
    assert.equal(decryptSecret(row.apiKeyEnc), typed);
    assert.deepEqual({ state: row.keyCheckState, at: row.keyCheckedAt }, { state: null, at: null });
  });

  await t.test('P2 follow-up only a runner that declares cursor-key-check/v1 and has the pinned Cursor CLI is handed the key, on its own heartbeat', async () => {
    const owner = await account('gate');
    const stranger = await account('stranger');
    const older = await machine(owner, { capabilities: OLDER.split(',') });
    const notInstalled = await machine(owner, { engines: NOT_INSTALLED });
    const anotherBuild = await machine(owner, { engines: ANOTHER_BUILD });
    const theirs = await machine(stranger);
    const ready = await machine(owner);
    const typed = key();
    const pending = connect(owner, typed);
    await woken(ready, 1);
    for (const at of [older, notInstalled, anotherBuild, theirs]) assert.equal(wakes(at), 0, 'a runner that is not the one asked was woken');
    // None of them is handed the key, whatever it declares; nor an older process of the ready machine.
    assert.equal('cursorKeyChecks' in await beat(older, OLDER), false);
    assert.equal('cursorKeyChecks' in await beat(notInstalled, DECLARES, NOT_INSTALLED), false);
    assert.equal('cursorKeyChecks' in await beat(anotherBuild, DECLARES, ANOTHER_BUILD), false);
    assert.equal('cursorKeyChecks' in await beat(theirs), false);
    assert.equal('cursorKeyChecks' in await beat(ready, OLDER), false, 'a process that does not declare the check was handed a key');
    const { cursorKeyChecks } = await beat(ready);
    assert.equal(cursorKeyChecks?.[0]?.apiKey, typed);
    // Another runner's answer about it settles nothing; the one it was handed to settles it.
    assert.deepEqual(answer(theirs, cursorKeyChecks![0], 'INVALID'), { accepted: false });
    assert.deepEqual(answer(ready, cursorKeyChecks![0], 'VALID'), { accepted: true });
    assert.equal((await pending).keyCheck, 'VALID');
  });

  await t.test('P2 follow-up Check Again keeps the answer on the key, and an answer about a replaced key is kept on nothing', async () => {
    const owner = await account('again');
    const at = await machine(owner);
    const first = key();
    const saved = await save(owner, first);
    const again = () => providers.recheckCursorKey(owner, saved.id).then(answered) as Promise<CursorKeyRecheckAnswer>;

    // Cursor refuses it: kept on the key, and the owner's list says so.
    let pending = again();
    await woken(at, 1);
    let checks = (await beat(at)).cursorKeyChecks!;
    assert.equal(checks[0].apiKey, first);
    answer(at, checks[0], 'INVALID');
    const refused = await pending;
    assert.deepEqual({ keyCheck: refused.keyCheck, recorded: refused.recorded, state: refused.keyCheckState }, { keyCheck: 'INVALID', recorded: true, state: 'INVALID' });
    assert.ok(refused.keyCheckedAt && Date.now() - Date.parse(refused.keyCheckedAt) < 60_000);
    assert.equal((await stored(saved.id)).keyCheckState, 'INVALID');
    const listed = (answered(await providers.listMine(owner)) as unknown as Array<{ id: string; keyCheckState: string | null }>).find((row) => row.id === saved.id);
    assert.equal(listed?.keyCheckState, 'INVALID');
    assert.ok(published.some((line) => line.startsWith('publishForUser') && line.includes(saved.id)), 'the owner\'s clients were not told');

    // A new key is saved while the old one is being checked: the old one's answer is kept on nothing.
    pending = again();
    await woken(at, 2);
    checks = (await beat(at)).cursorKeyChecks!;
    assert.equal(checks[0].apiKey, first);
    const second = key();
    answered(await providers.update(owner, saved.id, { apiKey: second } as never));
    assert.equal(answer(at, checks[0], 'VALID').accepted, true);
    const stale = await pending;
    assert.deepEqual(
      { keyCheck: stale.keyCheck, recorded: stale.recorded, state: stale.keyCheckState, at: stale.keyCheckedAt },
      { keyCheck: 'VALID', recorded: false, state: null, at: null },
    );
    assert.deepEqual({ state: (await stored(saved.id)).keyCheckState, at: (await stored(saved.id)).keyCheckedAt }, { state: null, at: null });

    // Checked again, the new key's answer is kept.
    pending = again();
    await woken(at, 3);
    checks = (await beat(at)).cursorKeyChecks!;
    assert.equal(checks[0].apiKey, second, 'the runner was handed the old key');
    answer(at, checks[0], 'VALID');
    assert.deepEqual((({ keyCheck, recorded, keyCheckState }) => ({ keyCheck, recorded, keyCheckState }))(await pending),
      { keyCheck: 'VALID', recorded: true, keyCheckState: 'VALID' });

    // No runner to ask keeps nothing: the last answer stands.
    await db.runner.update({ where: { id: at.id }, data: { status: RunnerStatus.OFFLINE } });
    const nobody = await again();
    assert.deepEqual({ keyCheck: nobody.keyCheck, recorded: nobody.recorded, state: nobody.keyCheckState }, { keyCheck: 'NO_RUNNER', recorded: false, state: 'VALID' });
    assert.match(nobody.message, /The key is checked before a session starts on it\.$/);

    // What is no Cursor key is not checked; another owner's key is not found.
    const glm = answered(await providers.create(owner, { label: 'GLM', presetSlug: 'glm', baseUrl: 'https://api.z.ai/api/anthropic', apiKey: `sk-glm-${randomUUID()}` } as never)) as unknown as { id: string };
    const notCursor = await refusal(providers.recheckCursorKey(owner, glm.id));
    assert.deepEqual({ status: notCursor.status, code: notCursor.code }, { status: 400, code: 'NOT_A_CURSOR_KEY' });
    const other = await account('other');
    assert.equal((await refusal(providers.recheckCursorKey(other, saved.id))).status, 404);
  });

  await t.test('P2 follow-up MCP and the CLI create and update a Cursor key through the runner’s provider doors', async () => {
    const owner = await account('mcp');
    const at = await machine(owner);
    const runner = { id: at.id, ownerId: owner } as never;
    // What provider_create and `orbit provider create --runtime cursor` send (TestMCPProviderCreatesAndUpdatesACursorKey,
    // TestCLIProviderCreatesAndUpdatesACursorKey), through the validation the door applies.
    const first = key();
    const body = { label: 'Cursor', runtime: 'cursor', apiKey: first, presetSlug: 'cursor-api', baseUrl: CURSOR_API };
    assert.deepEqual(await validate(plainToInstance(CreateModelProviderDto, body), { whitelist: true, forbidNonWhitelisted: true }), []);
    const created = answered(await runnerProviders.create(runner, body as never)) as unknown as Record<string, unknown>;
    assert.deepEqual(
      { runtime: created.runtime, presetSlug: created.presetSlug, hasApiKey: created.hasApiKey, models: created.models, keyCheckState: created.keyCheckState },
      { runtime: AgentProvider.CURSOR, presetSlug: 'cursor-api', hasApiKey: true, models: [], keyCheckState: null },
    );
    assert.ok(!('apiKey' in created) && !('apiKeyEnc' in created), 'the answer carries the key');
    const slug = String(created.slug);
    assert.match(slug, /^cursor-api/);
    assert.equal(decryptSecret((await stored(String(created.id))).apiKeyEnc), first);
    const usable = (answered(await runnerProviders.list(runner)) as unknown as Array<{ slug: string; engines: string[] }>).find((p) => p.slug === slug);
    assert.deepEqual(usable?.engines, [AgentProvider.CURSOR], 'provider_list does not say it runs on Cursor CLI alone');

    // Checked, then given a new key through the update door — which is unchecked again.
    const pending = providers.recheckCursorKey(owner, String(created.id));
    await woken(at, 1);
    answer(at, (await beat(at)).cursorKeyChecks![0], 'VALID');
    assert.equal((await pending).keyCheckState, 'VALID');
    const second = key();
    const update = { runtime: 'cursor', apiKey: second };
    assert.deepEqual(await validate(plainToInstance(UpdateModelProviderDto, update), { whitelist: true, forbidNonWhitelisted: true }), []);
    const updated = answered(await runnerProviders.update(runner, slug, update as never)) as unknown as Record<string, unknown>;
    assert.deepEqual({ runtime: updated.runtime, keyCheckState: updated.keyCheckState }, { runtime: AgentProvider.CURSOR, keyCheckState: null });
    assert.equal(decryptSecret((await stored(String(created.id))).apiKeyEnc), second);
  });

  await t.test('P2 follow-up no log line, event, database row or API response holds a key being checked; only its runner’s heartbeat does', async () => {
    assert.ok(keys.length >= 8 && handed.length >= 6, `${keys.length} keys used, ${handed.length} handed over`);
    // The search finds a key where it is: the heartbeat that handed each one over holds it.
    for (const secret of handed) assert.ok(beats.some((sent) => sent.includes(secret)), 'a heartbeat holds the key it hands over');
    const { rows: tables } = await sql.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'");
    assert.ok(tables.length > 100, `${tables.length} tables`);
    for (const secret of keys) {
      for (const { table_name: table } of tables) {
        const { rows } = await sql.query(
          `SELECT count(*)::int AS n FROM "${table}" t WHERE position($1 in row_to_json(t)::text) > 0`, [secret]);
        assert.equal(rows[0].n, 0, `table ${table} holds a key in plaintext`);
      }
      for (const [where, texts] of [['an API response or refusal', responses], ['a realtime event', published], ['a log line', printed]] as const) {
        assert.ok(texts.length > 0, `nothing to read in ${where}`);
        assert.equal(texts.filter((text) => text.includes(secret)).length, 0, `${where} holds a key`);
      }
    }
    assert.ok(printed.some((line) => line.includes(SENTINEL)), 'the capture saw nothing this process printed');
  });
});
