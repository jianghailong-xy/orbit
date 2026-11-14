/**
 * A session's task writes are the writes its card approved — held against a real apiserver
 * (`build/main.js`, every guard and pipe in front of the routes) over a PostgreSQL that
 * `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/tasks/task-write-approval.pg.spec.ts
 *
 * The policy is stated by caller, not by door (`docs/orbit-agent-contract.md` §2.4, §4.2): a
 * request that names an acting session is an agent writing on somebody's behalf, and creating a
 * task, creating a batch (including one that starts work at once) and restructuring a list's DAG
 * each require the answered confirmation card the MCP tools and the in-session CLI raise. A request
 * that names no session — the owner's terminal, headless automation, a personal access token — is
 * the owner's own door and is left as it was.
 *
 * The matrix is deliberate: Auto, Default, Plan and Don't Ask are engine permission modes, and the
 * rule here must not move with them (it is enforced in the control plane, not in a prompt). The
 * headless and token paths are the least-privilege ones the contract keeps.
 *
 * Refusals are asserted on literals rather than on the constants the change adds, so this file
 * compiles and fails against code that has no such door.
 *
 * Not destructive: every row belongs to users this run creates.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { JwtService } from '@nestjs/jwt';
import { toUuid, uuidToBase62 } from '@orbit/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import { Client } from 'pg';

import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import '../test-support/daemon-routes-over-http';

const URL = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);
const CARD_CODE = 'TASK_WRITE_NEEDS_OWNER_CARD';
const STANDARD = 'the work is checked by somebody who did not do it';
const b62 = (id: string) => uuidToBase62(id);

test('a session write is the write its card approved', { skip: !URL, concurrency: 1, timeout: 600_000 }, async (t) => {
  const url = URL!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  await verifyCoordinatorPgIdentity(sql);
  process.env.PROVIDER_SECRET_KEY = `task-write-approval-${RUN}`;
  const dir = mkdtempSync(path.join(tmpdir(), 'orbit-task-write-'));
  const db: PrismaClient = prismaClientFor(url);
  let server: Apiserver | undefined;
  t.after(async () => {
    await server?.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });
  const jwtSecret = `task-write-approval-${randomUUID()}`;
  server = await startApiserver(url, jwtSecret, {
    PROVIDER_SECRET_KEY: `task-write-approval-${RUN}`,
    MODEL_CATALOG_URL: 'http://127.0.0.1:9/',
    ORBIT_FILES_BACKEND: 'local',
    ORBIT_FILES_DIR: dir,
  });
  const api = server;

  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const token = `${runnerId}-${RUN}`;
  const email = `owner-${RUN}@task-write-approval.invalid`;
  await db.user.create({ data: { id: ownerId, email, name: 'owner', passwordHash: 'x' } });
  await db.runner.create({
    data: {
      id: runnerId, ownerId, name: 'machine', status: 'ONLINE', lastHeartbeatAt: new Date(Date.now() + 3_600_000),
      tokenHash: createHash('sha256').update(token).digest('hex'),
    },
  });
  await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: 'one', enabled: true } });
  const bearer = await new JwtService({ secret: jwtSecret }).signAsync({ sub: ownerId, email });

  /** A session of the account, optionally in one of the engine's permission modes. */
  const sessionOf = async (title: string, permissionMode?: string) => {
    const id = randomUUID();
    await db.session.create({
      data: {
        id, title, prompt: title, ownerId, creatorId: ownerId, workspaceId,
        assignedRunnerId: runnerId, status: 'AWAITING_INPUT', startedAt: new Date(),
        runtimeSessionId: `runtime-${id}`, provider: 'claude',
        ...(permissionMode ? { permissionMode } : {}),
      },
    });
    return id;
  };
  const listOf = async (title: string) => {
    const id = randomUUID();
    await db.taskList.create({ data: { id, ownerId, title } });
    return id;
  };
  const taskOf = async (title: string, extra: Partial<Prisma.TaskUncheckedCreateInput> = {}) => {
    const id = randomUUID();
    await db.task.create({
      data: {
        id, title, ownerId, creatorType: 'USER', creatorId: ownerId, assigneeId: workspaceId,
        status: 'OPEN', completionCriterion: 'EVIDENCE_JUDGMENT', acceptanceCriteria: STANDARD,
        ...extra,
      },
    });
    return id;
  };
  // EXECUTABLE, because EVIDENCE_JUDGMENT is refused for a task filed in no project: the criterion
  // needs a project's stated acceptance to be confirmed against, and this fixture's work is a
  // routing question, not a filing question.
  const taskBody = (title: string, extra: Record<string, Prisma.InputJsonValue> = {}): Record<string, Prisma.InputJsonValue> => ({
    title,
    completionCriterion: 'EXECUTABLE',
    acceptanceCommand: 'true',
    acceptanceExpectedExitCode: 0,
    assigneeId: b62(workspaceId),
    ...extra,
  });
  /** A card as the runner files it: what the person reads, in the state their answer left it in. */
  const cardOf = (
    sessionId: string,
    toolName: string,
    input: Prisma.InputJsonValue,
    status = 'ALLOWED',
    decidedById: string | null = ownerId,
    startAfterCreate = false,
  ) => db.approval.create({
    data: {
      sessionId, toolName, input, status, decidedById, startAfterCreate,
      decidedAt: status === 'PENDING' ? null : new Date(),
    },
  });

  const sessionHeaders = (sessionId: string) => ({
    'x-orbit-session-id': b62(sessionId),
    'x-orbit-workspace-id': b62(workspaceId),
  });
  const create = (sessionId: string | undefined, body: unknown) =>
    call(api!, 'POST', '/api/runner/tasks', token, body, sessionId ? sessionHeaders(sessionId) : {});
  const batch = (sessionId: string | undefined, tasks: unknown[]) =>
    call(api!, 'POST', '/api/runner/tasks/batch-create', token, { tasks }, sessionId ? sessionHeaders(sessionId) : {});
  const dagApply = (sessionId: string | undefined, listId: string, ops: unknown[]) =>
    call(api!, 'POST', `/api/runner/task-lists/${b62(listId)}/dag-apply`, token, { ops }, sessionId ? { 'x-orbit-session-id': b62(sessionId) } : {});
  const cardsFiled = () => db.approval.count({ where: { session: { ownerId } } });

  const refused = (reply: Reply, what: string) => {
    assert.equal(reply.status, 403, `${what} answered ${reply.status}: ${reply.text.slice(0, 400)}`);
    assert.equal(reply.json?.code, CARD_CODE, `${what}: ${reply.text.slice(0, 400)}`);
    assert.equal(reply.json.kind, 'REFUSAL', what);
    assert.equal(reply.json.requiredAction, 'ASK_THROUGH_THE_SAME_TOOL', what);
    assert.match(reply.json.message, /answered confirmation card/, what);
  };
  /** The same code for a write that named no usable acting session; its action names the way out. */
  const refusedForSession = (reply: Reply, what: string) => {
    assert.equal(reply.status, 403, `${what} answered ${reply.status}: ${reply.text.slice(0, 400)}`);
    assert.equal(reply.json?.code, CARD_CODE, `${what}: ${reply.text.slice(0, 400)}`);
    assert.equal(reply.json.kind, 'REFUSAL', what);
    assert.equal(reply.json.requiredAction, 'USE_A_PERSONAL_ACCESS_TOKEN', what);
    assert.match(reply.json.message, /must name the acting session/, what);
  };
  const ok = (reply: Reply, what: string) => {
    assert.ok(reply.status >= 200 && reply.status < 300, `${what} answered ${reply.status}: ${reply.text.slice(0, 400)}`);
    return reply.json;
  };
  const rows = (title: string) => db.task.count({ where: { ownerId, title } });

  // ── 1 ────────────────────────────────────────────────────────────────────────────────────────
  // The mode an engine runs in cannot widen the control plane's door. Auto and Bypass start an
  // engine's shell without asking; Plan and Don't Ask refuse it. None of that is how an Orbit
  // create is approved, and the same refusal is answered in all four (contract §4.1).
  for (const mode of ['auto', 'default', 'plan', 'dontAsk']) {
    await t.test(`${mode}: a create without an answered card is refused, and the card lets it through`, async () => {
      const sessionId = await sessionOf(`a ${mode} session`, mode);
      const body = taskBody(`a task from ${mode}`);

      refused(await create(sessionId, body), `${mode} without a card`);
      assert.equal(await rows(`a task from ${mode}`), 0, 'nothing was written');

      // A question nobody has answered is not an answer, and neither is a no.
      await cardOf(sessionId, 'orbit_task_create', body, 'PENDING', null);
      await cardOf(sessionId, 'orbit_task_create', body, 'DENIED');
      refused(await create(sessionId, body), `${mode} with an unanswered or declined card`);

      await cardOf(sessionId, 'orbit_task_create', body);
      const created = ok(await create(sessionId, body), `${mode} with the owner's yes`);
      // The receipt spells the id base62, as every door does; the row is keyed by the uuid.
      const row = await db.task.findUniqueOrThrow({ where: { id: toUuid(created.id) } });
      assert.equal(row.title, `a task from ${mode}`);
      // Attribution is the same on both surfaces that ask: this agent, linked to this session.
      assert.equal(row.creatorType, 'AGENT');
      assert.equal(row.creatorId, workspaceId);
      assert.equal(row.creatorSessionId, sessionId);
    });
  }

  // ── 2 ────────────────────────────────────────────────────────────────────────────────────────
  await t.test('a batch that starts work at once cannot be written without its card', async () => {
    const sessionId = await sessionOf('a batch session');
    const startAt = new Date(Date.now() + 60_000).toISOString();
    const items = [
      taskBody('a batch item that starts', { runAt: startAt, autoRunWhenReady: true }),
      taskBody('a second batch item'),
    ];

    refused(await batch(sessionId, items), 'an unapproved batch');
    assert.equal(await rows('a batch item that starts'), 0, 'nothing was written');

    // The single-create card is not the batch card: the person approved a different question.
    await cardOf(sessionId, 'orbit_task_create', items[0]);
    refused(await batch(sessionId, items), 'a batch covered only by a single-create card');

    await cardOf(sessionId, 'orbit_task_batch', { tasks: items, preview: { taskCount: 2, startingNow: 1 } });
    const created = ok(await batch(sessionId, items), 'the batch card');
    assert.equal(created.length, 2);
    const started = await db.task.findFirstOrThrow({ where: { ownerId, title: 'a batch item that starts' } });
    assert.equal(started.autoRunWhenReady, true);
    assert.ok(started.runAt instanceof Date, 'the schedule the card counted is written');
  });

  // ── 3 ────────────────────────────────────────────────────────────────────────────────────────
  await t.test('a DAG restructure is protected the same way, whichever door applies it', async () => {
    const sessionId = await sessionOf('a DAG session');
    const listId = await listOf('a list');
    const dependent = await taskOf('a listed task', { listId });
    const prerequisite = await taskOf('a prerequisite');
    const ops = [{ op: 'add', taskId: b62(dependent), dependsOnTaskId: b62(prerequisite) }];

    refused(await dagApply(sessionId, listId, ops), 'an unapproved restructure');
    assert.equal(await db.taskDependency.count({ where: { taskId: dependent } }), 0, 'no edge was written');

    // A card about another list, or about other edges, approved nothing here.
    const otherList = await listOf('another list');
    await cardOf(sessionId, 'orbit_dag_change', { listId: b62(otherList), ops, preview: {} });
    await cardOf(sessionId, 'orbit_dag_change', {
      listId: b62(listId),
      ops: [{ op: 'add', taskId: b62(dependent), dependsOnTaskId: b62(await taskOf('another prerequisite')) }],
      preview: {},
    });
    refused(await dagApply(sessionId, listId, ops), 'a card about something else');

    await cardOf(sessionId, 'orbit_dag_change', { listId: b62(listId), ops, preview: { effectiveCount: 1 } });
    ok(await dagApply(sessionId, listId, ops), 'the DAG card');
    assert.equal(await db.taskDependency.count({ where: { taskId: dependent, dependsOnTaskId: prerequisite } }), 1);

    // The same restructure over the same card is a retry, not a second question — and it settles.
    ok(await dagApply(sessionId, listId, ops), 'the same restructure again');
    assert.equal(await db.taskDependency.count({ where: { taskId: dependent } }), 1);
  });

  // ── 4 ────────────────────────────────────────────────────────────────────────────────────────
  await t.test("the owner's own answer adds exactly one field: the start", async () => {
    const sessionId = await sessionOf('a start-answer session');
    const proposed = taskBody('a task started from the card');
    await cardOf(sessionId, 'orbit_task_create', proposed, 'ALLOWED', ownerId, true);
    const started = ok(await create(sessionId, { ...proposed, runAt: new Date().toISOString() }), 'the start the owner chose');
    const row = await db.task.findUniqueOrThrow({ where: { id: toUuid(started.id) } });
    assert.ok(row.runAt instanceof Date, 'the due schedule is written');

    // Anything else it did not read is still refused.
    refused(await create(sessionId, { ...proposed, description: 'a field the card never carried' }), 'a body the card never read');
  });

  // ── 5 ────────────────────────────────────────────────────────────────────────────────────────
  await t.test('a card filed by another conversation is not this conversation\'s yes', async () => {
    const asker = await sessionOf('a session that asked');
    const writer = await sessionOf('a different session');
    const body = taskBody('a task from the wrong conversation');
    await cardOf(asker, 'orbit_task_create', body);
    refused(await create(writer, body), 'another session\'s card');
    assert.equal(await rows('a task from the wrong conversation'), 0);
  });

  // ── 6 ────────────────────────────────────────────────────────────────────────────────────────
  // The bypass this rule exists to close: the same machine credential, with the session header
  // taken off (or naming a session that cannot be acting), must not reach a write. `ORBIT_SESSION_ID`
  // is attribution, not authentication, so "no session" may be an agent that shed it.
  await t.test('the machine credential cannot write card-free: no session, a forged id, an ended session', async () => {
    const listId = await listOf('a machine-credential list');
    const dependent = await taskOf('a machine-credential node', { listId });
    const prerequisite = await taskOf('a machine-credential prerequisite');
    const ops = [{ op: 'add', taskId: b62(dependent), dependsOnTaskId: b62(prerequisite) }];
    const startAt = new Date(Date.now() + 60_000).toISOString();
    const items = [taskBody('a startNow item the credential tried to file', { runAt: startAt, autoRunWhenReady: true })];
    const cardsBefore = await cardsFiled();
    const sessionsBefore = await db.session.count({ where: { ownerId } });

    refusedForSession(await create(undefined, taskBody('a create with no session')), 'a create with no session');
    refusedForSession(await batch(undefined, items), 'a startNow batch with no session');
    refusedForSession(await dagApply(undefined, listId, ops), 'a DAG apply with no session');

    // A uuid that names no session at all, and one whose conversation has ended, are the same
    // answer: there is no acting agent behind them.
    const forged = randomUUID();
    refusedForSession(await create(forged, taskBody('a create under a forged session')), 'a create under a forged session');
    refusedForSession(await batch(forged, items), 'a startNow batch under a forged session');
    refusedForSession(await dagApply(forged, listId, ops), 'a DAG apply under a forged session');

    const ended = await sessionOf('an ended session');
    await db.session.update({ where: { id: ended }, data: { status: 'CANCELLED', completedAt: new Date() } });
    const endedBody = taskBody('a create under an ended session');
    await cardOf(ended, 'orbit_task_create', endedBody);
    refusedForSession(await create(ended, endedBody), 'a create under an ended session, even with a card of its own');
    const endedBatch = [taskBody('a startNow item under an ended session', { runAt: startAt, autoRunWhenReady: true })];
    await cardOf(ended, 'orbit_task_batch', { tasks: endedBatch, preview: {} });
    refusedForSession(await batch(ended, endedBatch), 'a startNow batch under an ended session, even with a card');

    // Nothing was written and nothing was started: no task, no edge, and no session for the
    // startNow rows that were never created.
    for (const title of [
      'a create with no session', 'a startNow item the credential tried to file',
      'a create under a forged session', 'a create under an ended session',
      'a startNow item under an ended session',
    ]) {
      assert.equal(await rows(title), 0, title);
    }
    assert.equal(await db.taskDependency.count({ where: { taskId: dependent } }), 0, 'no edge');
    // A row that was never written cannot have been started: this session count is the fixture's
    // own plus the one `sessionOf` made after the snapshot, and nothing else.
    assert.equal(await db.session.count({ where: { ownerId } }), sessionsBefore + 1, 'no run was started for the refused rows');
    assert.equal(await cardsFiled(), cardsBefore + 2, 'the refused calls filed no card; the two the fixture filed stand');
  });

  // ── 7 ────────────────────────────────────────────────────────────────────────────────────────
  // The deliberate exception, recorded in the contract: a PERSON's credential is the owner acting
  // for themselves, so there is no agent to card and no card to raise (`docs/orbit-agent-contract.md`
  // §4.5).
  await t.test('a personal access token writes as its owner, no card', async () => {
    const before = await cardsFiled();
    const pat = `orbit_pat_${randomBytes(32).toString('base64url')}`;
    await db.personalAccessToken.create({
      data: {
        ownerId,
        name: `task-write-${RUN}`,
        tokenHash: createHash('sha256').update(pat).digest('hex'),
        tokenHint: pat.slice(-4),
        scopes: ['tasks:read', 'tasks:write'],
        createdVia: 'CLI_DEVICE',
      },
    });
    const answer = await call(api!, 'POST', '/api/tasks', pat, taskBody('a task from a token'));
    const created = ok(answer, 'a token create');
    const row = await db.task.findUniqueOrThrow({ where: { id: toUuid(created.id) } });
    assert.equal(row.creatorType, 'USER');
    assert.equal(row.creatorId, ownerId);
    assert.equal(row.creatorSessionId, null);
    assert.equal(await cardsFiled(), before, 'a person\'s own act raises no card');
  });
});
