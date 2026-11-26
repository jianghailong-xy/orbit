import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Prisma, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { Client } from 'pg';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import { ownerRequestVersionSql } from './owner-request-hints';

/**
 * The per-second statement behind `owner_requests.changed` (owner-request-hints.ts), on an account with a long
 * history: about 5,000 settled requests and 20 pending. Its plan must go through `owner_request_owner_state_idx`
 * and read the pending rows only; the unfiltered statement it replaced reads every row the account ever had.
 * Both plans are printed so a reader can compare them.
 */
const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

const SETTLED = 5_000;
const PENDING = 20;

/** `Buffers: shared hit=N read=M` of the plan's top node, as N + M. */
function buffersOf(plan: string): number {
  const line = plan.split('\n').find((l) => l.includes('Buffers:'));
  assert.ok(line, `no Buffers line in:\n${plan}`);
  const hit = /shared hit=(\d+)/.exec(line)?.[1] ?? '0';
  const read = /read=(\d+)/.exec(line)?.[1] ?? '0';
  return Number(hit) + Number(read);
}

test('the version statement reads only the pending rows through the owner/state index', { skip, timeout: 120_000 }, async (t) => {
  assertCoordinatorPgUrlIsIsolated(URL);
  const sql = new Client({ connectionString: URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const db = prismaClientFor(URL!);
  t.after(async () => {
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  await db.user.create({ data: { id: ownerId, email: `orh-${ownerId}@owner-request-hints.invalid`, name: 'orh', passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'orh-runner', tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'orh-workspace', enabled: true } });
  await db.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title: 'orh', prompt: 'orh',
      provider: 'claude', providerBuiltin: true, turnState: 'IN_FLIGHT', startedAt: new Date(),
      dispatchOrigin: SessionDispatchOrigin.USER,
    },
  });
  const row = (state: 'PENDING' | 'DONE') => ({
    ownerId, askedBySessionId: sessionId, kind: 'SCHEDULE_FAILED', state, title: 't', why: 'w',
    scheduleId: randomUUID(), clientRequestId: randomUUID(),
    ...(state === 'DONE' ? { resolvedAt: new Date() } : {}),
  });
  await db.ownerRequest.createMany({ data: Array.from({ length: SETTLED }, () => row('DONE')) });
  await db.ownerRequest.createMany({ data: Array.from({ length: PENDING }, () => row('PENDING')) });
  // Other accounts' rows share the table, as they do in production.
  await sql.query('ANALYZE owner_request');

  const explain = async (statement: Prisma.Sql): Promise<string> => {
    const rows = await sql.query<{ 'QUERY PLAN': string }>(`EXPLAIN (ANALYZE, BUFFERS) ${statement.text}`, statement.values);
    return rows.rows.map((r) => r['QUERY PLAN']).join('\n');
  };

  const current = await explain(ownerRequestVersionSql([ownerId]));
  const unfiltered = await explain(Prisma.sql`
    SELECT owner_id::text AS owner_id,
           count(*)::text || ':' || (extract(epoch FROM max(updated_at)) * 1000)::bigint::text AS version
      FROM owner_request
     WHERE owner_id = ANY(${[ownerId]}::uuid[])
     GROUP BY owner_id`);
  console.log(`--- PENDING-only statement (${SETTLED} settled, ${PENDING} pending)\n${current}`);
  console.log(`--- unfiltered statement it replaced\n${unfiltered}`);

  assert.match(current, /owner_request_owner_state_idx/, 'goes through the (owner_id, state, created_at) index');
  assert.doesNotMatch(current, /Seq Scan/);
  const rows = await db.$queryRaw<Array<{ version: string }>>(ownerRequestVersionSql([ownerId]));
  assert.match(rows[0].version, new RegExp(`^${PENDING}:`), 'counts the pending rows only');
  const used = buffersOf(current);
  const before = buffersOf(unfiltered);
  console.log(`buffers: pending-only ${used}, unfiltered ${before}`);
  assert.ok(used * 5 < before, `the pending-only read touches far fewer buffers (${used} vs ${before})`);
});
