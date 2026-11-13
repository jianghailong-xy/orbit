/**
 * The maintenance settings' probe and the owner's run now (docs/wiki-repo-tiers-design.md §7.3, P3; contracts/wiki.contract.json
 * `maintenance.probe`, `maintenance.run`, `repoOps.kindRuns.probe`), against a real PostgreSQL:
 *
 *   1. the probe of a workspace asks its runner with the `probe` kind — no job behind it — and words the four answers the
 *      form draws: a git checkout of the space's repository, a folder that is not git, a folder that is not there, and
 *      another repository's clone (Turn on unavailable); a runner that is not beating is not asked, and the form says it
 *      could not check, with Turn on allowed;
 *   2. Turn on with a workspace whose folder is another repository's is refused WIKI_MAINTENANCE_WRONG_REPOSITORY and
 *      writes nothing; the same write with a checkout of the space's repository turns maintenance on;
 *   3. Check again and run now makes a run at once, due owner, counted against the day: another run not ended is 409
 *      WIKI_MAINTENANCE_RUNNING, and a day used up is 409 WIKI_MAINTENANCE_DAILY_LIMIT, which the health says too;
 *      Use this folder carries acceptFolder into the run's job.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/wiki/wiki-maintenance-probe.pg.spec.ts
 *
 * Not destructive: it writes only rows under its own account, and deletes them afterwards.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { after, test } from 'node:test';

import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import {
  WIKI_REPO_OP_CAPABILITY,
  WIKI_REPO_OP_FOLDER_CAPABILITY,
  WIKI_REPO_OP_PROBE_CAPABILITY,
  WIKI_REPO_OP_READ_CAPABILITY,
  WIKI_REPO_PROBE_COPY,
  wikiMaintenanceSettings,
  type WikiRepoProbeAnswer,
} from '@orbit/shared';
import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { claimWikiRepoOps, WikiRepoOps, type WikiRepoOpClaim } from '../wiki-worker/wiki-repo-ops';
import { WikiHealth } from './wiki-health';
import { probeWikiMaintenanceWorkspace } from './wiki-maintenance-probe';
import { runWikiMaintenanceNow, wikiMaintenanceRunsToday } from './wiki-maintenance-run';
import { setWikiMaintenance } from './wiki-maintenance-settings';
import { WikiRefusalError } from './wiki.service';

const URL_ = process.env.COORDINATOR_PG_URL;
const skip = !URL_;

const RUNNER_CAPABILITIES = [WIKI_REPO_OP_CAPABILITY, WIKI_REPO_OP_READ_CAPABILITY, WIKI_REPO_OP_FOLDER_CAPABILITY, WIKI_REPO_OP_PROBE_CAPABILITY];

interface Harness {
  sql: Client;
  prisma: PrismaClient;
  service: PrismaService;
  ops: WikiRepoOps;
  ownerId: string;
}

let harness: Promise<Harness> | undefined;

function boot(): Promise<Harness> {
  harness ??= (async () => {
    assertCoordinatorPgUrlIsIsolated(URL_);
    const sql = new Client({ connectionString: URL_, connectionTimeoutMillis: 5_000 });
    await sql.connect();
    await verifyCoordinatorPgIdentity(sql);
    const prisma = prismaClientFor(URL_ as string);
    const service = prisma as unknown as PrismaService;
    const ownerId = randomUUID();
    await prisma.user.create({ data: { id: ownerId, email: `wiki-probe-${ownerId}@wiki.invalid`, name: 'maintenance probe spec', passwordHash: 'x' } });
    return { sql, prisma, service, ops: new WikiRepoOps(service), ownerId };
  })();
  return harness;
}

after(async () => {
  if (!harness) return;
  const { prisma, sql, ownerId } = await harness;
  await prisma.wikiSpace.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.workspace.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.runner.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  await sql.end().catch(() => undefined);
});

interface Fixture {
  spaceId: string;
  workspaceId: string;
  runnerId: string;
  repo: string;
}

/** A space of a repository, and a workspace at ~/work/app on a machine named MacBook that answers the probe. */
async function fixture(h: Harness, over: { maintenance?: Record<string, unknown> } = {}): Promise<Fixture> {
  const runnerId = randomUUID();
  await h.prisma.runner.create({
    data: {
      id: runnerId, name: `MacBook ${runnerId.slice(0, 4)}`, ownerId: h.ownerId, tokenHash: `hash-${runnerId}`,
      capabilities: RUNNER_CAPABILITIES, capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  const workspaceId = randomUUID();
  await h.prisma.workspace.create({ data: { id: workspaceId, ownerId: h.ownerId, name: 'app', runnerId, workDir: '/home/me/work/app' } });
  const spaceId = randomUUID();
  const repo = `github.com/example/app-${spaceId.slice(0, 8)}`;
  await h.prisma.wikiSpace.create({
    data: {
      id: spaceId, ownerId: h.ownerId, slug: `probe-${spaceId.slice(0, 8)}`, title: 'app', repoUrlNorm: repo, rootCommitSha: 'c'.repeat(40),
      settings: { reviewMode: 'automatic', maintenance: over.maintenance ?? { enabled: false } } as never,
    },
  });
  await h.prisma.wikiSpaceWorkspace.create({ data: { spaceId, ownerId: h.ownerId, workspaceId } });
  return { spaceId, workspaceId, runnerId, repo };
}

type RunnerAnswer =
  | { state: 'succeeded'; result: Record<string, unknown> }
  | { state: 'failed'; error: string; reason: string };

/** The machine: its heartbeat claims the probe, and it answers as the runner's `wikiRepoOpProbe` would. */
async function answerProbe(h: Harness, fx: Fixture, answer: RunnerAnswer): Promise<WikiRepoOpClaim> {
  const leaseOwner = randomUUID();
  for (let i = 0; i < 400; i += 1) {
    const claims = await claimWikiRepoOps(h.service, { runnerId: fx.runnerId, leaseOwner, draining: false, capabilities: RUNNER_CAPABILITIES });
    const probe = claims.find((claim) => claim.kind === 'probe');
    if (probe) {
      await h.ops.applyWikiRepoOpResult({
        id: probe.id,
        runnerId: fx.runnerId,
        body: { claimGeneration: probe.claimGeneration, leaseOwner, ...answer },
      });
      return probe;
    }
    await delay(25);
  }
  throw new Error('no probe was asked of the runner');
}

/** The probe, answered by the machine as it is asked. */
async function probeAnswered(h: Harness, fx: Fixture, answer: RunnerAnswer): Promise<{ answer: WikiRepoProbeAnswer; claim: WikiRepoOpClaim }> {
  const [probe, claim] = await Promise.all([
    probeWikiMaintenanceWorkspace(h.service, { ownerId: h.ownerId, spaceId: fx.spaceId, workspaceId: fx.workspaceId, pollMs: 25 }),
    answerProbe(h, fx, answer),
  ]);
  return { answer: probe, claim };
}

const runnerName = async (h: Harness, fx: Fixture) => (await h.prisma.runner.findUniqueOrThrow({ where: { id: fx.runnerId } })).name;

test('the probe asks the runner with no job behind it, and words the four answers under the picker', { skip }, async () => {
  const h = await boot();
  const fx = await fixture(h);
  const runner = await runnerName(h, fx);

  const git = await probeAnswered(h, fx, { state: 'succeeded', result: { tier: 'git', origin: fx.repo } });
  // The operation the runner was handed: the probe kind, the workspace's folder, the space's repository to hold it to.
  assert.equal(git.claim.workDir, '/home/me/work/app');
  assert.equal(git.claim.repoUrlNorm, fx.repo);
  const row = await h.sql.query<{ kind: string; job_id: string | null; state: string }>(
    `SELECT "kind", "job_id", "state" FROM "wiki_repo_op" WHERE "id" = $1`, [git.claim.id]);
  assert.deepEqual(row.rows[0], { kind: 'probe', job_id: null, state: 'succeeded' }, 'a probe is no job\'s');
  assert.deepEqual(
    pick(git.answer),
    { tier: 'git', reason: null, origin: fx.repo, tone: 'ok', title: `Git checkout of ${fx.repo}`, note: null, canTurnOn: true },
  );

  const folder = await probeAnswered(h, fx, { state: 'succeeded', result: { tier: 'folder' } });
  assert.deepEqual(
    pick(folder.answer),
    { tier: 'folder', reason: null, origin: null, tone: 'folder', title: 'Folder, not git', note: 'Entries and code checks work. Commit anchors are not checked.', canTurnOn: true },
  );

  const missing = await probeAnswered(h, fx, {
    state: 'failed', reason: 'not_found', error: '/home/me/work/app was not found on this machine: stat /home/me/work/app: no such file or directory',
  });
  assert.deepEqual(pick(missing.answer), {
    tier: 'sessions', reason: 'not_found', origin: null, tone: 'paused', title: `~/work/app was not found on ${runner}`,
    note: 'Maintenance can still learn from sessions. Code checks wait until the folder is back.', canTurnOn: true,
  });
  assert.equal(missing.answer.note, WIKI_REPO_PROBE_COPY.pausedNote);

  const wrong = await probeAnswered(h, fx, {
    state: 'failed', reason: 'wrong_repository',
    error: `the checkout /home/me/work/app is a clone of github.com/x/y, not of the space's repository ${fx.repo}: nothing was read`,
  });
  assert.deepEqual(pick(wrong.answer), {
    tier: 'wrong_repository', reason: 'wrong_repository', origin: null, tone: 'wrong',
    title: '~/work/app is a clone of github.com/x/y, not this wiki\'s repository', note: null, canTurnOn: false,
  });

  // The machine away: nothing is asked of it, and the form says so with Turn on still allowed.
  await h.prisma.runner.update({ where: { id: fx.runnerId }, data: { lastHeartbeatAt: new Date(Date.now() - 60 * 60 * 1000) } });
  const before = await h.prisma.wikiRepoOp.count({ where: { spaceId: fx.spaceId } });
  const offline = await probeWikiMaintenanceWorkspace(h.service, { ownerId: h.ownerId, spaceId: fx.spaceId, workspaceId: fx.workspaceId });
  assert.deepEqual(pick(offline), {
    tier: null, reason: 'runner_offline', origin: null, tone: 'unchecked', title: `Could not check: ${runner} is offline`, note: null, canTurnOn: true,
  });
  assert.equal(await h.prisma.wikiRepoOp.count({ where: { spaceId: fx.spaceId } }), before, 'an offline runner is asked nothing');
  // A runner too old to answer the probe is not handed one either.
  await h.prisma.runner.update({
    where: { id: fx.runnerId },
    data: { lastHeartbeatAt: new Date(), capabilities: [WIKI_REPO_OP_CAPABILITY, WIKI_REPO_OP_READ_CAPABILITY] },
  });
  const old = await probeWikiMaintenanceWorkspace(h.service, { ownerId: h.ownerId, spaceId: fx.spaceId, workspaceId: fx.workspaceId });
  assert.equal(old.tone, 'unchecked');
  assert.equal(old.canTurnOn, true);
  assert.equal(await h.prisma.wikiRepoOp.count({ where: { spaceId: fx.spaceId } }), before);
});

test('Turn on with another repository\'s clone is refused WIKI_MAINTENANCE_WRONG_REPOSITORY and writes nothing; a checkout of the space\'s repository turns it on', { skip }, async () => {
  const h = await boot();
  const fx = await fixture(h);
  const turnOn = () => setWikiMaintenance(h.service, h.ownerId, fx.spaceId, { enabled: true, workspaceId: fx.workspaceId });

  const [refused] = await Promise.allSettled([
    turnOn(),
    answerProbe(h, fx, {
      state: 'failed', reason: 'wrong_repository',
      error: `the checkout /home/me/work/app is a clone of github.com/x/y, not of the space's repository ${fx.repo}: nothing was read`,
    }),
  ]);
  assert.equal(refused.status, 'rejected');
  const error = (refused as PromiseRejectedResult).reason;
  assert.ok(error instanceof WikiRefusalError, String(error));
  assert.equal(error.refusal.code, 'WIKI_MAINTENANCE_WRONG_REPOSITORY');
  assert.equal(error.getStatus(), 409);
  assert.match(error.refusal.message, /^~\/work\/app is a clone of github\.com\/x\/y, not this wiki's repository: /u);
  const stored = async () => wikiMaintenanceSettings(((await h.prisma.wikiSpace.findUniqueOrThrow({ where: { id: fx.spaceId } })).settings as Record<string, unknown>).maintenance);
  assert.equal((await stored()).enabled, false, 'nothing was written');
  assert.equal(await h.prisma.wikiCursor.count({ where: { spaceId: fx.spaceId } }), 0, 'no cursor was started');

  const [on] = await Promise.all([turnOn(), answerProbe(h, fx, { state: 'succeeded', result: { tier: 'git', origin: fx.repo } })]);
  assert.equal(on.enabled, true);
  assert.equal((await stored()).workspaceId, fx.workspaceId);
});

test('Check again and run now makes a run at once, counted against the day; another run not ended is 409 WIKI_MAINTENANCE_RUNNING, a day used up 409 WIKI_MAINTENANCE_DAILY_LIMIT', { skip }, async () => {
  const h = await boot();
  const fx0 = await fixture(h);
  const fx = { ...fx0 };
  await h.prisma.wikiSpace.update({
    where: { id: fx.spaceId },
    data: { settings: { reviewMode: 'automatic', maintenance: { enabled: true, workspaceId: fx.workspaceId, dailyRunLimit: 2 } } as never },
  });
  const runNow = (acceptFolder?: boolean) => runWikiMaintenanceNow(h.service, { ownerId: h.ownerId, spaceId: fx.spaceId, acceptFolder });
  const refusalOf = async (attempt: Promise<unknown>): Promise<{ code: string; status: number }> => {
    try {
      await attempt;
    } catch (error) {
      assert.ok(error instanceof WikiRefusalError, String(error));
      return { code: error.refusal.code, status: error.getStatus() };
    }
    return assert.fail('the run was made');
  };
  const today = async () => (await wikiMaintenanceRunsToday(h.service, h.ownerId, fx.spaceId)).used;
  assert.equal(await today(), 0);

  const first = await runNow();
  const run = await h.prisma.wikiMaintenanceRun.findUniqueOrThrow({ where: { id: first.runId } });
  assert.equal(run.due, 'owner');
  assert.equal(run.jobId, first.jobId);
  const job = await h.prisma.wikiJob.findUniqueOrThrow({ where: { id: first.jobId } });
  assert.deepEqual([job.kind, job.state, job.input], ['maintain', 'queued', { runId: first.runId }]);
  assert.equal(await today(), 1, 'the owner\'s run counts against the day');

  // One run of a space at a time.
  assert.deepEqual(await refusalOf(runNow()), { code: 'WIKI_MAINTENANCE_RUNNING', status: 409 });
  assert.equal(await h.prisma.wikiMaintenanceRun.count({ where: { spaceId: fx.spaceId } }), 1, 'the refused ask made nothing');

  // The first ends; Use this folder makes the second, whose job carries it to the snapshot.
  await endRun(h, first);
  const second = await runNow(true);
  assert.deepEqual((await h.prisma.wikiJob.findUniqueOrThrow({ where: { id: second.jobId } })).input, { runId: second.runId, acceptFolder: true });
  assert.equal(await today(), 2);
  await endRun(h, second);

  // The day is used up: refused, and the health says so — which is what greys the button and says Daily limit reached.
  assert.deepEqual(await refusalOf(runNow()), { code: 'WIKI_MAINTENANCE_DAILY_LIMIT', status: 409 });
  assert.equal(await today(), 2);
  const health = await new WikiHealth(h.service).read(h.ownerId, fx.spaceId);
  assert.equal(health.maintenance.dailyLimitReached, true);
});

/** A run's job ends, as the worker ends one. */
async function endRun(h: Harness, made: { jobId: string; runId: string }): Promise<void> {
  await h.prisma.wikiJob.update({ where: { id: made.jobId }, data: { state: 'succeeded', endedAt: new Date() } });
  await h.prisma.wikiMaintenanceRun.update({ where: { id: made.runId }, data: { startedAt: new Date(), endedAt: new Date(), outcome: 'succeeded' } });
}

function pick(answer: WikiRepoProbeAnswer): Omit<WikiRepoProbeAnswer, 'workspaceId' | 'checkedAt'> {
  const { workspaceId: _workspace, checkedAt: _checked, ...rest } = answer;
  return rest;
}
