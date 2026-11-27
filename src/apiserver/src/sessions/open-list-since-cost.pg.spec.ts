import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { Prisma, PrismaClient, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { readOpenListVersion } from './open-list-version';
import { SessionsService } from './sessions.service';
import { turnStateOfWord } from './session-turn-state';

/**
 * What one `since=` read of a workspace column costs when the account's version has moved, on a
 * column of about 550 rows where 0 to 3 of them changed since the cursor: the whole build every
 * such read paid before (the version, then `list`), against the read as it is now (`listOpenSince`).
 * For each it reports the rows built, the median wall time, and the shared buffers of every raw
 * statement it ran (replayed under EXPLAIN (ANALYZE, BUFFERS)); the Prisma reads both make alike —
 * the row overlay's cards and decisions, read by session id — are in the time, not the buffers.
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/sessions/open-list-since-cost.pg.spec.ts
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;
const ROWS = 550;
const ROUNDS = 7;

function inert<T>(): T {
  return new Proxy({}, { get: () => () => undefined }) as T;
}

test(`a since= read of a ${ROWS}-row column builds only the rows that moved`, { skip, timeout: 600_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  t.after(() => sql.end());
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(URL!);
  t.after(() => db.$disconnect());

  // Every raw statement the service runs, kept for the EXPLAIN replay.
  let recorded: Prisma.Sql[] = [];
  const prisma = new Proxy(db, {
    get(target, key, receiver) {
      if (key === '$queryRaw') {
        return (query: Prisma.Sql, ...rest: unknown[]) => {
          if (query && typeof (query as Prisma.Sql).text === 'string') recorded.push(query);
          return (target.$queryRaw as (...a: unknown[]) => unknown)(query, ...rest);
        };
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const sessions = new SessionsService(
    prisma as unknown as PrismaService,
    inert<ConstructorParameters<typeof SessionsService>[1]>(),
    inert<ConstructorParameters<typeof SessionsService>[2]>(),
  );
  let built = 0;
  const service = sessions as unknown as { listRows: (...args: unknown[]) => Promise<unknown[]> };
  const listRows = service.listRows.bind(sessions);
  service.listRows = async (...args: unknown[]) => {
    const rows = await listRows(...args);
    built += rows.length;
    return rows;
  };
  // Where the time goes: each step's milliseconds in the read being measured.
  let phases: Record<string, number> = {};
  const timed = sessions as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const name of ['listOverlay', 'openListProbe']) {
    const original = timed[name].bind(sessions);
    timed[name] = async (...args: unknown[]) => {
      const started = performance.now();
      try {
        return await original(...args);
      } finally {
        phases[name] = (phases[name] ?? 0) + performance.now() - started;
      }
    };
  }

  // The account: a runner, workspaces A and B, ~550 open rows in B — half carry a task, a tenth sit
  // in one of a few projects, a few run — and a few in A.
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const [a, b] = [randomUUID(), randomUUID()];
  await db.user.create({ data: { id: ownerId, email: `olc-${ownerId}@open-list-cost.invalid`, name: 'olc', passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'olc-runner', tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(Date.now() + 3_600_000),
    },
  });
  for (const [id, name] of [[a, 'olc-a'], [b, 'olc-b']]) {
    await db.workspace.create({ data: { id, ownerId, runnerId, name, enabled: true } });
  }
  const projects = await Promise.all([1, 2, 3].map((n) => db.project.create({ data: { ownerId, title: `olc project ${n}` } })));
  const make = async (workspaceId: string, n: number) => {
    const taskId = n % 2 === 0 ? (await db.task.create({
      data: {
        ownerId, title: `olc task ${n}`, creatorType: 'USER', creatorId: ownerId, completionCriterion: 'OWNER_CONFIRMED',
        projectId: n % 10 === 0 ? projects[n % 3].id : undefined,
      },
    })).id : undefined;
    return (await db.session.create({
      data: {
        ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title: `olc ${n}`, prompt: 'olc',
        provider: 'claude', providerBuiltin: true, startedAt: new Date(), taskId,
        turnState: turnStateOfWord(n % 50 === 0 ? RunStatus.RUNNING : RunStatus.AWAITING_INPUT),
        lastAssistantText: 'x'.repeat(2_000), dispatchOrigin: SessionDispatchOrigin.USER,
      },
    })).id;
  };
  const inB: string[] = [];
  for (let n = 0; n < ROWS; n++) inB.push(await make(b, n));
  const inA: string[] = [];
  for (let n = 0; n < 10; n++) inA.push(await make(a, n));
  // A few rows something is waiting on, as a busy column always has: each asked an A session for a reply.
  for (const from of inB.slice(0, 3)) {
    const turn = await db.conversationTurn.create({
      data: { sessionId: inA[0], seq: inB.indexOf(from) + 1, kind: 'message', status: 'IN_FLIGHT', clientTurnId: randomUUID() },
    });
    await db.sessionRequest.create({
      data: {
        ownerId, fromSessionId: from, toSessionId: inA[0], turnId: turn.id, clientTurnId: turn.clientTurnId,
        kind: 'MESSAGE', requestPreview: 'olc?', replyBy: new Date(Date.now() + 3_600_000),
      },
    });
  }
  await sql.query('ANALYZE');

  const filters = { runnerId, workspaceId: b };
  let cursor = (await sessions.listOpenSince(ownerId, filters, '')).cursor;

  /** The shared buffers of every statement recorded since the last call, replayed under EXPLAIN. */
  const buffers = async () => {
    let total = 0;
    for (const query of recorded) {
      const { rows } = await sql.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`, query.values as unknown[]);
      const plan = (rows[0]['QUERY PLAN'] as Array<{ Plan: Record<string, number> }>)[0].Plan;
      total += (plan['Shared Hit Blocks'] ?? 0) + (plan['Shared Read Blocks'] ?? 0);
    }
    recorded = [];
    return total;
  };
  let round = 0;
  /** One account write in A and `inBMoved` rows of B renamed, so the cursor's version is gone. */
  const write = async (inBMoved: number, card: boolean) => {
    round += 1;
    await db.session.update({ where: { id: inA[1 + (round % (inA.length - 1))] }, data: { title: `a moved ${round}` } });
    // An approval card in A: a source every row's overlay reads, so the read reads them all again.
    if (card) await db.approval.create({ data: { sessionId: inA[1], toolName: 'Bash', input: {}, status: 'PENDING' } });
    for (let i = 0; i < inBMoved; i++) {
      await db.session.update({ where: { id: inB[(round * 7 + i * 31) % inB.length] }, data: { title: `b moved ${round}.${i}` } });
    }
  };
  const median = (values: number[]) => [...values].sort((x, y) => x - y)[Math.floor(values.length / 2)];
  const phaseMedian = (runs: Record<string, number>[], name: string) => median(runs.map((run) => run[name] ?? 0)).toFixed(1);

  const report: string[] = [];
  for (const [moved, card] of [[0, false], [1, false], [3, false], [1, true]] as const) {
    // Before: the version, then the whole column, which is what every such read did.
    const before = { ms: [] as number[], rows: [] as number[], buffers: [] as number[], phases: [] as Record<string, number>[] };
    for (let i = 0; i < ROUNDS; i++) {
      await write(moved, card);
      recorded = [];
      built = 0;
      phases = {};
      const started = performance.now();
      await readOpenListVersion(prisma as never, ownerId);
      await sessions.list(ownerId, { ...filters, view: 'open' });
      before.ms.push(performance.now() - started);
      before.rows.push(built);
      before.phases.push(phases);
      before.buffers.push(await buffers());
    }
    // After: the read as it is now, from the cursor of the read before it (caught up first, unmeasured).
    cursor = (await sessions.listOpenSince(ownerId, filters, cursor)).cursor;
    const after = { ms: [] as number[], rows: [] as number[], buffers: [] as number[], phases: [] as Record<string, number>[] };
    for (let i = 0; i < ROUNDS; i++) {
      await write(moved, card);
      recorded = [];
      built = 0;
      phases = {};
      const started = performance.now();
      const answer = await sessions.listOpenSince(ownerId, filters, cursor);
      after.ms.push(performance.now() - started);
      after.rows.push(built);
      after.phases.push(phases);
      after.buffers.push(await buffers());
      assert.equal(answer.full, false);
      assert.equal((answer as { upserts: unknown[] }).upserts.length, moved);
      cursor = answer.cursor;
    }
    assert.equal(median(before.rows), ROWS);
    assert.equal(median(after.rows), moved, `${moved} moved: the read built more rows than moved`);
    report.push(
      `${moved} of ${ROWS} rows moved${card ? ' + a card in A' : ''} | before: built ${median(before.rows)}, ${median(before.ms).toFixed(1)} ms, `
      + `${median(before.buffers)} buffers | after: built ${median(after.rows)}, ${median(after.ms).toFixed(1)} ms, `
      + `${median(after.buffers)} buffers`
      + ` | of which overlay ${phaseMedian(before.phases, 'listOverlay')} -> ${phaseMedian(after.phases, 'listOverlay')} ms,`
      + ` probe ${phaseMedian(after.phases, 'openListProbe')} ms`,
    );
  }
  for (const line of report) t.diagnostic(line);
  console.log(['', 'OPEN LIST SINCE= COST (median of ' + ROUNDS + ')', ...report, ''].join('\n'));
});
