/**
 * THE PROJECTS, TASKS AND TASK-LISTS READERS ON THE FACTS, AGAINST POSTGRESQL (task T11 of
 * docs/session-status-retirement-plan.md, §2.1 and §2.4):
 *
 *   (1) the turn state helpers (sessions/session-turn-state.ts) select, for every word, exactly the rows the old word
 *       sets selected: Prisma, TypeScript, SQL
 *   (2) every SQL predicate T11 rewrote answers, row by row, what the predicate it replaced answered on the stored
 *       word, which since deploy D3 (task T14) migration 1671's trigger writes from the facts
 *   (3) the readers themselves give today's answers: the idle-run check (task-run-idle.ts), the project's ready-to-run
 *       queue (project-ready-to-run.ts) and the attempt-ended wake fact (task-exception-input.producer.ts), whose
 *       `sessionStatus` is the derived word (plan §3.4)
 *
 * The rows with turn_state NULL beside a word that names a turn, which the NULL fallback read until T14, no longer
 * exist: 1652 validated session_turn_state_agrees_chk, and the fallback went with T14.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/projects/session-turn-state-readers.pg.spec.ts
 *
 * The old predicates are spelled here, in a spec, on purpose: they are what the readers were held to.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Prisma, PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';

import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { LEGACY_STATUS_SELECT, legacySessionStatus, legacySessionStatusSql } from '../sessions/session-legacy-words';
import {
  sessionTurnStateSql,
  TURN_STATE_SELECT,
  turnStateFilter,
  turnStateOf,
  type TurnState,
} from '../sessions/session-turn-state';
import { assertCoordinatorPgUrlIsIsolated } from './coordinator-pg-test-safety';
import { readProjectReadyToRun } from './project-ready-to-run';
import { findIdleRuns } from './task-run-idle';
import { TaskExceptionInputProducer } from './task-exception-input.producer';
import { turnStateOfWord } from '../sessions/session-turn-state';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const HELD_WORDS = [RunStatus.PENDING, RunStatus.RUNNING, RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED];
const RELEASED_WORDS = [RunStatus.SUCCEEDED, RunStatus.FAILED, RunStatus.CANCELLED];

/** The word sets the T11 readers read, and the turn states each became (plan §2.1). */
const TRANSLATIONS: Array<{ code: string; words: RunStatus[]; states: Array<TurnState | null> }> = [
  { code: 'Q', words: [RunStatus.PENDING], states: ['QUEUED'] },
  { code: 'F', words: [RunStatus.RUNNING], states: ['IN_FLIGHT'] },
  { code: 'U', words: [RunStatus.PENDING, RunStatus.RUNNING], states: ['QUEUED', 'IN_FLIGHT'] },
  { code: 'A', words: [RunStatus.AWAITING_INPUT], states: [null] },
  { code: 'AI', words: [RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED], states: [null, 'ABANDONED'] },
];

const TURN_STATE_OF_WORD: Record<string, TurnState | null> = {
  PENDING: 'QUEUED', RUNNING: 'IN_FLIGHT', INTERRUPTED: 'ABANDONED', AWAITING_INPUT: null,
};

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
  projectId: string;
}

async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `${label}-${ownerId}@turn-state.invalid`, name: label, passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: `${label}-runner`, tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(), maxConcurrent: 8,
    },
  });
  const workspace = await db.workspace.create({ data: { ownerId, runnerId, name: `${label}-workspace`, enabled: true } });
  const project = await db.project.create({ data: { ownerId, title: `${label} project` } });
  return { ownerId, runnerId, workspaceId: workspace.id, projectId: project.id };
}

/** A session at `word`: its turn state, or its release. */
async function session(
  db: PrismaClient,
  ids: World,
  title: string,
  word: RunStatus,
  options: { data?: Partial<Prisma.SessionUncheckedCreateInput> } = {},
): Promise<string> {
  const released = RELEASED_WORDS.includes(word);
  const { id } = await db.session.create({
    data: {
      ownerId: ids.ownerId, creatorId: ids.ownerId, title, prompt: title, turnState: turnStateOfWord(word),
      dispatchOrigin: SessionDispatchOrigin.USER, provider: 'claude', providerBuiltin: true,
      workspaceId: ids.workspaceId, assignedRunnerId: ids.runnerId, startedAt: new Date(),
      ...(released ? { finishedAt: new Date(), lastTurnOutcome: word === RunStatus.FAILED ? 'FAILED' : 'ANSWERED' } : {}),
      ...options.data,
    },
  });
  return id;
}

async function task(db: PrismaClient, ids: World, title: string, extra: Partial<Prisma.TaskUncheckedCreateInput> = {}) {
  const created = await db.task.create({
    data: {
      ownerId: ids.ownerId, creatorType: 'USER', creatorId: ids.ownerId, title, projectId: ids.projectId,
      assigneeId: ids.workspaceId, completionCriterion: 'EVIDENCE_JUDGMENT', autoRunWhenReady: false, ...extra,
    },
  });
  return created.id;
}

test('projects, tasks and task lists read the facts, and answer as the stored word did', { skip, timeout: 300_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const db = prismaClientFor(URL!);
  t.after(() => db.$disconnect());

  await t.test('(1) the helpers select what the old word sets selected', async () => {
    const ids = await world(db, 'helpers');
    // Every word, and every held word once more with an end recorded.
    const rows: Array<{ title: string; word: RunStatus }> = [];
    for (const word of [...HELD_WORDS, ...RELEASED_WORDS]) {
      await session(db, ids, word, word);
      rows.push({ title: word, word });
    }
    for (const word of HELD_WORDS) {
      await session(db, ids, `${word} ended`, word, { data: { endReason: 'cancelled' } });
      rows.push({ title: `${word} ended`, word });
    }

    for (const { code, words, states } of TRANSLATIONS) {
      const found = await db.session.findMany({
        where: { AND: [{ ownerId: ids.ownerId }, turnStateFilter(states)] }, select: { title: true },
      });
      const expected = rows.filter((row) => words.includes(row.word)).map((row) => row.title);
      assert.deepEqual(found.map((row) => row.title).sort(), expected.sort(), `${code}: turnStateFilter`);
    }

    const read = await db.session.findMany({ where: { ownerId: ids.ownerId }, select: { title: true, ...TURN_STATE_SELECT } });
    const sql = await db.$queryRaw<Array<{ title: string; state: string | null; word: string; stored: string }>>(Prisma.sql`
      SELECT s.title, ${sessionTurnStateSql('s')} AS state, ${legacySessionStatusSql('s')} AS word, s.status::text AS stored
        FROM session s WHERE s.owner_id = ${ids.ownerId}::uuid`);
    const bySql = new Map(sql.map((row) => [row.title, row]));
    for (const row of read) {
      const word = rows.find((r) => r.title === row.title)!.word;
      const expected = RELEASED_WORDS.includes(word) ? null : TURN_STATE_OF_WORD[word];
      assert.equal(turnStateOf(row), expected, `${row.title}: turnStateOf`);
      assert.equal(bySql.get(row.title)!.state, expected, `${row.title}: sessionTurnStateSql`);
    }
    const full = await db.session.findMany({ where: { ownerId: ids.ownerId }, select: { title: true, ...LEGACY_STATUS_SELECT } });
    for (const row of full) {
      const stored = bySql.get(row.title)!;
      assert.equal(stored.word, legacySessionStatus(row), `${row.title}: legacySessionStatusSql is the projector`);
      // The stored word is migration 1671's, from the same facts (deploy D3).
      assert.equal(stored.stored, stored.word, `${row.title}: the stored word is the projector's`);
    }
  });

  await t.test('(2) each rewritten SQL predicate answers what the one it replaced answered, row by row', async () => {
    const ids = await world(db, 'predicates');
    for (const word of [...HELD_WORDS, ...RELEASED_WORDS]) {
      for (const endReason of [null, 'cancelled']) {
        await session(db, ids, `${word} ${endReason ?? 'no end'}`, word, { data: { endReason } });
      }
    }
    const ts = sessionTurnStateSql('s');
    const rows = await db.$queryRaw<Array<Record<string, unknown> & { title: string }>>(Prisma.sql`
      SELECT s.title,
             -- project-ready-to-run.ts: the run state and the order of a task's carriers.
             (CASE s.status WHEN 'PENDING'::run_status THEN 'QUEUED' ELSE 'RUNNING' END) AS "readyStateOld",
             (CASE ${ts} WHEN 'QUEUED' THEN 'QUEUED' ELSE 'RUNNING' END) AS "readyStateNew",
             (CASE s.status WHEN 'RUNNING'::run_status THEN 0 ELSE 1 END) AS "readyOrderOld",
             (CASE ${ts} WHEN 'IN_FLIGHT' THEN 0 ELSE 1 END) AS "readyOrderNew",
             -- tasks.service.ts materialisationBudget: a join condition, so NULL is false.
             COALESCE(s.status IN ('RUNNING', 'PENDING'), false) AS "budgetOld",
             COALESCE(${ts} IN ('IN_FLIGHT', 'QUEUED'), false) AS "budgetNew",
             -- tasks.service.ts: the paused run a press continues.
             (s.status IN ('AWAITING_INPUT'::run_status, 'INTERRUPTED'::run_status)) AS "pausedOld",
             (s.finished_at IS NULL AND COALESCE(${ts}, 'PARKED') IN ('PARKED', 'ABANDONED')) AS "pausedNew",
             -- open-item-escalation.service.ts: not an INTERRUPTED one whose end was recorded (beside held).
             (s.finished_at IS NULL AND (s.status <> 'INTERRUPTED' OR s.end_reason IS NULL)) AS "escalationOld",
             (s.finished_at IS NULL AND (${ts} IS DISTINCT FROM 'ABANDONED' OR s.end_reason IS NULL)) AS "escalationNew",
             -- tasks.service.ts and task-exception-input.producer.ts: the word, for a held row.
             (CASE WHEN s.finished_at IS NULL THEN s.status::text END) AS "heldWordOld",
             (CASE WHEN s.finished_at IS NULL THEN ${legacySessionStatusSql('s')} END) AS "heldWordNew"
        FROM session s WHERE s.owner_id = ${ids.ownerId}::uuid`);
    assert.equal(rows.length, HELD_WORDS.length * 2 + RELEASED_WORDS.length * 2);
    const differences = rows.flatMap((row) => ['readyState', 'readyOrder', 'budget', 'paused', 'escalation', 'heldWord']
      .filter((name) => row[`${name}Old`] !== row[`${name}New`])
      .map((name) => `${row.title}: ${name} was ${String(row[`${name}Old`])}, is ${String(row[`${name}New`])}`));
    assert.deepEqual(differences, []);
  });

  await t.test('(3) the readers', async () => {
    const ids = await world(db, 'readers');
    const now = new Date();
    const longAgo = new Date(now.getTime() - 2 * 3_600_000);

    // The idle-run check: a parked run is idle, an interrupted one is not.
    const idle: Record<string, boolean> = {};
    for (const word of [RunStatus.AWAITING_INPUT, RunStatus.INTERRUPTED]) {
      const taskId = await task(db, ids, `idle ${word}`, { status: 'IN_PROGRESS' });
      const sessionId = await session(db, ids, `idle ${word}`, word, {
        data: { taskId, startsTaskWork: true, lastTurnAt: longAgo },
      });
      idle[word] = (await findIdleRuns(db as unknown as PrismaService, now, { sessionId })).length === 1;
    }
    assert.deepEqual(idle, { AWAITING_INPUT: true, INTERRUPTED: false });

    // The ready-to-run queue: a queued run reads QUEUED and a running one RUNNING.
    const queueWorld = await world(db, 'queue');
    const runState: Record<string, string | undefined> = {};
    const tasks = new Map<string, string>();
    for (const word of [RunStatus.PENDING, RunStatus.RUNNING]) {
      const taskId = await task(db, queueWorld, `queue ${word}`, { status: 'IN_PROGRESS' });
      await session(db, queueWorld, `queue ${word}`, word, { data: { taskId, startsTaskWork: true } });
      tasks.set(word, taskId);
    }
    const queue = await readProjectReadyToRun(db as unknown as PrismaService, queueWorld.ownerId, queueWorld.projectId, 10);
    for (const [label, taskId] of tasks) runState[label] = queue.items.find((item) => item.taskId === taskId)?.runState;
    assert.deepEqual(runState, { PENDING: 'QUEUED', RUNNING: 'RUNNING' });
    assert.deepEqual([queue.queuedCount, queue.runningCount], [1, 1]);

    // The attempt-ended wake fact names the derived word: a failure reads FAILED; an end that was asked for, whose
    // run then failed, reads CANCELLED (plan §3.4, C2), where deploy 2 stored FAILED.
    const producer = new TaskExceptionInputProducer(db as unknown as PrismaService, {} as never);
    const failed = await task(db, ids, 'ended failed');
    const failedRun = await session(db, ids, 'ended failed', RunStatus.FAILED, { data: { taskId: failed, startsTaskWork: true } });
    const ended = await task(db, ids, 'ended after an end');
    await session(db, ids, 'ended after an end', RunStatus.FAILED, {
      data: { taskId: ended, startsTaskWork: true, endReason: 'cancelled' },
    });
    const facts = await producer.factsFor([failed, ended]);
    const words = new Map(facts.map((fact) => [fact.subjectId, (fact.detail as { sessionStatus?: string }).sessionStatus]));
    assert.deepEqual(Object.fromEntries([...words].map(([id, word]) => [id === failed ? 'failed' : 'ended', word])), {
      failed: 'FAILED', ended: 'CANCELLED',
    });
    assert.equal(facts.find((fact) => fact.subjectId === failed)?.subjectVersion, failedRun);
  });
});
