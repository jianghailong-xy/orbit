import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { RunnerStatus, type InstallCommand, type RunnerInstallState } from '@orbit/shared';
import type { AuthUser } from '../common/current-user.decorator';
import { isInstallEngine } from '../common/runner-engines';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { CURSOR_RUNNER_UPGRADE_ERROR, runnerKnowsCursor } from '../runner-api/runner-provider-support';
import { StartInstallDto } from './dto';
import { RunnersController } from './runners.controller';
import { RunnersService } from './runners.service';

/**
 * Installing Cursor CLI on a runner from Orbit, Install and Reinstall alike: POST /runners/:id/install
 * {engine: cursor}, relayed on the runner's heartbeat the way every engine's install is
 * (docs/cursor-runtime-contract.md §1, §16.1). Only a runner that knows Cursor CLI — it declares
 * provider:cursor, or reports the engine, installed or not — is handed one. Any other is refused at the
 * start, and at the heartbeat for a process that stopped knowing it since, in the words that say to
 * update it; nothing is left to time out. Every other engine's install is what it was. Named in
 * scripts/test-cursor-install-relay.mjs, beside its PostgreSQL half (cursor-install-relay.pg.spec.ts).
 */

const OWNER = 'owner-1';
const RUNNER_ID = '11111111-1111-4111-8111-111111111111';
const USER = { userId: OWNER } as AuthUser;
const PINNED = '2026.10.14-941492e';
/** What a runner of a release that predates Cursor CLI declares, and the engines it reports. */
const OLD_PROVIDERS = 'claude,codex,kimi,opencode,antigravity,dsh';
const OLD_ENGINES = ['claude', 'codex', 'kimi', 'opencode', 'antigravity', 'dsh'].map((engine) => ({ engine, installed: true, auth: 'unknown' }));
/** Cursor CLI as a release that knows it reports it: none installed, the pinned build, another build. */
const CURSOR_MISSING = { engine: 'cursor', installed: false, auth: 'unknown',
  installationError: `CURSOR_NOT_INSTALLED: Cursor CLI ${PINNED} is not installed in Orbit's version directory` };
const CURSOR_PINNED = { engine: 'cursor', installed: true, version: PINNED, auth: 'no' };
const CURSOR_ANOTHER = { engine: 'cursor', installed: true, version: '2026.10.16-e3cb207', auth: 'unknown',
  installationError: `CURSOR_VERSION_INCOMPATIBLE: Cursor CLI 2026.10.16-e3cb207 is installed, and Orbit runs exactly ${PINNED}` };
const SIX = ['claude', 'codex', 'kimi', 'antigravity', 'opencode', 'dsh'] as const;

type Row = Record<string, unknown>;

/** A where clause as the relay's statements write one: equality, a Date, or `{ not: … }`. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, want]) => {
    const have = row[key];
    if (want instanceof Date) return have instanceof Date && have.getTime() === want.getTime();
    if (want && typeof want === 'object' && 'not' in want) return have != null && have !== (want as Row).not;
    return have === want;
  });
}

function harness(initial: Row = {}) {
  const row: Row = {
    id: RUNNER_ID, ownerId: OWNER, status: 'ONLINE', maxConcurrent: 4, minFreeDiskMb: null,
    capabilities: [], capabilitiesReportedAt: null, engines: null,
    installStatus: null, installEngine: null, installCommand: null, installMessage: null, installAt: null, installMode: null,
    ...initial,
  };
  const writes: Row[] = [];
  /** Run once, right after the heartbeat's drain has read the install slot. */
  let afterDrainRead: (() => void) | undefined;
  const prisma = {
    runner: {
      findFirst: async ({ where }: { where: Row }) => (matches(row, where) ? { ...row } : null),
      findUnique: async ({ where, select }: { where: Row; select?: Row }) => {
        const read = matches(row, where) ? { ...row } : null;
        if (select?.installAt && afterDrainRead) {
          const interleave = afterDrainRead;
          afterDrainRead = undefined;
          interleave();
        }
        return read;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        assert.ok(matches(row, where), 'update of a row that is not there');
        writes.push(data);
        Object.assign(row, data);
        return { ...row };
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        if (!matches(row, where)) return { count: 0 };
        writes.push(data);
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    workspace: { findMany: async () => [] },
    codexRateLimitResetOperation: { findMany: async () => [] },
  } as never;
  const realtime = { drainCancellations: async () => [], drainArtifactRequests: async () => [] } as never;
  const api = new RunnerApiController(prisma, {} as never, realtime, { notifyEngineSignedOut: async () => undefined } as never,
    {} as never, {} as never, { appendFor: async (_tx: unknown, _sessionId: unknown, content?: string) => content } as never);
  const runners = new RunnersController(new RunnersService(prisma));
  // The pipe main.ts installs.
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false });
  return {
    row,
    writes,
    interleave: (run: () => void) => { afterDrainRead = run; },
    /** POST /runners/:id/install, from the raw JSON body on. */
    async post(body: Row): Promise<RunnerInstallState> {
      const dto = (await pipe.transform(body, { type: 'body', metatype: StartInstallDto })) as StartInstallDto;
      return runners.startInstall(USER, RUNNER_ID, dto);
    },
    state: () => runners.installState(USER, RUNNER_ID),
    /** One heartbeat of the runner's: what it declares and reports, and the install it is handed. */
    async beat(providers: string, engines: unknown[]): Promise<InstallCommand | undefined> {
      const response = await api.heartbeat(
        { id: RUNNER_ID, version: null },
        { status: RunnerStatus.ONLINE, idleCapacity: 1, engines } as never,
        'session-worktree-ops-v1',
        providers,
      );
      return response.installRequest;
    },
    /** POST /runner/install-result, as the runner sends it. */
    report: (body: Row) => api.installResult({ id: RUNNER_ID }, body as never),
  };
}

function refusedWith(message: string) {
  return (error: unknown) => {
    assert.ok(error instanceof BadRequestException, String(error));
    assert.equal((error.getResponse() as { message?: unknown }).message, message);
    return true;
  };
}

test('Install relay: POST /runners/:id/install takes engine cursor, and the six engines it always took, and nothing else', async () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false });
  for (const engine of [...SIX, 'cursor']) {
    const dto = (await pipe.transform({ engine }, { type: 'body', metatype: StartInstallDto })) as StartInstallDto;
    assert.equal(dto.engine, engine);
    assert.equal(isInstallEngine(engine), true, `${engine} is not an install engine`);
  }
  for (const body of [{ engine: 'cursor-agent' }, { engine: 'Cursor' }, { engine: 'agent' }, { engine: '' }, {}, { engine: ['cursor'] }]) {
    await assert.rejects(pipe.transform(body, { type: 'body', metatype: StartInstallDto }), BadRequestException, JSON.stringify(body));
  }
  for (const value of ['cursor-agent', 'agy', '', null, undefined, 7]) assert.equal(isInstallEngine(value), false, String(value));
});

test('Install relay: a runner knows Cursor CLI when it declares provider:cursor or reports the engine, installed or not', () => {
  const at = new Date();
  assert.equal(runnerKnowsCursor({ capabilities: ['provider:cursor'], capabilitiesReportedAt: at, engines: null }), true);
  for (const cursor of [CURSOR_MISSING, CURSOR_PINNED, CURSOR_ANOTHER]) {
    assert.equal(runnerKnowsCursor({ capabilities: [], capabilitiesReportedAt: at, engines: [...OLD_ENGINES, cursor] }), true);
  }
  // A release that predates Cursor CLI: neither, and a report it never sent says nothing either.
  assert.equal(runnerKnowsCursor({ capabilities: OLD_PROVIDERS.split(',').map((p) => `provider:${p}`), capabilitiesReportedAt: at, engines: OLD_ENGINES }), false);
  assert.equal(runnerKnowsCursor({ capabilities: [], capabilitiesReportedAt: null, engines: null }), false);
  assert.equal(runnerKnowsCursor({ capabilities: ['provider:cursor'], capabilitiesReportedAt: null, engines: null }), false);
  assert.equal(runnerKnowsCursor({ capabilities: [], capabilitiesReportedAt: at, engines: [{ engine: 'cursor-agent', installed: true }] }), false);
  assert.equal(runnerKnowsCursor({ capabilities: [], capabilitiesReportedAt: at, engines: 'cursor' }), false);
});

test('Install relay: Cursor CLI is relayed to a runner that knows it, and settled by what the runner reports', async () => {
  const h = harness();
  // A release that knows Cursor CLI, with none installed: it reports the engine and does not declare it.
  assert.equal(await h.beat(OLD_PROVIDERS, [...OLD_ENGINES, CURSOR_MISSING]), undefined);
  const started = await h.post({ engine: 'cursor' });
  assert.deepEqual(started, { status: 'pending', engine: 'cursor', command: null, message: null, mode: 'install' });
  assert.equal(h.writes.at(-1)?.installEngine, 'cursor');
  const attempt = (h.row.installAt as Date).toISOString();

  const handed = await h.beat(OLD_PROVIDERS, [...OLD_ENGINES, CURSOR_MISSING]);
  assert.deepEqual(handed, { engine: 'cursor', attempt, mode: 'install' });
  // Redelivered until the runner's first report moves the row on.
  assert.deepEqual(await h.beat(OLD_PROVIDERS, [...OLD_ENGINES, CURSOR_MISSING]), handed);
  const command = 'download Cursor CLI 2026.10.14-941492e from downloads.cursor.com, check its pinned SHA-256 and unpack it into Orbit\'s own version directory';
  await h.report({ status: 'installing', command });
  assert.equal(await h.beat(OLD_PROVIDERS, [...OLD_ENGINES, CURSOR_MISSING]), undefined);
  assert.deepEqual(await h.state(), { status: 'installing', engine: 'cursor', command, message: null, mode: 'install' });
  await h.report({ status: 'done', command });
  // The heartbeat right after: the pinned build, ready, and now declared.
  assert.equal(await h.beat(`${OLD_PROVIDERS},cursor`, [...OLD_ENGINES, CURSOR_PINNED]), undefined);
  assert.deepEqual(await h.state(), { status: null, engine: null, command: null, message: null, mode: null });
  assert.equal(runnerKnowsCursor(h.row as never), true);
});

test('Install relay: a runner that does not know Cursor CLI is refused the start with the upgrade notice, and nothing is written', async () => {
  assert.equal(CURSOR_RUNNER_UPGRADE_ERROR, 'Cursor CLI requires a newer Orbit runner with Cursor CLI support; update this runner first');
  const h = harness();
  await h.beat(OLD_PROVIDERS, OLD_ENGINES);
  const before = h.writes.length;
  await assert.rejects(h.post({ engine: 'cursor' }), refusedWith(CURSOR_RUNNER_UPGRADE_ERROR));
  assert.equal(h.writes.length, before, 'a refused start wrote to the row');
  assert.equal(await h.beat(OLD_PROVIDERS, OLD_ENGINES), undefined);
  assert.equal((await h.state()).status, null);

  // One that never reported at all is no better.
  const silent = harness();
  await assert.rejects(silent.post({ engine: 'cursor' }), refusedWith(CURSOR_RUNNER_UPGRADE_ERROR));
  assert.equal(silent.writes.length, 0);
});

test('Install relay: the heartbeat of a process that does not know Cursor CLI settles a pending Cursor CLI install as failed and hands it nothing', async () => {
  const h = harness();
  await h.beat(OLD_PROVIDERS, [...OLD_ENGINES, CURSOR_ANOTHER]);
  await h.post({ engine: 'cursor' });
  // The runner went back to a release before Cursor CLI between the start and its next heartbeat.
  assert.equal(await h.beat(OLD_PROVIDERS, OLD_ENGINES), undefined);
  assert.deepEqual(await h.state(), { status: 'failed', engine: 'cursor', command: null, message: CURSOR_RUNNER_UPGRADE_ERROR, mode: 'install' });
  assert.equal(await h.beat(OLD_PROVIDERS, OLD_ENGINES), undefined, 'a settled install was handed over');

  // Only the install it read is settled: one started between that read and the write — Claude Code's,
  // say — stays as asked, and the next heartbeat hands it over.
  const raced = harness();
  await raced.beat(OLD_PROVIDERS, [...OLD_ENGINES, CURSOR_ANOTHER]);
  await raced.post({ engine: 'cursor' });
  const claudeAt = new Date((raced.row.installAt as Date).getTime() + 1_000);
  raced.interleave(() => Object.assign(raced.row, { installStatus: 'pending', installEngine: 'claude', installAt: claudeAt }));
  assert.equal(await raced.beat(OLD_PROVIDERS, OLD_ENGINES), undefined);
  assert.deepEqual(await raced.state(), { status: 'pending', engine: 'claude', command: null, message: null, mode: 'install' });
  assert.deepEqual(await raced.beat(OLD_PROVIDERS, OLD_ENGINES), { engine: 'claude', attempt: claudeAt.toISOString(), mode: 'install' });
});

test('Install relay: every other engine is started and handed over as before, whatever the runner knows of Cursor CLI', async () => {
  for (const [label, providers, engines] of [
    ['a release that predates Cursor CLI', OLD_PROVIDERS, OLD_ENGINES],
    ['a release that knows it', `${OLD_PROVIDERS},cursor`, [...OLD_ENGINES, CURSOR_PINNED]],
  ] as const) {
    for (const engine of SIX) {
      const h = harness();
      await h.beat(providers, [...engines]);
      const started = await h.post({ engine });
      assert.deepEqual(started, { status: 'pending', engine, command: null, message: null, mode: 'install' }, `${label}: ${engine}`);
      const handed = await h.beat(providers, [...engines]);
      assert.deepEqual(handed, { engine, attempt: (h.row.installAt as Date).toISOString(), mode: 'install' }, `${label}: ${engine}`);
    }
  }
  // Antigravity's own gate is the one it had.
  const h = harness();
  await h.beat('claude,codex,kimi,opencode,dsh', OLD_ENGINES);
  await assert.rejects(h.post({ engine: 'antigravity' }), refusedWith('Antigravity needs Orbit runner 0.1.209 or newer — updates itself when idle'));
});
