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
 *      answer 409 WIKI_SERVER_EXECUTES.
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
import { WikiRefusalError, WikiService } from './wiki.service';
import { WikiMaintenance } from './wiki-maintenance';
import { setWikiMaintenance } from './wiki-maintenance-settings';
import { considerWikiMaintenance } from './wiki-maintenance-run';

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
