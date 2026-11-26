/**
 * A runner heartbeat's directory and disk probe of its workspaces neither moves the Open list's
 * version nor sends `sessions.list_changed` (migration 1428_open_list_workspace_probes), unless it
 * flips the disk gate's verdict for a queued session; a write of a column an Open list draws still
 * does both.
 *
 *  1. heartbeats: the probe as both heartbeat paths write it — the link's `directoryProbesSql`
 *     (writeLinkBeatReports) and the HTTPS route's per-workspace updateMany — run step by step. Each
 *     step asserts whether it moved the workspace counter, the version, and sent a hint, and what the
 *     queued row's `queuedReason` reads: free bytes moving on one side of the runner's floor, on a
 *     workspace with no queued session, the directory flags, the totals, `work_dir_probed_at` and a
 *     learned `repo_url` are silent; free bytes crossing the floor under a never-started PENDING
 *     session, either way or to "no reading", are not.
 *  2. drawn columns: a workspace's name, model, effort and clone_state, an owner change, an insert
 *     and a delete still move the version and send a hint, alone or beside a probe column.
 *  3. the row: every undrawn column changed at once, on the side of the floor it was on, leaves the
 *     Open list's rows as they were.
 *
 * scripts/run-pg-spec.sh src/apiserver/src/sessions/open-list-workspace-probes.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { MessageEvent } from '@nestjs/common';
import { PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { ControlEventType, type ControlEvent } from '@orbit/shared';
import { Client } from 'pg';
import { EventsController } from '../events/events.controller';
import { RUNNER_DISK_BELOW_FLOOR } from '../common/runner-disk-gate';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import { RealtimeService } from '../realtime/realtime.service';
import { linkBeatDigests, writeLinkBeatReports } from '../runner-api/link-heartbeat';
import { OPEN_LIST_UNDRAWN_WORKSPACE_COLUMNS, readOpenListVersion, readOpenListVersionParts } from './open-list-version';
import { SessionsService } from './sessions.service';
import { turnStateOfWord } from './session-turn-state';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

let safety: Promise<void> | undefined;
function verifyDisposableDatabase(): Promise<void> {
  if (safety) return safety;
  safety = (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const client = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await client.connect();
    try {
      await verifyCoordinatorPgIdentity(client);
    } finally {
      await client.end();
    }
  })();
  return safety;
}

function inert<T>(): T {
  return new Proxy({}, { get: () => () => undefined }) as T;
}

type T = { after: (fn: () => Promise<void> | void) => void };

/** The runner's Keep Free floor, and readings on either side of it. */
const FLOOR_MB = 1_000;
const ABOVE = 5e9;
const ABOVE_TOO = 4e9;
const BELOW = 5e8;
const BELOW_TOO = 4e8;

interface Fixture {
  db: PrismaClient;
  prisma: PrismaService;
  sessions: SessionsService;
  ownerId: string;
  runnerId: string;
  /** Holds `queuedId`: a PENDING session that has never run, so the disk gate reads its free bytes. */
  gatedId: string;
  /** Holds only a running session: no gate reads its free bytes. */
  freeId: string;
  queuedId: string;
}

async function fixture(t: T): Promise<Fixture> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  t.after(() => db.$disconnect());
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const gatedId = randomUUID();
  const freeId = randomUUID();
  const queuedId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `olw-${ownerId}@open-list-workspace.invalid`, name: 'olw', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'olw-runner', tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(), minFreeDiskMb: FLOOR_MB,
      // Room for the running session and the queued one, so the only gate left on the queued row is the disk.
      maxConcurrent: 4,
    },
  });
  await db.workspace.create({ data: { id: gatedId, ownerId, runnerId, name: 'olw-gated', workDir: '/srv/olw-gated', enabled: true } });
  await db.workspace.create({ data: { id: freeId, ownerId, runnerId, name: 'olw-free', workDir: '/srv/olw-free', enabled: true } });
  const session = (id: string, workspaceId: string, running: boolean) => db.session.create({
    data: {
      id, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title: `olw ${id}`,
      prompt: 'olw', provider: 'claude', model: 'claude-opus-5-5', providerBuiltin: true,
      turnState: turnStateOfWord(running ? RunStatus.RUNNING : RunStatus.PENDING),
      startedAt: running ? new Date() : null, lastTurnAt: new Date(),
      dispatchOrigin: SessionDispatchOrigin.USER,
    },
  });
  await session(queuedId, gatedId, false);
  await session(randomUUID(), freeId, true);
  const prisma = db as unknown as PrismaService;
  const sessions = new SessionsService(
    prisma,
    inert<ConstructorParameters<typeof SessionsService>[1]>(),
    inert<ConstructorParameters<typeof SessionsService>[2]>(),
  );
  return { db, prisma, sessions, ownerId, runnerId, gatedId, freeId, queuedId };
}

/** One `GET /api/events` stream that declared `hints=list_changed`, recording the hints it is sent. */
function hints(f: Fixture, t: T): Array<{ at: number; version: string }> {
  const realtime = new RealtimeService(f.prisma, { scheduleBadgeSync: () => undefined } as unknown as PushService);
  t.after(() => realtime.onModuleDestroy());
  const received: Array<{ at: number; version: string }> = [];
  const subscription = new EventsController(realtime).events({ userId: f.ownerId } as never, 'list_changed')
    .subscribe((m: MessageEvent) => {
      const event = m.data as ControlEvent;
      if (event.type === ControlEventType.SESSIONS_LIST_CHANGED) {
        received.push({ at: Date.now(), version: String((event.data as { version: string }).version) });
      }
    });
  t.after(() => subscription.unsubscribe());
  return received;
}

async function until(cond: () => boolean, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

async function workspaceCounter(f: Fixture): Promise<string> {
  return (await readOpenListVersionParts(f.prisma, f.ownerId)).epochs.workspace ?? '0';
}

async function queuedReason(f: Fixture): Promise<string | null> {
  const rows = await f.sessions.list(f.ownerId, { view: 'open' }) as Array<{ id: string; queuedReason?: string | null }>;
  const row = rows.find((r) => r.id === f.queuedId);
  assert.ok(row, 'the queued session is not on the Open list');
  return row.queuedReason ?? null;
}

interface Probe { agentId: string; workDir: string; exists: boolean; isGitRepo?: boolean; freeBytes?: number; totalBytes?: number; repoUrl?: string }

/** The link heartbeat's probe write (link-heartbeat.ts directoryProbesSql), one statement for every workspace. */
function linkBeat(f: Fixture, probes: Probe[]) {
  const dto = { agentDirProbes: probes };
  return writeLinkBeatReports(f.prisma, {
    runnerId: f.runnerId, leaseOwner: null, dto: dto as never, reports: ['agentDirProbes'],
    digests: linkBeatDigests(dto as never, {}), storedFacts: {}, storedPlanUsage: null, now: new Date(),
  });
}

/** The HTTPS heartbeat's probe write (runner-api.controller.ts heartbeat), one updateMany per workspace, as it writes it. */
async function httpsBeat(f: Fixture, probes: Probe[]) {
  const bytes = (v: number | undefined) => (v == null ? null : BigInt(Math.floor(v)));
  await Promise.all(probes.map(async (p) => {
    await f.db.workspace.updateMany({
      where: { id: p.agentId, runnerId: f.runnerId, deletedAt: null },
      data: {
        workDirExists: p.exists,
        workDirIsGit: p.exists ? p.isGitRepo : null,
        workDirFreeBytes: bytes(p.freeBytes),
        workDirTotalBytes: bytes(p.totalBytes),
        workDirProbedAt: new Date(),
      },
    });
    if (p.exists && p.isGitRepo && p.workDir && p.repoUrl) {
      await f.db.workspace.updateMany({
        where: { id: p.agentId, runnerId: f.runnerId, workDir: p.workDir, deletedAt: null, OR: [{ repoUrl: null }, { repoUrl: '' }] },
        data: { repoUrl: p.repoUrl },
      });
    }
  }));
}

/** Asserts a step's verdict: silent (no counter, no version, no hint) or loud (all three). */
function steps(f: Fixture, received: Array<{ version: string }>) {
  let version = '';
  let told = 0;
  const begin = async () => {
    assert.ok(await until(() => received.length === 1, 3_000), 'a new stream was not told the current version');
    told = received.length;
    version = await readOpenListVersion(f.prisma, f.ownerId);
  };
  const quiet = async (what: string, write: () => Promise<unknown>) => {
    const counter = await workspaceCounter(f);
    await write();
    assert.equal(await workspaceCounter(f), counter, `${what} moved the workspace counter`);
    assert.equal(await readOpenListVersion(f.prisma, f.ownerId), version, `${what} moved the Open list's version`);
    return what;
  };
  const loud = async (what: string, write: () => Promise<unknown>) => {
    const counter = await workspaceCounter(f);
    await write();
    assert.notEqual(await workspaceCounter(f), counter, `${what} did not move the workspace counter`);
    const after = await readOpenListVersion(f.prisma, f.ownerId);
    assert.notEqual(after, version, `${what} did not move the Open list's version`);
    assert.ok(await until(() => received.length > told, 2_500), `${what}: no sessions.list_changed within 2.5 s`);
    told = received.length;
    version = after;
  };
  /** The counters are summed once a second: three ticks with nothing to tell. */
  const noHintSince = async (silent: string[]) => {
    await sleep(3_200);
    assert.equal(received.length, told, `a hint was sent for probe writes alone (${silent.join(', ')})`);
  };
  return { begin, quiet, loud, noHintSince };
}

test('0. the undrawn workspace columns are the probe columns both heartbeats write', () => {
  assert.deepEqual([...OPEN_LIST_UNDRAWN_WORKSPACE_COLUMNS].sort(), [
    'repo_url', 'work_dir_exists', 'work_dir_free_bytes', 'work_dir_is_git', 'work_dir_probed_at', 'work_dir_total_bytes',
  ]);
});

test('1. heartbeats: probe writes are silent unless free bytes cross a queued session\'s disk floor', { skip, timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  const received = hints(f, t);
  const { begin, quiet, loud, noHintSince } = steps(f, received);
  await begin();
  assert.equal(await queuedReason(f), null, 'the queued session is held by some gate before any probe');

  const gated = (freeBytes: number | undefined, extra: Partial<Probe> = {}): Probe => ({
    agentId: f.gatedId, workDir: '/srv/olw-gated', exists: true, isGitRepo: true, freeBytes, totalBytes: 1e10, ...extra,
  });
  const free = (freeBytes: number | undefined, extra: Partial<Probe> = {}): Probe => ({
    agentId: f.freeId, workDir: '/srv/olw-free', exists: true, isGitRepo: true, freeBytes, totalBytes: 2e10, ...extra,
  });

  const silent: string[] = [];
  silent.push(await quiet('link: first probe, a repository learned, free bytes above the floor', () =>
    linkBeat(f, [gated(ABOVE, { repoUrl: 'https://example.invalid/olw.git' }), free(ABOVE)])));
  const learned = await f.db.workspace.findUniqueOrThrow({ where: { id: f.gatedId } });
  assert.equal(learned.repoUrl, 'https://example.invalid/olw.git', 'the link probe learned no repository');
  assert.equal(learned.workDirFreeBytes, BigInt(ABOVE));
  silent.push(await quiet('link: the same probe again (work_dir_probed_at alone)', () =>
    linkBeat(f, [gated(ABOVE), free(ABOVE)])));
  silent.push(await quiet('link: free and total bytes move above the floor', () =>
    linkBeat(f, [gated(ABOVE_TOO, { totalBytes: 1.1e10 }), free(ABOVE_TOO, { totalBytes: 2.1e10 })])));
  silent.push(await quiet('https: the same probe, written per workspace', () =>
    httpsBeat(f, [gated(ABOVE), free(ABOVE)])));
  silent.push(await quiet('https: the directory is no longer a repository, and is then gone', async () => {
    await httpsBeat(f, [free(ABOVE, { isGitRepo: false })]);
    await httpsBeat(f, [free(undefined, { exists: false, totalBytes: undefined })]);
  }));
  silent.push(await quiet('link: free bytes below the floor on a workspace no queued session reads', () =>
    linkBeat(f, [gated(ABOVE), free(BELOW)])));
  assert.equal(await queuedReason(f), null);
  await noHintSince(silent);

  await loud('link: free bytes drop below the floor under the queued session', () =>
    linkBeat(f, [gated(BELOW), free(BELOW_TOO)]));
  assert.equal(await queuedReason(f), RUNNER_DISK_BELOW_FLOOR, 'the gate did not hold the queued session');
  silent.length = 0;
  silent.push(await quiet('link: free bytes move below the floor (still held)', () =>
    linkBeat(f, [gated(BELOW_TOO), free(BELOW)])));
  silent.push(await quiet('https: free bytes move below the floor (still held)', () =>
    httpsBeat(f, [gated(BELOW)])));
  assert.equal(await queuedReason(f), RUNNER_DISK_BELOW_FLOOR);
  await noHintSince(silent);

  await loud('https: the reading is lost, so the gate lets go (fail-open)', () =>
    httpsBeat(f, [gated(undefined, { totalBytes: undefined })]));
  assert.equal(await queuedReason(f), null, 'no reading still held the queued session');
  await loud('link: a reading below the floor again', () => linkBeat(f, [gated(BELOW)]));
  assert.equal(await queuedReason(f), RUNNER_DISK_BELOW_FLOOR);
  await loud('link: free bytes back above the floor', () => linkBeat(f, [gated(ABOVE)]));
  assert.equal(await queuedReason(f), null);

  // Once the session has run, no gate reads the disk for it: the same crossing is silent.
  const toldBefore = received.length;
  await f.db.session.update({ where: { id: f.queuedId }, data: { turnState: 'IN_FLIGHT', startedAt: new Date() } });
  const started = await readOpenListVersion(f.prisma, f.ownerId);
  assert.ok(await until(() => received.length > toldBefore, 2_500), 'the session starting sent no hint');
  const counter = await workspaceCounter(f);
  await linkBeat(f, [gated(BELOW)]);
  assert.equal(await workspaceCounter(f), counter, 'free bytes crossing the floor of a session that has run moved the counter');
  assert.equal(await readOpenListVersion(f.prisma, f.ownerId), started);
});

test('2. drawn columns: a workspace\'s name, model, effort, clone state, owner, insert and delete still move the version', { skip, timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  const received = hints(f, t);
  const { begin, loud } = steps(f, received);
  await begin();
  const sql = (statement: string, ...args: unknown[]) => async () => {
    assert.equal(await f.db.$executeRawUnsafe(statement, ...args), 1, `${statement}: the write matched no row`);
  };
  await loud('workspace.name', sql(`UPDATE workspace SET name = 'renamed' WHERE id = $1::uuid`, f.gatedId));
  await loud('workspace.model with work_dir_probed_at', sql(
    `UPDATE workspace SET model = 'claude-sonnet-5-5', work_dir_probed_at = now() WHERE id = $1::uuid`, f.gatedId));
  await loud('workspace.effort with free bytes', sql(
    `UPDATE workspace SET effort = 'high', work_dir_free_bytes = 123 WHERE id = $1::uuid`, f.freeId));
  await loud('workspace.clone_state', sql(`UPDATE workspace SET clone_state = 'CLONING' WHERE id = $1::uuid`, f.gatedId));
  await loud('a column no list reads but no probe writes either (description)', sql(
    `UPDATE workspace SET description = 'olw' WHERE id = $1::uuid`, f.freeId));
  await loud('a workspace inserted', () => f.db.workspace.create({
    data: { ownerId: f.ownerId, runnerId: f.runnerId, name: 'olw-third', enabled: true },
  }));
  const other = randomUUID();
  await f.db.user.create({ data: { id: other, email: `olw-${other}@open-list-workspace.invalid`, name: 'olw2', passwordHash: 'x' } });
  const third = await f.db.workspace.findFirstOrThrow({ where: { ownerId: f.ownerId, name: 'olw-third' } });
  const otherBefore = (await readOpenListVersionParts(f.prisma, other)).epochs.workspace ?? '0';
  await loud('workspace.owner_id with work_dir_probed_at', sql(
    `UPDATE workspace SET owner_id = $2::uuid, work_dir_probed_at = now() WHERE id = $1::uuid`, third.id, other));
  assert.notEqual((await readOpenListVersionParts(f.prisma, other)).epochs.workspace ?? '0', otherBefore,
    'the owner a workspace joined was not bumped');
  const fourth = await f.db.workspace.create({ data: { ownerId: f.ownerId, runnerId: f.runnerId, name: 'olw-fourth', enabled: true } });
  await loud('a workspace deleted', sql(`DELETE FROM workspace WHERE id = $1::uuid`, fourth.id));
});

test('3. the row: every undrawn workspace column changed at once leaves the Open list\'s rows as they were', { skip, timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  await linkBeat(f, [{ agentId: f.gatedId, workDir: '/srv/olw-gated', exists: true, isGitRepo: true, freeBytes: ABOVE, totalBytes: 1e10 }]);
  const before = await f.sessions.list(f.ownerId, { view: 'open' });
  assert.ok((before as Array<{ id: string }>).some((r) => r.id === f.queuedId));
  const counter = await workspaceCounter(f);
  await f.db.$executeRawUnsafe(
    `UPDATE workspace SET work_dir_exists = NOT COALESCE(work_dir_exists, false), work_dir_is_git = false,
            work_dir_probed_at = now() + interval '1 minute', work_dir_free_bytes = $2::bigint,
            work_dir_total_bytes = 7, repo_url = 'https://example.invalid/other.git'
      WHERE id = $1::uuid`, f.gatedId, String(ABOVE_TOO),
  );
  assert.equal(await workspaceCounter(f), counter, 'a write of the undrawn columns alone moved the workspace counter');
  assert.deepEqual(await f.sessions.list(f.ownerId, { view: 'open' }), before);
});
