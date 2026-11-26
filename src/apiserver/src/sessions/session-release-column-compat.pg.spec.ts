/**
 * THE COLUMN `release_cause` AND ITS CHECK ARE GONE AFTER DEPLOY 3, AND THE SERVER OF DEPLOY 2 STILL RUNS WITHOUT THEM.
 *
 * Design §12.6, removal steps R5 and R8: the field left the Prisma model in deploy 2 (R5), and migration 1443 drops the
 * column and `session_release_cause_chk` in deploy 3 (R8), the last migration of the removal. Dropping a column is
 * irreversible, so a rollback past 1443 has to be a rollback to deploy 2's code, which never reads or writes the
 * column. This is the only spec that names the column; it shows, on a database every migration has been applied to:
 *
 *   (1) information_schema lists no session.release_cause, and pg_constraint no constraint naming it
 *   (2) the writers release and revive sessions, and a model read selects every field, on the table without it: the
 *       finalize, the reaper, the end of a queued session, the failed import, the revive (deploy 2 and deploy 3 run the
 *       same writers; deploy 3 changed only how the failure question reads)
 *   (3) a server of deploy 2 boots on the database deploy 3 left: its `prisma migrate deploy`, over deploy 2's
 *       migrations (this tree's without 1441, 1442 and 1443), finds nothing to apply and exits 0
 *   (4) no trigger, function, index or view names the column
 *
 *     bash scripts/run-pg-spec.sh src/apiserver/src/sessions/session-release-column-compat.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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
import { fixtureFacts } from '../test-support/session-word';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

interface Stack {
  db: PrismaClient;
  sql: Client;
  api: RunnerApiController;
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
    data: { id: ownerId, email: `${label}-${ownerId}@release.invalid`, name: label, passwordHash: 'x' },
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


/** Deploy 3's migrations, which deploy 2 does not have. */
const DEPLOY_3_MIGRATIONS = [
  '1441_session_turn_outcome_backfill', '1442_ended_triggers_drop_status_bridge', '1443_session_release_cause_drop',
];

test('release_cause and session_release_cause_chk are gone; the writers, and deploy 2\'s boot, run without them', {
  skip, concurrency: 1, timeout: 300_000,
}, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const s = stackFor(url, sql);
  t.after(async () => {
    await s.db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  const row = async (id: string) => (await sql.query(
    `SELECT status::text AS status, finished_at, end_reason, last_turn_outcome, deleted_at FROM "session"
      WHERE id = $1::uuid`, [id])).rows[0] as {
    status: string; finished_at: Date | null; end_reason: string | null; last_turn_outcome: string | null;
    deleted_at: Date | null;
  };

  await t.test('(1) no column and no constraint names release_cause', async () => {
    const column = (await sql.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'session' AND column_name = 'release_cause'`,
    )).rows;
    assert.deepEqual(column, []);
    const constraints = (await sql.query(
      `SELECT conname FROM pg_constraint
        WHERE conname LIKE '%release_cause%' OR pg_get_constraintdef(oid) LIKE '%release_cause%' ORDER BY conname`)).rows;
    assert.deepEqual(constraints, []);
    const applied = (await sql.query(
      `SELECT migration_name FROM _prisma_migrations
        WHERE migration_name = ANY($1::text[]) AND finished_at IS NOT NULL AND rolled_back_at IS NULL
        ORDER BY migration_name`, [DEPLOY_3_MIGRATIONS])).rows.map((r: { migration_name: string }) => r.migration_name);
    assert.deepEqual(applied, DEPLOY_3_MIGRATIONS, 'deploy 3\'s migrations are applied');
  });

  await t.test('(2) the writers release and revive sessions on the table without the column', async () => {
    const w = await world(s.db, 'compat-own');
    const failed = await session(s.db, w);
    await s.api.finalize({ id: w.runnerId }, failed, { status: SharedRunStatus.FAILED, error: 'engine crashed' } as never);
    const cancelled = await session(s.db, w, { cancelRequestedAt: new Date(Date.now() - 10 * 60_000) });
    await (s.reaper as unknown as { sweep(): Promise<void> }).sweep();
    const ended = await session(s.db, w, { status: RunStatus.PENDING, startedAt: null });
    await s.sessions.end(w.ownerId, ended);
    const imported = await session(s.db, w, { importSourceCwd: '/home/someone/project' });
    await s.api.importResult({ id: w.runnerId, ownerId: w.ownerId } as never, imported, {
      ok: false, error: 'transcript holds no conversation',
    });
    for (const [name, id] of [['finalized', failed], ['reaped', cancelled], ['ended queued', ended], ['import', imported]] as const) {
      const r = await row(id);
      console.log(`# ${name} ${JSON.stringify(r)}`);
      assert.ok(r.finished_at instanceof Date, `${name}: released`);
    }
    assert.ok((await row(imported)).deleted_at instanceof Date, 'the failed import went to Trash');
    await s.sessions.resume(w.ownerId, failed, { clientTurnId: randomUUID(), content: 'Try again' });
    const revived = await row(failed);
    assert.equal(revived.status, 'PENDING', 'the revive worked');
    assert.equal(revived.finished_at, null);
    // A model read selects every field of the model: it runs against the table without the column.
    const read = await s.db.session.findUniqueOrThrow({ where: { id: failed } });
    assert.equal('releaseCause' in read, false, 'the model has no such field');
  });

  await t.test('(3) deploy 2\'s prisma migrate deploy boots on this database and finds nothing to apply', async () => {
    // Deploy 2's migrations are this tree's without deploy 3's three (the evidence of task 351QPAh8wuz6nl3n1ghm2 shows
    // the project branch's folder is exactly that). A server boots by running migrate deploy over its own folder.
    const api = join(__dirname, '..', '..');
    // Inside the apiserver directory, so the config's imports (prisma/config, dotenv) resolve as they do for the real
    // one: from src/apiserver/node_modules or, where npm hoisted them (CI), from the repository's node_modules.
    const deploy2 = mkdtempSync(join(api, '.deploy2-'));
    t.after(() => rmSync(deploy2, { recursive: true, force: true }));
    cpSync(join(api, 'prisma'), join(deploy2, 'prisma'), { recursive: true });
    cpSync(join(api, 'prisma.config.ts'), join(deploy2, 'prisma.config.ts'));
    for (const name of DEPLOY_3_MIGRATIONS) rmSync(join(deploy2, 'prisma', 'migrations', name), { recursive: true });
    let out: string;
    try {
      out = execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
        cwd: deploy2, env: { ...process.env, DATABASE_URL: url }, encoding: 'utf8', stdio: 'pipe',
      });
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      assert.fail(`deploy 2's prisma migrate deploy failed:\n${e.stdout ?? ''}${e.stderr ?? ''}`);
    }
    console.log(`# ${out.trim().split('\n').join(' | ')}`);
    assert.match(out, /No pending migrations to apply/);
  });

  await t.test('(4) no trigger, function, index or view names the column', async () => {
    const functions = (await sql.query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p') AND pg_get_functiondef(p.oid) LIKE '%release_cause%'`)).rows;
    assert.deepEqual(functions, []);
    const triggers = (await sql.query(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND pg_get_triggerdef(oid) LIKE '%release_cause%'`)).rows;
    assert.deepEqual(triggers, []);
    const indexes = (await sql.query(
      `SELECT indexname FROM pg_indexes WHERE indexdef LIKE '%release_cause%'`)).rows;
    assert.deepEqual(indexes, []);
    const views = (await sql.query(
      `SELECT viewname FROM pg_views WHERE schemaname = 'public' AND definition LIKE '%release_cause%'`)).rows;
    assert.deepEqual(views, []);
  });
});
