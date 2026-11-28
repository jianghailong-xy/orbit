/**
 * THE SESSION TABLE HAS NO `status` COLUMN (docs/session-status-retirement-plan.md §5, deploy D4, task T15; migration
 * 1711). session-status-column.spec.ts reads the server's source; what it cannot see are the objects the database
 * holds. On a database every migration has been applied to:
 *
 *   (1) there is no column session.status, no type run_status, and nothing — a trigger column list or WHEN clause, a
 *       function body, an index, a CHECK, a view, a generated column — names either
 *   (2) the check fails by name when either is re-added: the column, the type, and a function, trigger, index or CHECK
 *       that names the column, each planted and reported (and rolled back)
 *   (3) the session suite's writers run on this schema: the claim, the finalize, the reaper's sweep, the end of a queued
 *       session, a failed import, a revive and a model read of every field; each row's legacy word is the projector's
 *
 * The migration itself and the way back (scripts/session-status-drop-down.sql) are session-status-drop.pg.spec.ts's.
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-status-column.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import {
  PrismaClient,
  RunnerStatus,
  SessionDispatchOrigin,
  SessionRunSource,
} from '@prisma/client';
import { RunStatus } from '@orbit/shared';
import { RunStatus as SharedRunStatus } from '@orbit/shared';
import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import type { RealtimeService } from '../realtime/realtime.service';
import { ReaperService } from '../realtime/reaper.service';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import { SessionsService } from './sessions.service';
import { fixtureFacts, sessionWord } from '../test-support/session-word';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

interface Stack {
  db: PrismaClient;
  sql: Client;
  api: RunnerApiController;
  queue: QueueService;
  sessions: SessionsService;
  reaper: ReaperService;
}

function stackFor(url: string, sql: Client): Stack {
  const db = prismaClientFor(url);
  const prisma = db as unknown as PrismaService;
  const realtime = new Proxy({}, { get: () => () => undefined }) as unknown as RealtimeService;
  const queue = new QueueService(prisma, realtime);
  const sessions = new SessionsService(prisma, queue, realtime);
  return {
    db,
    sql,
    sessions,
    queue,
    reaper: new ReaperService(prisma, realtime),
    api: new RunnerApiController(
      prisma,
      queue,
      realtime,
      new Proxy({}, { get: () => async () => undefined }) as never,
      { assert: async (_runner: unknown, callingSessionId?: string) => callingSessionId ?? randomUUID() } as never,
      { expand: async (_ownerId: string, content?: string) => content } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      sessions,
    ),
  };
}

interface World {
  ownerId: string;
  runnerId: string;
  workspaceId: string;
}

async function world(db: PrismaClient, label: string): Promise<World> {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@column-less.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `hash-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: [],
      capabilitiesReportedAt: new Date(),
      lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true, workDir: `/srv/${label}` },
  });
  return { ownerId, runnerId, workspaceId };
}

/** A conversation on the world's runner, in the given state. */
async function session(db: PrismaClient, w: World, data: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id,
      ownerId: w.ownerId,
      creatorId: w.ownerId,
      workspaceId: w.workspaceId,
      assignedRunnerId: w.runnerId,
      title: 'a conversation',
      prompt: 'Explain the error in the log',
      turnState: 'IN_FLIGHT',
      provider: 'claude',
      providerBuiltin: true,
      engine: 'claude',
      dispatchOrigin: SessionDispatchOrigin.USER,
      runSource: SessionRunSource.MANUAL,
      startedAt: new Date(),
      runtimeSessionId: randomUUID(),
      ...fixtureFacts(data),
    },
  });
  return id;
}


function bodyNamesStatus(body: string, onSession: boolean, takesSession = false): boolean {
  const text = body.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  if (/\brun_status\b/i.test(text)) return true;
  if (onSession && /\b(new|old)\s*\.\s*"?status\b/i.test(text)) return true;
  if (takesSession && /\.\s*"?status\b/i.test(text)) return true;
  const statements = text.split(';');
  return statements.some((statement) => {
    const tables = [...statement.matchAll(/\b(from|join|update|into)\s+(?:only\s+)?(?:"?public"?\.)?"?session"?(?![\w"])(?:\s+(?:as\s+)?([a-z_]\w*))?/gi)];
    return tables.some((table) => {
      const alias = table[2] && !/^(set|where|on|inner|left|join|for|order|group|limit)$/i.test(table[2]) ? table[2] : 'session';
      return new RegExp(`(?<![\\w.])"?${alias}"?\\s*\\.\\s*"?status\\b`, 'i').test(statement)
        || (table[1].toLowerCase() === 'update' && /\bset\b[\s\S]*?(?<![\w.])"?status"?\s*=/i.test(statement));
    });
  });
}

async function objectsNamingStatus(sql: Client): Promise<string[]> {
  const found: string[] = [];
  const names = async (query: string): Promise<void> => {
    found.push(...(await sql.query<{ name: string }>(query)).rows.map((row) => row.name));
  };
  await names(`SELECT 'column ' || c.relname || '.' || a.attname AS name
     FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    WHERE NOT a.attisdropped AND c.relkind IN ('r', 'p', 'v', 'm')
      AND (a.atttypid = to_regtype('public.run_status')
        OR (c.oid = 'public.session'::regclass AND a.attname = 'status'))`);
  await names(`SELECT 'type run_status' AS name WHERE to_regtype('public.run_status') IS NOT NULL`);
  // `\\m…\\M` take an underscore as part of a word, so `task_status` and `run_status_x` are other words.
  await names(`SELECT 'trigger ' || t.tgname AS name FROM pg_trigger t
    WHERE NOT t.tgisinternal AND t.tgrelid = 'public.session'::regclass
      AND regexp_replace(pg_get_triggerdef(t.oid), 'EXECUTE (FUNCTION|PROCEDURE).*$', '') ~* '\\m(status|run_status)\\M'`);
  await names(`SELECT 'index ' || i.indexrelid::regclass::text AS name FROM pg_index i
    WHERE (i.indrelid = 'public.session'::regclass
           AND regexp_replace(pg_get_indexdef(i.indexrelid), '^.* USING \\w+ ', '') ~ '\\mstatus\\M')
       OR pg_get_indexdef(i.indexrelid) ~ '\\mrun_status\\M'`);
  await names(`SELECT 'check ' || c.conname AS name FROM pg_constraint c
    WHERE c.contype = 'c' AND ((c.conrelid = 'public.session'::regclass AND pg_get_constraintdef(c.oid) ~ '\\mstatus\\M')
       OR pg_get_constraintdef(c.oid) ~ '\\mrun_status\\M')`);
  await names(`SELECT 'view ' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')
      AND pg_get_viewdef(c.oid) ~* '\\mrun_status\\M|session[^\\n]*\\mstatus\\M'`);
  await names(`SELECT 'generated ' || a.attrelid::regclass::text || '.' || a.attname AS name
     FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attgenerated <> '' AND (pg_get_expr(d.adbin, d.adrelid) ~ '\\mrun_status\\M'
       OR (a.attrelid = 'public.session'::regclass AND pg_get_expr(d.adbin, d.adrelid) ~ '\\mstatus\\M'))`);

  const functions = (await sql.query<{ name: string; body: string; onSession: boolean; takesSession: boolean }>(
    `SELECT p.proname AS name, pg_get_functiondef(p.oid) AS body,
            EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid = p.oid AND NOT t.tgisinternal
                      AND t.tgrelid = 'public.session'::regclass) AS "onSession",
            'public.session'::regtype = ANY (p.proargtypes::oid[]) AS "takesSession"
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')`)).rows;
  assert.ok(functions.length > 50, `only ${functions.length} functions: is this a migrated database?`);
  found.push(...functions.filter((fn) => bodyNamesStatus(fn.body, fn.onSession, fn.takesSession)).map((fn) => `function ${fn.name}`));
  return found.sort();
}

test('session.status and run_status do not exist, nothing names them, and the session writers run without them', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const stack = stackFor(url, sql);
  t.after(async () => {
    await stack.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  await t.test('(1) no column, no type, and nothing names either', async () => {
    const found = await objectsNamingStatus(sql);
    assert.deepEqual(found, [], `\nthese name session.status or run_status:\n${found.join('\n')}\n`);
    const column = await sql.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'session' AND column_name = 'status'`);
    assert.equal(column.rowCount, 0);
  });

  await t.test('(2) re-adding the column or the type, or naming the column, is reported by name', async () => {
    const planted = async (statements: string[]): Promise<string[]> => {
      await sql.query('BEGIN');
      try {
        for (const statement of statements) await sql.query(statement);
        return await objectsNamingStatus(sql);
      } finally {
        await sql.query('ROLLBACK');
      }
    };
    assert.deepEqual(await planted(['ALTER TABLE session ADD COLUMN status text']), ['column session.status']);
    assert.deepEqual(await planted([`CREATE TYPE run_status AS ENUM ('PENDING')`]), ['type run_status']);
    assert.deepEqual(await planted([
      `CREATE TYPE run_status AS ENUM ('PENDING', 'RUNNING')`,
      `ALTER TABLE session ADD COLUMN status run_status NOT NULL DEFAULT 'PENDING'`,
      `CREATE FUNCTION planted_status_reader() RETURNS bigint LANGUAGE sql AS
         $$ SELECT count(*) FROM session s WHERE s.status = 'RUNNING' $$`,
      'CREATE INDEX planted_status_index ON session (status)',
      'ALTER TABLE session ADD CONSTRAINT planted_status_chk CHECK (status IS NOT NULL) NOT VALID',
      'CREATE FUNCTION planted_noop() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
      `CREATE FUNCTION planted_row_reader(s session) RETURNS boolean LANGUAGE sql AS $$ SELECT s.status = 'PENDING' $$`,
      'CREATE TRIGGER planted_status_trigger BEFORE UPDATE OF status ON session FOR EACH ROW EXECUTE FUNCTION planted_noop()',
    ]), [
      'check planted_status_chk',
      'column session.status',
      'function planted_row_reader',
      'function planted_status_reader',
      'index planted_status_index',
      'trigger planted_status_trigger',
      'type run_status',
    ].sort());
    assert.deepEqual(await objectsNamingStatus(sql), [], 'rolled back');
  });

  await t.test('(3) the claim, the releases and the revive run on this schema, and answer the facts\' words', async () => {
    const w = await world(stack.db, 'column-less');
    const word = (id: string) => sessionWord(stack.db, id);
    const queued = await session(stack.db, w, { status: RunStatus.PENDING, startedAt: null, runtimeSessionId: null, engine: null });
    assert.equal(await word(queued), 'PENDING');
    const claimed = await stack.queue.claimSessionForRunner({ id: w.runnerId });
    assert.equal(claimed?.sessionId, queued, 'the claim took the queued turn');
    assert.equal(await word(queued), 'RUNNING');
    const failed = await session(stack.db, w);
    await stack.api.finalize({ id: w.runnerId }, failed, { status: SharedRunStatus.FAILED, error: 'engine crashed' } as never);
    const cancelled = await session(stack.db, w, { cancelRequestedAt: new Date(Date.now() - 10 * 60_000) });
    await (stack.reaper as unknown as { sweep(): Promise<void> }).sweep();
    const ended = await session(stack.db, w, { status: RunStatus.PENDING, startedAt: null });
    await stack.sessions.end(w.ownerId, ended);
    const imported = await session(stack.db, w, { importSourceCwd: '/home/someone/project' });
    await stack.api.importResult({ id: w.runnerId, ownerId: w.ownerId } as never, imported, {
      ok: false, error: 'transcript holds no conversation',
    });
    for (const [name, id, expected] of [
      ['finalized', failed, 'FAILED'], ['reaped', cancelled, 'CANCELLED'], ['ended queued', ended, 'CANCELLED'],
      ['failed import', imported, 'FAILED'],
    ] as const) {
      const row = await stack.db.session.findUniqueOrThrow({ where: { id } });
      assert.ok(row.finishedAt instanceof Date, `${name}: released`);
      assert.equal(await word(id), expected, name);
    }
    await stack.sessions.resume(w.ownerId, failed, { clientTurnId: randomUUID(), content: 'Try again' });
    assert.equal(await word(failed), 'PENDING', 'the revive worked');
    // A model read selects every field of the model: it runs against the table without the column.
    const read = await stack.db.session.findUniqueOrThrow({ where: { id: failed } });
    assert.equal('status' in read, false, 'the model has no such field');
  });
});
