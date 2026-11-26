import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Prisma, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { isReleasedStatus } from '../common/session-release';

import { assertCoordinatorPgUrlIsIsolated } from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import {
  SESSION_EXECUTING_WHERE,
  SESSION_HOLDS_SLOT_WHERE,
  SESSION_WILL_WAKE_WHERE,
  isSessionExecuting,
  sessionExecutingSql,
  sessionHoldsSlot,
  sessionHoldsSlotSql,
  sessionWillWake,
  sessionWillWakeSql,
  type SessionWorkingRow,
} from './session-working';
import { turnStateOfWord } from '../sessions/session-turn-state';

/**
 * The three questions of common/session-working.ts answer alike in all three forms — TypeScript
 * predicate, Prisma `where`, SQL fragment — on the same rows, against a real PostgreSQL:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/common/session-working.pg.spec.ts
 *
 * One owner, and one session per status (all seven) and per combination of seven bits: the engine's
 * own turn, a subagent, a background job, a background SHELL (which must count for nothing), an
 * ACTIVE RESUME_SESSION watch, a PENDING scheduled wake-up and an armed retry — 896 rows, each written as its facts
 * (the turn state of a held word, the release of a released one), so the facts select what the stored word selected
 * (docs/session-status-retirement-plan.md §1.4). Every
 * session also carries the near misses that must not count: a CANCELLED RESUME_SESSION watch, an
 * ACTIVE NOTIFY_USER watch it observes, and a DELIVERED wake-up. Each row is then asked each
 * question three ways, and the answers are compared with each other and with the expectation stated
 * here independently of the module.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const BITS = ['engine', 'subagent', 'job', 'shell', 'watch', 'wakeup', 'retry'] as const;
type Bit = (typeof BITS)[number];
const NOT_ENDED = new Set<string>(['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED']);

interface Fixture {
  id: string;
  status: RunStatus;
  on: Set<Bit>;
}

const watchData = (ownerId: string, sessionId: string, action: string, state: string) => ({
  ownerId,
  observerType: 'SESSION',
  observerSessionId: sessionId,
  predicate: { kind: 'ALL', over: 'ALL_TARGETS', leaf: 'TASK_TERMINAL' },
  mode: 'ONE_SHOT',
  action,
  state,
  expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
});

test('predicate, Prisma filter and SQL fragment agree on every status and fact combination', { skip }, async () => {
  assertCoordinatorPgUrlIsIsolated(URL!);
  const db = prismaClientFor(URL!);
  try {
    const ownerId = randomUUID();
    await db.user.create({
      data: { id: ownerId, email: `session-working-${ownerId}@session-working.invalid`, name: 'w', passwordHash: 'x' },
    });

    const fixtures: Fixture[] = [];
    for (const status of Object.values(RunStatus)) {
      for (let mask = 0; mask < 1 << BITS.length; mask += 1) {
        fixtures.push({ id: randomUUID(), status, on: new Set(BITS.filter((_, bit) => mask & (1 << bit))) });
      }
    }
    assert.equal(fixtures.length, 7 * 128);

    await db.session.createMany({
      data: fixtures.map((f) => ({
        id: f.id, ownerId, creatorId: ownerId, title: 'session-working', prompt: 'p', provider: 'claude',
        turnState: turnStateOfWord(f.status), dispatchOrigin: SessionDispatchOrigin.USER,
        ...(isReleasedStatus(f.status) ? {
          finishedAt: new Date(),
        } : {}),
        engineTurnActive: f.on.has('engine'),
        runningSubagents: f.on.has('subagent') ? ['toolu_sub'] : [],
        runningBgJobs: f.on.has('job') ? ['bgj_job'] : [],
        runningBgShells: [...(f.on.has('job') ? ['bgj_job'] : []), ...(f.on.has('shell') ? ['svc_shell'] : [])],
        retryAt: f.on.has('retry') ? new Date(Date.now() + 60_000) : null,
      })),
    });
    const stored = await db.session.groupBy({
      by: ['turnState'], where: { id: { in: fixtures.filter((f) => NOT_ENDED.has(f.status) && f.status !== 'AWAITING_INPUT').map((f) => f.id) } },
      _count: { _all: true },
    });
    assert.deepEqual(
      Object.fromEntries(stored.map((g) => [String(g.turnState), g._count._all])),
      { QUEUED: 128, IN_FLIGHT: 128, ABANDONED: 128 },
      'each held word that names a turn, with its turn state',
    );
    await db.watch.createMany({
      data: fixtures.flatMap((f) => [
        watchData(ownerId, f.id, 'RESUME_SESSION', 'CANCELLED'),
        watchData(ownerId, f.id, 'NOTIFY_USER', 'ACTIVE'),
        ...(f.on.has('watch') ? [watchData(ownerId, f.id, 'RESUME_SESSION', 'ACTIVE')] : []),
      ]),
    });
    await db.sessionScheduledWakeup.createMany({
      data: fixtures.flatMap((f) => [
        {
          sessionId: f.id, delaySeconds: 60, reason: 'spent', state: 'DELIVERED',
          dueAt: new Date(Date.now() - 60_000), settledAt: new Date(),
        },
        ...(f.on.has('wakeup')
          ? [{ sessionId: f.id, delaySeconds: 1800, reason: 'later', dueAt: new Date(Date.now() + 1_800_000) }]
          : []),
      ]),
    });

    const ids = async (where: Prisma.SessionWhereInput) => new Set(
      (await db.session.findMany({ where: { ownerId, ...where }, select: { id: true } })).map((r) => r.id),
    );
    const prisma = {
      executing: await ids(SESSION_EXECUTING_WHERE),
      willWake: await ids(SESSION_WILL_WAKE_WHERE),
      holdsSlot: await ids(SESSION_HOLDS_SLOT_WHERE),
    };

    const sqlRows = await db.$queryRaw<Array<{
      id: string; executing: boolean; willWake: boolean; holdsSlot: boolean;
    }>>(Prisma.sql`
      SELECT s."id" AS "id",
             ${Prisma.raw(sessionExecutingSql('s'))} AS "executing",
             ${Prisma.raw(sessionWillWakeSql('s'))} AS "willWake",
             ${Prisma.raw(sessionHoldsSlotSql('s'))} AS "holdsSlot"
        FROM "session" s
       WHERE s."owner_id" = ${ownerId}::uuid`);
    const sql = new Map(sqlRows.map((row) => [row.id, row]));
    assert.equal(sql.size, fixtures.length);

    // The TypeScript predicate reads the row as a reader fetches it, the two related facts beside it.
    const fetched = await db.session.findMany({
      where: { ownerId },
      select: {
        id: true, status: true, finishedAt: true, turnState: true, engineTurnActive: true, runningSubagents: true,
        runningBgJobs: true, retryAt: true,
        _count: {
          select: {
            observingWatches: { where: { state: 'ACTIVE', action: 'RESUME_SESSION' } },
            scheduledWakeups: { where: { state: 'PENDING' } },
          },
        },
      },
    });
    const rows = new Map(fetched.map((r): [string, SessionWorkingRow] => [r.id, {
      finishedAt: r.finishedAt, turnState: r.turnState,
      engineTurnActive: r.engineTurnActive, runningSubagents: r.runningSubagents,
      runningBgJobs: r.runningBgJobs, retryAt: r.retryAt,
      hasResumeWatch: r._count.observingWatches > 0, hasPendingWakeup: r._count.scheduledWakeups > 0,
    }]));

    const counts = { executing: 0, willWake: 0, holdsSlot: 0 };
    for (const f of fixtures) {
      const label = `${f.status}: ${[...f.on].join(', ') || 'nothing'}`;
      const row = rows.get(f.id)!;
      const outsideTurn = f.on.has('engine') || f.on.has('subagent') || f.on.has('job');
      const wake = f.on.has('watch') || f.on.has('wakeup') || f.on.has('retry');
      const expected = {
        executing: f.status === RunStatus.RUNNING || (NOT_ENDED.has(f.status) && outsideTurn),
        holdsSlot: f.status === RunStatus.RUNNING,
        willWake: false,
      };
      expected.willWake = !expected.executing && wake;

      const answers = {
        executing: [isSessionExecuting(row), prisma.executing.has(f.id), sql.get(f.id)!.executing],
        willWake: [sessionWillWake(row), prisma.willWake.has(f.id), sql.get(f.id)!.willWake],
        holdsSlot: [sessionHoldsSlot(row), prisma.holdsSlot.has(f.id), sql.get(f.id)!.holdsSlot],
      };
      for (const question of ['executing', 'willWake', 'holdsSlot'] as const) {
        assert.deepEqual(
          answers[question],
          [expected[question], expected[question], expected[question]],
          `${question} [predicate, prisma, sql] on ${label}`,
        );
        if (expected[question]) counts[question] += 1;
      }
    }
    // Neither side is vacuous: every question is true on some rows and false on others.
    for (const question of ['executing', 'willWake', 'holdsSlot'] as const) {
      assert.ok(counts[question] > 0 && counts[question] < fixtures.length, `${question}: ${counts[question]}`);
    }
  } finally {
    await db.$disconnect();
  }
});
