/**
 * The runner dispatch pause (queue/dispatch-pause.ts) held against the production apiserver — `build/main.js`,
 * the whole AppModule, run as a child process — over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates
 * from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/queue/dispatch-pause.pg.spec.ts
 *
 * An administrator switches it with the plain HTTP requests curl sends, and a runner is played over its own
 * door with its token. Against one server that is never restarted:
 *
 *   1. never switched, it reads off, and the runner is handed work as before;
 *   2. only a signed-in administrator reads or switches it — not a member, not an access token, not anybody
 *      unsigned — and a body that is not a boolean is refused;
 *   3. switched on, it lists what a cut-over waits for, each with how long it has run: the turn in flight,
 *      the integration job a runner holds, the merge still asked for;
 *   4. the inbox hands out interrupt, end and a steer into the running turn, and no message, shell or reload:
 *      a run with nothing in flight and its next turn queued goes back to PENDING;
 *   5. the turn that was running carries on — its events, an approval its owner answers, its completion —
 *      and leaves the list;
 *   6. a message the owner sends stays PENDING, no session is claimed and no queued integration job is;
 *   7. switched off, the claim that waited through the pause is woken at once, every held session is claimed
 *      and every held message, reload and integration job is handed out.
 *
 * Not destructive: every row belongs to accounts this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { type PrismaClient, RunStatus, RunnerStatus, SessionDispatchOrigin } from '@prisma/client';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { hashPassword, sha256 } from '../common/crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { enqueueForDoneTask, INTEGRATION_JOB_CLAIM } from '../projects/project-integration-job';
import { configureProjectIntegration } from '../projects/project-integration-line';
import { TasksService } from '../tasks/tasks.service';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const RUNNER_TOKEN = `dispatch-pause-runner-${randomUUID()}`;

/** A long poll held open on a connection of its own, which the caller can drop. */
interface Held {
  answer: Promise<Reply>;
  settled(): boolean;
  hangUp(): void;
}

function hold(server: Apiserver, route: string): Held {
  let done = false;
  const req = http.request({
    host: '127.0.0.1',
    port: server.port,
    method: 'GET',
    path: route,
    agent: false,
    headers: { authorization: `Bearer ${RUNNER_TOKEN}` },
  });
  const answer = new Promise<Reply>((resolve, reject) => {
    req.on('response', (res) => {
      const parts: Buffer[] = [];
      res.on('data', (chunk: Buffer) => parts.push(chunk));
      res.on('end', () => {
        done = true;
        const text = Buffer.concat(parts).toString('utf8');
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, json, text, headers: res.headers });
      });
    });
    req.on('error', (error) => {
      done = true;
      reject(error);
    });
  });
  answer.catch(() => undefined);
  req.end();
  return { answer, settled: () => done, hangUp: () => req.destroy() };
}

async function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    sleep(ms).then(() => {
      throw new Error(`${what} did not answer within ${ms} ms`);
    }),
  ]);
}

test('the runner dispatch pause holds new work, lets running work finish, and hands everything out once it is off', {
  skip: !URL_, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  const beats = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await beats.connect();
  const prisma: PrismaClient = prismaClientFor(url);
  let server: Apiserver | undefined;
  let beating: ReturnType<typeof setInterval> | undefined;
  t.after(async () => {
    if (beating) clearInterval(beating);
    await server?.stop();
    await prisma.$disconnect().catch(() => undefined);
    await beats.end().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });

  // ── accounts, the machine and its checkout ──────────────────────────────────────────────────────────────
  const account = async (name: string, role: 'ADMIN' | 'MEMBER') => {
    const id = randomUUID();
    const password = `pw-${name}-${RUN}`;
    const email = `${name}-${RUN}@dispatch-pause.invalid`;
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, $5)`,
      [id, email, name, hashPassword(password), role]);
    return { id, email, password };
  };
  const admin = await account('admin', 'ADMIN');
  const owner = await account('owner', 'MEMBER');

  const runnerId = randomUUID();
  await prisma.runner.create({
    data: {
      id: runnerId, ownerId: owner.id, name: 'the machine being drained', tokenHash: sha256(RUNNER_TOKEN),
      maxConcurrent: 8, status: RunnerStatus.ONLINE, lastHeartbeatAt: new Date(),
    },
  });
  // The reaper ends a RUNNING session whose runner stopped heartbeating. This one stays online the whole run.
  const beat = () =>
    beats.query(`UPDATE "runner" SET "last_heartbeat_at" = clock_timestamp() WHERE "id" = $1::uuid`, [runnerId])
      .catch(() => undefined);
  await beat();
  beating = setInterval(() => void beat(), 3_000);
  const workspaceId = randomUUID();
  await prisma.workspace.create({
    data: {
      id: workspaceId, ownerId: owner.id, runnerId, name: 'the checkout these sessions run in', enabled: true,
      workDir: mkdtempSync(path.join(tmpdir(), 'dispatch-pause-')),
    },
  });

  /** A Claude session on the machine; `lease` is the engine process holding its inbox, registered as one. */
  async function session(
    status: RunStatus,
    lease?: { owner: string; generation: string },
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const id = randomUUID();
    await prisma.session.create({
      data: {
        id, ownerId: owner.id, creatorId: owner.id, workspaceId, assignedRunnerId: runnerId,
        title: `dispatch pause ${status.toLowerCase()}`, prompt: 'the work', provider: 'claude', engine: 'claude',
        status, dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: false,
        ...(lease ? { inboxLeaseOwner: lease.owner, inboxLeaseGeneration: lease.generation } : {}),
        ...extra,
      },
    });
    if (lease) {
      await sql.query(
        `INSERT INTO "inbox_lease_generation" ("generation", "session_id", "lease_owner") VALUES ($1::uuid, $2::uuid, $3::uuid)`,
        [lease.generation, id, lease.owner],
      );
    }
    return id;
  }
  const seqs = new Map<string, number>();
  /** A turn queued on `sessionId`, the next in its order. */
  async function turn(sessionId: string, kind: string): Promise<string> {
    const id = randomUUID();
    const seq = (seqs.get(sessionId) ?? 0) + 1;
    seqs.set(sessionId, seq);
    await prisma.conversationTurn.create({
      data: {
        id, sessionId, seq, clientTurnId: randomUUID(), kind, status: 'PENDING',
        content: kind === 'reload' ? '{"model":"claude-sonnet-5-5"}' : `${kind} ${seq}`,
      },
    });
    return id;
  }

  // A session queued for its first claim.
  const queued = await session(RunStatus.PENDING);
  const queuedMessage = await turn(queued, 'message');
  // A session whose turn has been running for a minute and a half, on a live lease; behind it an interrupt,
  // an end and a steer meant for that turn.
  const runningLease = { owner: randomUUID(), generation: randomUUID() };
  const running = await session(RunStatus.RUNNING, runningLease);
  const runningTurn = await turn(running, 'message');
  await sql.query(
    `UPDATE "conversation_turn" SET "status" = 'IN_FLIGHT', "delivered_at" = now() - interval '90 seconds',
            "lease_deadline_at" = now() + interval '5 minutes', "lease_generation" = $2::uuid
      WHERE "id" = $1::uuid`,
    [runningTurn, runningLease.generation],
  );
  const interrupt = await turn(running, 'interrupt');
  const end = await turn(running, 'end');
  const steer = await turn(running, 'steer');
  // A run claimed just before the switch: its message not handed out yet, nothing in flight.
  const claimedLease = { owner: randomUUID(), generation: randomUUID() };
  const claimed = await session(RunStatus.RUNNING, claimedLease);
  const claimedMessage = await turn(claimed, 'message');
  // A resident engine between turns, with a reload queued for it.
  const idleLease = { owner: randomUUID(), generation: randomUUID() };
  const idle = await session(RunStatus.AWAITING_INPUT, idleLease, { numTurns: 1 });
  const idleReload = await turn(idle, 'reload');
  // A merge asked for on a finished session, not yet carried out.
  const merging = await session(RunStatus.SUCCEEDED, undefined, {
    branch: `orbit/merge-${RUN}`, finishedAt: new Date(), mergeStatus: 'pending', mergeOperationId: randomUUID(),
  });
  await sql.query(`UPDATE "session" SET "merge_requested_at" = now() - interval '20 seconds' WHERE "id" = $1::uuid`, [merging]);

  // A task's landing, queued on its project's line: a project of its own per landing, so each has its own
  // repository and target ref and neither waits behind the other's claim.
  const tasks = new TasksService(prisma as never, {} as never, { publishTaskChanged() {}, publishForUser() {} } as never);
  async function landingQueued(name: string): Promise<string> {
    const projectWorkspaceId = randomUUID();
    const projectId = randomUUID();
    await prisma.workspace.create({
      data: {
        id: projectWorkspaceId, ownerId: owner.id, runnerId, name: `${name} checkout`, enabled: true,
        repoUrl: `https://git.invalid/${name}-${RUN}.git`, workDir: mkdtempSync(path.join(tmpdir(), `dispatch-pause-${name}-`)),
      },
    });
    await prisma.project.create({ data: { id: projectId, ownerId: owner.id, title: `${name} project`, coordinatorWorkspaceId: projectWorkspaceId } });
    await prisma.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
    await prisma.$transaction((tx) => configureProjectIntegration(tx, {
      ownerId: owner.id, projectId, settings: { line: 'PROJECT_BRANCH' },
    }));
    const task = await tasks.create(owner.id, {
      title: `${name} work`, projectId, autoRunWhenReady: false,
      completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
    } as never);
    await prisma.$executeRawUnsafe(`UPDATE "task" SET "status" = 'DONE' WHERE "id" = $1::uuid`, task.id);
    const branch = `orbit/${name}-${RUN}`;
    await prisma.session.create({
      data: {
        ownerId: owner.id, creatorId: owner.id, taskId: task.id, workspaceId: projectWorkspaceId,
        assignedRunnerId: runnerId, title: `${name} work`, prompt: `${name} work`, branch,
        isolationStatus: 'worktree', baseSha: 'b'.repeat(40), status: RunStatus.SUCCEEDED, startsTaskWork: true,
        finishedAt: new Date(Date.now() - 2 * 86_400_000), worktreeBranch: branch, worktreeDirty: false,
        changedFiles: [{ path: 'src/work.ts' }] as never,
      },
    });
    const outcome = await prisma.$transaction((tx) => enqueueForDoneTask(tx, owner.id, task.id));
    assert.ok(outcome.enqueued, `the ${name} landing was not queued`);
    const job = await prisma.projectIntegrationJob.findFirstOrThrow({ where: { taskId: task.id } });
    assert.equal(job.state, 'QUEUED');
    return job.id;
  }
  const landedFirst = await landingQueued('landed-first');

  server = await startApiserver(url, `dispatch-pause-${randomUUID()}`);
  const api = (method: string, route: string, bearer?: string, body?: unknown, headers?: Record<string, string>) =>
    call(server!, method, route, bearer, body, headers);
  const runner = (method: string, route: string, body?: unknown, headers?: Record<string, string>) =>
    call(server!, method, route, RUNNER_TOKEN, body, headers);
  const signIn = async (who: { email: string; password: string }) => {
    const reply = await api('POST', '/api/auth/login', undefined, { email: who.email, password: who.password });
    assert.equal(reply.status, 201, reply.text);
    return reply.json.accessToken as string;
  };
  const adminToken = await signIn(admin);
  const ownerToken = await signIn(owner);

  /** As the administrator unless told otherwise; null is a request with no token at all. */
  const switchTo = (paused: unknown, bearer: string | null = adminToken) =>
    api('PUT', '/api/admin/dispatch-pause', bearer ?? undefined, { paused });
  const read = (bearer: string | null = adminToken) => api('GET', '/api/admin/dispatch-pause', bearer ?? undefined);
  const route = (sessionId: string, rest: string) => `/api/runner/sessions/${uuidToBase62(sessionId)}/${rest}`;
  const inbox = (sessionId: string, generation: string) => route(sessionId, `inbox?leaseGeneration=${generation}&acceptsSteer=1`);
  const leaseOwner = randomUUID();
  /** A heartbeat of a process that claims integration jobs. */
  const heartbeat = () =>
    runner('POST', '/api/runner/heartbeat', { leaseOwner, status: 'ONLINE' }, { 'x-orbit-runner-capabilities': INTEGRATION_JOB_CLAIM });
  const statusOf = async (sessionId: string) =>
    (await sql.query<{ status: string }>(`SELECT "status" FROM "session" WHERE "id" = $1::uuid`, [sessionId])).rows[0].status;
  const turnStatusOf = async (turnId: string) =>
    (await sql.query<{ status: string }>(`SELECT "status" FROM "conversation_turn" WHERE "id" = $1::uuid`, [turnId])).rows[0].status;
  const jobStateOf = async (jobId: string) =>
    (await sql.query<{ state: string }>(`SELECT "state" FROM "project_integration_job" WHERE "id" = $1::uuid`, [jobId])).rows[0].state;
  /** The turn an inbox poll handed out, and its kind; an empty poll's turnId is ''. */
  const handed = (reply: Reply) => [reply.json?.turnId ? toUuid(reply.json.turnId) : reply.json?.turnId, reply.json?.kind];

  await t.test('never switched, it reads off and the runner is handed work as before', async () => {
    const off = await read();
    assert.equal(off.status, 200, off.text);
    assert.deepEqual([off.json.paused, off.json.updatedAt, off.json.updatedById], [false, null, null]);
    const beatOn = await heartbeat();
    assert.equal(beatOn.status, 201, beatOn.text);
    assert.deepEqual((beatOn.json.integrationJobs ?? []).map((job: { jobId: string }) => toUuid(job.jobId)), [landedFirst]);
    assert.equal(await jobStateOf(landedFirst), 'RUNNING');
  });

  await t.test('only a signed-in administrator reads or switches it', async () => {
    assert.equal((await read(null)).status, 401);
    assert.equal((await switchTo(true, null)).status, 401);
    assert.equal((await read(ownerToken)).status, 403, 'a member read it');
    assert.equal((await switchTo(true, ownerToken)).status, 403, 'a member switched it');
    const issued = await api('POST', '/api/access-tokens', adminToken, { name: `dispatch pause ${RUN}`, scopes: ['tasks:read'], expiresInDays: 30 });
    assert.equal(issued.status, 201, issued.text);
    for (const reply of [await read(issued.json.token), await switchTo(true, issued.json.token)]) {
      assert.equal(reply.status, 403, reply.text);
      assert.deepEqual([reply.json.code, reply.json.reason], ['PAT_FORBIDDEN', 'ADMIN'], reply.text);
    }
    for (const body of [{}, { paused: 'true' }, { paused: 1 }]) {
      const refused = await api('PUT', '/api/admin/dispatch-pause', adminToken, body);
      assert.equal(refused.status, 400, `${JSON.stringify(body)} answered ${refused.status}: ${refused.text}`);
    }
    assert.equal((await read()).json.paused, false, 'a refused request switched it');
  });

  let switchedAt = '';
  await t.test('switched on, it lists the turn, the integration job and the merge still running, with how long', async () => {
    const on = await switchTo(true);
    assert.equal(on.status, 200, on.text);
    assert.equal(on.json.paused, true);
    assert.equal(toUuid(on.json.updatedById), admin.id);
    switchedAt = on.json.updatedAt;
    assert.ok(switchedAt, on.text);
    const again = await switchTo(true);
    assert.equal(again.status, 200, again.text);
    assert.equal(again.json.updatedAt, switchedAt, 'asking for the state it was in wrote it again');

    const { turns, integrationJobs, worktreeOperations } = on.json.running;
    assert.deepEqual(turns.map((row: { turnId: string }) => toUuid(row.turnId)), [runningTurn], on.text);
    assert.equal(toUuid(turns[0].sessionId), running);
    assert.equal(toUuid(turns[0].runnerId), runnerId);
    assert.equal(turns[0].kind, 'message');
    assert.ok(turns[0].elapsedSeconds >= 85 && turns[0].elapsedSeconds < 3_600, `the turn has run ${turns[0].elapsedSeconds}s, not about 90`);
    const job = integrationJobs.find((row: { jobId: string }) => toUuid(row.jobId) === landedFirst);
    assert.ok(job, `the claimed landing is not listed: ${on.text}`);
    assert.equal(toUuid(job.runnerId), runnerId);
    assert.ok(job.elapsedSeconds >= 0 && job.elapsedSeconds < 3_600, on.text);
    const merge = worktreeOperations.find((row: { sessionId: string }) => toUuid(row.sessionId) === merging);
    assert.deepEqual([merge?.operation, merge?.claimed], ['merge', false], on.text);
    assert.ok(merge.elapsedSeconds >= 15 && merge.elapsedSeconds < 3_600, on.text);
  });

  let idleHeld: Held | undefined;
  await t.test('the inbox hands out interrupt, end and a steer into the running turn, and nothing that starts one', async () => {
    assert.deepEqual(handed(await runner('GET', inbox(running, runningLease.generation))), [interrupt, 'interrupt']);
    assert.deepEqual(handed(await runner('GET', inbox(running, runningLease.generation))), [end, 'end']);
    assert.deepEqual(handed(await runner('GET', inbox(running, runningLease.generation))), [steer, 'steer']);
    assert.equal(await statusOf(running), 'RUNNING', 'the running turn lost its run');

    // The run claimed just before the switch is handed nothing: it goes back to the queue, and its engine lets go.
    const given = await runner('GET', inbox(claimed, claimedLease.generation));
    assert.equal(given.status, 409, given.text);
    assert.match(given.json.message, /runner dispatch is paused/);
    assert.equal(await statusOf(claimed), 'PENDING');
    assert.equal(await turnStatusOf(claimedMessage), 'PENDING');
    const fence = await sql.query(`SELECT "retired_at" FROM "inbox_lease_generation" WHERE "generation" = $1::uuid`, [claimedLease.generation]);
    assert.ok(fence.rows[0]?.retired_at, 'the engine that gave the run back can still take its turns');

    // The resident engine's reload waits too; this poll runs its whole course while the pause is on.
    idleHeld = hold(server!, inbox(idle, idleLease.generation));
  });

  let followUp = '';
  await t.test('the turn that was running reports, is answered an approval and completes, then leaves the list', async () => {
    const events = await runner('POST', route(running, 'events'), {
      leaseOwner: runningLease.owner,
      events: [{ seq: 1, type: 'assistant', turnId: runningTurn, ts: new Date().toISOString(), payload: { text: 'still working while dispatch is paused' } }],
    });
    assert.equal(events.status, 202, events.text);

    const asked = await runner('POST', route(running, 'approvals'), { toolName: 'Bash', input: { command: 'git status' }, toolUseId: `toolu_${RUN}` });
    assert.equal(asked.status, 201, asked.text);
    assert.equal(asked.json.status, 'PENDING');
    const decided = await api('POST', `/api/sessions/${uuidToBase62(running)}/approvals/${asked.json.id}/decision`, ownerToken, { behavior: 'allow' });
    assert.ok(decided.status === 200 || decided.status === 201, decided.text);
    const answer = await runner('GET', route(running, `approvals/${asked.json.id}`));
    assert.equal(answer.status, 200, answer.text);
    assert.equal(answer.json.status, 'ALLOWED');

    followUp = await turn(running, 'message');
    const completed = await runner('POST', route(running, 'turn-complete'), {
      turnId: runningTurn, leaseOwner: runningLease.owner, status: 'SUCCEEDED', result: 'done', numTurns: 1, costUsd: 0,
    });
    assert.equal(completed.status, 200, completed.text);
    assert.equal(completed.json.status, 'RUNNING', 'the slot did not pass to the queued follow-up as it always does');
    assert.equal(await turnStatusOf(runningTurn), 'ANSWERED');

    // The follow-up would start a turn: the run goes back to the queue instead.
    const given = await runner('GET', inbox(running, runningLease.generation));
    assert.equal(given.status, 409, given.text);
    assert.match(given.json.message, /runner dispatch is paused/);
    assert.equal(await statusOf(running), 'PENDING');
    assert.equal(await turnStatusOf(followUp), 'PENDING');
    const listed = await read();
    assert.deepEqual(listed.json.running.turns, [], `a turn is still listed as running: ${listed.text}`);
  });

  let sentMessage = '';
  let heldBack = '';
  await t.test('a message its owner sends stays PENDING, and a queued integration job is not claimed', async () => {
    const sent = await api('POST', `/api/sessions/${uuidToBase62(idle)}/turns`, ownerToken, {
      clientTurnId: randomUUID(), content: 'sent while dispatch is paused',
    });
    assert.equal(sent.status, 201, sent.text);
    const { rows: [newest] } = await sql.query<{ id: string; status: string }>(
      `SELECT "id", "status" FROM "conversation_turn" WHERE "session_id" = $1::uuid AND "kind" = 'message' ORDER BY "seq" DESC LIMIT 1`,
      [idle],
    );
    sentMessage = newest.id;
    assert.equal(newest.status, 'PENDING');
    assert.equal(await statusOf(idle), 'PENDING');

    heldBack = await landingQueued('held-back');
    const pausedBeat = await heartbeat();
    assert.equal(pausedBeat.status, 201, pausedBeat.text);
    assert.equal(pausedBeat.json.integrationJobs, undefined, `a queued integration job was claimed while paused: ${pausedBeat.text}`);
    assert.equal(await jobStateOf(heldBack), 'QUEUED');

    // The reload's poll ran out with nothing handed over.
    const idleAnswer = await within(40_000, 'the resident engine\'s inbox poll', idleHeld!.answer);
    assert.equal(idleAnswer.status, 200, idleAnswer.text);
    assert.equal(idleAnswer.json.turnId, '', `the inbox handed out a turn while paused: ${idleAnswer.text}`);
    assert.equal(await turnStatusOf(idleReload), 'PENDING');
  });

  await t.test('switched off, the waiting claim is woken at once and everything held is handed out', async () => {
    // Take any runner wake owed from before, so the one asked for below is the resume's.
    const owed = hold(server!, '/api/runner/wake');
    await sleep(1_000);
    owed.hangUp();
    await sleep(300);

    // Opened 6.5 s before the switch: past the claim's own 5 s re-poll, and 3.5 s short of the next one, so
    // an answer well inside that is the wake's.
    const waiting = hold(server!, '/api/runner/sessions/claim');
    await sleep(6_500);
    assert.equal(waiting.settled(), false, 'a session was claimed while paused');
    for (const id of [queued, claimed, running, idle]) assert.equal(await statusOf(id), 'PENDING');
    for (const id of [queuedMessage, claimedMessage, followUp, idleReload, sentMessage]) assert.equal(await turnStatusOf(id), 'PENDING');

    const resumedAt = Date.now();
    const off = await switchTo(false);
    assert.equal(off.status, 200, off.text);
    assert.equal(off.json.paused, false);
    assert.notEqual(off.json.updatedAt, switchedAt);
    const first = await within(10_000, 'the claim that waited through the pause', waiting.answer);
    const latency = Date.now() - resumedAt;
    assert.equal(first.status, 200, first.text);
    assert.ok(first.json?.sessionId, `the claim that waited through the pause came back empty: ${first.text}`);
    assert.ok(latency < 2_500, `the waiting claim answered ${latency} ms after the switch: it was not woken`);
    const woken = await within(5_000, 'the runner wake', hold(server!, '/api/runner/wake').answer);
    assert.equal(woken.json?.wake, true, 'the runner a queued integration job waits for was not woken');

    const claimedNow = new Set([toUuid(first.json.sessionId)]);
    for (let round = 0; round < 6 && claimedNow.size < 4; round += 1) {
      const next = await runner('GET', '/api/runner/sessions/claim');
      assert.equal(next.status, 200, next.text);
      if (next.json?.sessionId) claimedNow.add(toUuid(next.json.sessionId));
    }
    assert.deepEqual([...claimedNow].sort(), [queued, claimed, running, idle].sort());

    /** What a runner does with a claimed session: take the inbox over, then activate a generation of its own. */
    const attach = async (sessionId: string) => {
      const { rows: [current] } = await sql.query<{ owner: string | null }>(
        `SELECT "inbox_lease_owner"::text AS "owner" FROM "session" WHERE "id" = $1::uuid`, [sessionId]);
      const process = randomUUID();
      const generation = randomUUID();
      const taken = await runner('POST', route(sessionId, 'takeover-leases'), { leaseOwner: process, expectedLeaseOwner: current.owner });
      assert.equal(taken.status, 200, taken.text);
      const activated = await runner('POST', route(sessionId, 'activate-leases'), { leaseGeneration: generation, leaseOwner: process });
      assert.equal(activated.status, 200, activated.text);
      return generation;
    };
    for (const [sessionId, held] of [[queued, queuedMessage], [claimed, claimedMessage], [running, followUp]]) {
      const delivered = await runner('GET', inbox(sessionId, await attach(sessionId)));
      assert.equal(delivered.status, 200, delivered.text);
      assert.deepEqual(handed(delivered), [held, 'message'], delivered.text);
      assert.equal(await turnStatusOf(held), 'IN_FLIGHT');
    }
    // The resident engine's reload goes out first, then the message its owner sent while paused.
    const idleGeneration = await attach(idle);
    assert.deepEqual(handed(await runner('GET', inbox(idle, idleGeneration))), [idleReload, 'reload']);
    assert.deepEqual(handed(await runner('GET', inbox(idle, idleGeneration))), [sentMessage, 'message']);

    const resumedBeat = await heartbeat();
    assert.equal(resumedBeat.status, 201, resumedBeat.text);
    assert.deepEqual((resumedBeat.json.integrationJobs ?? []).map((job: { jobId: string }) => toUuid(job.jobId)), [heldBack]);
    assert.equal(await jobStateOf(heldBack), 'RUNNING');

    const after = await read();
    assert.deepEqual(
      after.json.running.turns.map((row: { turnId: string }) => toUuid(row.turnId)).sort(),
      [queuedMessage, claimedMessage, followUp, sentMessage].sort(),
    );
    assert.deepEqual(
      after.json.running.integrationJobs.map((row: { jobId: string }) => toUuid(row.jobId)).sort(),
      [landedFirst, heldBack].sort(),
    );
  });
});
