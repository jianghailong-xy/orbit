/**
 * Independent QA of the Watch core backend across real process death: the production apiserver —
 * `build/main.js`, the whole AppModule with its Watch evaluator and delivery loops — runs as a child
 * process against a real PostgreSQL and is killed with SIGKILL halfway through an evaluation's landing
 * and halfway through a delivery's turn transaction, stopped while a watched condition comes true, and
 * started again as a new process.
 *
 *     RUN_PG_SPEC_TIMEOUT=1500 bash scripts/run-pg-spec.sh src/apiserver/src/watches/watch-core-qa-process.pg.spec.ts
 *
 * Written by the QA session for task 34DH29mTc7OQ6AwxAFIJu; it changes no product code. Inside the child
 * the production defaults apply — 5s polls, 60s leases, 60s reconciliation — so each recovery below
 * takes about a minute: that minute is the latency bound the design states, not slack in the test.
 * `WATCH_QA_ONLY=P-02` registers only the named cases (run-pg-spec.sh strips --test-name-pattern).
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { JwtService } from '@nestjs/jwt';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { sha256 } from '../common/crypto.util';
import {
  assertCoordinatorPgUrlIsIsolated,
  verifyCoordinatorPgIdentity,
} from '../projects/coordinator-pg-test-safety';

const PG_URL = process.env.COORDINATOR_PG_URL;
const skip = !PG_URL;
const ONLY = (process.env.WATCH_QA_ONLY ?? '').split(',').map((id) => id.trim()).filter(Boolean);
const JWT_SECRET = `watch-qa-${randomUUID()}`;
/** build/watches → build/main.js, the apiserver's production entry point. */
const MAIN = path.resolve(__dirname, '..', 'main.js');
const API_DIR = path.resolve(__dirname, '..', '..');

function qa(id: string, title: string, timeout: number, body: () => Promise<void>): void {
  if (ONLY.length > 0 && !ONLY.includes(id)) return;
  test(`${id} ${title}`, { skip, timeout }, body);
}

function note(id: string, facts: Record<string, unknown>): void {
  console.log(`QA-NOTE ${id} ${JSON.stringify(facts)}`);
}

const ALL = (leaf: string) => ({ kind: 'ALL', over: 'ALL_TARGETS', leaf });
const ANY = (leaf: string) => ({ kind: 'ANY', over: 'ALL_TARGETS', leaf });

// ── the apiserver process ──────────────────────────────────────────────────────────────────────

interface Apiserver {
  port: number;
  child: ChildProcess;
  output(): string;
  kill(signal: NodeJS.Signals): Promise<void>;
}

const servers: Apiserver[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

interface Reply {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
  text: string;
}

/** One HTTP request on a fresh connection: a restarted process on a reused port must not inherit a dead keep-alive socket. */
function request(server: Apiserver, method: string, route: string, options: { token?: string; body?: unknown } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        path: route,
        method,
        agent: false,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
          ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
        },
      },
      (res) => {
        const parts: Buffer[] = [];
        res.on('data', (chunk: Buffer) => parts.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          let json: unknown = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(30_000, () => req.destroy(new Error(`${method} ${route} timed out`)));
    if (payload) req.write(payload);
    req.end();
  });
}

/** `node build/main.js`, as the container starts it, on a port of its own; resolves once it answers. */
async function startApiserver(label: string): Promise<Apiserver> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DATABASE_URL: PG_URL,
    JWT_SECRET,
    PORT: String(port),
    NO_COLOR: '1',
    CORS_ORIGINS: 'http://127.0.0.1',
  };
  delete env.NODE_TEST_CONTEXT;
  let log = '';
  const child = spawn(process.execPath, [MAIN], { cwd: API_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const collect = (chunk: Buffer) => {
    log = (log + chunk.toString('utf8')).slice(-400_000);
  };
  child.stdout!.on('data', collect);
  child.stderr!.on('data', collect);
  const server: Apiserver = {
    port,
    child,
    output: () => log,
    async kill(signal) {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill(signal);
      await Promise.race([exited, sleep(20_000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
    },
  };
  servers.push(server);
  const deadline = Date.now() + 150_000;
  for (;;) {
    if (child.exitCode !== null) assert.fail(`${label}: the apiserver exited ${child.exitCode} before answering:\n${log.slice(-6_000)}`);
    const reply = await request(server, 'GET', '/api/auth/setup-status').catch(() => null);
    if (reply?.status === 200) return server;
    if (Date.now() > deadline) assert.fail(`${label}: the apiserver did not answer within 150s:\n${log.slice(-6_000)}`);
    await sleep(250);
  }
}

/** The Watch loops' own error lines in an apiserver's log (NO_COLOR is set, so the level reads plainly). */
function watchErrors(server: Apiserver): string[] {
  return server
    .output()
    .split('\n')
    .filter((line) => /ERROR\s+\[Watch(?:Evaluator|Delivery)\]/.test(line))
    .map((line) => line.slice(0, 300));
}

// ── the database ───────────────────────────────────────────────────────────────────────────────

let sql: Client;
let heartbeats: Client;
let heartbeat: ReturnType<typeof setInterval> | undefined;
const heldLocks: Array<() => Promise<void>> = [];
const jwt = new JwtService({ secret: JWT_SECRET });

before(async () => {
  if (skip) return;
  assertCoordinatorPgUrlIsIsolated(PG_URL);
  sql = new Client({ connectionString: PG_URL, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  // The runners in these cases are online for as long as the file runs, as a real one heartbeating would be.
  heartbeats = new Client({ connectionString: PG_URL, connectionTimeoutMillis: 5_000 });
  await heartbeats.connect();
  heartbeat = setInterval(() => {
    void heartbeats
      .query(`UPDATE "runner" SET "last_heartbeat_at" = clock_timestamp() WHERE "name" = 'watch qa process runner'`)
      .catch(() => undefined);
  }, 3_000);
});

after(async () => {
  if (skip) return;
  if (heartbeat) clearInterval(heartbeat);
  for (const release of heldLocks.splice(0)) await release();
  for (const server of servers.splice(0)) await server.kill('SIGKILL');
  await heartbeats?.end().catch(() => undefined);
  await sql?.end().catch(() => undefined);
});

async function holdLock(statement: string): Promise<{ release(): Promise<void> }> {
  const client = new Client({ connectionString: PG_URL, connectionTimeoutMillis: 5_000 });
  await client.connect();
  await client.query('BEGIN');
  await client.query(statement);
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await client.query('COMMIT').catch(() => undefined);
    await client.end().catch(() => undefined);
  };
  heldLocks.push(release);
  return { release };
}

async function lockWaiters(fragment: string): Promise<number> {
  const { rows } = await sql.query<{ n: number }>(
    `SELECT count(*)::int AS "n" FROM pg_stat_activity
      WHERE "datname" = current_database() AND "wait_event_type" = 'Lock' AND position($1 in "query") > 0`,
    [fragment],
  );
  return rows[0].n;
}

async function eventually<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) assert.fail(`${what}: gave up after ${timeoutMs}ms at ${JSON.stringify(value)}`);
    await sleep(100);
  }
}

async function insertUser(): Promise<string> {
  const id = randomUUID();
  await sql.query(`INSERT INTO "user"("id","email","name","password_hash") VALUES ($1,$2,'watch qa','h')`, [id, `${id}@watch-qa.invalid`]);
  return id;
}

async function tokenFor(userId: string): Promise<string> {
  return jwt.signAsync({ sub: userId, email: `${userId}@watch-qa.invalid` });
}

async function insertRunner(owner: string, token: string): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "runner"("id","name","owner_id","token_hash","status","last_heartbeat_at","capabilities","max_concurrent")
     VALUES ($1,'watch qa process runner',$2,$3,'ONLINE',clock_timestamp(),'{}'::text[],8)`,
    [id, owner, sha256(token)],
  );
  return id;
}

async function insertTask(owner: string, status: string): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "task"("id","title","owner_id","creator_type","creator_id","updated_at","completion_criterion","status")
     VALUES ($1,'watched work',$2,'USER',$2,now(),'EVIDENCE_JUDGMENT',$3)`,
    [id, owner, status],
  );
  return id;
}

async function insertSession(owner: string, status: string, runnerId: string): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "session"("id","title","prompt","owner_id","creator_id","updated_at","status","assigned_runner_id",
                           "provider","provider_builtin","num_turns","started_at","runtime_session_id")
     VALUES ($1,'watch qa','the opening prompt',$2,$2,now(),$3,$4,'claude',TRUE,1,now(),$5)`,
    [id, owner, status, runnerId, `runtime-${id}`],
  );
  await sql.query(
    `INSERT INTO "conversation_turn"("id","session_id","seq","client_turn_id","kind","content","status","delivered_at","answered_at")
     VALUES ($1,$2,1,$3,'message','the opening prompt','ANSWERED',now(),now())`,
    [randomUUID(), id, `initial-${id}`],
  );
  return id;
}

async function insertRunningTurn(sessionId: string, seq: number): Promise<string> {
  const id = randomUUID();
  await sql.query(
    `INSERT INTO "conversation_turn"("id","session_id","seq","client_turn_id","kind","content","status","delivered_at","lease_deadline_at")
     VALUES ($1,$2,$3,$4,'message','the turn the session is running','IN_FLIGHT',now(),now() + interval '10 minutes')`,
    [id, sessionId, seq, `running-${id}`],
  );
  return id;
}

const MICROS = `'YYYY-MM-DD"T"HH24:MI:SS.US'`;

async function watchRow(id: string): Promise<{ state: string; nextEvaluateAt: string | null; due: boolean | null; landed: boolean | null }> {
  const { rows } = await sql.query(
    `SELECT "state", to_char("next_evaluate_at" AT TIME ZONE 'UTC', ${MICROS}) AS "nextEvaluateAt", "next_evaluate_at" <= now() AS "due",
            "last_evaluated_at" > "created_at" AS "landed"
       FROM "watch" WHERE "id" = $1`,
    [id],
  );
  return rows[0];
}

/** The first evaluation the apiserver LANDED — a claim alone moves next_evaluate_at as well, so `due` cannot say this. */
async function landedEvaluation(id: string, timeoutMs = 45_000) {
  return eventually(`an evaluation of ${id} to land`, () => watchRow(id), (row) => row.landed === true && row.due === false, timeoutMs);
}

async function matchesOf(watchId: string): Promise<Array<{ generation: number; matchedAt: string }>> {
  const { rows } = await sql.query(
    `SELECT "generation", to_char("matched_at" AT TIME ZONE 'UTC', ${MICROS}) AS "matchedAt" FROM "watch_match" WHERE "watch_id" = $1`,
    [watchId],
  );
  return rows;
}

async function deliveriesOf(watchId: string): Promise<Array<{ state: string; attempts: number; lastError: string | null }>> {
  const { rows } = await sql.query(
    `SELECT d."state", d."attempts", d."last_error" AS "lastError"
       FROM "watch_delivery" d JOIN "watch_match" m ON m."id" = d."match_id" WHERE m."watch_id" = $1`,
    [watchId],
  );
  return rows;
}

async function wakesOf(watchId: string): Promise<Array<{ id: string; status: string }>> {
  const { rows } = await sql.query(`SELECT "id", "status" FROM "conversation_turn" WHERE "client_turn_id" LIKE $1`, [`watch:${watchId}:%`]);
  return rows;
}

async function statusOf(sessionId: string): Promise<string> {
  const { rows } = await sql.query<{ status: string }>(`SELECT "status" FROM "session" WHERE "id" = $1`, [sessionId]);
  return rows[0].status;
}

// ── cases ──────────────────────────────────────────────────────────────────────────────────────

qa('P-01', 'the production AppModule boots with the Watch modules, and the Watch HTTP API works in public ids: idempotent create, read, list, edit, pause, resume, cancel, contract refusals, another account, and its own loops evaluating and delivering', 300_000, async () => {
  const server = await startApiserver('P-01');
  const owner = await insertUser();
  const stranger = await insertUser();
  const [token, strangerToken] = [await tokenFor(owner), await tokenFor(stranger)];
  const open = await insertTask(owner, 'OPEN');
  const ended = await insertTask(owner, 'CANCELLED');
  const key = `p01-${randomUUID()}`;
  const createBody = {
    predicateVersion: 1,
    predicate: ALL('TASK_TERMINAL'),
    targets: [{ kind: 'TASK', id: uuidToBase62(open) }],
    action: 'NOTIFY_USER',
    ttlSeconds: 3_600,
    idempotencyKey: key,
  };

  const created = await request(server, 'POST', '/api/watches', { token, body: createBody });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.state, 'ACTIVE');
  const watchId = toUuid(created.json.id);
  assert.deepEqual(created.json.targets.map((target: { targetResourceId: string }) => toUuid(target.targetResourceId)), [open]);
  const retried = await request(server, 'POST', '/api/watches', { token, body: createBody });
  assert.equal(retried.status, 201, retried.text);
  assert.equal(toUuid(retried.json.id), watchId, 'a retried create made a second watch');
  const { rows: [{ n }] } = await sql.query<{ n: number }>(`SELECT count(*)::int AS "n" FROM "watch" WHERE "idempotency_key" = $1`, [key]);
  assert.equal(n, 1);

  const read = await request(server, 'GET', `/api/watches/${uuidToBase62(watchId)}`, { token });
  assert.equal(read.status, 200, read.text);
  const listed = await request(server, 'GET', '/api/watches?state=ACTIVE', { token });
  assert.equal(listed.status, 200, listed.text);
  assert.ok(listed.json.some((watch: { id: string }) => toUuid(watch.id) === watchId));
  assert.equal((await request(server, 'GET', `/api/watches/${uuidToBase62(watchId)}`, { token: strangerToken })).status, 404);
  assert.equal((await request(server, 'POST', `/api/watches/${uuidToBase62(watchId)}/cancel`, { token: strangerToken })).status, 404);

  const edited = await request(server, 'PATCH', `/api/watches/${uuidToBase62(watchId)}`, { token, body: { ttlSeconds: 7_200 } });
  assert.equal(edited.status, 200, edited.text);
  const paused = await request(server, 'POST', `/api/watches/${uuidToBase62(watchId)}/pause`, { token });
  assert.deepEqual([paused.status, paused.json?.state], [200, 'PAUSED'], paused.text);
  assert.equal((await request(server, 'POST', `/api/watches/${uuidToBase62(watchId)}/pause`, { token })).status, 200);
  const resumed = await request(server, 'POST', `/api/watches/${uuidToBase62(watchId)}/resume`, { token });
  assert.deepEqual([resumed.status, resumed.json?.state], [200, 'ACTIVE'], resumed.text);
  // This process's evaluator takes what resuming left due.
  await eventually('the apiserver\'s own loop to evaluate the resumed watch', () => watchRow(watchId), (row) => row.due === false, 45_000);

  const refusals: Array<[string, Record<string, unknown>, string | undefined, number, string]> = [
    ['a shell predicate', { predicate: { kind: 'SHELL', command: 'true' } }, token, 400, 'UNKNOWN_PREDICATE_KIND'],
    ['a script smuggled into a term', { predicate: { ...ALL('TASK_TERMINAL'), script: 'rm -rf /' } }, token, 400, 'UNKNOWN_PREDICATE_KIND'],
    ['another account\'s target', {}, strangerToken, 403, 'PERMISSION_DENIED'],
    ['a TTL under a minute', { ttlSeconds: 10 }, token, 400, 'TTL_OUT_OF_RANGE'],
    ['no targets', { targets: [] }, token, 400, 'EMPTY_TARGET_SET'],
    ['a session leaf over a task', { predicate: ALL('SESSION_TURN_SETTLED') }, token, 400, 'TARGET_KIND_MISMATCH'],
    ['an unknown predicate version', { predicateVersion: 2 }, token, 400, 'PREDICATE_VERSION_UNSUPPORTED'],
  ];
  for (const [name, change, caller, status, code] of refusals) {
    const refused = await request(server, 'POST', '/api/watches', {
      token: caller,
      body: { ...createBody, idempotencyKey: undefined, ...change },
    });
    assert.deepEqual([refused.status, refused.json?.code], [status, code], `${name}: ${refused.text}`);
  }

  // Already true at create: matched in the response, then delivered by this process's delivery loop.
  const matched = await request(server, 'POST', '/api/watches', {
    token,
    body: { ...createBody, idempotencyKey: undefined, targets: [{ kind: 'TASK', id: uuidToBase62(ended) }] },
  });
  assert.equal(matched.status, 201, matched.text);
  assert.deepEqual([matched.json.state, matched.json.generation, matched.json.matches.length], ['MATCHED', 1, 1]);
  const matchedId = toUuid(matched.json.id);
  const delivered = await eventually(
    'the apiserver\'s delivery loop',
    async () => (await request(server, 'GET', `/api/watches/${uuidToBase62(matchedId)}`, { token })).json,
    (view) => view?.matches?.[0]?.deliveries?.[0]?.state === 'DELIVERED',
    45_000,
  );
  assert.equal(delivered.matches[0].deliveries.length, 1);

  const cancelled = await request(server, 'POST', `/api/watches/${uuidToBase62(watchId)}/cancel`, { token });
  assert.deepEqual([cancelled.status, cancelled.json?.state], [200, 'CANCELLED'], cancelled.text);
  assert.equal((await request(server, 'POST', `/api/watches/${uuidToBase62(watchId)}/cancel`, { token })).status, 200);
  const late = await request(server, 'POST', `/api/watches/${uuidToBase62(watchId)}/pause`, { token });
  assert.deepEqual([late.status, late.json?.state], [409, 'CANCELLED'], late.text);
  assert.equal(
    (await request(server, 'PATCH', `/api/watches/${uuidToBase62(matchedId)}`, { token, body: { ttlSeconds: 600 } })).status,
    409,
    'a MATCHED watch was edited',
  );
  assert.deepEqual(watchErrors(server), [], 'the Watch loops logged errors in ordinary operation');
  await server.kill('SIGTERM');
});

qa('P-02', 'SIGKILL in the middle of an evaluation\'s landing, reached through the runner door\'s real event: the landing dies with the process, and the restarted apiserver lands exactly one Match once the dead lease lapses', 360_000, async () => {
  const owner = await insertUser();
  const token = await tokenFor(owner);
  const runnerToken = `watch-qa-${randomUUID()}`;
  const runner = await insertRunner(owner, runnerToken);
  const target = await insertSession(owner, 'RUNNING', runner);
  const targetTurn = await insertRunningTurn(target, 2);
  let server = await startApiserver('P-02 first process');
  const created = await request(server, 'POST', '/api/watches', {
    token,
    body: { predicateVersion: 1, predicate: ALL('SESSION_TURN_SETTLED'), targets: [{ kind: 'SESSION', id: uuidToBase62(target) }], action: 'NOTIFY_USER' },
  });
  assert.equal(created.status, 201, created.text);
  const watchId = toUuid(created.json.id);
  const scheduled = await landedEvaluation(watchId);

  const gate = await holdLock(`LOCK TABLE "watch_match" IN SHARE ROW EXCLUSIVE MODE`);
  const completedAt = Date.now();
  const completed = await request(server, 'POST', `/api/runner/sessions/${uuidToBase62(target)}/turn-complete`, {
    token: runnerToken,
    body: { turnId: uuidToBase62(targetTurn), status: 'SUCCEEDED', subtype: 'completed', numTurns: 2, costUsd: 0 },
  });
  assert.equal(completed.status, 200, completed.text);
  await eventually('the apiserver to park at the Match insert', () => lockWaiters('INSERT INTO "watch_match"'), (n) => n >= 1, 90_000);
  const parkedAfterMs = Date.now() - completedAt;
  const { rows: [{ beforeSweep }] } = await sql.query<{ beforeSweep: boolean }>(
    `SELECT now() < ($1::text)::timestamp AT TIME ZONE 'UTC' AS "beforeSweep"`,
    [scheduled.nextEvaluateAt],
  );
  const leased = await watchRow(watchId);
  assert.equal(leased.due, false, 'the landing is not running under a lease');

  await server.kill('SIGKILL');
  await gate.release();
  await eventually('the dead process\'s backend to go', () => lockWaiters('watch_match'), (n) => n === 0, 60_000);
  assert.deepEqual(await matchesOf(watchId), [], 'a Match from the killed process committed');
  assert.equal((await watchRow(watchId)).state, 'ACTIVE');

  server = await startApiserver('P-02 restarted process');
  const [match] = await eventually('the restarted apiserver to land the Match', () => matchesOf(watchId), (rows) => rows.length === 1, 180_000);
  assert.ok(match.matchedAt >= leased.nextEvaluateAt!, `matched at ${match.matchedAt}, inside the dead process's lease until ${leased.nextEvaluateAt}`);
  await eventually('its delivery', () => deliveriesOf(watchId), (rows) => rows[0]?.state === 'DELIVERED', 60_000);
  await sleep(11_000);
  assert.equal((await matchesOf(watchId)).length, 1);
  assert.equal((await deliveriesOf(watchId)).length, 1);
  note('P-02', {
    turnCompleteToLandingMs: parkedAfterMs,
    landingBeforeReconciliation: beforeSweep,
    deadLeaseUntil: leased.nextEvaluateAt,
    matchedAt: match.matchedAt,
    restartedProcessWatchErrors: watchErrors(server),
  });
  await server.kill('SIGTERM');
});

qa('P-03', 'SIGKILL in the middle of a delivery\'s turn transaction: neither the wake nor its acknowledgement survives, the restarted apiserver takes the delivery back and writes the one turn, and a second crash after delivery delivers nothing twice', 360_000, async () => {
  const owner = await insertUser();
  const token = await tokenFor(owner);
  const runner = await insertRunner(owner, `watch-qa-${randomUUID()}`);
  const observer = await insertSession(owner, 'AWAITING_INPUT', runner);
  const ended = await insertTask(owner, 'FAILED');
  let server = await startApiserver('P-03 first process');

  const gate = await holdLock(`LOCK TABLE "conversation_turn" IN SHARE ROW EXCLUSIVE MODE`);
  const created = await request(server, 'POST', '/api/watches', {
    token,
    body: {
      predicateVersion: 1,
      predicate: ANY('TASK_FAILED'),
      targets: [{ kind: 'TASK', id: uuidToBase62(ended) }],
      action: 'RESUME_SESSION',
      observerSessionId: uuidToBase62(observer),
    },
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.json.state, 'MATCHED');
  const watchId = toUuid(created.json.id);
  await eventually('the apiserver to park at the wake insert', () => lockWaiters('INSERT INTO "public"."conversation_turn"'), (n) => n >= 1, 60_000);
  assert.equal((await deliveriesOf(watchId))[0].state, 'IN_FLIGHT');

  await server.kill('SIGKILL');
  await gate.release();
  await eventually('the dead process\'s backend to go', () => lockWaiters('conversation_turn'), (n) => n === 0, 60_000);
  assert.deepEqual(await wakesOf(watchId), [], 'a wake from the killed process committed');
  const [orphan] = await deliveriesOf(watchId);
  assert.equal(orphan.state, 'IN_FLIGHT', 'the acknowledgement outlived the turn it was written with');
  assert.equal(await statusOf(observer), 'AWAITING_INPUT');

  server = await startApiserver('P-03 restarted process');
  const [delivered] = await eventually('the restarted apiserver to deliver', () => deliveriesOf(watchId), (rows) => rows[0]?.state === 'DELIVERED', 180_000);
  assert.equal(delivered.attempts, 1, 'the attempt the crash lost was not counted');
  const wakes = await wakesOf(watchId);
  assert.deepEqual(wakes.map((wake) => wake.status), ['PENDING']);
  assert.equal(await statusOf(observer), 'PENDING');

  await server.kill('SIGKILL');
  server = await startApiserver('P-03 restarted again');
  await sleep(12_000);
  assert.equal((await wakesOf(watchId)).length, 1);
  const [still] = await deliveriesOf(watchId);
  assert.deepEqual([still.state, still.attempts], ['DELIVERED', 1]);
  note('P-03', { lastErrorAfterRecovery: delivered.lastError, watchErrors: watchErrors(server) });
  await server.kill('SIGTERM');
});

qa('P-04', 'the apiserver is down while a watched condition comes true and no event reaches anyone: the next process\'s reconciliation matches it once, and a crash after delivery delivers nothing twice', 300_000, async () => {
  const owner = await insertUser();
  const token = await tokenFor(owner);
  const work = await insertTask(owner, 'OPEN');
  let server = await startApiserver('P-04 first process');
  const created = await request(server, 'POST', '/api/watches', {
    token,
    body: { predicateVersion: 1, predicate: ANY('TASK_FAILED'), targets: [{ kind: 'TASK', id: uuidToBase62(work) }], action: 'NOTIFY_USER' },
  });
  assert.equal(created.status, 201, created.text);
  const watchId = toUuid(created.json.id);
  const scheduled = await landedEvaluation(watchId);
  await server.kill('SIGTERM');

  await sql.query(`UPDATE "task" SET "status" = 'FAILED' WHERE "id" = $1`, [work]);
  await sleep(2_000);
  assert.deepEqual(await matchesOf(watchId), [], 'something matched while no apiserver was running');

  server = await startApiserver('P-04 restarted process');
  const [match] = await eventually('reconciliation in the restarted apiserver', () => matchesOf(watchId), (rows) => rows.length === 1, 150_000);
  assert.ok(match.matchedAt >= scheduled.nextEvaluateAt!, 'matched before the sweep it was scheduled for');
  await eventually('its delivery', () => deliveriesOf(watchId), (rows) => rows[0]?.state === 'DELIVERED', 60_000);

  await server.kill('SIGKILL');
  server = await startApiserver('P-04 restarted again');
  await sleep(12_000);
  assert.equal((await matchesOf(watchId)).length, 1);
  const [delivery, ...more] = await deliveriesOf(watchId);
  assert.deepEqual(more, []);
  assert.deepEqual([delivery.state, delivery.attempts], ['DELIVERED', 0]);
  note('P-04', { sweepDueAt: scheduled.nextEvaluateAt, matchedAt: match.matchedAt, watchErrors: watchErrors(server) });
  await server.kill('SIGTERM');
});
