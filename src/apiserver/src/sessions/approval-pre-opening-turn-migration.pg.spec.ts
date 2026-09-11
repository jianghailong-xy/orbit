/**
 * 0258 SETTLES THE PRE-0252 APPROVALS NOTHING IS ASKING ANY MORE, AND ONLY THOSE.
 *
 * `abandoned-approvals.ts` collects an approval when the turn that raised it has ended, and reads
 * that from `approval.turn_id`, which 0252 added. Every row filed before 0252 is null there, so none
 * of them could ever be collected: production held 27 PENDING ones on 12 sessions, lighting "needs
 * you" on conversations where nobody was waiting. 0258 settles them once.
 *
 * WHAT THIS HOLDS THE MIGRATION TO
 * --------------------------------
 * The rows below are seeded on the database run-pg-spec.sh migrated, and then the migration's own
 * file is executed against them, not a transcription of its predicate.
 *
 *   (1) Where there is no migration history table (Prisma's shadow database) it runs, and writes
 *       nothing.
 *   (2) Where the history has no record of 0252 it collects nothing: the landing moment is unknown.
 *   (3) What it collects: a PENDING row with no opener, filed before 0252 was applied here, that
 *       nothing is asking any more. That covers one in an ended session, one in an idle session, and
 *       one in a generating session whose call already has a result. Each becomes ABANDONED with
 *       the reason, keeps a null `decided_at` and `decided_by_id`, and is not deleted.
 *   (4) What it must not touch, one negative control each, every one collectable but for the clause
 *       it stands against: a row that names its turn (the reaper's population); a row filed after
 *       0252 was applied; a row still being asked in a dispatched turn and one in a self-driven turn;
 *       and a row somebody already decided.
 *   (5) Running it again changes nothing.
 *
 * (1) and (2) run inside rolled-back transactions before the real pass, while every row in (3) is
 * still collectable, and (4) reads the same pass as (3). So no "nothing changed" here can pass by
 * the migration having done nothing at all.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/approval-pre-opening-turn-migration.pg.spec.ts
 *
 * Not destructive: every id is freshly generated and every assertion is scoped to this owner.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { Client } from 'pg';

import { prismaClientFor } from '../prisma/prisma-client';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { APPROVAL_ABANDONED_STATUS } from './abandoned-approvals';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const MIGRATION = readFileSync(
  path.resolve(
    __dirname,
    '../../prisma/migrations/0258_approval_pre_opening_turn_abandoned/migration.sql',
  ),
  'utf8',
);

/** The reason 0258 writes into every row it settles. */
const SETTLED_MESSAGE =
  'raised before approvals recorded their turn, and no longer being asked when this was written ' +
  '(its session was not generating, or the call already had a result), so nothing is left to ' +
  'receive an answer';

type Row = Record<string, string | null>;

interface Owner {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
}

interface Seeded {
  id: string;
  toolUseId: string;
}

async function owner(db: PrismaClient): Promise<Owner> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `pre-0252-${ownerId}@approvals.invalid`,
      name: 'The account owner',
      passwordHash: 'x',
    },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: 'pre-0252-runner',
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: 'pre-0252-workspace', enabled: true },
  });
  return { ownerId, runnerId, workspaceId };
}

async function session(
  db: PrismaClient,
  o: Owner,
  label: string,
  status: RunStatus,
  engineTurnActive: boolean,
): Promise<string> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id,
      ownerId: o.ownerId,
      creatorId: o.ownerId,
      workspaceId: o.workspaceId,
      assignedRunnerId: o.runnerId,
      title: `${label} session`,
      prompt: `${label} session`,
      provider: 'claude',
      status,
      engineTurnActive,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startedAt: new Date(),
      runtimeSessionId: randomUUID(),
    },
  });
  return id;
}

/** An `AskUserQuestion` approval as the runner files one; `decidedBy` makes it an answered one. */
async function approval(
  db: PrismaClient,
  sessionId: string,
  opts: { createdAt: Date; turnId?: string; decidedBy?: string },
): Promise<Seeded> {
  const toolUseId = `toolu_${randomUUID()}`;
  const row = await db.approval.create({
    data: {
      sessionId,
      toolName: 'AskUserQuestion',
      input: { questions: [{ question: 'which way?', header: 'Way', options: [] }] },
      toolUseId,
      turnId: opts.turnId ?? null,
      createdAt: opts.createdAt,
      ...(opts.decidedBy
        ? {
            status: 'ALLOWED',
            message: 'allowed by the owner',
            answers: { 'which way?': ['left'] },
            decidedById: opts.decidedBy,
            decidedAt: new Date(opts.createdAt.getTime() + 60_000),
          }
        : {}),
    },
    select: { id: true },
  });
  return { id: row.id, toolUseId };
}

/** The engine's record of the call; `finishedAt` null is a call that is still running. */
async function toolCall(
  db: PrismaClient,
  sessionId: string,
  toolUseId: string,
  startedAt: Date,
  finishedAt: Date | null,
): Promise<void> {
  await db.toolCall.create({
    data: {
      sessionId,
      name: 'AskUserQuestion',
      toolUseId,
      startedAt,
      finishedAt,
      ...(finishedAt ? { isError: true, output: 'approval poll failed: connection reset by peer' } : {}),
    },
  });
}

/** Every column of these sessions' approvals, as text, by id: what "untouched" is measured on. */
async function snapshot(sql: Client, sessionIds: string[]): Promise<Map<string, Row>> {
  const { rows } = await sql.query<Row>(
    `SELECT "id"::text AS "id", "session_id"::text AS "session_id", "tool_name",
            "input"::text AS "input", "tool_use_id", "turn_id"::text AS "turn_id", "status",
            "message", "answers"::text AS "answers", "remember_rule"::text AS "remember_rule",
            "decided_by_id"::text AS "decided_by_id", "created_at"::text AS "created_at",
            "decided_at"::text AS "decided_at"
       FROM "approval"
      WHERE "session_id" = ANY($1::uuid[])
      ORDER BY "id"`,
    [sessionIds],
  );
  return new Map(rows.map((row) => [row.id!, row]));
}

test('0258 settles the pre-0252 approvals nothing is asking any more, and only those', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(url);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  // When 0252 was applied to THIS database: the moment the migration reads, and the one the
  // fixture straddles.
  const history = await sql.query<{ at: Date | null }>(
    `SELECT min("finished_at") AS "at" FROM "_prisma_migrations"
      WHERE "migration_name" = '0252_approval_opening_turn' AND "rolled_back_at" IS NULL`,
  );
  const landed = history.rows[0].at;
  assert.ok(landed instanceof Date, '0252 is in this database’s migration history');
  const beforeLanding = new Date(landed.getTime() - 60 * 60 * 1000);
  const afterLanding = new Date(landed.getTime() + 1000);

  const o = await owner(db);
  const ended = await session(db, o, 'ended', RunStatus.CANCELLED, false);
  const idle = await session(db, o, 'idle', RunStatus.AWAITING_INPUT, false);
  const dispatched = await session(db, o, 'dispatched', RunStatus.RUNNING, true);
  const selfDriven = await session(db, o, 'self-driven', RunStatus.AWAITING_INPUT, true);
  const sessions = [ended, idle, dispatched, selfDriven];

  // What 0258 is for.
  const inEndedSession = await approval(db, ended, { createdAt: beforeLanding });
  const inIdleSession = await approval(db, idle, { createdAt: beforeLanding });
  const callHasResult = await approval(db, dispatched, { createdAt: beforeLanding });
  await toolCall(db, dispatched, callHasResult.toolUseId, beforeLanding,
    new Date(beforeLanding.getTime() + 60_000));

  // What it must leave alone.
  const turn = await db.conversationTurn.create({
    data: {
      sessionId: ended,
      seq: 1,
      clientTurnId: `turn-${randomUUID()}`,
      kind: 'message',
      content: 'ask me something',
      status: 'ANSWERED',
      deliveredAt: beforeLanding,
      answeredAt: beforeLanding,
    },
    select: { id: true },
  });
  const namesItsTurn = await approval(db, ended, { createdAt: beforeLanding, turnId: turn.id });
  const filedAfterLanding = await approval(db, ended, { createdAt: afterLanding });
  const askedInDispatchedTurn = await approval(db, dispatched, { createdAt: beforeLanding });
  const askedInSelfDrivenTurn = await approval(db, selfDriven, { createdAt: beforeLanding });
  await toolCall(db, selfDriven, askedInSelfDrivenTurn.toolUseId, beforeLanding, null);
  const decided = await approval(db, ended, { createdAt: beforeLanding, decidedBy: o.ownerId });

  const seeded = await snapshot(sql, sessions);
  assert.equal(seeded.size, 8, 'every seeded approval is on record');

  /** Run the migration after `prepare`, read the rows, and undo all of it. */
  async function rolledBack(prepare: string): Promise<Map<string, Row>> {
    await sql.query('BEGIN');
    try {
      await sql.query(prepare);
      await sql.query(MIGRATION);
      return await snapshot(sql, sessions);
    } finally {
      await sql.query('ROLLBACK');
    }
  }

  await t.test('(1) with no migration history table it runs, and writes nothing', async () => {
    const seen = await rolledBack(
      'ALTER TABLE "_prisma_migrations" RENAME TO "_prisma_migrations_hidden_by_0258_spec"',
    );
    assert.deepEqual(seen, seeded, 'a database with no history table has nothing to settle');
  });

  await t.test('(2) with no record of 0252 in the history it collects nothing', async () => {
    const seen = await rolledBack(
      `UPDATE "_prisma_migrations" SET "migration_name" = 'hidden_by_0258_spec'
        WHERE "migration_name" = '0252_approval_opening_turn'`,
    );
    assert.deepEqual(seen, seeded, 'with the landing moment unknown, no row is before it');
  });

  await sql.query(MIGRATION);
  const settled = await snapshot(sql, sessions);

  await t.test('(3) it settles the rows nothing is asking, and only writes the reason', async () => {
    const collected: Array<[string, Seeded]> = [
      ['a row in an ended session', inEndedSession],
      ['a row in an idle session', inIdleSession],
      ['a row in a generating session whose call already has a result', callHasResult],
    ];
    for (const [name, row] of collected) {
      const now = settled.get(row.id);
      assert.ok(now, `${name} is still on record: settled, not deleted`);
      assert.equal(now.decided_at, null, `${name} was not decided; nobody decided anything`);
      assert.equal(now.decided_by_id, null, `${name} names no decider, for the same reason`);
      const expected: Row = {
        ...seeded.get(row.id)!,
        status: APPROVAL_ABANDONED_STATUS,
        message: SETTLED_MESSAGE,
      };
      assert.deepEqual(now, expected, `${name} is ABANDONED with the reason, and no other column moved`);
    }
    assert.equal(settled.size, seeded.size, 'no approval was deleted');
  });

  const untouched: Array<[string, Seeded, string]> = [
    ['a PENDING row that names its turn', namesItsTurn,
      'its turn is the reaper’s fact to decide on; 0258 is only for rows that cannot name one'],
    ['a row filed after 0252 was applied', filedAfterLanding,
      'a null opener then means "raised outside a turn", which stays the reaper’s to leave alone'],
    ['a row still being asked in a dispatched turn', askedInDispatchedTurn,
      'its session is generating and its own call has no result (the result in that session is another call’s)'],
    ['a row still being asked in a self-driven turn', askedInSelfDrivenTurn,
      'its session is generating and its call is still running'],
    ['a row somebody already decided', decided, 'a decision is never rewritten'],
  ];
  for (const [name, row, why] of untouched) {
    await t.test(`(4) it leaves alone ${name}`, async () => {
      assert.deepEqual(settled.get(row.id), seeded.get(row.id), `${name} is exactly as it was: ${why}`);
    });
  }

  await t.test('(5) running it again changes nothing', async () => {
    await sql.query(MIGRATION);
    assert.deepEqual(await snapshot(sql, sessions), settled, 'the second pass wrote nothing');
  });
});
