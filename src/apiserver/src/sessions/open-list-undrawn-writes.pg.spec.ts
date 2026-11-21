/**
 * A write that changes no field an Open list draws neither moves the list's version nor sends
 * `sessions.list_changed` (migration 1420_open_list_undrawn_writes); a write of a drawn field still
 * does both.
 *
 *  1. replay: a Claude turn as a runner reports it — its event batches through the runner API's own
 *     ingest, a heartbeat's worktree snapshot, the turn's completion — with an audit trigger beside
 *     the counters recording, for every statement, which columns of `session` and
 *     `conversation_turn` it changed. Prints the census (column → statements that changed it, and
 *     the statements that changed nothing drawn), and asserts each step moved a source's counter
 *     exactly when it changed a drawn column of it.
 *  2. hints: bare SQL writes of only undrawn columns — each one, and a write that changes nothing
 *     at all — send no hint and leave the version; writes of drawn columns of both tables send one.
 *  3. the row: changing every undrawn session column leaves the Open list's rows as they were.
 *
 * scripts/run-pg-spec.sh src/apiserver/src/sessions/open-list-undrawn-writes.pg.spec.ts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { MessageEvent } from '@nestjs/common';
import { PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { ControlEventType, RunEventType, RunStatus as SharedRunStatus, type ControlEvent } from '@orbit/shared';
import { Client } from 'pg';
import { EventsController } from '../events/events.controller';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';
import { prismaClientFor } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { PushService } from '../push/push.service';
import type { QueueService } from '../queue/queue.service';
import { RealtimeService } from '../realtime/realtime.service';
import { linkBeatDigests, writeLinkBeatReports } from '../runner-api/link-heartbeat';
import { RunnerApiController } from '../runner-api/runner-api.controller';
import {
  OPEN_LIST_UNDRAWN_SESSION_COLUMNS,
  OPEN_LIST_UNDRAWN_TURN_COLUMNS,
  readOpenListVersion,
  readOpenListVersionParts,
} from './open-list-version';
import { SessionsService } from './sessions.service';

const URL = process.env.COORDINATOR_PG_URL;
const skip = !URL;

let safety: Promise<void> | undefined;
function verifyDisposableDatabase(): Promise<void> {
  if (safety) return safety;
  safety = (async () => {
    assertCoordinatorPgUrlIsIsolated(URL);
    const client = new Client({ connectionString: URL, connectionTimeoutMillis: 2_000 });
    await client.connect();
    try {
      await verifyCoordinatorPgIdentity(client);
    } finally {
      await client.end();
    }
  })();
  return safety;
}

function inert<T>(): T {
  return new Proxy({}, { get: () => () => undefined }) as T;
}

type T = { after: (fn: () => Promise<void> | void) => void };

interface Fixture {
  db: PrismaClient;
  prisma: PrismaService;
  ownerId: string;
  runnerId: string;
  sessionId: string;
  turnId: string;
}

async function fixture(t: T): Promise<Fixture> {
  await verifyDisposableDatabase();
  const db = prismaClientFor(URL!);
  t.after(() => db.$disconnect());
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const sessionId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `olu-${ownerId}@open-list-undrawn.invalid`, name: 'olu', passwordHash: 'x' },
  });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'olu-runner', tokenHash: `hash-${runnerId}`, status: RunnerStatus.ONLINE,
      capabilities: [], capabilitiesReportedAt: new Date(), lastHeartbeatAt: new Date(),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'olu-workspace', enabled: true } });
  await db.session.create({
    data: {
      id: sessionId, ownerId, creatorId: ownerId, workspaceId, assignedRunnerId: runnerId, title: 'olu',
      prompt: 'olu', provider: 'claude', model: 'claude-opus-5-5', providerBuiltin: true,
      status: RunStatus.RUNNING, startedAt: new Date(), lastTurnAt: new Date(),
      dispatchOrigin: SessionDispatchOrigin.USER,
    },
  });
  const { id: turnId } = await db.conversationTurn.create({
    data: {
      sessionId, seq: 1, clientTurnId: `olu-${randomUUID()}`, kind: 'message', content: 'fix the bug',
      status: 'IN_FLIGHT', deliveredAt: new Date(), leaseDeadlineAt: new Date(Date.now() + 300_000),
    },
    select: { id: true },
  });
  return { db, prisma: db as unknown as PrismaService, ownerId, runnerId, sessionId, turnId };
}

/** The counters of the two sources a running session writes. */
async function counters(f: Fixture): Promise<{ session: string; turn: string }> {
  const { epochs } = await readOpenListVersionParts(f.prisma, f.ownerId);
  return { session: epochs.session ?? '0', turn: epochs.conversation_turn ?? '0' };
}

const UNDRAWN: Record<string, ReadonlySet<string>> = {
  session: new Set(OPEN_LIST_UNDRAWN_SESSION_COLUMNS),
  conversation_turn: new Set(OPEN_LIST_UNDRAWN_TURN_COLUMNS),
};

test('1. replay: a running turn moves the version only with the statements that change a drawn column', { skip, timeout: 300_000 }, async (t) => {
  const f = await fixture(t);
  const sql = new Client({ connectionString: URL!, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  t.after(() => sql.end());
  // Every row a statement wrote, and the columns it changed in it. Row-level, beside the
  // statement-level counter triggers it observes; dropped again at the end.
  const audit = `olu_audit_${f.sessionId.replace(/-/g, '').slice(0, 12)}`;
  await sql.query(`
    CREATE TABLE ${audit} (id bigserial PRIMARY KEY, tbl text, op text, txid bigint, changed text[]);
    CREATE FUNCTION ${audit}() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (CASE WHEN TG_TABLE_NAME = 'session' THEN NEW.id ELSE (to_jsonb(NEW)->>'session_id')::uuid END) <> '${f.sessionId}'::uuid THEN
        RETURN NULL;
      END IF;
      IF TG_OP = 'INSERT' THEN
        INSERT INTO ${audit}(tbl, op, txid, changed) VALUES (TG_TABLE_NAME, 'INSERT', txid_current(), '{}');
      ELSE
        INSERT INTO ${audit}(tbl, op, txid, changed)
        SELECT TG_TABLE_NAME, 'UPDATE', txid_current(),
               COALESCE(array_agg(n.key ORDER BY n.key) FILTER (WHERE n.value IS DISTINCT FROM o.value), '{}')
          FROM jsonb_each(to_jsonb(NEW)) n JOIN jsonb_each(to_jsonb(OLD)) o USING (key);
      END IF;
      RETURN NULL;
    END $$;
    CREATE TRIGGER ${audit}_s AFTER INSERT OR UPDATE ON session FOR EACH ROW EXECUTE FUNCTION ${audit}();
    CREATE TRIGGER ${audit}_t AFTER INSERT OR UPDATE ON conversation_turn FOR EACH ROW EXECUTE FUNCTION ${audit}();
  `);
  t.after(async () => {
    await sql.query(`DROP TRIGGER ${audit}_s ON session; DROP TRIGGER ${audit}_t ON conversation_turn;
                     DROP FUNCTION ${audit}(); DROP TABLE ${audit};`);
  });

  const api = new RunnerApiController(
    f.prisma,
    { notifySessionQueued: () => undefined } as unknown as QueueService,
    inert<RealtimeService>(),
    {} as never,
    {} as never,
    { expand: async (_ownerId: string, content?: string) => content } as never,
    { appendFor: async (_tx: unknown, _sessionId: string, content?: string) => content } as never,
  );
  (api as unknown as { logger: { warn: (line: string) => void } }).logger.warn = () => undefined;

  let seq = 0;
  const ts = () => new Date().toISOString();
  const ev = (type: RunEventType, payload: Record<string, unknown>, turn = true) => ({
    seq: ++seq, type, ts: ts(), payload, ...(turn ? { turnId: f.turnId } : {}),
  });
  const batch = (...events: ReturnType<typeof ev>[]) => api.events({ id: f.runnerId }, f.sessionId, { events });
  let files = 0;
  const snapshot = (dirty: boolean) => {
    const dto = {
      sessions: [{
        sessionId: f.sessionId, isolationStatus: 'worktree', baseSha: 'a'.repeat(40), worktreeDirty: dirty,
        worktreeBranch: 'orbit/olu', branchSha: 'b'.repeat(40), branchMerged: false, mergeTargets: ['main'],
        changedFiles: Array.from({ length: files }, (_, i) => ({ path: `src/f${i}.ts`, status: 'M' })),
      }],
    };
    return writeLinkBeatReports(f.prisma, {
      runnerId: f.runnerId, leaseOwner: null, dto: dto as never, reports: ['sessions'],
      digests: linkBeatDigests(dto as never, {}), storedFacts: {}, storedPlanUsage: null, now: new Date(),
    });
  };

  // One Claude turn as the runner reports it, batch by batch, with the heartbeats that run beside it.
  const steps: Array<[string, () => Promise<unknown>]> = [
    ['user echo + delivery ack', () => batch(
      ev(RunEventType.USER, { text: 'fix the bug' }),
      ev(RunEventType.USER_DELIVERY, { turnId: f.turnId, delivery: 'acknowledged' }),
    )],
    ['system init', () => batch(ev(RunEventType.SYSTEM, { subtype: 'init', session_id: 'olu-runtime' }))],
    ['streamed deltas only', () => batch(
      ev(RunEventType.THINKING_DELTA, { text: 'Let me' }),
      ev(RunEventType.TEXT_DELTA, { text: 'Looking' }),
    )],
    ['thinking + assistant + tool_use', () => batch(
      ev(RunEventType.THINKING, { text: 'Let me look.' }),
      ev(RunEventType.ASSISTANT, { text: 'Looking at the code.' }),
      ev(RunEventType.TOOL_USE, { name: 'Read', toolUseId: 'tu-1', input: { file_path: 'a.ts' } }),
    )],
    ['tool_result', () => batch(ev(RunEventType.TOOL_RESULT, { toolUseId: 'tu-1', content: 'ok' }))],
    ['tool_use (same tool again)', () => batch(
      ev(RunEventType.TOOL_USE, { name: 'Read', toolUseId: 'tu-2', input: { file_path: 'b.ts' } }),
    )],
    ['tool_result (again)', () => batch(ev(RunEventType.TOOL_RESULT, { toolUseId: 'tu-2', content: 'ok' }))],
    ['context ping', () => batch(
      ev(RunEventType.SYSTEM, { subtype: 'context', contextTokens: 41_000, contextWindow: 200_000 }),
    )],
    ['heartbeat: worktree snapshot, a file changed', () => { files = 1; return snapshot(true); }],
    ['heartbeat: worktree snapshot, another file changed', () => { files = 2; return snapshot(true); }],
    ['bg job launched (running report)', () => batch(
      ev(RunEventType.BACKGROUND_TASK, { toolUseId: 'bgj_olu', status: 'running', kind: 'job', idleMs: 0 }),
    )],
    ['bg job progress report', async () => {
      await sleep(1_100);
      return batch(ev(RunEventType.BACKGROUND_TASK, { toolUseId: 'bgj_olu', status: 'running', kind: 'job', idleMs: 0 }));
    }],
    ['bg job ended', () => batch(
      ev(RunEventType.BACKGROUND_TASK, { toolUseId: 'bgj_olu', status: 'completed', kind: 'job' }),
    )],
    ['assistant + turn_end', () => batch(
      ev(RunEventType.ASSISTANT, { text: 'Fixed.' }),
      ev(RunEventType.TURN_END, { contextTokens: 45_000, contextWindow: 200_000 }),
    )],
    ['turn-complete', () => api.turnComplete({ id: f.runnerId }, f.sessionId, {
      turnId: f.turnId, status: SharedRunStatus.SUCCEEDED, subtype: 'success', numTurns: 1, costUsd: 0.5,
      modelUsage: { 'claude-opus-5-5': { inputTokens: 1000, outputTokens: 100, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, costUSD: 0.5 } },
    } as never)],
    ['heartbeat: worktree snapshot, unchanged', () => snapshot(true)],
  ];

  const census = new Map<string, number>();
  const report: string[] = [];
  const wrong: string[] = [];
  let lastId = 0;
  for (const [name, run] of steps) {
    const before = await counters(f);
    await run();
    const after = await counters(f);
    const { rows } = await sql.query<{ id: string; tbl: string; op: string; txid: string; changed: string[] }>(
      `SELECT id, tbl, op, txid::text, changed FROM ${audit} WHERE id > $1 ORDER BY id`, [lastId],
    );
    if (rows.length > 0) lastId = Number(rows.at(-1)!.id);
    const parts: string[] = [];
    for (const [tbl, moved] of [['session', before.session !== after.session], ['conversation_turn', before.turn !== after.turn]] as const) {
      const mine = rows.filter((r) => r.tbl === tbl);
      for (const r of mine) for (const c of r.changed) census.set(`${tbl}.${c}`, (census.get(`${tbl}.${c}`) ?? 0) + 1);
      const drawn = mine.some((r) => r.op === 'INSERT' || r.changed.some((c) => !UNDRAWN[tbl].has(c)));
      const shown = mine.map((r) => (r.op === 'INSERT' ? 'INSERT' : `{${r.changed.join(',') || 'nothing'}}`)).join(' ');
      if (mine.length > 0 || moved) parts.push(`${tbl}: ${mine.length} row write(s) ${shown}; drawn=${drawn}; counter moved=${moved}`);
      if (mine.length > 0 && drawn !== moved) wrong.push(`${name} / ${tbl}: drawn=${drawn} but counter moved=${moved}`);
    }
    report.push(`step "${name}": ${parts.join(' | ') || 'no write'}`);
  }
  for (const line of report) t.diagnostic(line);
  for (const [column, n] of [...census].sort()) {
    const [tbl, c] = column.split('.');
    t.diagnostic(`census ${column}: changed by ${n} statement(s); ${UNDRAWN[tbl].has(c) ? 'UNDRAWN' : 'drawn'}`);
  }
  assert.deepEqual(wrong, [], 'a step moved a counter without changing a drawn column, or changed one without moving it');
});

/** One `GET /api/events` stream that declared `hints=list_changed`, recording the hints it is sent. */
function hints(f: Fixture, t: T): Array<{ at: number; version: string }> {
  const realtime = new RealtimeService(f.prisma, { scheduleBadgeSync: () => undefined } as unknown as PushService);
  t.after(() => realtime.onModuleDestroy());
  const received: Array<{ at: number; version: string }> = [];
  const subscription = new EventsController(realtime).events({ userId: f.ownerId } as never, 'list_changed')
    .subscribe((m: MessageEvent) => {
      const event = m.data as ControlEvent;
      if (event.type === ControlEventType.SESSIONS_LIST_CHANGED) {
        received.push({ at: Date.now(), version: String((event.data as { version: string }).version) });
      }
    });
  t.after(() => subscription.unsubscribe());
  return received;
}

async function until(cond: () => boolean, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await sleep(50);
  }
  return cond();
}

/** A write of each undrawn column that changes its value (and `updated_at`, as a Prisma write does). */
const UNDRAWN_SESSION_WRITES: Record<(typeof OPEN_LIST_UNDRAWN_SESSION_COLUMNS)[number], string> = {
  updated_at: `updated_at = updated_at + interval '1 second'`,
  context_tokens: `context_tokens = COALESCE(context_tokens, 0) + 1000`,
  context_window: `context_window = 200000`,
  agent_tools: `agent_tools = '{"tools":["Read"]}'::jsonb`,
  engine_usage_totals: `engine_usage_totals = '{"costUsd":0.5}'::jsonb`,
  coordinator_context_epoch: `coordinator_context_epoch = coordinator_context_epoch + 1`,
  coordinator_context_ack_key: `coordinator_context_ack_key = repeat('c', 64)`,
  isolation_status: `isolation_status = 'worktree'`,
  base_sha: `base_sha = repeat('a', 40)`,
  changed_files: `changed_files = '[{"path":"a.ts","status":"M"}]'::jsonb`,
  worktree_dirty: `worktree_dirty = true`,
  worktree_branch: `worktree_branch = 'orbit/olu'`,
  branch_sha: `branch_sha = repeat('b', 40)`,
  branch_merged: `branch_merged = false`,
  merge_targets: `merge_targets = ARRAY['main']`,
  branch_commits: `branch_commits = '[{"sha":"b"}]'::jsonb`,
  recap_claimed_at: `recap_claimed_at = now()`,
  recap_event_seq: `recap_event_seq = 7`,
  alerted_approval_at: `alerted_approval_at = now()`,
  agent_notified_at: `agent_notified_at = now()`,
  inbox_lease_owner: `inbox_lease_owner = gen_random_uuid()`,
  inbox_lease_generation: `inbox_lease_generation = gen_random_uuid()`,
  inbox_request_id: `inbox_request_id = 'olu-request'`,
  inbox_request_turn_id: `inbox_request_turn_id = gen_random_uuid()`,
  claim_request_id: `claim_request_id = 'olu-claim'`,
  retry_attempts: `retry_attempts = retry_attempts + 1`,
  retry_claimed_at: `retry_claimed_at = now()`,
};

const UNDRAWN_TURN_WRITES: Record<(typeof OPEN_LIST_UNDRAWN_TURN_COLUMNS)[number], string> = {
  delivery_status: `delivery_status = 'acknowledged'`,
  delivery_acknowledged_at: `delivery_acknowledged_at = now()`,
  lease_deadline_at: `lease_deadline_at = now() + interval '5 minutes'`,
  translation_state: `translation_state = 'DONE'`,
  translation_lang: `translation_lang = 'en'`,
  delivery_failure_code: `delivery_failure_code = 'olu'`,
  delivery_failure_reason: `delivery_failure_reason = 'olu'`,
  delivery_terminal_at: `delivery_terminal_at = now()`,
  lease_generation: `lease_generation = gen_random_uuid()`,
  translation_failure_reason: `translation_failure_reason = 'olu'`,
  translation_http_status: `translation_http_status = 500`,
  wiki_context: `wiki_context = '{"entries":[]}'::jsonb`,
  coordinator_context_key: `coordinator_context_key = repeat('k', 64)`,
};

test('2. hints: a write of undrawn columns alone sends no sessions.list_changed and keeps the version; a drawn one sends one', { skip, timeout: 120_000 }, async (t) => {
  const f = await fixture(t);
  const received = hints(f, t);
  assert.ok(await until(() => received.length === 1, 3_000), 'a new stream was not told the current version');
  let told = received.length;
  let version = await readOpenListVersion(f.prisma, f.ownerId);

  const quiet = async (what: string, statement: string, ...args: unknown[]) => {
    const wrote = await f.db.$executeRawUnsafe(statement, ...args);
    assert.equal(wrote, 1, `${what}: the write matched no row`);
    assert.equal(await readOpenListVersion(f.prisma, f.ownerId), version, `${what} moved the Open list's version`);
    return what;
  };
  const loud = async (what: string, statement: string, ...args: unknown[]) => {
    const wrote = await f.db.$executeRawUnsafe(statement, ...args);
    assert.equal(wrote, 1, `${what}: the write matched no row`);
    const after = await readOpenListVersion(f.prisma, f.ownerId);
    assert.notEqual(after, version, `${what} did not move the Open list's version`);
    assert.ok(await until(() => received.at(-1)?.version === after, 2_500), `${what}: no sessions.list_changed within 2.5 s`);
    told = received.length;
    version = after;
  };

  const silent: string[] = [];
  for (const [column, set] of Object.entries(UNDRAWN_SESSION_WRITES)) {
    silent.push(await quiet(`session.${column}`, `UPDATE session SET ${set} WHERE id = $1::uuid`, f.sessionId));
  }
  for (const [column, set] of Object.entries(UNDRAWN_TURN_WRITES)) {
    silent.push(await quiet(`conversation_turn.${column}`, `UPDATE conversation_turn SET ${set} WHERE id = $1::uuid`, f.turnId));
  }
  silent.push(await quiet('a session write that changes nothing',
    `UPDATE session SET engine_turn_active = engine_turn_active, last_tool_use = last_tool_use WHERE id = $1::uuid`, f.sessionId));
  silent.push(await quiet('a turn write that changes nothing',
    `UPDATE conversation_turn SET status = status WHERE id = $1::uuid`, f.turnId));
  // The counters are summed once a second: three ticks with nothing to tell.
  await sleep(3_200);
  assert.equal(received.length, told, `a hint was sent for writes of undrawn columns alone (${silent.join(', ')})`);

  await loud('session.title', `UPDATE session SET title = 'renamed' WHERE id = $1::uuid`, f.sessionId);
  await loud('session.last_turn_at', `UPDATE session SET last_turn_at = now() + interval '1 minute' WHERE id = $1::uuid`, f.sessionId);
  await loud('session.last_assistant_text with updated_at', `UPDATE session SET last_assistant_text = 'new reply', updated_at = now() WHERE id = $1::uuid`, f.sessionId);
  await loud('session.engine_turn_active with context_tokens', `UPDATE session SET engine_turn_active = NOT engine_turn_active, context_tokens = 1 WHERE id = $1::uuid`, f.sessionId);
  await loud('conversation_turn.answered_at with delivery_status', `UPDATE conversation_turn SET answered_at = now(), delivery_status = 'done' WHERE id = $1::uuid`, f.turnId);
  await loud('conversation_turn.status', `UPDATE conversation_turn SET status = 'ANSWERED' WHERE id = $1::uuid`, f.turnId);
  await loud('a turn inserted', `INSERT INTO conversation_turn (id, session_id, seq, client_turn_id, kind, content, status)
                                 VALUES (gen_random_uuid(), $1::uuid, 2, 'olu-second', 'message', 'next', 'PENDING')`, f.sessionId);
  // A session leaving the account moves both owners, whatever else it changed.
  const other = randomUUID();
  await f.db.user.create({ data: { id: other, email: `olu-${other}@open-list-undrawn.invalid`, name: 'olu2', passwordHash: 'x' } });
  await loud('session.owner_id with context_tokens', `UPDATE session SET owner_id = $2::uuid, creator_id = $2::uuid, context_tokens = 2 WHERE id = $1::uuid`, f.sessionId, other);
});

test('3. the row: changing every undrawn session column leaves the Open list\'s rows as they were', { skip, timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const sessions = new SessionsService(
    f.prisma,
    inert<ConstructorParameters<typeof SessionsService>[1]>(),
    inert<ConstructorParameters<typeof SessionsService>[2]>(),
  );
  const before = await sessions.list(f.ownerId, { view: 'open' });
  assert.equal((before as Array<{ id: string }>)[0]?.id, f.sessionId);
  await f.db.$executeRawUnsafe(
    `UPDATE session SET ${Object.values(UNDRAWN_SESSION_WRITES).join(', ')} WHERE id = $1::uuid`, f.sessionId,
  );
  await f.db.$executeRawUnsafe(
    `UPDATE conversation_turn SET ${Object.values(UNDRAWN_TURN_WRITES).join(', ')} WHERE id = $1::uuid`, f.turnId,
  );
  assert.deepEqual(await sessions.list(f.ownerId, { view: 'open' }), before);
});
