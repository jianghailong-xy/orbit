/**
 * The Project and Task refusal wire contract (contracts/project-task-refusals.contract.json), held
 * against the production apiserver — `build/main.js`, the whole AppModule and its exception filters —
 * over a real PostgreSQL that `scripts/run-pg-spec.sh` migrates from empty:
 *
 *   bash scripts/run-pg-spec.sh src/apiserver/src/common/refusal-recovery.pg.spec.ts
 *
 *   (1) each refusal this spec can reach through a door is served with its code, the public ids it is
 *       about, and the recovery block its contract entry states, and reads back through the client
 *       parser as that decision: a stale revision re-reads the project, a dependency refusal reads the
 *       graph, a non-empty delete waits for the owner's confirmation, a retired task stops, a
 *       prerequisite is a wait, a missing assignee is the caller's to fix;
 *   (2) a plan a coordinator files through the runner door is judged whole before anything is
 *       written: every refusing finding, the warnings, a summary, a stable code and one top-level
 *       recovery come back in one answer, each finding with its own block and its project. The
 *       account owner's own writes are outside preflight (§4 R1), so this is the door it guards;
 *   (3) the security boundary: another account's ids, ids that name nothing, and no credential at all
 *       are answered byte for byte alike, with no recovery block and no id of the other account's in
 *       them — so a recovery block never says that something of someone else's exists.
 *
 * Not destructive: every row belongs to a user this run creates.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';

import { parseRecovery, uuidToBase62 } from '@orbit/shared';
import { Client } from 'pg';

import { generateToken, hashPassword, sha256 } from './crypto.util';
import { prismaClientFor } from '../prisma/prisma-client';
import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from '../projects/coordinator-pg-test-safety';
import { call, startApiserver, type Apiserver, type Reply } from '../auth/pat-test-apiserver';
import { DISPOSITION_SEVERITY, REFUSAL_RECOVERY, planFindingRecovery } from './refusal-recovery';

const URL_ = process.env.COORDINATOR_PG_URL;
const RUN = randomUUID().slice(0, 8);

/** The served body agrees with the contract entry for its code, and the client reads it the same. */
function assertServedAsContracted(reply: Reply, status: number, code: string, resources: Array<{ type: string; id: string }>): void {
  assert.equal(reply.status, status, reply.text);
  assert.equal(reply.json?.code, code, reply.text);
  const entry = REFUSAL_RECOVERY.find((e) => e.code === code)!;
  assert.ok(entry, code);
  assert.equal(entry.status, status, `${code}: the contract names ${entry.status}`);
  const { resources: served, ...stated } = reply.json.recovery;
  assert.deepEqual(stated, entry.recovery, `${code}: ${reply.text}`);
  assert.deepEqual(served, resources, code);
  const env = parseRecovery({ source: 'HTTP', status: reply.status, body: reply.text })!;
  assert.equal(env.disposition, entry.recovery.disposition, code);
  assert.equal(env.actionCode, entry.recovery.actionCode, code);
  assert.equal(env.retry.policy, entry.recovery.retryPolicy, code);
}

test('Project and Task refusals carry their contracted recovery, and leak nothing across accounts', {
  skip: !URL_, concurrency: 1, timeout: 600_000,
}, async (t) => {
  const url = URL_!;
  assertCoordinatorPgUrlIsIsolated(url);
  const sql = new Client({ connectionString: url, connectionTimeoutMillis: 5_000 });
  await sql.connect();
  let server: Apiserver | undefined;
  const db = prismaClientFor(url);
  t.after(async () => {
    await server?.stop();
    await db.$disconnect().catch(() => undefined);
    await sql.end().catch(() => undefined);
  });
  await verifyCoordinatorPgIdentity(sql);

  server = await startApiserver(url, `refusal-recovery-${randomUUID()}`);
  const api = (method: string, route: string, bearer?: string, body?: unknown) => call(server!, method, route, bearer, body);

  const signedIn = async (name: string): Promise<string> => {
    const email = `${name}-${RUN}@refusal-recovery.invalid`;
    const password = `pw-${name}-${RUN}`;
    await sql.query(`INSERT INTO "user" (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, 'MEMBER')`,
      [randomUUID(), email, `Refusal ${name}`, hashPassword(password)]);
    const reply = await api('POST', '/api/auth/login', undefined, { email, password });
    assert.equal(reply.status, 201, reply.text);
    return reply.json.accessToken as string;
  };
  const a = await signedIn('a');
  const b = await signedIn('b');

  const project = async (who: string, title: string): Promise<{ id: string; configRevision: string }> => {
    const reply = await api('POST', '/api/projects', who, { title });
    assert.equal(reply.status, 201, reply.text);
    return { id: reply.json.publicId ?? reply.json.id, configRevision: String(reply.json.configRevision ?? '0') };
  };
  const task = async (who: string, title: string, projectId?: string): Promise<string> => {
    const reply = await api('POST', '/api/tasks', who, {
      title,
      ...(projectId ? { projectId } : {}),
      completionCriterion: 'EXECUTABLE',
      acceptanceCommand: 'true',
      acceptanceExpectedExitCode: 0,
    });
    assert.equal(reply.status, 201, reply.text);
    return (reply.json.publicId ?? reply.json.id) as string;
  };

  const pa = await project(a, `A ${RUN}`);
  const t1 = await task(a, 'first', pa.id);
  const t2 = await task(a, 'second', pa.id);
  const t3 = await task(a, 'third', pa.id);
  const t4 = await task(a, 'fourth', pa.id);
  const bTask = await task(b, 'b own');
  const nothing = uuidToBase62(randomUUID());

  await t.test('(1) STALE_CONFIG_REVISION names the project to re-read before deciding again', async () => {
    const reply = await api('PATCH', `/api/projects/${pa.id}`, a, { title: 'renamed', expectedConfigRevision: '987654' });
    assertServedAsContracted(reply, 409, 'STALE_CONFIG_REVISION', [{ type: 'PROJECT', id: pa.id }]);
    assert.equal(reply.json.recovery.actionCode, 'REREAD_AND_DECIDE');
  });

  await t.test('(1) dependency self, duplicate and cycle: the graph is read before anything is recomputed', async () => {
    const add = (from: string, to: string, who = a) => api('POST', `/api/tasks/${from}/dependencies`, who, { dependsOnTaskId: to });
    assert.equal((await add(t1, t2)).status, 201);
    assertServedAsContracted(await add(t1, t1), 400, 'DEPENDENCY_SELF', [{ type: 'TASK', id: t1 }]);
    assertServedAsContracted(await add(t1, t2), 409, 'DEPENDENCY_DUPLICATE', [{ type: 'TASK', id: t1 }, { type: 'TASK', id: t2 }]);
    assertServedAsContracted(await add(t2, t1), 400, 'DEPENDENCY_CYCLE', [{ type: 'TASK', id: t2 }, { type: 'TASK', id: t1 }]);
    assert.equal(parseRecovery({ source: 'HTTP', status: 400, body: (await add(t2, t1)).text })!.disposition, 'AUTOMATIC');
  });

  await t.test('(1) starting: a prerequisite is a wait, no assignee is the caller\'s, a retired task stops', async () => {
    const start = (id: string, who = a) => api('POST', `/api/tasks/${id}/execute`, who, {});
    assertServedAsContracted(await start(t1), 400, 'TASK_PREREQUISITES_INCOMPLETE', [{ type: 'TASK', id: t1 }]);
    assertServedAsContracted(await start(t2), 400, 'TASK_NO_ASSIGNEE', [{ type: 'TASK', id: t2 }]);
    const retire = await api('PATCH', `/api/tasks/${t3}`, a, { status: 'CANCELLED', supersededByTaskId: t4 });
    assert.equal(retire.status, 200, retire.text);
    assertServedAsContracted(await start(t3), 409, 'TASK_RETIRED', [{ type: 'TASK', id: t4 }, { type: 'TASK', id: t3 }]);
  });

  await t.test('(1) a project that still holds tasks is not deleted until the owner confirms what happens to them', async () => {
    const reply = await api('DELETE', `/api/projects/${pa.id}`, a);
    assertServedAsContracted(reply, 409, 'PROJECT_NOT_EMPTY', [{ type: 'PROJECT', id: pa.id }]);
    assert.equal(reply.json.taskCount, 4);
    assert.equal(parseRecovery({ source: 'HTTP', status: 409, body: reply.text })!.userConfirmation, 'REQUIRED');
    const still = await sql.query(`SELECT count(*)::int AS n FROM task WHERE project_id = (SELECT id FROM project WHERE title = $1)`, [`A ${RUN}`]);
    assert.equal(still.rows[0].n, 4, 'nothing was detached or deleted');
  });

  await t.test('(2) a coordinator\'s refused plan answers every finding, its warnings and a summary, in one body', async () => {
    // A's machine, an agent on it, and a conversation that coordinates project B — the scope a
    // coordinator files a plan from. The owner's own plans are not preflighted (§4 R1).
    const ownerId = (await sql.query(`SELECT id FROM "user" WHERE email = $1`, [`a-${RUN}@refusal-recovery.invalid`])).rows[0].id as string;
    const runnerToken = generateToken(32);
    const runnerId = randomUUID();
    await sql.query(`INSERT INTO runner (id, owner_id, name, token_hash) VALUES ($1, $2, $3, $4)`,
      [runnerId, ownerId, `refusal-${RUN}`, sha256(runnerToken)]);
    const workspaceId = randomUUID();
    await db.workspace.create({ data: { id: workspaceId, ownerId, runnerId, name: `refusal agent ${RUN}`, enabled: true } });
    const coordinatorId = randomUUID();
    await db.session.create({
      data: {
        id: coordinatorId, title: 'coordinator', prompt: 'coordinator', ownerId, creatorId: ownerId, workspaceId,
        assignedRunnerId: runnerId, turnState: null, startedAt: new Date(), runtimeSessionId: `runtime-${coordinatorId}`,
      },
    });
    const pb = await project(a, `B ${RUN}`);
    // A budget that admits nothing: refused at the API's door, so written the way a restored backup
    // would leave it. Its finding is the owner's to clear; the edge onto A's project is a crossing
    // nobody asked for. Two findings of two kinds, both in one answer.
    await sql.query(`UPDATE project SET session_budget_per_day = 0, coordinator_session_id = $2 WHERE title = $1`,
      [`B ${RUN}`, coordinatorId]);
    const item = (title: string, extra: Record<string, unknown> = {}) => ({
      title, projectId: pb.id, completionCriterion: 'EXECUTABLE', acceptanceCommand: 'true', acceptanceExpectedExitCode: 0,
      autoRunWhenReady: false, ...extra,
    });
    const before = await sql.query(`SELECT count(*)::int AS n FROM task WHERE owner_id = $1`, [ownerId]);
    const plan = { tasks: [item('plan one'), item('plan two', { dependsOnTaskIds: [t2] })] };
    // The runner door is carded by caller (task-write-approval.ts): the coordinator's plan reaches
    // preflight only under the owner's answered card for this exact batch.
    await db.approval.create({
      data: { sessionId: coordinatorId, toolName: 'orbit_task_batch', input: plan as never, status: 'ALLOWED', decidedById: ownerId, decidedAt: new Date() },
    });
    const reply = await call(server!, 'POST', '/api/runner/tasks/batch-create', runnerToken, plan, { 'x-orbit-session-id': coordinatorId });

    assert.equal(reply.status, 400, reply.text);
    assert.equal(reply.json.code, 'PLAN_PREFLIGHT_FAILED', reply.text);
    assert.equal(reply.json.written, 0);
    const findings = reply.json.findings as Array<{ index: number; code: string; requiredAction: string; severity: string;
      recovery: Record<string, unknown> & { disposition: string; userConfirmation: string; resources: unknown[] } }>;
    const codes = findings.map((f) => f.code);
    assert.ok(codes.includes('PLAN_BUDGET_ADMITS_NOTHING'), reply.text);
    assert.ok(findings.length >= 2, `every refusal in one answer: ${reply.text}`);
    assert.ok(findings.some((f) => f.index === 1 && f.code !== 'PLAN_BUDGET_ADMITS_NOTHING'),
      `the crossing edge is a finding of its own: ${reply.text}`);
    for (const f of findings) {
      assert.equal(f.severity, 'REFUSE');
      // Each finding's block is its contract entry, and names the project its item lands in.
      const { resources, ...stated } = f.recovery;
      assert.deepEqual(stated, planFindingRecovery(f.code, f.requiredAction), f.code);
      assert.deepEqual(resources, [{ type: 'PROJECT', id: pb.id }], f.code);
    }
    // The whole plan: counted, warned about, and as stuck as its stuckest finding.
    assert.ok(Array.isArray(reply.json.warnings));
    const byDisposition: Record<string, number> = {};
    const byCode: Record<string, number> = {};
    for (const f of findings) {
      byDisposition[f.recovery.disposition] = (byDisposition[f.recovery.disposition] ?? 0) + 1;
      byCode[f.code] = (byCode[f.code] ?? 0) + 1;
    }
    assert.deepEqual(reply.json.summary, { refusing: findings.length, warnings: reply.json.warnings.length, byDisposition, byCode });
    const top = reply.json.recovery;
    const worst = DISPOSITION_SEVERITY.find((d) => byDisposition[d])!;
    assert.equal(top.disposition, worst);
    assert.equal(top.actionCode, 'FIX_REQUEST');
    assert.equal(top.effect, 'NONE');
    assert.equal(top.retryPolicy, 'NEVER');
    assert.equal(top.userConfirmation, worst === 'CONFIRM_THEN_RUN' ? 'REQUIRED' : 'NOT_REQUIRED', 'the confirmation boundary');
    assert.deepEqual(top.resources, [{ type: 'PROJECT', id: pb.id }]);
    // The client reads the same decision from the served body.
    const env = parseRecovery({ source: 'HTTP', status: 400, body: reply.text })!;
    assert.equal(env.code, 'PLAN_PREFLIGHT_FAILED');
    assert.equal(env.disposition, worst);
    assert.equal(env.actionCode, 'FIX_REQUEST');
    assert.deepEqual(env.resources, [{ type: 'PROJECT', id: pb.id }]);
    // Nothing of the plan was written.
    const after = await sql.query(`SELECT count(*)::int AS n FROM task WHERE owner_id = $1`, [ownerId]);
    assert.equal(after.rows[0].n, before.rows[0].n, 'nothing of the plan was written');
  });

  await t.test('(3) another account\'s ids are answered as ids that name nothing, and carry no recovery', async () => {
    const same = async (method: string, theirs: string, none: string, body?: unknown, who: string | undefined = b) => {
      const mine = await api(method, theirs, who, body);
      const blank = await api(method, none, who, body);
      assert.equal(mine.status, blank.status, `${method} ${theirs}: ${mine.text} vs ${blank.text}`);
      assert.equal(mine.text, blank.text, `${method} ${theirs}`);
      assert.ok(mine.status === 401 || mine.status === 404, `${method} ${theirs} -> ${mine.status} ${mine.text}`);
      assert.equal(mine.json?.recovery, undefined, `${method} ${theirs} names a recovery`);
      for (const id of [pa.id, t1, t2, t3, t4]) assert.ok(!mine.text.includes(id), `${method} ${theirs} names ${id}`);
    };
    // B on A's project and tasks, with a stale revision, a non-empty delete, a cycle and a start.
    await same('PATCH', `/api/projects/${pa.id}`, `/api/projects/${nothing}`, { title: 'x', expectedConfigRevision: '987654' });
    await same('DELETE', `/api/projects/${pa.id}`, `/api/projects/${nothing}`);
    await same('POST', `/api/tasks/${t2}/dependencies`, `/api/tasks/${nothing}/dependencies`, { dependsOnTaskId: t1 });
    await same('POST', `/api/tasks/${bTask}/dependencies`, `/api/tasks/${bTask}/dependencies`, { dependsOnTaskId: t1 });
    const intoNothing = await api('POST', `/api/tasks/${bTask}/dependencies`, b, { dependsOnTaskId: nothing });
    const intoA = await api('POST', `/api/tasks/${bTask}/dependencies`, b, { dependsOnTaskId: t1 });
    assert.equal(intoA.text, intoNothing.text, 'B\'s own task onto A\'s reads as onto nothing');
    await same('POST', `/api/tasks/${t1}/execute`, `/api/tasks/${nothing}/execute`, {});
    // And with no credential at all.
    await same('DELETE', `/api/projects/${pa.id}`, `/api/projects/${nothing}`, undefined, undefined);
    await same('POST', `/api/tasks/${t2}/dependencies`, `/api/tasks/${nothing}/dependencies`, { dependsOnTaskId: t1 }, undefined);
    // A's rows are as they were.
    const edges = await sql.query(
      `SELECT count(*)::int AS n FROM task_dependency d JOIN task x ON x.id = d.task_id JOIN project p ON p.id = x.project_id WHERE p.title = $1`,
      [`A ${RUN}`],
    );
    assert.equal(edges.rows[0].n, 1, 'only A\'s own edge');
  });
});
