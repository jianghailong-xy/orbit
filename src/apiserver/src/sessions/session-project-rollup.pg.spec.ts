/**
 * The session list's project rollup — `projectId` / `projectTitle` / `role` /
 * `oldestPendingApprovalAt` on every row, and the per-project tallies behind a group header —
 * against a real PostgreSQL, through the service the API calls.
 *
 * Both queries are hand-written `$queryRaw`, where the row interface is the ONLY check on a column
 * name: rename `verifies_task_id` or `coordinator_session_id` and this code keeps compiling, keeps
 * running, and serves `undefined` under the old name — every worker silently becomes a `user`
 * session and the grouping quietly disappears. So what runs here is the production statement on the
 * real schema, not a copy of it; a copy would agree with itself forever.
 *
 * The worker session is dispatched through the real Project dispatcher rather than inserted,
 * because `PROJECT_COORDINATOR` is not a value a test may write: §7.7's trigger refuses any session
 * claiming that origin without an applied action to attribute it to. The role this list reports is
 * therefore read off a row production produced.
 *
 * Destructive: it truncates. It refuses to run anywhere but the disposable server the guard in
 * coordinator-pg-test-safety identifies.
 *
 *   docker run -d --name pcca2_rollup-pg -e POSTGRES_PASSWORD=pcca2_rollup \
 *     -e POSTGRES_USER=pcca2_rollup -e POSTGRES_DB=pcca2_rollup \
 *     -p 127.0.0.1:55623:5432 postgres:16-alpine
 *   DATABASE_URL=postgresql://pcca2_rollup:pcca2_rollup@127.0.0.1:55623/pcca2_rollup \
 *     node node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma
 *   COORDINATOR_PG_URL=... COORDINATOR_PG_EXPECTED_DATABASE=pcca2_rollup \
 *     COORDINATOR_PG_EXPECTED_USER=pcca2_rollup COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER=... \
 *     node --test --test-concurrency=1 build/sessions/session-project-rollup.pg.spec.js
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient, RunStatus, SessionDispatchOrigin } from '@prisma/client';
import {
  connectIsolatedPg,
  dispatch,
  emptyWorld,
  servicesOn,
  task,
  world,
} from '../projects/project-e2e-harness';

const URL = process.env.COORDINATOR_PG_URL;

/** Fixed instants: the list orders by them, and the inbox orders by the approval one. */
const T = (hhmm: string) => new Date(`2026-08-20T${hhmm}:00.000Z`);

/** A user's own session — the one origin a test may write directly (see §12.3 D3's carve-out). */
async function userSession(
  db: PrismaClient,
  target: { ownerId: string; agentId: string },
  title: string,
  over: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  await db.session.create({
    data: {
      id,
      ownerId: target.ownerId,
      creatorId: target.ownerId,
      workspaceId: target.agentId,
      title,
      prompt: 'p',
      dispatchOrigin: SessionDispatchOrigin.USER,
      ...over,
    } as never,
  });
  return id;
}

const suite = URL ? test : test.skip;

suite('session list project rollup, on real PostgreSQL', async (t) => {
  const client = await connectIsolatedPg(URL);
  // The dispatch pass stays unregistered: a registered one dispatches every ready task the moment
  // a lease is released, and this world's counts are exactly the sessions it seeds.
  const services = servicesOn(URL!, { registerDispatchPass: false });
  const db = services.db;
  t.after(async () => {
    await services.dispose();
    await client.end();
  });

  await emptyWorld(client);
  const w = await world(db, 'Rollup');
  const workTaskId = await task(db, w, 'ship it');
  // A verification is named by its task's subject — that link, not the project, is what decides it.
  const verifyTaskId = await task(db, w, 'check it', { verifiesTaskId: workTaskId });
  const doneTaskId = await task(db, w, 'already shipped');
  const trashedTaskId = await task(db, w, 'abandoned');

  // One real DISPATCH_TASK, through every gate a pass goes through. The row it writes is the only
  // kind of row that may carry PROJECT_COORDINATOR.
  const dispatched = await dispatch(services, w, workTaskId);
  assert.equal(dispatched.applyStatus, 'APPLIED', 'the worker session must come from a real dispatch');
  const workerSessionId = dispatched.sessionId!;
  // Mid-turn on a wake-up of its own: AWAITING_INPUT with the engine still producing. That is the
  // half of "generating" a status check alone gets wrong, and the row `running` has to count.
  await db.session.update({
    where: { id: workerSessionId },
    data: { status: RunStatus.AWAITING_INPUT, engineTurnActive: true, lastTurnAt: T('12:00') },
  });

  const coordinatorSessionId = await userSession(db, w, 'coordinator', {
    status: RunStatus.RUNNING, lastTurnAt: T('10:00'), pinnedAt: T('09:00'),
  });
  await db.project.update({
    where: { id: w.projectId },
    data: { coordinatorSessionId },
  });
  const verifierSessionId = await userSession(db, w, 'verifier', {
    taskId: verifyTaskId, status: RunStatus.SUCCEEDED, lastTurnAt: T('11:00'),
  });
  const completedSessionId = await userSession(db, w, 'completed', {
    taskId: doneTaskId, status: RunStatus.SUCCEEDED, lastTurnAt: T('07:00'), completedAt: T('07:30'),
  });
  const trashedSessionId = await userSession(db, w, 'trashed', {
    taskId: trashedTaskId, status: RunStatus.RUNNING, lastTurnAt: T('06:00'), deletedAt: T('06:30'),
  });
  const unfiledSessionId = await userSession(db, w, 'unfiled', {
    status: RunStatus.AWAITING_INPUT, lastTurnAt: T('13:00'),
  });
  // A second workspace, to prove the list's existing scope still scopes.
  const elsewhereWorkspaceId = randomUUID();
  await db.workspace.create({
    data: { id: elsewhereWorkspaceId, ownerId: w.ownerId, runnerId: w.runnerId, name: 'elsewhere', enabled: true },
  });
  const elsewhereSessionId = await userSession(
    db,
    { ownerId: w.ownerId, agentId: elsewhereWorkspaceId },
    'elsewhere',
    { status: RunStatus.RUNNING, lastTurnAt: T('14:00') },
  );

  // A second project, whose every session is waiting on the user — and which runs in the OTHER
  // workspace, because that is why these tallies cannot be derived from the per-workspace ones:
  // a project's conversations are wherever its coordinator and its workers happen to run. It also
  // gives the disjointness a witness: a header that counted a blocked session as running would
  // read the same as this one on a project with one of each.
  const waitingProjectId = randomUUID();
  await db.project.create({ data: { id: waitingProjectId, ownerId: w.ownerId, title: 'Waiting' } });
  const waitingSessionIds: string[] = [];
  for (const n of [1, 2]) {
    const taskId = randomUUID();
    await db.task.create({
      data: {
        id: taskId, ownerId: w.ownerId, projectId: waitingProjectId, title: `waiting ${n}`,
        creatorType: 'USER', creatorId: w.ownerId,
      },
    });
    waitingSessionIds.push(
      await userSession(db, { ownerId: w.ownerId, agentId: elsewhereWorkspaceId }, `waiting ${n}`, {
        taskId, status: RunStatus.RUNNING, lastTurnAt: T('05:00'),
      }),
    );
  }

  // Two live prompts on the coordinator (the oldest is what the inbox sorts by) and one already
  // answered on the worker, which must leave it with nothing waiting.
  await db.approval.createMany({
    data: [
      { sessionId: coordinatorSessionId, toolName: 'Bash', toolUseId: 'a', input: {}, status: 'PENDING', createdAt: T('09:00') },
      { sessionId: coordinatorSessionId, toolName: 'ExitPlanMode', toolUseId: 'b', input: {}, status: 'PENDING', createdAt: T('09:30') },
      { sessionId: workerSessionId, toolName: 'Bash', toolUseId: 'c', input: {}, status: 'ALLOWED', createdAt: T('08:00'), decidedAt: T('08:01') },
      ...waitingSessionIds.map((sessionId) => ({
        sessionId, toolName: 'Bash', toolUseId: 'd', input: {}, status: 'PENDING', createdAt: T('05:30'),
      })),
    ],
  });

  const open = async (): Promise<any[]> =>
    (await services.sessions.list(w.ownerId, { workspaceId: w.agentId, view: 'open' })) as any[];
  const rowFor = async (id: string) => (await open()).find((row) => row.id === id);

  await t.test('a session outside every project carries no project, and no role but its own', async () => {
    const row = await rowFor(unfiledSessionId);
    assert.ok(row, 'the unfiled session is missing from the Open list');
    assert.equal(row.projectId, null);
    assert.equal(row.projectTitle, null);
    assert.equal(row.oldestPendingApprovalAt, null);
    assert.equal(row.role, 'user');
  });

  await t.test('each role is read off the column that decides it', async () => {
    const rows = await open();
    const role = (id: string) => rows.find((r) => r.id === id)?.role;
    // Coordinating is what the session IS: it is named by the project, and it has no task at all.
    assert.equal(role(coordinatorSessionId), 'coordinator');
    // A verification is named by its task's subject...
    assert.equal(role(verifierSessionId), 'verification');
    // ...and a worker by the dispatch that started it.
    assert.equal(role(workerSessionId), 'execution');
    for (const id of [coordinatorSessionId, verifierSessionId, workerSessionId]) {
      const row = rows.find((r) => r.id === id);
      assert.equal(row.projectId, w.projectId, 'a project row lost its project');
      assert.equal(row.projectTitle, 'Rollup');
    }
  });

  await t.test('a blocked row says how long it has been waiting, not just that it is', async () => {
    const coordinator = await rowFor(coordinatorSessionId);
    assert.equal(coordinator.pendingApprovals, 2);
    // The OLDEST of the live prompts — 09:00, not the 09:30 one — because the inbox orders by how
    // long the user has been kept waiting.
    assert.deepEqual(coordinator.oldestPendingApprovalAt, T('09:00'));
    // An answered approval is not waiting on anybody.
    const worker = await rowFor(workerSessionId);
    assert.equal(worker.pendingApprovals, 0);
    assert.equal(worker.oldestPendingApprovalAt, null);
  });

  await t.test('the per-project tallies are the four numbers a group header states', async () => {
    const counts = await services.sessions.projectSessionCounts(w.ownerId);
    assert.equal(counts.length, 2, 'one row per project that has sessions, and no others');
    assert.deepEqual(counts.find((c) => c.projectId === w.projectId), {
      projectId: w.projectId,
      // The coordinator: generating, with a live prompt on it.
      needsYou: 1,
      // The worker: generating, nothing waiting on the user. Disjoint from needsYou, because
      // "1 needs you · 2 running" out of three sessions is a header that does not add up.
      running: 1,
      // Finished successfully, and filed as completed.
      done: 2,
      // Five sessions belong to this project; the trashed one is in no bucket, because it is in
      // no list.
      total: 4,
    });
    // And the project where everything is blocked has nothing running: a session waiting on a
    // human is generating too, and counting it twice is what makes a header lie.
    assert.deepEqual(counts.find((c) => c.projectId === waitingProjectId), {
      projectId: waitingProjectId, needsYou: 2, running: 0, done: 0, total: 2,
    });
  });

  await t.test('the list this widened still answers exactly as it did', async () => {
    const rows = await open();
    // Same rows, same order: pinned first, then by last activity. Two LEFT JOINs on
    // at-most-one-row keys cannot multiply a list — and an INNER one would have deleted the
    // project-less half of it.
    assert.deepEqual(
      rows.map((r) => r.id),
      [coordinatorSessionId, unfiledSessionId, workerSessionId, verifierSessionId],
    );
    // The workspace scope still scopes, and neither the completed nor the trashed row leaked in.
    assert.ok(!rows.some((r) => r.id === elsewhereSessionId));
    assert.ok(!rows.some((r) => r.id === completedSessionId || r.id === trashedSessionId));
    // Completed still holds the one row it held, and still orders by when it was completed.
    const completed = (await services.sessions.list(w.ownerId, {
      workspaceId: w.agentId,
      view: 'completed',
    })) as any[];
    assert.deepEqual(completed.map((r) => r.id), [completedSessionId]);
    // And a row still carries everything it carried before the rollup was added.
    const worker = rows.find((r) => r.id === workerSessionId);
    assert.equal(worker.taskId, workTaskId);
    assert.equal(worker.taskTitle, 'ship it');
    assert.equal(worker.workspace.name, 'Rollup-agent');
    assert.equal(worker.status, RunStatus.AWAITING_INPUT);
  });
});
