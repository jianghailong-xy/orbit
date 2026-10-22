/**
 * Installing Cursor CLI from Orbit, on a real PostgreSQL (project Cursor CLI native, the Install follow-up;
 * docs/cursor-runtime-contract.md §1, §16.1). Install and Reinstall are one request, POST
 * /runners/:id/install {engine: cursor}, relayed on the runner's heartbeat the way every engine's install
 * is. Only a runner that knows Cursor CLI — it declares provider:cursor, or reports the engine, installed
 * or not — is handed it; any other is refused at the start, and at the heartbeat when the process polling
 * stopped knowing it since, with the notice that says to update it, so nothing waits on a runner that
 * cannot act. The runner's own reports settle it, and the heartbeat that reports the pinned build retires
 * it — over another build too, which is what Reinstall is for. Every other engine's install is relayed as
 * it was. Named in scripts/test-cursor-install-relay.mjs; a missing server is a failure, not a skip.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { ValidationPipe } from '@nestjs/common';
import { RunnerStatus } from '@prisma/client';
import type { InstallCommand, RunnerInstallState } from '@orbit/shared';
import { Client } from 'pg';

import type { AuthUser } from '../common/current-user.decorator';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { CURSOR_RUNNER_UPGRADE_ERROR } from '../runner-api/runner-provider-support';
import { StartInstallDto } from './dto';
import { RunnersController } from './runners.controller';
import { RunnersService } from './runners.service';

const URL = process.env.COORDINATOR_PG_URL;

const PINNED = '2026.10.14-941492e';
/** What the runner says it runs for a Cursor CLI install (cursorInstallDescription, src/runner-go). */
const COMMAND = `download Cursor CLI ${PINNED} from downloads.cursor.com, check its pinned SHA-256 and unpack it into Orbit's own version directory`;
/** A release from before Cursor CLI: what it declares, and the engines it reports. */
const OLD_PROVIDERS = 'claude,codex,kimi,opencode,antigravity,dsh';
const OLD_ENGINES = ['claude', 'codex', 'kimi', 'opencode', 'antigravity', 'dsh'].map((engine) => ({ engine, installed: true, auth: 'unknown' }));
/** Cursor CLI as a release that knows it reports it: none installed, the pinned build, another build. */
const CURSOR_MISSING = { engine: 'cursor', installed: false, auth: 'unknown',
  installationError: `CURSOR_NOT_INSTALLED: Cursor CLI ${PINNED} is not installed in Orbit's version directory` };
const CURSOR_PINNED = { engine: 'cursor', installed: true, version: PINNED, auth: 'no',
  accounts: [{ id: 'default', name: 'Default', dir: '/home/runner/.orbit/cursor/default', auth: 'no' }] };
const CURSOR_ANOTHER = { engine: 'cursor', installed: true, version: '2026.10.16-e3cb207', auth: 'unknown',
  installationError: `CURSOR_VERSION_INCOMPATIBLE: Cursor CLI 2026.10.16-e3cb207 is installed, and Orbit runs exactly ${PINNED}` };
const SIX = ['claude', 'codex', 'kimi', 'antigravity', 'opencode', 'dsh'] as const;
const IDLE = { status: null, engine: null, command: null, message: null, mode: null };

test('Cursor install relay on PostgreSQL', { timeout: 300_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(URL);
  t.after(async () => {
    await db.$disconnect();
    await sql.end();
  });

  const drains: Record<string, unknown> = {
    drainCancellations: async () => [], drainMergeRequests: async () => [],
    drainCommitRequests: async () => [], drainArtifactRequests: async () => [],
  };
  const realtime = new Proxy(drains, { get: (target, name: string) => target[name] ?? (() => undefined) }) as unknown as RealtimeService;
  const prisma = db as unknown as PrismaService;
  const api = new RunnerApiController(prisma, new QueueService(prisma, realtime), realtime,
    { notifyEngineSignedOut: async () => undefined } as never, {} as never, {} as never);
  const runners = new RunnersController(new RunnersService(prisma, realtime));
  // The pipe main.ts installs.
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false });

  async function account(label: string) {
    const id = randomUUID();
    await db.user.create({ data: { id, email: `${label}-${id}@cursor-install-relay.invalid`, name: label, passwordHash: 'x' } });
    return id;
  }
  type Machine = { id: string; ownerId: string };
  /** A runner of `ownerId`'s that has not sent a heartbeat yet. */
  async function machine(ownerId: string): Promise<Machine> {
    const id = randomUUID();
    await db.runner.create({ data: {
      id, ownerId, name: 'cursor-install-relay', tokenHash: `x-${id}`, status: RunnerStatus.ONLINE, maxConcurrent: 4,
      lastHeartbeatAt: new Date(),
    } });
    return { id, ownerId };
  }
  /** One heartbeat of the machine's: what it declares and reports, and the install it is handed. */
  async function beat(at: Machine, providers: string, engines: unknown[]): Promise<InstallCommand | undefined> {
    const response = await api.heartbeat({ id: at.id, version: null },
      { status: 'ONLINE', idleCapacity: 1, engines } as never, 'session-worktree-ops-v1', providers);
    return response.installRequest;
  }
  /** POST /runners/:id/install as `ownerId`, from the raw JSON body on. */
  async function post(ownerId: string, at: Machine, body: Record<string, unknown>): Promise<RunnerInstallState> {
    const dto = (await pipe.transform(body, { type: 'body', metatype: StartInstallDto })) as StartInstallDto;
    return runners.startInstall({ userId: ownerId } as AuthUser, at.id, dto);
  }
  /** GET /runners/:id/install, as the row polls it. */
  const state = (at: Machine) => runners.installState({ userId: at.ownerId } as AuthUser, at.id);
  /** POST /runner/install-result, as the runner sends it. */
  const report = (at: Machine, body: Record<string, unknown>) => api.installResult({ id: at.id }, body as never);
  const stored = (at: Machine) => db.runner.findUniqueOrThrow({ where: { id: at.id } });
  const installColumns = async (at: Machine) => {
    const row = await stored(at);
    return [row.installStatus, row.installEngine, row.installCommand, row.installMessage, row.installAt?.toISOString() ?? null, row.installMode];
  };
  async function refusal(operation: Promise<unknown>): Promise<{ status: number; message: string }> {
    try {
      await operation;
    } catch (error) {
      const e = error as { getStatus?: () => number; message: string };
      assert.ok(e.getStatus, `not an HTTP refusal: ${String(error)}`);
      return { status: e.getStatus(), message: e.message };
    }
    assert.fail('the door accepted what it should have refused');
  }
  const cursorOf = async (at: Machine) =>
    ((await stored(at)).engines as Array<Record<string, unknown>> | null)?.find((engine) => engine.engine === 'cursor');

  await t.test('Cursor install relay: POST /runners/:id/install takes cursor and relays it to a runner that knows Cursor CLI, which reports the pinned build installed', async () => {
    const owner = await account('install');
    const at = await machine(owner);
    // A release that knows Cursor CLI with none installed: it reports the engine and does not declare it.
    assert.equal(await beat(at, OLD_PROVIDERS, [...OLD_ENGINES, CURSOR_MISSING]), undefined);

    assert.deepEqual(await post(owner, at, { engine: 'cursor' }), { status: 'pending', engine: 'cursor', command: null, message: null, mode: 'install' });
    const attempt = (await stored(at)).installAt!.toISOString();
    assert.deepEqual(await beat(at, OLD_PROVIDERS, [...OLD_ENGINES, CURSOR_MISSING]), { engine: 'cursor', attempt, mode: 'install' });
    await report(at, { status: 'installing', command: COMMAND });
    assert.equal(await beat(at, OLD_PROVIDERS, [...OLD_ENGINES, CURSOR_MISSING]), undefined, 'an install under way was handed over again');
    assert.deepEqual(await state(at), { status: 'installing', engine: 'cursor', command: COMMAND, message: null, mode: 'install' });
    await report(at, { status: 'done', command: COMMAND });
    assert.deepEqual(await state(at), { status: 'done', engine: 'cursor', command: COMMAND, message: null, mode: 'install' });

    // The heartbeat the runner sends right after: the pinned build, ready, and now declared.
    assert.equal(await beat(at, `${OLD_PROVIDERS},cursor`, [...OLD_ENGINES, CURSOR_PINNED]), undefined);
    assert.deepEqual(await state(at), IDLE);
    const cursor = await cursorOf(at);
    assert.deepEqual([cursor?.installed, cursor?.version, cursor?.installationError], [true, PINNED, undefined]);
    assert.ok((await stored(at)).capabilities.includes('provider:cursor'));
    const listed = (await runners.list({ userId: owner } as AuthUser) as Array<{ id: string; engines?: Array<{ engine: string; version?: string }> | null }>)
      .find((runner) => runner.id === at.id);
    assert.equal(listed?.engines?.find((engine) => engine.engine === 'cursor')?.version, PINNED);
  });

  await t.test('Cursor install relay: a runner that does not know Cursor CLI is refused with the upgrade notice and never handed the install', async () => {
    const owner = await account('older');
    const older = await machine(owner);
    await beat(older, OLD_PROVIDERS, OLD_ENGINES);
    const before = await installColumns(older);
    assert.deepEqual(await refusal(post(owner, older, { engine: 'cursor' })), { status: 400, message: CURSOR_RUNNER_UPGRADE_ERROR });
    assert.equal(CURSOR_RUNNER_UPGRADE_ERROR, 'Cursor CLI requires a newer Orbit runner with Cursor CLI support; update this runner first');
    assert.deepEqual(await installColumns(older), before, 'a refused start wrote to the runner');
    assert.equal(await beat(older, OLD_PROVIDERS, OLD_ENGINES), undefined);
    assert.deepEqual(await state(older), IDLE);

    // One that has never sent a heartbeat, and an engine no runner knows.
    const silent = await machine(owner);
    assert.deepEqual(await refusal(post(owner, silent, { engine: 'cursor' })), { status: 400, message: CURSOR_RUNNER_UPGRADE_ERROR });
    assert.equal((await refusal(post(owner, older, { engine: 'cursor-agent' }))).status, 400);
    assert.deepEqual(await installColumns(older), before);
    // Another owner's runner is not found, whatever it knows.
    const stranger = await account('stranger');
    const knows = await machine(stranger);
    await beat(knows, OLD_PROVIDERS, [...OLD_ENGINES, CURSOR_MISSING]);
    assert.equal((await refusal(post(owner, knows, { engine: 'cursor' }))).status, 404);
    assert.equal((await stored(knows)).installStatus, null);
  });

  await t.test('Cursor install relay: a heartbeat from a process that no longer knows Cursor CLI settles the install as failed instead of handing it over', async () => {
    const owner = await account('rolled-back');
    const at = await machine(owner);
    await beat(at, OLD_PROVIDERS, [...OLD_ENGINES, CURSOR_ANOTHER]);
    await post(owner, at, { engine: 'cursor' });
    // The runner went back to a release from before Cursor CLI between the start and its next heartbeat.
    assert.equal(await beat(at, OLD_PROVIDERS, OLD_ENGINES), undefined);
    assert.deepEqual(await state(at), { status: 'failed', engine: 'cursor', command: null, message: CURSOR_RUNNER_UPGRADE_ERROR, mode: 'install' });
    assert.equal(await beat(at, OLD_PROVIDERS, OLD_ENGINES), undefined, 'a settled install was handed over');
  });

  await t.test('Cursor install relay: Reinstall is the same request, and replaces another build once the runner reports the pinned one', async () => {
    const owner = await account('reinstall');
    const at = await machine(owner);
    // Another build in the pinned build's place: the runner reports it, and does not declare Cursor CLI.
    await beat(at, OLD_PROVIDERS, [...OLD_ENGINES, CURSOR_ANOTHER]);
    assert.equal((await cursorOf(at))?.installationError, 'CURSOR_VERSION_INCOMPATIBLE');

    assert.deepEqual(await post(owner, at, { engine: 'cursor' }), { status: 'pending', engine: 'cursor', command: null, message: null, mode: 'install' });
    const attempt = (await stored(at)).installAt!.toISOString();
    assert.deepEqual(await beat(at, OLD_PROVIDERS, [...OLD_ENGINES, CURSOR_ANOTHER]), { engine: 'cursor', attempt, mode: 'install' });
    await report(at, { status: 'installing', command: COMMAND });
    // A heartbeat still reporting the other build while the runner works does not retire it.
    assert.equal(await beat(at, OLD_PROVIDERS, [...OLD_ENGINES, CURSOR_ANOTHER]), undefined);
    assert.equal((await state(at)).status, 'installing');
    await report(at, { status: 'done', command: COMMAND });
    assert.equal(await beat(at, `${OLD_PROVIDERS},cursor`, [...OLD_ENGINES, CURSOR_PINNED]), undefined);
    assert.deepEqual(await state(at), IDLE);
    const cursor = await cursorOf(at);
    assert.deepEqual([cursor?.installed, cursor?.version, cursor?.installationError], [true, PINNED, undefined]);

    // A Reinstall the runner could not carry out says so, and the row shows the runner's words.
    await post(owner, at, { engine: 'cursor' });
    await beat(at, `${OLD_PROVIDERS},cursor`, [...OLD_ENGINES, CURSOR_PINNED]);
    const refused = `CURSOR_INSTALL_FAILED: the Cursor CLI ${PINNED} tarball from https://downloads.cursor.com/lab does not match its pinned size and SHA-256; nothing was installed`;
    await report(at, { status: 'installing', command: COMMAND });
    await report(at, { status: 'failed', command: COMMAND, message: refused });
    assert.deepEqual(await state(at), { status: 'failed', engine: 'cursor', command: COMMAND, message: refused, mode: 'install' });
  });

  await t.test('Cursor install relay: every other engine is installed exactly as before, with or without Cursor CLI on the runner', async () => {
    for (const [label, providers, engines] of [
      ['a release from before Cursor CLI', OLD_PROVIDERS, OLD_ENGINES],
      ['a release that runs it', `${OLD_PROVIDERS},cursor`, [...OLD_ENGINES, CURSOR_PINNED]],
    ] as const) {
      const owner = await account('others');
      const at = await machine(owner);
      await beat(at, providers, [...engines]);
      for (const engine of SIX) {
        assert.deepEqual(await post(owner, at, { engine }), { status: 'pending', engine, command: null, message: null, mode: 'install' }, `${label}: ${engine}`);
        const attempt = (await stored(at)).installAt!.toISOString();
        assert.deepEqual(await beat(at, providers, [...engines]), { engine, attempt, mode: 'install' }, `${label}: ${engine}`);
        await report(at, { status: 'installing', command: `install ${engine}` });
        await report(at, { status: 'done', command: `install ${engine}` });
        assert.equal(await beat(at, providers, [...engines]), undefined);
        assert.deepEqual(await state(at), IDLE, `${label}: ${engine} was not retired once the runner reported it installed`);
      }
    }
  });
});
