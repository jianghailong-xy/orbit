import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after } from 'node:test';

const require = createRequire(import.meta.url);
const repo = path.resolve(import.meta.dirname, '..');
const apiDist = path.join(repo, 'src/apiserver/dist');
const url = process.env.EXECUTABLE_ACCEPTANCE_PG_URL;
const evidencePath = process.env.EXECUTABLE_ACCEPTANCE_EVIDENCE_PATH;
const sourceSha = process.env.EXECUTABLE_ACCEPTANCE_SOURCE_SHA;
assert.ok(url, 'EXECUTABLE_ACCEPTANCE_PG_URL is required');
assert.ok(evidencePath, 'EXECUTABLE_ACCEPTANCE_EVIDENCE_PATH is required');
assert.match(sourceSha ?? '', /^[0-9a-f]{40}$/);

const { Pool } = require('pg');
const { prismaClientFor } = require(path.join(apiDist, 'prisma/prisma-client.js'));
const { TasksService } = require(path.join(apiDist, 'tasks/tasks.service.js'));
const { ProjectsService } = require(path.join(apiDist, 'projects/projects.service.js'));
const { RunnerApiController } = require(path.join(apiDist, 'runner-api/runner-api.controller.js'));
const { OutcomeWatchdogService } = require(path.join(
  apiDist, 'outcome-watchdog/outcome-watchdog.service.js',
));
const runtime = require(path.join(apiDist, 'tasks/executable-acceptance-runtime.js'));
const { RunStatus, RunnerStatus, SessionDispatchOrigin, TaskStatus } = require(path.join(
  repo, 'src/apiserver/node_modules/@prisma/client',
));

const db = prismaClientFor(url);
const pool = new Pool({ connectionString: url, max: 8 });
const evidence = {
  schemaVersion: 1,
  suite: 'executable-acceptance-runtime-v2',
  sourceSha,
  negotiation: {},
  typedTerminations: [],
  supersessionSurfaces: {},
  watchdog: {},
  legacy: {},
  compatibility: {},
};

after(async () => {
  await db.$disconnect();
  await pool.end();
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
});

function sha(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

async function empty() {
  await pool.query(`
    TRUNCATE executable_dead_man_event, executable_runtime_heartbeat, task, session, workspace,
             runner, project, "user" RESTART IDENTITY CASCADE
  `);
}

function realtime() {
  return {
    publishSessionUpdated() {}, publishTaskChanged() {}, publishQueuedTurnsChanged() {},
    publish() {}, publishForUser() {}, notifyInbox() {}, waitForInbox: async () => undefined,
  };
}

function tasks(sessions = {}) {
  return new TasksService(db, sessions, realtime());
}

function controller() {
  return new RunnerApiController(
    db,
    { notifySessionQueued() {} },
    realtime(),
    {}, {}, {},
    { appendFor: async (_tx, _sessionId, content) => content },
  );
}

async function foundation(label, withProject = false) {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  await db.user.create({
    data: { id: ownerId, email: `${label}-${ownerId}@acceptance.invalid`, name: label, passwordHash: 'x' },
  });
  await db.runner.create({
    data: { id: runnerId, ownerId, name: `${label}-runner`, tokenHash: 'x', status: RunnerStatus.ONLINE },
  });
  await db.workspace.create({
    data: { id: workspaceId, ownerId, runnerId, name: `${label}-workspace`, enabled: true },
  });
  let projectId = null;
  if (withProject) {
    projectId = randomUUID();
    await db.project.create({ data: { id: projectId, ownerId, title: `${label}-project` } });
    await db.projectRuntime.upsert({ where: { projectId }, create: { projectId }, update: {} });
  }
  return { ownerId, runnerId, workspaceId, projectId };
}

async function executableFixture(label, options = {}) {
  const base = await foundation(label);
  const task = await tasks().create(base.ownerId, {
    title: label,
    assigneeId: base.workspaceId,
    completionCriterion: 'EXECUTABLE',
    acceptanceCriteria: 'The declared shell command exits with the expected code.',
    acceptanceCommand: options.command ?? 'true',
    acceptanceExpectedExitCode: options.expectedExitCode ?? 0,
    ...(options.legacy ? {} : {
      acceptanceTimeoutSeconds: options.timeoutSeconds ?? 1200,
      acceptanceOwnerTimeoutCeilingSeconds: options.ownerCeilingSeconds
        ?? options.timeoutSeconds ?? 1200,
    }),
  });
  const sessionId = randomUUID();
  const messageTurnId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId, ownerId: base.ownerId, creatorId: base.ownerId, taskId: task.id,
      workspaceId: base.workspaceId, assignedRunnerId: base.runnerId, title: label, prompt: label,
      provider: 'claude', status: RunStatus.RUNNING,
      dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
    },
  });
  await db.conversationTurn.create({
    data: {
      id: messageTurnId, sessionId, seq: 1, clientTurnId: `message:${messageTurnId}`,
      kind: 'message', content: 'finish work', status: 'IN_FLIGHT',
    },
  });
  return { ...base, taskId: task.id, sessionId, messageTurnId };
}

async function queueAcceptance(api, fixture) {
  await api.turnComplete({ id: fixture.runnerId }, fixture.sessionId, {
    turnId: fixture.messageTurnId, status: RunStatus.SUCCEEDED,
  });
}

async function dequeue(api, fixture, hardMaxSeconds, capabilityRevision = 2) {
  return api.dequeueTurn(
    fixture.sessionId, fixture.runnerId, null, false, [], hardMaxSeconds == null ? null : {
      schemaRevision: 2, capabilityRevision, hardMaxSeconds, runnerSha: sourceSha,
    },
  );
}

async function admitAndStart(label, options = {}) {
  const fixture = await executableFixture(label, options);
  const api = controller();
  await queueAcceptance(api, fixture);
  const delivery = await dequeue(api, fixture, options.hardMaxSeconds ?? 3600);
  assert.ok(delivery?.acceptancePlan, `${label} was not admitted`);
  const started = await api.startExecutableAcceptanceAttempt(
    { id: fixture.runnerId }, fixture.sessionId, delivery.acceptancePlan.admissionId,
  );
  return { fixture, api, delivery, started };
}

async function forceStatus(taskId, status) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query('UPDATE task SET status = $2::task_status WHERE id = $1', [taskId, status]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

test('virtual negotiation rejects hardMax=120 before spawn and admits hardMax=1200 exactly', () => {
  const plan = runtime.executableEvaluationPlan({
    command: 'npm run test:outcome-reconciler:watchdog', expectedExitCode: 0,
    requestedTimeoutSeconds: 1200, ownerTimeoutCeilingSeconds: 1200,
    policyTimeoutCeilingSeconds: 3600,
  });
  const clock = new Date('2026-08-28T12:00:00.000Z');
  const rejected = runtime.negotiateExecutableAcceptance(plan, {
    schemaRevision: 2, capabilityRevision: 2, hardMaxSeconds: 120, runnerSha: sourceSha,
  }, clock);
  assert.deepEqual(
    [rejected.decision, rejected.rejectionCode, rejected.spawnCount, rejected.effectiveTimeoutSeconds],
    ['REJECTED', 'RUNNER_HARD_MAX_INSUFFICIENT', 0, null],
  );
  const admitted = runtime.negotiateExecutableAcceptance(plan, {
    schemaRevision: 2, capabilityRevision: 2, hardMaxSeconds: 1200, runnerSha: sourceSha,
  }, clock);
  assert.equal(admitted.decision, 'ADMITTED');
  assert.equal(admitted.effectiveTimeoutSeconds, 1200);
  assert.equal(admitted.effectiveDeadline.toISOString(), '2026-08-28T12:20:00.000Z');
  evidence.negotiation = { rejected, admitted, planDigest: plan.evaluationPlanDigest };
});

test('owner and policy ceilings reject before admission and every plan field is digest-bound', () => {
  const clock = new Date('2026-08-28T12:00:00.000Z');
  const runner = {
    schemaRevision: 2, capabilityRevision: 2, hardMaxSeconds: 3600, runnerSha: sourceSha,
  };
  const ownerLimited = runtime.executableEvaluationPlan({
    command: 'true', expectedExitCode: 0, requestedTimeoutSeconds: 1200,
    ownerTimeoutCeilingSeconds: 1199, policyTimeoutCeilingSeconds: 3600,
  });
  const policyLimited = runtime.executableEvaluationPlan({
    command: 'true', expectedExitCode: 0, requestedTimeoutSeconds: 1200,
    ownerTimeoutCeilingSeconds: 1200, policyTimeoutCeilingSeconds: 1199,
  });
  for (const [plan, code] of [
    [ownerLimited, 'OWNER_CEILING_INSUFFICIENT'],
    [policyLimited, 'POLICY_CEILING_INSUFFICIENT'],
  ]) {
    const decision = runtime.negotiateExecutableAcceptance(plan, runner, clock);
    assert.deepEqual(
      [decision.decision, decision.rejectionCode, decision.spawnCount,
        decision.effectiveTimeoutSeconds, decision.effectiveDeadline],
      ['REJECTED', code, 0, null, null],
    );
  }
  const changedCommand = { ...ownerLimited, command: 'false' };
  assert.match(runtime.executableAcceptancePlanError(changedCommand), /commandDigest/);
  const changedExpectedExit = { ...ownerLimited, expectedExitCode: 9 };
  assert.match(runtime.executableAcceptancePlanError(changedExpectedExit), /evaluationPlanDigest/);
  Object.assign(evidence.negotiation, {
    ownerCeilingRejected: true, policyCeilingRejected: true, commandAndPlanDigestBound: true,
  });
});

test('only EXITED has a criterion result; all five non-exit kinds remain actionable', () => {
  for (const kind of runtime.ATTEMPT_TERMINATION_KINDS) {
    const result = runtime.evaluateExecutableAttempt({
      terminationKind: kind, expectedExitCode: 0, actualExitCode: kind === 'EXITED' ? 9 : null,
    });
    assert.equal(result.state, kind === 'EXITED' ? 'UNSATISFIED' : 'ACTIONABLE');
    assert.equal(result.goalActionable, true);
    evidence.typedTerminations.push({ kind, state: result.state });
  }
  assert.deepEqual(runtime.evaluateExecutableAttempt({
    terminationKind: 'EXITED', expectedExitCode: 0, actualExitCode: 0,
  }), { state: 'SATISFIED', goalActionable: false });
});

test('real API rejects an insufficient current poller without an attempt or budget spend', async () => {
  await empty();
  const fixture = await executableFixture('api-rejected');
  const api = controller();
  await queueAcceptance(api, fixture);
  assert.equal(await dequeue(api, fixture, 120), null);
  const admission = await db.taskExecutableAdmission.findFirstOrThrow({ where: { taskId: fixture.taskId } });
  const task = await db.task.findUniqueOrThrow({ where: { id: fixture.taskId } });
  assert.equal(admission.decision, 'REJECTED');
  assert.equal(admission.rejectionCode, 'RUNNER_HARD_MAX_INSUFFICIENT');
  assert.equal(admission.spawnCount, 0);
  assert.equal(task.executionAttemptCount, 0);
  assert.equal(await db.taskExecutableAttempt.count(), 0);
  await assert.rejects(
    api.startExecutableAcceptanceAttempt({ id: fixture.runnerId }, fixture.sessionId, admission.id),
    /rejected executable acceptance decision cannot start/i,
  );
});

test('real API admission is exact and the idempotent start boundary spends one attempt', async () => {
  await empty();
  const { fixture, api, delivery, started } = await admitAndStart('api-admitted');
  const repeated = await api.startExecutableAcceptanceAttempt(
    { id: fixture.runnerId }, fixture.sessionId, delivery.acceptancePlan.admissionId,
  );
  assert.equal(repeated.attemptId, started.attemptId);
  const [admission, task] = await Promise.all([
    db.taskExecutableAdmission.findUniqueOrThrow({ where: { id: delivery.acceptancePlan.admissionId } }),
    db.task.findUniqueOrThrow({ where: { id: fixture.taskId } }),
  ]);
  assert.equal(admission.decision, 'ADMITTED');
  assert.equal(admission.effectiveTimeoutSeconds, admission.requestedTimeoutSeconds);
  assert.equal(admission.spawnCount, 1);
  assert.equal(task.executionAttemptCount, 1);
  assert.equal(await db.taskExecutableAttempt.count(), 1);
});

test('typed timeout/cancel/signal/start-failure/infrastructure-loss keep real tasks actionable', async () => {
  await empty();
  for (const kind of ['TIMED_OUT', 'CANCELLED', 'SIGNALED', 'START_FAILED', 'INFRASTRUCTURE_LOST']) {
    const { fixture, api, delivery, started } = await admitAndStart(`typed-${kind.toLowerCase()}`);
    await api.turnComplete({ id: fixture.runnerId }, fixture.sessionId, {
      turnId: delivery.turnId, status: RunStatus.SUCCEEDED, subtype: 'shell', shellOutput: kind,
      acceptanceAdmissionId: delivery.acceptancePlan.admissionId,
      acceptanceAttemptId: started.attemptId, acceptanceTerminationKind: kind,
      ...(kind === 'SIGNALED' ? { acceptanceSignal: 'SIGTERM' } : {}),
    });
    const [task, attempt, continuation] = await Promise.all([
      db.task.findUniqueOrThrow({ where: { id: fixture.taskId } }),
      db.taskExecutableAttempt.findUniqueOrThrow({ where: { id: started.attemptId } }),
      db.taskExecutableContinuation.findUniqueOrThrow({ where: { attemptId: started.attemptId } }),
    ]);
    assert.equal(task.status, TaskStatus.OPEN, `${kind} concluded the goal`);
    assert.equal(attempt.terminationKind, kind);
    assert.equal(attempt.actualExitCode, null);
    assert.equal(continuation.goalActionable, true);
    assert.ok(['RETRY', 'DIAGNOSIS', 'SUCCESSOR'].includes(continuation.kind));
  }
});

test('typed EXITED alone derives DONE or FAILED from the expected code', async () => {
  await empty();
  for (const [actualExitCode, expectedStatus] of [[0, TaskStatus.DONE], [9, TaskStatus.FAILED]]) {
    const { fixture, api, delivery, started } = await admitAndStart(`exited-${actualExitCode}`);
    await api.turnComplete({ id: fixture.runnerId }, fixture.sessionId, {
      turnId: delivery.turnId, status: RunStatus.SUCCEEDED, subtype: 'shell', shellOutput: 'output',
      acceptanceAdmissionId: delivery.acceptancePlan.admissionId,
      acceptanceAttemptId: started.attemptId, acceptanceTerminationKind: 'EXITED',
      acceptanceActualExitCode: actualExitCode,
    });
    assert.equal(
      (await db.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).status,
      expectedStatus,
    );
  }
});

test('N-1 omission stays on v1 and legacy -1 cannot conclude the task', async () => {
  await empty();
  const fixture = await executableFixture('n-minus-one', { legacy: true });
  const api = controller();
  await queueAcceptance(api, fixture);
  const delivery = await dequeue(api, fixture, null);
  assert.equal(delivery.taskAcceptance, true);
  assert.equal(delivery.acceptancePlan, undefined);
  await api.turnComplete({ id: fixture.runnerId }, fixture.sessionId, {
    turnId: delivery.turnId, status: RunStatus.SUCCEEDED, subtype: 'shell',
    shellExitCode: -1, shellOutput: 'legacy outer deadline',
  });
  assert.equal((await db.task.findUniqueOrThrow({ where: { id: fixture.taskId } })).status, TaskStatus.OPEN);
  evidence.compatibility = { nMinusOnePlan: 'v1', legacyMinusOneActionable: true };
});

test('legacy bootstrap import preserves UNTYPED/-1 and appends only an evidence diagnosis', async () => {
  await empty();
  const base = await foundation('legacy-bootstrap');
  const taskId = '01a04672-4b57-7267-9f0c-24ac4e0ab282';
  const sessionId = '01d2bdbf-f122-5b50-8f2c-02112709dcba';
  const turnId = '01a047fe-d899-711f-a3b7-53a3269f0c12';
  await db.task.create({ data: {
    id: taskId, ownerId: base.ownerId, creatorType: 'USER', creatorId: base.ownerId,
    title: 'legacy watchdog', assigneeId: base.workspaceId, status: TaskStatus.FAILED,
    completionCriterion: 'EXECUTABLE', acceptanceCommand: 'npm run test:outcome-reconciler:watchdog',
    acceptanceExpectedExitCode: 0,
  } });
  await db.session.create({ data: {
    id: sessionId, ownerId: base.ownerId, creatorId: base.ownerId, taskId,
    workspaceId: base.workspaceId, assignedRunnerId: base.runnerId, title: 'legacy', prompt: 'legacy',
    provider: 'claude', status: RunStatus.FAILED, dispatchOrigin: SessionDispatchOrigin.USER,
    startsTaskWork: true,
  } });
  const createdAt = new Date('2026-08-28T10:51:19.065Z');
  await db.conversationTurn.create({ data: {
    id: turnId, sessionId, seq: 2, clientTurnId: `system:task-acceptance:v1:${randomUUID()}:0`,
    kind: 'shell', content: 'npm run test:outcome-reconciler:watchdog', status: 'ANSWERED',
    createdAt, answeredAt: new Date(createdAt.getTime() + 120_731),
  } });
  await db.taskComment.create({ data: {
    id: '01a04800-b056-74bd-8ff6-7dabe9b8566e', taskId, authorId: base.ownerId,
    authorType: 'USER', body: '实际退出码：-1\nok 12 - samples are append-only\n(output ended)',
  } });
  assert.equal((await pool.query(
    'SELECT executable_acceptance_import_bootstrap_legacy_timeout() AS imported',
  )).rows[0].imported, true);
  const [attempt, diagnosis, session, task] = await Promise.all([
    db.taskExecutableAttempt.findFirstOrThrow({ where: { sessionId } }),
    db.taskExecutableDiagnosis.findFirstOrThrow({ where: { sessionId } }),
    db.session.findUniqueOrThrow({ where: { id: sessionId } }),
    db.task.findUniqueOrThrow({ where: { id: taskId } }),
  ]);
  assert.equal(attempt.legacyTermination, 'UNTYPED');
  assert.equal(attempt.legacyExitCode, -1);
  assert.equal(attempt.terminationKind, null);
  assert.equal(diagnosis.kind, 'TIMEOUT');
  assert.equal(diagnosis.evidence.typedTerminationClaimed, false);
  assert.equal(session.status, RunStatus.FAILED);
  assert.equal(task.executionAttemptCount, 0);
  evidence.legacy = {
    sessionId: '3RIgJAt2GsNCTVoKKfOvK', legacyTermination: attempt.legacyTermination,
    legacyExitCode: attempt.legacyExitCode, diagnosis: diagnosis.kind, evidence: diagnosis.evidence,
  };
});

async function dependencyChain(label, withProject) {
  const base = await foundation(label, withProject);
  const service = tasks();
  const common = { completionCriterion: 'HUMAN_SIGNOFF', ...(withProject ? { projectId: base.projectId } : {}) };
  const old = await service.create(base.ownerId, { title: `${label}-W`, ...common });
  const successor = await service.create(base.ownerId, { title: `${label}-S`, ...common });
  await db.task.update({ where: { id: old.id }, data: { status: TaskStatus.FAILED } });
  await service.update(base.ownerId, old.id, { supersededByTaskId: successor.id });
  await forceStatus(successor.id, TaskStatus.DONE);
  const dependent = await service.create(base.ownerId, {
    title: `${label}-D`, ...common, assigneeId: base.workspaceId,
    dependsOnTaskIds: [old.id], autoRunWhenReady: true,
  });
  return { ...base, oldId: old.id, successorId: successor.id, dependentId: dependent.id };
}

test('W=FAILED -> S=DONE makes task_get/list/Ready/project agree on READY without editing the edge', async () => {
  await empty();
  const chain = await dependencyChain('surface', true);
  const service = tasks();
  const [detail, list, readyPage, projectPage, storedEdge] = await Promise.all([
    service.get(chain.ownerId, chain.dependentId),
    service.list(chain.ownerId),
    service.listPage(chain.ownerId, { status: 'RUNNABLE', projectId: chain.projectId, counts: 'none' }),
    new ProjectsService(db).taskPage(chain.ownerId, chain.projectId, { limit: 20 }),
    db.taskDependency.findUniqueOrThrow({
      where: { taskId_dependsOnTaskId: { taskId: chain.dependentId, dependsOnTaskId: chain.oldId } },
    }),
  ]);
  assert.equal(storedEdge.dependsOnTaskId, chain.oldId, 'the acceptance rewired the historical edge');
  assert.equal(detail.dependencyState, 'READY');
  assert.equal(list.find((row) => row.id === chain.dependentId).dependencyState, 'READY');
  assert.ok(readyPage.items.some((row) => row.id === chain.dependentId));
  assert.equal(projectPage.items.find((row) => row.id === chain.dependentId).dependencyState, 'READY');
  evidence.supersessionSurfaces = {
    taskGet: 'READY', taskList: 'READY', readySelector: true, project: 'READY', edgeStillPointsToW: true,
  };
});

test('Run Now, instant trigger, periodic sweep and execute commit gate use the same chain tail', async () => {
  await empty();
  const chain = await dependencyChain('dispatch', false);
  let dispatched = 0;
  const sentinel = new Error('ACCEPTANCE_DISPATCH_REACHED');
  const service = tasks({
    create: async () => { dispatched += 1; throw sentinel; },
    resume: async () => { dispatched += 1; throw sentinel; },
  });
  await assert.rejects(
    service.execute(chain.ownerId, chain.dependentId, undefined, `acceptance:${randomUUID()}`),
    /ACCEPTANCE_DISPATCH_REACHED/,
  );
  assert.equal(dispatched, 1, 'Run Now did not cross the READY gate');
  await service.triggerDependents(chain.ownerId, chain.successorId);
  assert.ok(dispatched >= 2, 'instant successor completion did not find the stored W edge');
  await service.reconcileReadyTasks();
  assert.ok(dispatched >= 3, 'periodic selector did not dispatch the chain-tail-ready task');

  const committed = await db.session.create({ data: {
    id: randomUUID(), ownerId: chain.ownerId, creatorId: chain.ownerId, taskId: chain.dependentId,
    workspaceId: chain.workspaceId, assignedRunnerId: chain.runnerId, title: 'commit gate',
    prompt: 'commit gate', provider: 'claude', status: RunStatus.PENDING,
    dispatchOrigin: SessionDispatchOrigin.USER, startsTaskWork: true,
  } });
  assert.equal(committed.taskId, chain.dependentId);
  await db.session.delete({ where: { id: committed.id } });
  Object.assign(evidence.supersessionSurfaces, {
    runNow: true, instantTrigger: true, periodicSweep: true, executeCommitGate: true,
  });
});

test('broken and cyclic supersession chains fail closed', async () => {
  await empty();
  const chain = await dependencyChain('broken', false);
  await db.task.delete({ where: { id: chain.successorId } });
  assert.equal((await pool.query(
    'SELECT task_dependency_tail_satisfied($1::uuid) AS satisfied', [chain.oldId],
  )).rows[0].satisfied, false);

  const base = await foundation('cycle');
  const service = tasks();
  const left = await service.create(base.ownerId, { title: 'cycle-left', completionCriterion: 'HUMAN_SIGNOFF' });
  const right = await service.create(base.ownerId, { title: 'cycle-right', completionCriterion: 'HUMAN_SIGNOFF' });
  await db.task.updateMany({ where: { id: { in: [left.id, right.id] } }, data: { status: TaskStatus.FAILED } });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(`UPDATE task SET terminal_reason='SUPERSEDED', superseded_at=now(), superseded_by_task_id=$2 WHERE id=$1`, [left.id, right.id]);
    await client.query(`UPDATE task SET terminal_reason='SUPERSEDED', superseded_at=now(), superseded_by_task_id=$2 WHERE id=$1`, [right.id, left.id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  assert.equal((await pool.query(
    'SELECT task_dependency_tail_id($1::uuid) AS tail', [left.id],
  )).rows[0].tail, null);
  Object.assign(evidence.supersessionSurfaces, { brokenFailClosed: true, cycleFailClosed: true });
});

function waitForOutput(child, pattern, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`worker output timeout: ${output}`)), timeoutMs);
    const read = (chunk) => {
      output += chunk.toString();
      if (pattern.test(output)) {
        clearTimeout(timer);
        resolve(output);
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`worker exited ${code}: ${output}`));
    });
  });
}

test('external dead-man detects a terminated real worker and recovery without reading its projection', async () => {
  await empty();
  const worker = spawn(process.execPath, [path.join(apiDist, 'outcome-watchdog/main.js')], {
    cwd: repo,
    env: {
      ...process.env, DATABASE_URL: url,
      OUTCOME_WATCHDOG_POLICY_PATH: path.join(repo, 'contracts/outcome-reconciler-v2-watchdog-slo.json'),
      OUTCOME_WATCHDOG_COLLECTOR_SHA: sourceSha, OUTCOME_WATCHDOG_TARGET_SHA: sourceSha,
      OUTCOME_WATCHDOG_INSTANCE_ID: 'acceptance-worker',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForOutput(worker, /OUTCOME_WATCHDOG_HEARTBEAT/);
  const workerExited = new Promise((resolve) => worker.once('exit', resolve));
  worker.kill('SIGTERM');
  await workerExited;
  const heartbeat = await db.executableRuntimeHeartbeat.findFirstOrThrow({
    where: { instanceId: 'acceptance-worker' }, orderBy: { sequence: 'desc' },
  });
  const deadman = path.join(repo, 'scripts/executable-acceptance-dead-man.mjs');
  const staleAt = new Date(heartbeat.deadlineAt.getTime() + 1_000);
  const stale = spawnSync(process.execPath, [
    deadman, '--database-url', url, '--source-sha', sourceSha,
    '--instance-id', 'acceptance-worker', '--now', staleAt.toISOString(),
  ], { cwd: repo, encoding: 'utf8' });
  assert.equal(stale.status, 0, stale.stderr);
  assert.equal(JSON.parse(stale.stdout).events[0].kind, 'WATCHDOG_STALE');
  let view = (await pool.query(
    `SELECT state, active_obligation_count FROM executable_runtime_liveness
      WHERE instance_id='acceptance-worker'`,
  )).rows[0];
  assert.deepEqual([view.state, view.active_obligation_count], ['WATCHDOG_STALE', 1]);
  const surfaces = [
    'DONE_GATE', 'AGENT_QUEUE', 'OWNER_DECISION_INBOX',
    'PROJECT_ATTENTION', 'MUTATION_RESPONSE', 'WEB',
  ];
  for (const surface of surfaces) {
    const payload = (await pool.query(
      `SELECT executable_runtime_overlay_read_surface(
         '{"schemaVersion":2,"staleness":"CURRENT","obligations":[],
           "doneGate":{"allowed":true}}'::jsonb, $1::text
       ) AS payload`,
      [surface],
    )).rows[0].payload;
    assert.equal(payload.surface, surface);
    assert.equal(payload.staleness, 'WATCHDOG_STALE');
    assert.equal(payload.doneGate.allowed, false);
    assert.equal(payload.obligations.length, 1, `${surface} rendered an empty stale obligation`);
    assert.equal(payload.obligations[0].kind, 'WATCHDOG_STALE');
  }

  const heartbeatService = new OutcomeWatchdogService(db);
  const recoveredAt = new Date(staleAt.getTime() + 1_000);
  await heartbeatService.appendRuntimeHeartbeat({
    component: 'outcome-watchdog', instanceId: 'acceptance-worker', sourceSha,
    moduleGraphDigest: sha('acceptance-recovery-module-graph'), observedAt: recoveredAt,
    deadlineAt: new Date(recoveredAt.getTime() + 30_000),
    payload: { schemaVersion: 1, recovery: true },
  });
  const recovered = spawnSync(process.execPath, [
    deadman, '--database-url', url, '--source-sha', sourceSha,
    '--instance-id', 'acceptance-worker', '--now', new Date(recoveredAt.getTime() + 1_000).toISOString(),
  ], { cwd: repo, encoding: 'utf8' });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).events[0].kind, 'WATCHDOG_RECOVERED');
  view = (await pool.query(
    `SELECT state, active_obligation_count FROM executable_runtime_liveness
      WHERE instance_id='acceptance-worker'`,
  )).rows[0];
  assert.deepEqual([view.state, view.active_obligation_count], ['HEALTHY', 0]);
  for (const surface of surfaces) {
    const payload = (await pool.query(
      `SELECT executable_runtime_overlay_read_surface(
         '{"schemaVersion":2,"staleness":"CURRENT","obligations":[],
           "doneGate":{"allowed":true}}'::jsonb, $1::text
       ) AS payload`,
      [surface],
    )).rows[0].payload;
    assert.deepEqual(payload.obligations, [], `${surface} retained a recovered obligation`);
    assert.equal(payload.doneGate.allowed, true);
  }
  await assert.rejects(
    db.executableRuntimeHeartbeat.update({ where: { id: heartbeat.id }, data: { sequence: 99n } }),
    /append.only/i,
  );
  const deadmanSource = readFileSync(deadman, 'utf8');
  assert.doesNotMatch(deadmanSource, /from ['"].*(outcome-watchdog|outcome-reconciler|projection|acceptance.executor)/);
  evidence.watchdog = {
    workerTerminated: true, detectedAt: staleAt.toISOString(), maximumDeltaSeconds: 30,
    staleEvent: true, staleSurfaceObligations: 1, recoveryEvent: true, recoveryCleared: true,
    allSixSurfacesStale: true, allSixSurfacesRecovered: true,
    deadmanReadsWorkerProjection: false,
  };
});

test('independent watchdog marks only a started ADMITTED attempt as INFRASTRUCTURE_LOST', async () => {
  await empty();
  const { fixture, delivery, started } = await admitAndStart('stale-attempt');
  const attempt = await db.taskExecutableAttempt.findUniqueOrThrow({ where: { id: started.attemptId } });
  const marked = await new OutcomeWatchdogService(db).markStaleExecutableAttempts(
    new Date(attempt.deadlineAt.getTime() + 1_000),
  );
  assert.equal(marked, 1);
  const [terminated, continuation, task] = await Promise.all([
    db.taskExecutableAttempt.findUniqueOrThrow({ where: { id: started.attemptId } }),
    db.taskExecutableContinuation.findUniqueOrThrow({ where: { attemptId: started.attemptId } }),
    db.task.findUniqueOrThrow({ where: { id: fixture.taskId } }),
  ]);
  assert.equal(terminated.terminationKind, 'INFRASTRUCTURE_LOST');
  assert.equal(continuation.goalActionable, true);
  assert.equal(task.status, TaskStatus.OPEN);
  assert.equal(delivery.acceptancePlan.effectiveTimeoutSeconds, 1200);
});

test('REST/CLI/MCP/shared wire sources expose v2 fields while retaining an explicit N-1 lane', () => {
  const sources = {
    dto: readFileSync(path.join(repo, 'src/apiserver/src/tasks/dto.ts'), 'utf8'),
    controller: readFileSync(path.join(repo, 'src/apiserver/src/runner-api/runner-api.controller.ts'), 'utf8'),
    mcp: readFileSync(path.join(repo, 'src/runner-go/mcp.go'), 'utf8'),
    cli: readFileSync(path.join(repo, 'src/runner-go/task_cli.go'), 'utf8'),
    shared: readFileSync(path.join(repo, 'src/shared/src/dto.ts'), 'utf8'),
  };
  for (const field of ['acceptanceTimeoutSeconds', 'acceptanceOwnerTimeoutCeilingSeconds']) {
    assert.match(sources.dto, new RegExp(field));
    assert.match(sources.mcp, new RegExp(field));
  }
  assert.match(sources.shared, /requestedTimeoutSeconds/);
  assert.match(sources.shared, /effectiveTimeoutSeconds/);
  assert.match(sources.cli, /acceptance-timeout-seconds/);
  assert.match(sources.controller, /TASK_ACCEPTANCE_CLIENT_TURN_V2_PREFIX/);
  assert.match(sources.controller, /version: 1/);
  assert.match(sources.shared, /INFRASTRUCTURE_LOST/);
  Object.assign(evidence.compatibility, { rest: true, cli: true, mcp: true, sharedWire: true });
});

test('successor watchdog task is atomically bound to 1200/current revision by migration source', () => {
  const migration = readFileSync(path.join(
    repo, 'src/apiserver/prisma/migrations/0200_executable_acceptance_runtime_contract/migration.sql',
  ), 'utf8');
  assert.match(migration, /01a0480d-7aba-7281-9b84-aefcba1e75b0/);
  assert.match(migration, /"acceptance_timeout_seconds" = 1200/);
  assert.match(migration, /"acceptance_capability_revision" = 2/);
  assert.match(migration, /task_executable_plan_bind/);
});
