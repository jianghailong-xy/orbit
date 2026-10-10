/**
 * The trigger of a server-executed maintenance run (contracts/wiki.contract.json
 * `maintenance.job.server.trigger`, `space.settings.maintenance.channel`; design §5.1 and §8, P8), against a
 * real PostgreSQL:
 *
 *   1. a fact that finds a space due makes a `maintain` wiki job and the run row that names it, and no task
 *      at all — where the same fact under the default `runner` mode makes the maintenance task it always
 *      made and no job;
 *   2. the settings door asks no provider of an account the server executes: a space whose maintenance names
 *      a provider no run could start on ('claude', the machine's own sign-in) is turned on by `server` and
 *      `canary`, and refused by `runner` as it always was;
 *   3. the runner door hands a server-executed account neither its run context nor its dossiers: both routes
 *      answer 409 WIKI_SERVER_EXECUTES;
 *   4. the end of a server run that queued its space's articles job asks for the next round (the owner's decision of
 *      2026-10-10): in the canary's own order — the articles job queued at T, the worker's pass at T+5 s, the owner's
 *      next event at T+15 s or T+100 s — the round is made at the end, right behind the articles job, and runs first;
 *      and a run whose end leaves the space no longer due makes none, its articles job running at the next pass.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/wiki/wiki-maintain-trigger.pg.spec.ts
 *
 * Not destructive: it writes only rows under its own account, spaces and sessions, and deletes them
 * afterwards.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';

import type { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { BadRequestException } from '@nestjs/common';

import { prismaClientFor } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { RunnerWikiMaintainController } from '../runner-api/runner-wiki-maintain.controller';
import { RunnerWikiMaintenanceController } from '../runner-api/runner-wiki-maintenance.controller';
import { claimWikiJobs, succeedWikiJob, type ClaimedWikiJob } from '../wiki-worker/wiki-jobs';
import { WikiRefusalError, WikiService } from './wiki.service';
import { WikiMaintenance } from './wiki-maintenance';
import { setWikiMaintenance } from './wiki-maintenance-settings';
import { considerWikiMaintenance, finishWikiMaintenanceJob } from './wiki-maintenance-run';

const URL_ = process.env.COORDINATOR_PG_URL;
const skip = !URL_;

interface Harness {
  sql: Client;
  prisma: PrismaClient;
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
    const ownerId = randomUUID();
    await prisma.user.create({ data: { id: ownerId, email: `wiki-maintain-trigger-${ownerId}@wiki.invalid`, name: 'maintain trigger spec', passwordHash: 'x' } });
    return { sql, prisma, ownerId };
  })();
  return harness;
}

after(async () => {
  if (!harness) return;
  const { prisma, sql, ownerId } = await harness;
  delete process.env.ORBIT_WIKI_EXECUTOR;
  delete process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS;
  await prisma.wikiSpace.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.session.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.workspace.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.runner.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.taskList.deleteMany({ where: { ownerId } }).catch(() => undefined);
  await prisma.user.deleteMany({ where: { id: ownerId } }).catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  await sql.end().catch(() => undefined);
});

interface Fixture {
  spaceId: string;
  workspaceId: string;
  runnerId: string;
  listId: string;
  sessionId: string;
}

/**
 * One space of its own with a workspace bound to it and a session that came to rest a day and an hour ago:
 * a fact after the cursor, past the settle grace, and old enough for the space to be due by age.
 */
async function fixture(h: Harness, over: { settings?: Record<string, unknown> } = {}): Promise<Fixture> {
  const runnerId = randomUUID();
  await h.prisma.runner.create({
    data: { id: runnerId, name: `trigger-${runnerId.slice(0, 8)}`, ownerId: h.ownerId, tokenHash: `hash-${runnerId}`, lastHeartbeatAt: new Date() },
  });
  const workspaceId = randomUUID();
  await h.prisma.workspace.create({
    data: { id: workspaceId, ownerId: h.ownerId, name: 'trigger checkout', runnerId, workDir: '/tmp/trigger-spec' },
  });
  const spaceId = randomUUID();
  // The hidden «Wiki maintenance» list the runner path makes its task in; the server path makes none.
  const listId = randomUUID();
  await h.prisma.taskList.create({ data: { id: listId, ownerId: h.ownerId, title: 'Wiki maintenance', hidden: true, maxConcurrent: 1 } });
  await h.prisma.wikiSpace.create({
    data: {
      id: spaceId, ownerId: h.ownerId, slug: `trigger-${spaceId.slice(0, 8)}`, title: 'app',
      repoUrlNorm: `github.com/example/trigger-${spaceId.slice(0, 8)}`, rootCommitSha: 'b'.repeat(40),
      settings: (over.settings ?? { reviewMode: 'manual', maintenance: { enabled: true, workspaceId, provider: 'local-vllm', listId } }) as never,
    },
  });
  await h.prisma.wikiSpaceWorkspace.create({ data: { spaceId, ownerId: h.ownerId, workspaceId } });
  const sessionId = randomUUID();
  const settled = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await h.prisma.session.create({
    data: {
      id: sessionId, title: 'a settled session', prompt: 'p', ownerId: h.ownerId, creatorId: h.ownerId,
      dispatchOrigin: 'USER', status: 'SUCCEEDED', workspaceId, assignedRunnerId: runnerId, lastTurnAt: settled,
    },
  });
  return { spaceId, workspaceId, runnerId, listId, sessionId };
}

/** The spaces and maintenance lists a case leaves behind are its own; the next case makes new ones. */

test('a fact that finds a space due makes a maintain job and its run row, and no task, under server execution', { skip }, async () => {
  const h = await boot();
  process.env.ORBIT_WIKI_EXECUTOR = 'server';
  delete process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS;
  const fx = await fixture(h);

  const outcome = await considerWikiMaintenance(h.prisma as unknown as PrismaService, h.ownerId, fx.spaceId, {
    sessionIds: [fx.sessionId], taskIds: [],
  });
  assert.equal(outcome.made, true, JSON.stringify(outcome));
  if (!outcome.made) return;
  assert.equal(outcome.taskId, null, 'no maintenance task is made');
  assert.ok(outcome.jobId, 'the run is a wiki job');
  const tasks = await h.prisma.task.count({ where: { ownerId: h.ownerId, listId: fx.listId } });
  assert.equal(tasks, 0, 'the hidden list the runner path would use holds no task');
  const job = await h.prisma.wikiJob.findFirstOrThrow({ where: { id: outcome.jobId! } });
  assert.equal(job.kind, 'maintain');
  assert.equal(job.state, 'queued');
  assert.deepEqual(job.input, { runId: outcome.runId });
  const run = await h.prisma.wikiMaintenanceRun.findFirstOrThrow({ where: { id: outcome.runId } });
  assert.equal(run.jobId, outcome.jobId);
  assert.equal(run.taskId, null);
  assert.equal(run.due, outcome.due);
  assert.equal(run.expectRef, outcome.expect === null ? null : run.expectRef);
  assert.ok(run.expectAt, 'the position the run expects is on its row');
  // And a second fact of the same space makes nothing: the unfinished job holds it.
  const again = await considerWikiMaintenance(h.prisma as unknown as PrismaService, h.ownerId, fx.spaceId, {
    sessionIds: [fx.sessionId], taskIds: [],
  });
  assert.deepEqual(again, { made: false, spaceId: fx.spaceId, why: 'unfinished' });
});

test('the same fact under the default runner mode makes the maintenance task it always made, and no job', { skip }, async () => {
  const h = await boot();
  delete process.env.ORBIT_WIKI_EXECUTOR;
  delete process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS;
  const fx = await fixture(h);

  const outcome = await considerWikiMaintenance(h.prisma as unknown as PrismaService, h.ownerId, fx.spaceId, {
    sessionIds: [fx.sessionId], taskIds: [],
  });
  assert.equal(outcome.made, true, JSON.stringify(outcome));
  if (!outcome.made) return;
  assert.ok(outcome.taskId, 'the runner path makes a task');
  assert.equal(outcome.jobId, null);
  const task = await h.prisma.task.findFirstOrThrow({ where: { id: outcome.taskId! } });
  assert.ok(task.acceptanceCommand?.includes('orbit wiki check'), 'the task is the maintenance task');
  assert.equal((await h.prisma.wikiJob.count({ where: { spaceId: fx.spaceId, kind: 'maintain' } })), 0);
});

test('the settings door asks no provider of an account the server executes, and the runner mode\'s refusal is unchanged', { skip }, async () => {
  const h = await boot();
  const prisma = h.prisma as unknown as PrismaService;
  // A provider no maintenance run could start on: the machine's own Claude Code sign-in.
  // runner: refused, word for word as it always was.
  delete process.env.ORBIT_WIKI_EXECUTOR;
  const runnerFx = await fixture(h);
  await assert.rejects(
    setWikiMaintenance(prisma, h.ownerId, runnerFx.spaceId, { enabled: true, workspaceId: runnerFx.workspaceId, provider: 'claude' }),
    (error: Error) => error instanceof BadRequestException && /maintenance\.provider/u.test(error.message),
    'the runner path still refuses a provider no run could start on',
  );

  // canary with this account listed, and server: taken, and the cursor started.
  for (const mode of ['canary', 'server']) {
    process.env.ORBIT_WIKI_EXECUTOR = mode;
    process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS = h.ownerId;
    const fx = await fixture(h, { settings: { reviewMode: 'manual', maintenance: { enabled: false } } });
    const written = await setWikiMaintenance(prisma, h.ownerId, fx.spaceId, {
      enabled: true, workspaceId: fx.workspaceId, provider: 'claude', lookbackDays: 7,
    });
    assert.equal(written.enabled, true, `${mode}: maintenance is on`);
    const cursor = await h.prisma.wikiCursor.findFirstOrThrow({ where: { spaceId: fx.spaceId, source: 'facts' } });
    assert.ok(cursor.positionAt, `${mode}: the cursor started where the look-back says`);
  }
  delete process.env.ORBIT_WIKI_EXECUTOR;
  delete process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS;
});

test('the runner door hands a server-executed account neither its run context nor its dossiers, and the runner mode\'s own refusals are unchanged', { skip }, async () => {
  const h = await boot();
  const prisma = h.prisma as unknown as PrismaService;
  const wiki = new WikiService(prisma);
  const maintenance = new WikiMaintenance(prisma);
  const fx = await fixture(h);
  // The session the door names is one this machine hosts: the refusal is the switch's, not the door's own.
  const runner = { id: fx.runnerId, ownerId: h.ownerId };

  // server execution: both routes are the run's model work, and neither is a session's.
  process.env.ORBIT_WIKI_EXECUTOR = 'server';
  delete process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS;
  const maintain = new RunnerWikiMaintainController(prisma, wiki, maintenance);
  await assert.rejects(
    maintain.run(runner as never, undefined, fx.spaceId),
    (error: Error) => error instanceof WikiRefusalError && error.refusal.code === 'WIKI_SERVER_EXECUTES',
    'the run context is not handed to a session',
  );
  const maintenanceDoor = new RunnerWikiMaintenanceController(prisma, wiki, maintenance);
  await assert.rejects(
    maintenanceDoor.dossiers(runner as never, fx.sessionId, fx.spaceId),
    (error: Error) => error instanceof WikiRefusalError && error.refusal.code === 'WIKI_SERVER_EXECUTES',
    'the dossiers are not handed to a session',
  );

  // runner mode: the same calls are refused as they always were — the door's own session test, not the switch.
  delete process.env.ORBIT_WIKI_EXECUTOR;
  await assert.rejects(
    maintain.run(runner as never, undefined, fx.spaceId),
    (error: Error) => !(error instanceof WikiRefusalError) || error.refusal.code !== 'WIKI_SERVER_EXECUTES',
    'a headless call is still the door\'s own 400',
  );
  await assert.rejects(
    maintenanceDoor.dossiers(runner as never, fx.sessionId, fx.spaceId),
    (error: Error) => error instanceof WikiRefusalError && error.refusal.code === 'WIKI_NOT_MAINTENANCE_SESSION',
    'a session that is no maintenance run is still WIKI_NOT_MAINTENANCE_SESSION',
  );
});

test('a server run counts against the day the way a task\'s run does, and a local catch-up run is not counted', { skip }, async () => {
  const h = await boot();
  process.env.ORBIT_WIKI_EXECUTOR = 'server';
  delete process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS;
  const prisma = h.prisma as unknown as PrismaService;
  // One run a day, so the second fact of the day is held exactly where the runner path's own spec holds it.
  const fx = await fixture(h, {
    settings: { reviewMode: 'manual', maintenance: { enabled: true, workspaceId: 'x', listId: 'x', dailyRunLimit: 1 } },
  });
  const space = await h.prisma.wikiSpace.findFirstOrThrow({ where: { id: fx.spaceId } });
  const settings = (space.settings ?? {}) as Record<string, unknown>;
  const maintenance = { ...((settings.maintenance ?? {}) as Record<string, unknown>), dailyRunLimit: 1, workspaceId: fx.workspaceId, listId: fx.listId };
  await h.prisma.wikiSpace.update({ where: { id: fx.spaceId }, data: { settings: { ...settings, maintenance } as never } });

  const hints = { sessionIds: [fx.sessionId], taskIds: [] as string[] };
  const first = await considerWikiMaintenance(prisma, h.ownerId, fx.spaceId, hints);
  assert.equal(first.made, true, JSON.stringify(first));
  if (!first.made) return;
  assert.ok(first.jobId, 'the server path makes a job, and no task');
  // The run ended, and the worker settled its job (the executor's own write): from here the day has one run,
  // exactly as a task's ended run would be counted, and the space is free of an unfinished one.
  await h.prisma.wikiMaintenanceRun.updateMany({
    where: { id: first.runId },
    data: { outcome: 'succeeded', endedAt: new Date(), startedAt: new Date(), report: { ops: { recorded: 1 } } as never },
  });
  await h.prisma.wikiJob.updateMany({
    where: { id: first.jobId! },
    data: { state: 'succeeded', endedAt: new Date(), report: { kind: 'maintain', outcome: 'succeeded' } as never },
  });
  const second = await considerWikiMaintenance(prisma, h.ownerId, fx.spaceId, hints);
  assert.deepEqual(second, { made: false, spaceId: fx.spaceId, why: 'daily_limit_reached' },
    'the day\'s run is used up, and the space is held with the reason the runner path writes');

  // A run made in active catch-up on a local endpoint is not counted (contract `maintenance.job.catchUp.dailyLimit`):
  // the same exemption, read off the run row's own localEndpoint rather than a provider.
  await h.prisma.wikiMaintenanceRun.updateMany({
    where: { id: first.runId },
    data: { catchUp: 'active', localEndpoint: true, createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
  });
  const third = await considerWikiMaintenance(prisma, h.ownerId, fx.spaceId, hints);
  assert.equal(third.made, true, `an uncounted run is no run for the day: ${JSON.stringify(third)}`);
  delete process.env.ORBIT_WIKI_EXECUTOR;
});

// ── 4. the end of a server run that queued the articles asks for the next round (the owner's decision of 2026-10-10) ──

/**
 * A server-executed space whose `sessions` sessions came to rest in the last hour, a minute apart: past the settle grace
 * and under a day old, so the space is due by its backlog and not behind.
 */
async function busySpace(h: Harness, sessions: number): Promise<{ spaceId: string; sessionIds: string[] }> {
  const fx = await fixture(h);
  await h.prisma.session.update({ where: { id: fx.sessionId }, data: { lastTurnAt: new Date(Date.now() - 60 * 60_000) } });
  const sessionIds = [fx.sessionId];
  for (let i = 1; i < sessions; i += 1) {
    const id = randomUUID();
    await h.prisma.session.create({
      data: {
        id, title: `a settled session ${i}`, prompt: 'p', ownerId: h.ownerId, creatorId: h.ownerId, dispatchOrigin: 'USER',
        status: 'SUCCEEDED', workspaceId: fx.workspaceId, assignedRunnerId: fx.runnerId, lastTurnAt: new Date(Date.now() - (60 - i) * 60_000),
      },
    });
    sessionIds.push(id);
  }
  return { spaceId: fx.spaceId, sessionIds };
}

/**
 * The canary's order, end to end, in a space of 22 sessions: a fact makes the space's run and the worker claims it; the
 * run reads `read` sessions and ends having recorded ops (finishWikiMaintenanceJob, as the maintain job ends), which
 * queues the articles job its ops owe (T); the worker settles the run's job. Then the worker's next pass (T+5 s), the
 * owner's next event about the space `nextEventAfter` seconds after the end — what made the next round on the canary —
 * and the passes after it, each job run to its end, until the space has nothing left. Answers what the end left queued
 * (oldest first), the order the space's jobs ran in, and what the late event made.
 */
async function canaryOrder(h: Harness, read: number, nextEventAfter: number): Promise<{ atRunEnd: string[]; order: string[]; lateEvent: string }> {
  const prisma = h.prisma as unknown as PrismaService;
  const maintenance = new WikiMaintenance(prisma);
  // The cases before this one leave their spaces' jobs queued: a claim of this account must find this space's alone.
  await h.sql.query('DELETE FROM "wiki_job" WHERE "owner_id" = $1', [h.ownerId]);
  const space = await busySpace(h, 22);
  const newest = space.sessionIds[space.sessionIds.length - 1];
  const made = await considerWikiMaintenance(prisma, h.ownerId, space.spaceId, { sessionIds: [newest], taskIds: [] });
  assert.equal(made.made, true, JSON.stringify(made));
  if (!made.made) throw new Error('the space made no run');
  const claim = async (): Promise<ClaimedWikiJob | undefined> => (await claimWikiJobs(prisma, {
    workerId: randomUUID(), kinds: ['maintain', 'articles'], owners: [h.ownerId], limit: 1, leaseMs: 60_000,
  }))[0];
  const queued = () => h.prisma.wikiJob.findMany({
    where: { spaceId: space.spaceId, state: 'queued' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, kind: true },
  });
  const run = await claim();
  assert.equal(run?.id, made.jobId, 'the worker claims the run');
  // T: the run read its page and ends having recorded ops.
  const page = await maintenance.dossierPage(h.ownerId, space.spaceId, { limit: read });
  const end = new Date();
  await finishWikiMaintenanceJob(prisma, maintenance, h.ownerId, space.spaceId, run!.id,
    { outcome: 'succeeded', to: page.cursor, report: { ops: { recorded: 3 } } }, end);
  const left = await queued();
  await succeedWikiJob(prisma, { id: run!.id, generation: run!.leaseGeneration });
  const names = new Map(left.map((job) => [job.id, job.kind === 'maintain' ? 'round' : job.kind]));
  const order: string[] = [];
  // T+5 s: the worker's next pass.
  let taken = await claim();
  if (taken) order.push(names.get(taken.id) ?? taken.kind);
  // T+15 s or T+100 s: the owner's next event about the space, as the trigger hears it.
  const late = await considerWikiMaintenance(prisma, h.ownerId, space.spaceId, { sessionIds: [newest], taskIds: [] },
    new Date(end.getTime() + nextEventAfter * 1000));
  const lateEvent = late.made ? 'made a round' : late.why;
  for (const job of await queued()) if (!names.has(job.id)) names.set(job.id, job.kind === 'maintain' ? 'a round the late event made' : job.kind);
  // The passes after it, each job run to its end, until nothing of the space is left.
  while (taken) {
    await succeedWikiJob(prisma, { id: taken.id, generation: taken.leaseGeneration });
    taken = await claim();
    if (taken) order.push(names.get(taken.id) ?? taken.kind);
  }
  return { atRunEnd: left.map((job) => job.kind), order, lateEvent };
}

test('the canary\'s order: the run\'s end queues the articles job at T, the worker passes at T+5 s, the owner\'s next event comes at T+15 s or T+100 s — the next round runs first, the articles job after it', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  process.env.ORBIT_WIKI_EXECUTOR = 'server';
  delete process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS;
  // 1d4b9a86 queued at 04:27:06 and its round 61e91611 made at 04:27:21; 3f3a8f90 queued at 07:19:40, claimed at 07:19:42,
  // and its round 96cd83f0 made at 07:21:20. One session read of 22: the space is still due when the run ends.
  const seen = { atFifteen: await canaryOrder(h, 1, 15), atHundred: await canaryOrder(h, 1, 100) };
  assert.deepEqual(seen, {
    atFifteen: { atRunEnd: ['articles', 'maintain'], order: ['round', 'articles'], lateEvent: 'unfinished' },
    atHundred: { atRunEnd: ['articles', 'maintain'], order: ['round', 'articles'], lateEvent: 'unfinished' },
  }, 'the end made the round right behind the articles job, the pass at T+5 s took the round, and the late event found it under way');
  delete process.env.ORBIT_WIKI_EXECUTOR;
});

test('a run whose end leaves the space no longer due makes no round, and its articles job runs at the next pass', { skip, timeout: 60_000 }, async () => {
  const h = await boot();
  process.env.ORBIT_WIKI_EXECUTOR = 'server';
  delete process.env.ORBIT_WIKI_EXECUTOR_CANARY_OWNERS;
  // Five sessions read of 22: seventeen are left, under the backlog threshold and under a day old.
  assert.deepEqual(await canaryOrder(h, 5, 15), { atRunEnd: ['articles'], order: ['articles'], lateEvent: 'not_due' },
    'nothing waits for a round that is not coming: the articles job is the next pass\'s, and the late event makes none');
  delete process.env.ORBIT_WIKI_EXECUTOR;
});
