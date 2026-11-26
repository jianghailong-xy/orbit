/**
 * THE REMAINING MODULES' READERS ON THE FACTS, AGAINST POSTGRESQL (task T12 of
 * docs/session-status-retirement-plan.md, §2.3 and §2.5): feishu, github, help, link previews, providers, push,
 * schedules, watches and wiki. Each reader is called as the server calls it, over one session of every held word
 * with turn_state as migration 1611's trigger keeps it AND with turn_state NULL, as a held row nothing has written
 * since that migration has until the backfill (task T3), and over released rows. The expected answers are today's,
 * spelled from the stored word each row was written with; the one exception is a row kind of plan §3.4, whose
 * observation carries the derived word.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/remaining-modules-on-the-facts.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Prisma, PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';

import { FeishuGroupService } from '../feishu/feishu-group.service';
import { reserveOpenSlot } from '../feishu/feishu-open-limits';
import { GithubWorkspaceService } from '../github/github-workspace.service';
import { HelpAsk } from '../help/help-ask';
import { readSessions } from '../help/help-ask-reads';
import { LinkPreviewsService } from '../link-previews/link-previews.service';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { claimTrialByKey, liveAccountHealth } from '../providers/account-health.service';
import { activeSessionsOn } from '../providers/active-sessions';
import { poolPauseBlocksRequest } from '../providers/pool-pause';
import { PushService } from '../push/push.service';
import { ScheduleRunsService } from '../schedules/schedule-runs.service';
import { WatchEvaluatorService } from '../watches/watch-evaluator.service';
import { WatchesService } from '../watches/watches.service';
import { loadDossierRecords } from '../wiki/wiki-dossier';
import { wikiSessionsOfSpace } from '../wiki/wiki-maintenance';
import { ALLOW_UNFILLED_SESSIONS } from '../test-support/unfilled-sessions';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const HELD_WORDS = [RunStatus.PENDING, RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED];

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
}

interface Row {
  id: string;
  title: string;
  word: RunStatus;
}

async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@t12.invalid`, name: label, passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(), maxConcurrent: 32,
    },
  });
  const workspace = await db.workspace.create({ data: { ownerId, runnerId, name: `${label}-workspace`, enabled: true } });
  return { ownerId, runnerId, workspaceId: workspace.id };
}

/** A session stored with `word`. `unfilled`: turn_state cleared afterwards, as on a row not yet backfilled. */
async function session(
  db: PrismaClient,
  ids: World,
  title: string,
  word: RunStatus,
  options: { unfilled?: boolean; data?: Partial<Prisma.SessionUncheckedCreateInput> } = {},
): Promise<Row> {
  const released = word === RunStatus.SUCCEEDED || word === RunStatus.FAILED || word === RunStatus.CANCELLED;
  const { id } = await db.session.create({
    data: {
      ownerId: ids.ownerId, creatorId: ids.ownerId, title, prompt: title, status: word,
      dispatchOrigin: SessionDispatchOrigin.USER, provider: 'claude', providerBuiltin: true,
      workspaceId: ids.workspaceId, assignedRunnerId: ids.runnerId, startedAt: new Date(), lastTurnAt: new Date(),
      ...(released ? { finishedAt: new Date(), lastTurnOutcome: word === RunStatus.FAILED ? 'FAILED' : 'ANSWERED' } : {}),
      ...options.data,
    },
  });
  // The word trigger fires on `status` alone, so this leaves the row as one nothing has written since 1611.
  if (options.unfilled) await db.$executeRawUnsafe('UPDATE session SET turn_state = NULL WHERE id = $1::uuid', id);
  return { id, title, word };
}

/** One session of every held word filled and unfilled, and a finished and a failed release. */
async function everyRow(db: PrismaClient, ids: World, data: Partial<Prisma.SessionUncheckedCreateInput> = {}): Promise<Row[]> {
  const rows: Row[] = [];
  for (const word of HELD_WORDS) {
    rows.push(await session(db, ids, `${word} filled`, word, { data }));
    rows.push(await session(db, ids, `${word} unfilled`, word, { unfilled: true, data }));
  }
  rows.push(await session(db, ids, 'finished', RunStatus.SUCCEEDED, { data: { ...data, endReason: 'task_done' } }));
  rows.push(await session(db, ids, 'failed', RunStatus.FAILED, { data }));
  return rows;
}

const of = (rows: Row[], ...words: RunStatus[]): string[] => rows.filter((row) => words.includes(row.word)).map((row) => row.id).sort();
const owed = (rows: Row[]): string[] => of(rows, RunStatus.PENDING, RunStatus.RUNNING);
const notOwed = (rows: Row[]): string[] => rows.map((row) => row.id).filter((id) => !owed(rows).includes(id)).sort();

test('the remaining modules read the facts, and a row with no turn_state reads as today', { skip, timeout: 600_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const db = prismaClientFor(URL!);
  await db.$executeRawUnsafe(ALLOW_UNFILLED_SESSIONS);
  const prisma = db as unknown as PrismaService;
  t.after(() => db.$disconnect());

  await t.test('feishu: the open bot and a group count the queued and in-flight chains', async () => {
    const ids = await world(db, 'feishu');
    const rows = await everyRow(db, ids);
    const appId = `cli_${randomUUID()}`;
    await db.feishuApp.create({
      data: {
        ownerId: ids.ownerId, platform: 'FEISHU', appId, appSecretEnc: 'x', botName: 'bot', ownerOpenId: 'ou_owner',
        ownerName: 'owner', defaultWorkspaceId: ids.workspaceId, messageDetail: 'TITLES_ONLY',
        accessMode: 'AVAILABILITY_SCOPE', openWorkspaceId: ids.workspaceId, openPermissionMode: 'acceptEdits',
        openMaxRunningPerPerson: 50, openSessionsPerDayPerPerson: 100, openMaxRunningTotal: owed(rows).length, openSessionsPerDayTotal: 100,
      },
    });
    await db.feishuChatRoute.create({
      data: {
        ownerId: ids.ownerId, appId, chatId: 'oc_group', workspaceId: ids.workspaceId, permissionMode: 'acceptEdits', enabled: true,
        confirmedAt: new Date(),
        maxConcurrentSessions: owed(rows).length, sessionsPerDay: 100,
      },
    });
    for (const row of rows) {
      await db.feishuThread.create({
        data: { ownerId: ids.ownerId, appId, chatId: 'oc_group', rootMessageId: `om_${row.id}`, sessionId: row.id, openAccessOpenId: 'ou_other' },
      });
    }
    const request = {
      appId, ownerId: ids.ownerId, chatId: 'oc_group', rootMessageId: 'om_new', sessionId: randomUUID(), openId: 'ou_new',
    };
    const open = () => db.$transaction((tx) => reserveOpenSlot(tx, request));
    const full = await open();
    assert.deepEqual([full.ok, !full.ok && full.limit], [false, 'TOTAL_RUNNING']);
    const reserve = (FeishuGroupService.prototype as unknown as {
      reserve: (...args: unknown[]) => Promise<string | null>;
    }).reserve;
    const group = () => db.$transaction((tx) => reserve.call(
      {}, tx, { appId }, { ownerId: ids.ownerId }, 'oc_group', 'om_new', request.sessionId,
    ));
    assert.notEqual(await group(), null, 'the group is full');
    // One more than are queued or in flight: both let the request in, so neither counted a parked or released chain.
    await db.feishuApp.update({ where: { appId }, data: { openMaxRunningTotal: owed(rows).length + 1 } });
    await db.feishuChatRoute.updateMany({ where: { appId }, data: { maxConcurrentSessions: owed(rows).length + 1 } });
    assert.equal(await group(), null);
    await db.feishuThread.deleteMany({ where: { appId, rootMessageId: 'om_new' } });
    assert.equal((await open()).ok, true);
  });

  await t.test('github: a moved clone republishes the queued sessions', async () => {
    const ids = await world(db, 'github');
    const rows = await everyRow(db, ids);
    const published: string[] = [];
    const announce = (GithubWorkspaceService.prototype as unknown as {
      announce: (...args: unknown[]) => Promise<void>;
    }).announce;
    await announce.call(
      { prisma, realtime: { publishWorkspaceCloneChanged: () => undefined, publishSessionUpdated: (id: string) => published.push(id) } },
      ids.ownerId, ids.workspaceId, 'PENDING', null,
    );
    assert.deepEqual(published.sort(), of(rows, RunStatus.PENDING));
  });

  await t.test('providers: the account pick, the trial claim and a pool pause', async () => {
    const ids = await world(db, 'providers');
    const rows = await everyRow(db, ids);
    // The account pick's filter, captured from the query the function makes.
    let where: Prisma.SessionWhereInput | undefined;
    const reader = { session: { findMany: async (args: Prisma.SessionFindManyArgs) => { where = args.where; return []; } } };
    const twoAccounts = {
      id: ids.runnerId, defaultRemoved: [], accountPauses: null, planUsage: null,
      engines: [{
        engine: 'codex', installed: true, auth: 'yes',
        accounts: ['default', '3fa91c2e'].map((id) => ({ id, home: `/h/${id}`, codexHome: `/h/${id}`, auth: 'yes' })),
      }],
    };
    await activeSessionsOn(reader as never, [twoAccounts], new Date());
    assert.ok(where, 'the pick read the sessions');
    const counted = await db.session.findMany({ where, select: { id: true } });
    // Queued, in flight, and held-and-idle with a recent turn; never a released one.
    assert.deepEqual(counted.map((row) => row.id).sort(), of(rows, ...HELD_WORDS));

    const now = new Date();
    for (const row of rows) {
      const key = `runner:${ids.runnerId}:codex:${row.title}`;
      await db.accountHealth.create({
        data: {
          ownerId: ids.ownerId, subjectKey: key, runnerId: ids.runnerId, engine: 'codex', state: 'BLOCKED', kind: 'AUTH',
          blockedUntil: new Date(now.getTime() - 1000), trialSessionId: row.id, trialClaimedAt: new Date(now.getTime() - 3_600_000),
        },
      });
    }
    const trialRunning = (await liveAccountHealth(db, ids.ownerId, now)).filter((entry) => entry.view === 'trial-running');
    assert.deepEqual(
      trialRunning.map((entry) => entry.subjectKey).sort(),
      rows.filter((row) => row.word === RunStatus.RUNNING).map((row) => `runner:${ids.runnerId}:codex:${row.title}`).sort(),
    );
    for (const row of rows) {
      const key = `runner:${ids.runnerId}:codex:${row.title}`;
      const claim = await claimTrialByKey(db, ids.ownerId, key, '', randomUUID(), now);
      assert.equal(claim, row.word === RunStatus.RUNNING ? 'HELD' : 'CLAIMED', `trial claim over ${row.title}`);
    }

    const pausedAt = new Date(now.getTime() - 60_000);
    for (const row of rows) {
      await db.conversationTurn.create({
        data: {
          sessionId: row.id, seq: 1, clientTurnId: randomUUID(), kind: 'message', content: 'x', status: 'IN_FLIGHT',
          deliveredAt: new Date(pausedAt.getTime() - 1000), leaseDeadlineAt: new Date(now.getTime() + 60_000),
        },
      });
      const blocks = await poolPauseBlocksRequest(db, row.id, { pausedAt, pausedUntil: new Date(now.getTime() + 60_000) }, now);
      // Only a turn in flight may finish under a pause.
      assert.equal(blocks, row.word !== RunStatus.RUNNING, `pool pause over ${row.title}`);
    }
  });

  await t.test('help: the Ask list and the account read', async () => {
    const ids = await world(db, 'help');
    const rows = await everyRow(db, ids);
    const byId = new Map(rows.map((row) => [row.id, row]));
    const read = await readSessions(prisma, ids.ownerId);
    for (const answer of read.sessions) {
      const row = byId.get(answer.id)!;
      assert.equal(answer.status, row.word, `${row.title}: the word`);
      assert.equal(answer.paused, row.word === RunStatus.INTERRUPTED, `${row.title}: paused`);
    }
    assert.equal(read.sessions.length, rows.length);
    // A session is an Ask from its creation or never, so the Ask list has rows of its own.
    const asker = await world(db, 'asks');
    const asks = await everyRow(db, asker, { helpAsk: { page: null } });
    const asked = new Map(asks.map((row) => [row.id, row]));
    const list = await HelpAsk.prototype.list.call({ prisma } as never, asker.ownerId);
    const outcomes = Object.fromEntries(list.questions.map((question) => [asked.get(question.sessionId)!.title, question.outcome]));
    for (const row of asks) {
      const expected = owed([row]).length ? 'working' : row.title === 'failed' ? 'failed' : 'answered';
      assert.equal(outcomes[row.title], expected, row.title);
    }
  });

  await t.test('link previews: a task card\'s last run carries the word', async () => {
    const ids = await world(db, 'links');
    const tasks: Array<{ taskId: string; row: Row }> = [];
    for (const word of HELD_WORDS) {
      for (const unfilled of [false, true]) {
        const task = await db.task.create({
          data: {
            ownerId: ids.ownerId, creatorType: 'USER', creatorId: ids.ownerId, title: `${word} ${unfilled}`,
            assigneeId: ids.workspaceId, completionCriterion: 'EVIDENCE_JUDGMENT', autoRunWhenReady: false,
          },
        });
        tasks.push({ taskId: task.id, row: await session(db, ids, `${word} ${unfilled}`, word, { unfilled, data: { taskId: task.id } }) });
      }
    }
    const taskCards = (LinkPreviewsService.prototype as unknown as {
      taskCards: (ownerId: string, ids: string[]) => Promise<Map<string, { lastRun: { status: string } | null }>>;
    }).taskCards;
    const cards = await taskCards.call(
      { prisma, tasks: { withRunning: async (_owner: string, found: object[]) => found.map((task) => ({ ...task, running: false, queued: false })) } },
      ids.ownerId, tasks.map((task) => task.taskId),
    );
    for (const { taskId, row } of tasks) assert.equal(cards.get(taskId)?.lastRun?.status, row.word, row.title);
  });

  await t.test('push: needs-you counts a turn in flight and a parked engine turn', async () => {
    const ids = await world(db, 'push');
    const rows = await everyRow(db, ids);
    const generating = await everyRow(db, ids, { engineTurnActive: true });
    for (const row of [...rows, ...generating]) {
      await db.approval.create({ data: { sessionId: row.id, toolName: 'Bash', input: {}, status: 'PENDING' } });
    }
    const needs = await PushService.prototype.needsYouSessions.call({ prisma } as never, ids.ownerId);
    assert.deepEqual(
      needs.sort(),
      [...of(rows, RunStatus.RUNNING), ...of(generating, RunStatus.RUNNING, RunStatus.AWAITING_INPUT)].sort(),
    );
  });

  await t.test('schedules: completing and landing a run', async () => {
    const ids = await world(db, 'schedules');
    const schedule = await db.schedule.create({
      data: {
        ownerId: ids.ownerId, workspaceId: ids.workspaceId, intent: 'x', title: 'x', prompt: 'x', rule: {}, timezone: 'UTC',
        startAt: new Date(), accessLevel: 'CHECK_ONLY', envelopeWorkspaceId: ids.workspaceId, envelopeAccessLevel: 'CHECK_ONLY',
        envelopeRunsPerWeek: 1, envelopeRunLimitMinutes: 30,
      },
    });
    const rows = await everyRow(db, ids);
    for (const row of rows) {
      const run = await db.scheduleRun.create({
        data: { scheduleId: schedule.id, scheduleRevision: 1, plannedAt: new Date(), trigger: 'MANUAL', state: 'NO_CHANGE', sessionId: row.id },
      });
      // Names no status: an unfilled row stays unfilled.
      await db.session.update({ where: { id: row.id }, data: { runSource: 'SCHEDULE', scheduleRunId: run.id } });
    }
    const completed: string[] = [];
    const self = { prisma, sessions: { complete: async (_owner: string, id: string) => { completed.push(id); } }, logger: console };
    const prototype = ScheduleRunsService.prototype as unknown as {
      completeNoChangeSessions: (batch: number) => Promise<string[]>;
      landRun: (run: object) => Promise<void>;
    };
    assert.deepEqual((await prototype.completeNoChangeSessions.call(self, 100)).sort(), notOwed(rows));
    for (const row of rows) {
      const settled: string[] = [];
      await prototype.landRun.call(
        { prisma, settleLanding: async (_run: string, status: string, _sha: unknown, reason?: string) => { settled.push(`${status} ${reason ?? ''}`); } },
        { id: randomUUID(), sessionId: row.id, scheduleId: schedule.id },
      );
      // A run stopped mid-turn (INTERRUPTED) still lands, so it reaches the branch check like a parked one.
      const expected = row.word === RunStatus.PENDING || row.word === RunStatus.RUNNING
        ? []
        : row.title === 'failed'
          ? ['FAILED The run session ended unsuccessfully; nothing was landed.']
          : ['FAILED The runner did not report the branch and base commits.'];
      assert.deepEqual(settled, expected, `landing ${row.title}`);
    }
  });

  await t.test('watches: the facts at create and at evaluation, and the observation', async () => {
    const ids = await world(db, 'watches');
    const rows = await everyRow(db, ids);
    // Plan §3.4, C1: an end asked for and not honoured, stored FAILED, reads CANCELLED from the facts.
    const unhonoured = await session(db, ids, 'unhonoured', RunStatus.FAILED, { data: { endReason: 'cancelled' } });
    const all = [...rows, unhonoured];
    const watches = new WatchesService(prisma);
    const created = await watches.create(ids.ownerId, {
      predicateVersion: 1,
      predicate: { kind: 'ANY', over: 'ALL_TARGETS', leaf: 'SESSION_TURN_SETTLED' },
      targets: all.map((row) => ({ kind: 'SESSION' as const, id: row.id })),
      action: 'NOTIFY_USER',
    });
    type Observed = { id: string; leaves: Record<string, boolean>; observed: { status: string; runState: string } };
    const snapshotOf = async (watchId: string): Promise<Map<string, Observed>> => {
      const match = await db.watchMatch.findFirstOrThrow({ where: { watchId } });
      const { targets } = match.perTargetSnapshot as unknown as { targets: Observed[] };
      return new Map(targets.map((target) => [target.id, target]));
    };
    const atCreate = await snapshotOf(created.id);
    for (const row of all) {
      const seen = atCreate.get(row.id)!;
      const word = row.title === 'unhonoured' ? RunStatus.CANCELLED : row.word;
      assert.equal(seen.observed.status, word, `${row.title}: observed at create`);
      assert.equal(seen.leaves.SESSION_TURN_SETTLED, !owed([row]).length, `${row.title}: settled`);
    }
    assert.equal(atCreate.get(unhonoured.id)!.observed.runState, 'ENDED');
    const named = created.targets.find((target) => target.targetResourceId === unhonoured.id)!;
    assert.equal((named.targetStatus as { status: string }).status, 'ENDED');

    // The evaluator's own read: nothing settled at create, then one unfilled row parks.
    const turning = await session(db, ids, 'turning', RunStatus.RUNNING, { unfilled: true });
    const queued = await session(db, ids, 'queued', RunStatus.PENDING, { unfilled: true });
    const filled = await session(db, ids, 'filled', RunStatus.RUNNING);
    const waiting = await watches.create(ids.ownerId, {
      predicateVersion: 1,
      predicate: { kind: 'ANY', over: 'ALL_TARGETS', leaf: 'SESSION_TURN_SETTLED' },
      targets: [turning, queued, filled].map((row) => ({ kind: 'SESSION' as const, id: row.id })),
      action: 'NOTIFY_USER',
    });
    assert.equal(await db.watchMatch.count({ where: { watchId: waiting.id } }), 0);
    await db.session.update({ where: { id: turning.id }, data: { status: RunStatus.INTERRUPTED } });
    await db.$executeRawUnsafe('UPDATE session SET turn_state = NULL WHERE id = $1::uuid', turning.id);
    const evaluator = new WatchEvaluatorService(prisma, { publishWatchChanged: () => undefined } as never);
    await evaluator.evaluate(waiting.id);
    const evaluated = await snapshotOf(waiting.id);
    assert.deepEqual(
      [turning, queued, filled].map((row) => [evaluated.get(row.id)!.observed.status, evaluated.get(row.id)!.leaves.SESSION_TURN_SETTLED]),
      [[RunStatus.INTERRUPTED, true], [RunStatus.PENDING, false], [RunStatus.RUNNING, false]],
    );
  });

  await t.test('wiki: the sessions a run may read, and a dossier\'s word', async () => {
    const ids = await world(db, 'wiki');
    const rows = await everyRow(db, ids);
    const read = await wikiSessionsOfSpace(db, {
      ownerId: ids.ownerId, spaceId: randomUUID(), workspaceIds: [ids.workspaceId], projectIds: [], foreignSessionIds: [],
      maintenanceListId: null,
    }, rows.map((row) => row.id));
    assert.deepEqual([...read].sort(), notOwed(rows));
    for (const row of rows) {
      const records = await loadDossierRecords(db, ids.ownerId, row.id);
      assert.equal(records?.session.legacyStatus, row.word, row.title);
    }
  });
});
