/**
 * CLAIM, SLOT AND DISPATCH ON THE FACTS, AGAINST POSTGRESQL (task T7 of docs/session-status-retirement-plan.md, §1.3,
 * §1.4 and §2.3).
 *
 * Every case runs over the same rows: each held word, written as its turn state, also with a background job and with
 * the engine's own turn, which make `phase` RUNNING without a dispatched turn; and each released word, with the same
 * stale work beside it. Every row has a runner, a batch, a spawn tree and a workspace of its own, so what a reader
 * counts or selects is that one row's answer. What each reader selects now is held to what it selected on the stored
 * word before, spelled here as the code spelled it before the change, in SQL, with the column replaced by the word
 * the facts give (test-support wordSql, the projector's SQL twin): the column was dropped in deploy D4 (task T15).
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/queue/claim-slot-turn-state.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Prisma, PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';

import { drainWaitingOf } from '../common/runner-drain-waiting';
import { GENERATING_SESSION_FILTER } from '../common/session-generating';
import { heldFilter } from '../common/session-release';
import {
  batchActiveTurns,
  runnerActiveTurns,
  runnerBackgroundHeldSessions,
  treeActiveTurns,
} from '../common/session-tree-sql';
import {
  SESSION_EXECUTING_EXCEPT_BG_JOB_WHERE,
  SESSION_EXECUTING_WHERE,
  SESSION_HOLDS_SLOT_WHERE,
  SESSION_RUNNING_BG_JOB_WHERE,
} from '../common/session-working';
import { managedRunnerWork } from '../managed-runners/managed-runner-work';
import { readFleetGauges } from '../metrics/fleet-metrics';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { ProviderPlanUsageService } from '../providers/plan-usage.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { runningSessionCounts } from '../runners/runner-background-holders';
import { turnStateFilter } from '../sessions/session-turn-state';
import { DispatchPauseService } from './dispatch-pause.service';
import { QueueService } from './queue.service';
import { turnStateOfWord } from '../sessions/session-turn-state';
import { wordSql } from '../test-support/session-word';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const HELD_WORDS = [RunStatus.PENDING, RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED];
const RELEASED_WORDS = [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED];
/** Work outside a dispatched turn: none, a background job (phase RUNNING), the engine's own turn (phase RUNNING). */
const EXTRAS = ['none', 'job', 'engine'] as const;

interface Row {
  title: string;
  id: string;
  word: RunStatus;
  held: boolean;
  extra: (typeof EXTRAS)[number];
  runnerId: string;
  batchId: string;
}

const silent = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;

/** One owner; one session of every shape, each on its own runner, batch, tree and workspace. */
async function everyShape(db: PrismaClient): Promise<{ ownerId: string; rows: Row[] }> {
  const ownerId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `t7-${ownerId}@claim-facts.invalid`, name: 't7', passwordHash: 'x' } });
  const shapes = [
    ...HELD_WORDS.flatMap((word) => EXTRAS.map((extra) => ({ word, extra }))),
    ...RELEASED_WORDS.flatMap((word) => EXTRAS.map((extra) => ({ word, extra }))),
  ];
  const rows: Row[] = [];
  for (const { word, extra } of shapes) {
    const held = HELD_WORDS.includes(word);
    const title = `${word}${extra === 'none' ? '' : ` + ${extra}`}`;
    const runnerId = randomUUID();
    await db.runner.create({
      data: {
        id: runnerId, ownerId, name: `t7 ${title}`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
        capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(), maxConcurrent: 64,
      },
    });
    const workspace = await db.workspace.create({
      data: { ownerId, runnerId, name: `t7 ${title} ${randomUUID()}`, workDir: '/repo', enabled: true },
    });
    const id = randomUUID();
    const batchId = randomUUID();
    await db.session.create({
      data: {
        id, ownerId, creatorId: ownerId, title, prompt: title, turnState: turnStateOfWord(word), workspaceId: workspace.id,
        assignedRunnerId: runnerId, provider: 'claude', providerBuiltin: true, model: 'claude-opus-5',
        permissionMode: 'default', usesRuntimeDefaultModel: true, dispatchOrigin: SessionDispatchOrigin.USER,
        numTurns: 1, startedAt: new Date(Date.now() - 60 * 60_000), runtimeSessionId: randomUUID(),
        batchId, batchMaxConcurrent: 64, rootSessionId: id,
        engineTurnActive: extra === 'engine',
        runningBgJobs: extra === 'job' ? ['bgj_t7'] : [],
        runningBgShells: extra === 'job' ? ['bgj_t7'] : [],
        ...(held ? {} : { finishedAt: new Date(), lastTurnOutcome: word === RunStatus.FAILED ? 'FAILED' : 'ANSWERED' }),
        // A SUCCEEDED run's writers ask the task_done end (plan §3.1 P4); released without it, it reads CANCELLED.
        ...(word === RunStatus.SUCCEEDED ? { endReason: 'task_done' } : {}),
      },
    });
    // A turn in flight and a message waiting, on every row: what the dispatch pause and the drain count read.
    await db.conversationTurn.create({
      data: { sessionId: id, seq: 1, clientTurnId: `t7-1-${id}`, kind: 'message', content: title, status: 'IN_FLIGHT', deliveredAt: new Date() },
    });
    await db.conversationTurn.create({
      data: { sessionId: id, seq: 2, clientTurnId: `t7-2-${id}`, kind: 'message', content: title, status: 'PENDING' },
    });
    // The runner's last beat names the session as held by a background job (runner_presence, migration 0780).
    await db.runnerPresence.create({ data: { runnerId, lastBeatAt: new Date(), linkState: 'HTTP', backgroundJobSessionIds: [id] } });
    rows.push({ title, id, word, held, extra, runnerId, batchId });
  }
  return { ownerId, rows };
}

const titles = (rows: Row[], keep: (row: Row) => boolean): string[] => rows.filter(keep).map((row) => row.title).sort();

test('claim, slots and dispatch read the turn state, and select what the stored word selected', { skip, timeout: 600_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const db = prismaClientFor(URL!);
  const prisma = db as unknown as PrismaService;
  t.after(() => db.$disconnect());
  const { ownerId, rows } = await everyShape(db);
  const byRunner = new Map(rows.map((row) => [row.runnerId, row]));
  const ids = rows.map((row) => row.id);

  /** Of these rows, the titles a per-row SQL answer is true for. */
  const where = async (answer: (alias: string) => Prisma.Sql): Promise<string[]> => {
    const found = await db.$queryRaw<Array<{ id: string; yes: boolean }>>(Prisma.sql`
      SELECT s.id::text AS id, (${answer('s')}) AS yes FROM "session" s WHERE s.id = ANY(${ids}::uuid[])`);
    return titles(rows, (row) => found.find((f) => f.id === row.id)?.yes === true);
  };
  /** The titles a Prisma filter selects of these rows. */
  const filtered = async (filter: Prisma.SessionWhereInput): Promise<string[]> => {
    const found = new Set((await db.session.findMany({ where: { AND: [{ id: { in: ids } }, filter] }, select: { id: true } })).map((r) => r.id));
    return titles(rows, (row) => found.has(row.id));
  };

  await t.test('the slot counts: runner, batch and tree count the dispatched turns and nothing else', async () => {
    // Before (common/session-tree-sql.ts at the project tip): `status = 'RUNNING'`, the child's `status IN ('PENDING', 'RUNNING')`.
    const before = {
      runner: (s: string) => Prisma.sql`(SELECT count(*) FROM "session" active WHERE active."assigned_runner_id" = ${Prisma.raw(s)}."assigned_runner_id" AND ${Prisma.raw(wordSql('active'))} = 'RUNNING') > 0`,
      batch: (s: string) => Prisma.sql`(SELECT count(*) FROM "session" ba WHERE ba."batch_id" = ${Prisma.raw(s)}."batch_id" AND ${Prisma.raw(wordSql('ba'))} = 'RUNNING') > 0`,
      tree: (s: string) => Prisma.sql`(SELECT count(*) FROM "session" tree WHERE tree."root_session_id" = ${Prisma.raw(s)}."root_session_id" AND ${Prisma.raw(wordSql('tree'))} = 'RUNNING'
        AND NOT EXISTS (SELECT 1 FROM "session" child WHERE child."parent_session_id" = tree.id AND ${Prisma.raw(wordSql('child'))} IN ('PENDING', 'RUNNING'))) > 0`,
      background: (s: string) => Prisma.sql`(SELECT count(*) FROM "session" held WHERE held."assigned_runner_id" = ${Prisma.raw(s)}."assigned_runner_id"
        AND ${Prisma.raw(wordSql('held'))} IN ('PENDING', 'AWAITING_INPUT', 'INTERRUPTED')
        AND held.id = ANY(SELECT unnest(p."background_job_session_ids") FROM "runner_presence" p WHERE p."runner_id" = ${Prisma.raw(s)}."assigned_runner_id")) > 0`,
    };
    const after = {
      runner: (s: string) => Prisma.sql`${runnerActiveTurns(Prisma.raw(`${s}."assigned_runner_id"`))} > 0`,
      batch: (s: string) => Prisma.sql`${batchActiveTurns(s)} > 0`,
      tree: (s: string) => Prisma.sql`${treeActiveTurns(s)} > 0`,
      background: (s: string) => Prisma.sql`${runnerBackgroundHeldSessions(Prisma.raw(`${s}."assigned_runner_id"`))} > 0`,
    };
    const running = titles(rows, (row) => row.word === RunStatus.RUNNING);
    assert.equal(running.length, 3, 'RUNNING, with each kind of outside work');
    for (const kind of ['runner', 'batch', 'tree'] as const) {
      assert.deepEqual(await where(after[kind]), await where(before[kind]), `${kind}: the same rows`);
      assert.deepEqual(await where(after[kind]), running, `${kind}: a slot is a dispatched turn only, never phase`);
    }
    const holders = titles(rows, (row) => row.held && row.word !== RunStatus.RUNNING);
    assert.deepEqual(await where(after.background), await where(before.background), 'background holders: the same rows');
    assert.deepEqual(await where(after.background), holders, 'background holders: held and not in flight');
  });

  await t.test('the spawn-tree exemption: a parent waiting on a queued or running child is not counted', async () => {
    // A RUNNING parent over each row: the row moves into the parent's tree, as its child.
    const parents = new Map<string, string>();
    for (const row of rows) {
      const parent = randomUUID();
      await db.session.create({
        data: {
          id: parent, ownerId, creatorId: ownerId, title: `parent of ${row.title}`, prompt: 'p', turnState: 'IN_FLIGHT',
          provider: 'claude', providerBuiltin: true, dispatchOrigin: SessionDispatchOrigin.USER, rootSessionId: parent,
        },
      });
      await db.$executeRawUnsafe('UPDATE session SET parent_session_id = $1::uuid WHERE id = $2::uuid', parent, row.id);
      parents.set(parent, row.title);
    }
    const parentIds = [...parents.keys()];
    const counted = async (fragment: Prisma.Sql): Promise<string[]> => (await db.$queryRaw<Array<{ id: string; n: bigint }>>(Prisma.sql`
      SELECT s.id::text AS id, ${fragment} AS n FROM "session" s WHERE s.id = ANY(${parentIds}::uuid[])`))
      .filter((r) => Number(r.n) > 0).map((r) => parents.get(r.id)!).sort();
    const before = await counted(Prisma.sql`(SELECT count(*) FROM "session" tree WHERE tree."root_session_id" = s."root_session_id" AND ${Prisma.raw(wordSql('tree'))} = 'RUNNING'
      AND NOT EXISTS (SELECT 1 FROM "session" child WHERE child."parent_session_id" = tree.id AND ${Prisma.raw(wordSql('child'))} IN ('PENDING', 'RUNNING')))`);
    const after = await counted(treeActiveTurns('s'));
    assert.deepEqual(after, before, 'the same parents counted');
    assert.deepEqual(after, titles(rows, (row) => !(row.word === RunStatus.PENDING || row.word === RunStatus.RUNNING)),
      'a parent is exempt exactly while its child is queued or in flight');
    await db.$executeRawUnsafe('UPDATE session SET parent_session_id = NULL WHERE id = ANY($1::uuid[])', ids);
  });

  await t.test('the Prisma filters the slot, generating and managed readers use select what the word selected', async () => {
    const HELD = `${wordSql('s')} IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')`;
    const cases: Array<[string, Prisma.SessionWhereInput, string]> = [
      ['queued (claim holds, hold notices)', turnStateFilter(['QUEUED']), `${wordSql('s')} = 'PENDING'`],
      ['in flight (claim undo, Update Now, draining turns, OOM stop)', turnStateFilter(['IN_FLIGHT']), `${wordSql('s')} = 'RUNNING'`],
      ['holds a slot', SESSION_HOLDS_SLOT_WHERE, `${wordSql('s')} = 'RUNNING'`],
      ['held (Update Now shells)', heldFilter(), HELD],
      ['generating', GENERATING_SESSION_FILTER, `${wordSql('s')} = 'RUNNING' OR (${wordSql('s')} = 'AWAITING_INPUT' AND s."engine_turn_active")`],
      ['executing', SESSION_EXECUTING_WHERE, `${wordSql('s')} = 'RUNNING' OR (${HELD}
        AND (s."engine_turn_active" OR cardinality(s."running_subagents") > 0 OR cardinality(s."running_bg_jobs") > 0))`],
      ['executing but a job', SESSION_EXECUTING_EXCEPT_BG_JOB_WHERE, `${wordSql('s')} = 'RUNNING' OR (${HELD}
        AND (s."engine_turn_active" OR cardinality(s."running_subagents") > 0))`],
      ['a job running', SESSION_RUNNING_BG_JOB_WHERE, `${HELD} AND cardinality(s."running_bg_jobs") > 0`],
    ];
    for (const [name, now, before] of cases) {
      const selected = await filtered(now);
      assert.deepEqual(selected, await where(() => Prisma.raw(`COALESCE(${before}, false)`)), `${name}: the same rows`);
      assert.ok(selected.length > 0 && selected.length < rows.length, `${name}: not vacuous`);
    }
    // Phase never decides a slot: a parked row with a job or the engine's own turn is phase RUNNING and holds none.
    const phaseRunning = await filtered({ phase: 'RUNNING' });
    assert.ok(phaseRunning.includes('AWAITING_INPUT + job') && phaseRunning.includes('AWAITING_INPUT + engine'));
    assert.ok(!(await filtered(SESSION_HOLDS_SLOT_WHERE)).includes('AWAITING_INPUT + job'));
  });

  await t.test('managed runner work, runner N-of-M counts and the drain\'s waiting work read the same rows', async () => {
    const before = await db.$queryRaw<Array<{ runnerId: string; active: boolean; queued: boolean }>>(Prisma.sql`
      SELECT r.id::text AS "runnerId",
             EXISTS (SELECT 1 FROM "session" s WHERE s."assigned_runner_id" = r.id AND ${Prisma.raw(wordSql('s'))} = 'RUNNING') AS active,
             EXISTS (SELECT 1 FROM "session" s WHERE s."assigned_runner_id" = r.id AND ${Prisma.raw(wordSql('s'))} = 'PENDING' AND s."cancel_requested_at" IS NULL) AS queued
        FROM "runner" r WHERE r.id = ANY(${rows.map((row) => row.runnerId)}::uuid[])`);
    for (const { runnerId, active, queued } of before) {
      const row = byRunner.get(runnerId)!;
      const work = await managedRunnerWork(prisma, runnerId);
      assert.equal(work.includes('ACTIVE_TURN'), active, `${row.title}: ACTIVE_TURN`);
      assert.equal(work.includes('QUEUED_TURN'), queued, `${row.title}: QUEUED_TURN`);
      assert.equal(work.includes('BACKGROUND_WORK'), row.held && row.extra !== 'none', `${row.title}: BACKGROUND_WORK`);
    }
    // "N of M running": turns, plus what the last beat names as held by a background job and is still held.
    const runners = await db.runner.findMany({
      where: { id: { in: rows.map((row) => row.runnerId) } },
      select: { id: true, status: true, presence: { select: { lastBeatAt: true, backgroundJobSessionIds: true } } },
    });
    const counts = await runningSessionCounts(prisma, runners as never, Date.now());
    for (const row of rows) assert.equal(counts.get(row.runnerId) ?? 0, row.held ? 1 : 0, `${row.title}: running count`);
    // The drain's waiting work (every runner beats draining): a queued session with earlier turns, its message waiting.
    const waiting = await drainWaitingOf(prisma, ownerId, runners.map((r) => ({ id: r.id, heartbeatDraining: true, selfUpdate: null })));
    const beforeWaiting = await db.$queryRaw<Array<{ runnerId: string; messages: number }>>(Prisma.sql`
      SELECT s.assigned_runner_id::text AS "runnerId",
             (COALESCE(sum(m.turns) FILTER (WHERE NOT (${Prisma.raw(wordSql('s'))} = 'PENDING' AND s.num_turns = 0)), 0)
              + count(*) FILTER (WHERE ${Prisma.raw(wordSql('s'))} = 'PENDING' AND s.num_turns > 0 AND m.turns = 0))::int AS messages
        FROM "session" s
        CROSS JOIN LATERAL (SELECT count(*)::int AS turns FROM "conversation_turn" t
                             WHERE t.session_id = s.id AND t.status = 'PENDING' AND t.kind = 'message') m
       WHERE s.id = ANY(${ids}::uuid[]) AND ${Prisma.raw(wordSql('s'))} IN ('PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED')
       GROUP BY s.assigned_runner_id`);
    for (const row of rows) {
      const old = beforeWaiting.find((w) => w.runnerId === row.runnerId)?.messages ?? 0;
      assert.equal(waiting.get(row.runnerId)?.messages ?? 0, old, `${row.title}: waiting messages`);
      assert.equal(waiting.get(row.runnerId)?.sessions ?? 0, 0, `${row.title}: no queued session that never ran`);
    }
  });

  await t.test('the dispatch pause reads the held turns and hints the runners of queued sessions', async () => {
    const hinted: string[] = [];
    const inboxes: string[] = [];
    const pause = new DispatchPauseService(
      prisma,
      { notifySessionQueued: (runnerIds: string[]) => hinted.push(...runnerIds) } as never,
      { notifyInbox: (id: string) => inboxes.push(id), notifyRunnerWake: () => undefined } as never,
    );
    const read = await pause.read();
    const mine = new Set(ids);
    const turns = new Set(read.running.turns.filter((turn) => mine.has(turn.sessionId)).map((turn) => turn.sessionId));
    assert.deepEqual(titles(rows, (row) => turns.has(row.id)), titles(rows, (row) => row.held), 'turns of held sessions');
    await (pause as unknown as { wake(): Promise<void> }).wake();
    const mineHinted = new Set(hinted.filter((id) => byRunner.has(id)));
    assert.deepEqual(titles(rows, (row) => mineHinted.has(row.runnerId)), titles(rows, (row) => row.word === RunStatus.PENDING),
      'the runners of queued sessions');
    assert.deepEqual(titles(rows, (row) => inboxes.includes(row.id)), titles(rows, (row) => row.held), 'the inboxes of held sessions');
  });

  await t.test('the fleet gauges count what the word counted', async () => {
    const [before] = await db.$queryRaw<Array<{ queued: number; running: number }>>(Prisma.sql`
      SELECT (SELECT count(*) FROM "session" s WHERE s."deleted_at" IS NULL AND ${Prisma.raw(wordSql('s'))} = 'PENDING')::int AS queued,
             (SELECT count(*) FROM "session" s WHERE s."deleted_at" IS NULL AND ${Prisma.raw(wordSql('s'))} = 'RUNNING')::int AS running`);
    const gauges = await readFleetGauges(db);
    assert.deepEqual(gauges.sessions, before);
    assert.ok(gauges.sessions.queued >= EXTRAS.length && gauges.sessions.running >= EXTRAS.length);
  });

  await t.test('the claim takes exactly the queued rows, and the slot gate counts the turns in flight', async () => {
    const queue = new QueueService(prisma, silent, new ProviderPlanUsageService(silent));
    // A runner at capacity by a turn in flight claims nothing; one slot more and it claims its queued session.
    const gated = rows.find((row) => row.word === RunStatus.PENDING && row.extra === 'none')!;
    const turn = randomUUID();
    await db.session.create({
      data: {
        id: turn, ownerId, creatorId: ownerId, title: 'slot holder', prompt: 'p', turnState: 'IN_FLIGHT',
        assignedRunnerId: gated.runnerId, provider: 'claude', providerBuiltin: true, dispatchOrigin: SessionDispatchOrigin.USER,
      },
    });
    // A parked session with a background job on the same runner: phase RUNNING, no slot.
    await db.session.create({
      data: {
        ownerId, creatorId: ownerId, title: 'phase only', prompt: 'p', turnState: null,
        assignedRunnerId: gated.runnerId, provider: 'claude', providerBuiltin: true, dispatchOrigin: SessionDispatchOrigin.USER,
        runningBgJobs: ['bgj_phase'], engineTurnActive: true,
      },
    });
    await db.runner.update({ where: { id: gated.runnerId }, data: { maxConcurrent: 1 } });
    assert.equal(await queue.claimSessionForRunner({ id: gated.runnerId, supportedProviders: ['claude'] } as never), null,
      'the turn in flight holds the one slot');
    await db.runner.update({ where: { id: gated.runnerId }, data: { maxConcurrent: 2 } });
    assert.equal((await queue.claimSessionForRunner({ id: gated.runnerId, supportedProviders: ['claude'] } as never))?.sessionId, gated.id,
      'the phase-RUNNING parked session holds none');

    const claimed: string[] = [gated.title];
    for (const row of rows) {
      if (row === gated) continue;
      const job = await queue.claimSessionForRunner({ id: row.runnerId, supportedProviders: ['claude'] } as never);
      if (job) {
        assert.equal(job.sessionId, row.id, `${row.title}: its own runner's session`);
        claimed.push(row.title);
      }
    }
    assert.deepEqual(claimed.sort(), titles(rows, (row) => row.word === RunStatus.PENDING), 'exactly the queued rows');
    const after = await db.$queryRaw<Array<{ id: string; word: string; turnState: string | null; phase: string }>>(Prisma.sql`
      SELECT id::text AS id, ${Prisma.raw(wordSql())} AS word, turn_state AS "turnState", phase FROM "session"
       WHERE id = ANY(${ids}::uuid[])`);
    for (const row of rows) {
      const now = after.find((a) => a.id === row.id)!;
      if (row.word === RunStatus.PENDING) {
        // The claim writes turn_state alone, and the word follows it.
        assert.deepEqual([now.word, now.turnState, now.phase], ['RUNNING', 'IN_FLIGHT', 'RUNNING'], `${row.title}: claimed`);
      } else {
        assert.equal(now.word, row.word, `${row.title}: untouched`);
      }
    }
  });
});
