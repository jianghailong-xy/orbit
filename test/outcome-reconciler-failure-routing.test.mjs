import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after } from 'node:test';

const require = createRequire(import.meta.url);
const repo = path.resolve(import.meta.dirname, '..');
const apiDist = path.join(repo, 'src/apiserver/dist');
const url = process.env.FAILURE_ROUTING_PG_URL;
const evidencePath = process.env.FAILURE_ROUTING_EVIDENCE_PATH;
const targetSha = process.env.FAILURE_ROUTING_TARGET_SHA;
const expectedDatabase = process.env.FAILURE_ROUTING_PG_EXPECTED_DATABASE;
const expectedUser = process.env.FAILURE_ROUTING_PG_EXPECTED_USER;
const expectedSystemIdentifier = process.env.FAILURE_ROUTING_PG_EXPECTED_SYSTEM_IDENTIFIER;
const startedAt = process.env.FAILURE_ROUTING_STARTED_AT;

assert.ok(url, 'FAILURE_ROUTING_PG_URL is required');
assert.ok(evidencePath, 'FAILURE_ROUTING_EVIDENCE_PATH is required');
assert.match(targetSha ?? '', /^[0-9a-f]{40}$/);
assert.ok(expectedDatabase);
assert.ok(expectedUser);
assert.match(expectedSystemIdentifier ?? '', /^\d+$/);
assert.ok(Number.isFinite(Date.parse(startedAt ?? '')));

const { Pool } = require('pg');
const { prismaClientFor } = require(path.join(apiDist, 'prisma/prisma-client.js'));
const { TasksService } = require(path.join(apiDist, 'tasks/tasks.service.js'));
const { RunnerApiController } = require(path.join(
  apiDist,
  'runner-api/runner-api.controller.js',
));
const { FailureContinuationService } = require(path.join(
  apiDist,
  'projects/failure-continuation.service.js',
));
const { FailureContinuationControllerService } = require(path.join(
  apiDist,
  'projects/failure-continuation-controller.service.js',
));
const controllerContract = require(path.join(
  apiDist,
  'projects/failure-continuation-controller.js',
));
const runtime = require(path.join(apiDist, 'tasks/executable-acceptance-runtime.js'));
const {
  RunStatus,
  RunnerStatus,
  SessionDispatchOrigin,
} = require(path.join(repo, 'src/apiserver/node_modules/@prisma/client'));

const db = prismaClientFor(url);
const pool = new Pool({ connectionString: url, max: 16 });
const controller = new FailureContinuationControllerService(db);
const courier = new FailureContinuationService(db, {});
const DEFAULT_COMMAND = 'node -e "process.exit(9)"';
const DEFAULT_OUTPUT = 'isolated product assertion failed\n';

const evidence = {
  schemaVersion: 1,
  suite: 'failure-continuation-deterministic-routing-v1',
  outcome: 'INCOMPLETE',
  targetSha,
  postgres: {
    required: true,
    connected: false,
    database: null,
    user: null,
    systemIdentifier: null,
    migrations: Number(process.env.FAILURE_ROUTING_MIGRATION_COUNT ?? 0),
    lastMigration: process.env.FAILURE_ROUTING_LAST_MIGRATION ?? null,
    requiredMigrationApplied:
      process.env.FAILURE_ROUTING_REQUIRED_MIGRATION_APPLIED === '1',
  },
  observationWindow: {
    startedAt,
    finishedAt: null,
    durationMilliseconds: null,
  },
  samples: {
    failureDomains: 0,
    persistedRoutes: 0,
    convergenceGenerations: 0,
    ownerOnlyReasons: 0,
    ordinaryRoutesOutsideInbox: 0,
    evaluationPlanChanges: 0,
    replayReads: 0,
    deadlineBearingResults: 0,
    releaseDagFailureSites: 0,
    distinctReleaseDagFingerprints: 0,
    siteIdentityParityCases: 0,
    typedSiteDegradations: 0,
    preservedHistoricalAttempts: 0,
  },
  coverage: {
    isolatedDatabase: false,
    uniqueDeterministicDomains: false,
    typedTerminationConsumed: false,
    bindingAndCapabilityObserved: false,
    unchangedRetryBoundedOnce: false,
    secondFingerprintChangesPath: false,
    threeNoEvidenceAttention: false,
    fourOwnerReasonsOnly: false,
    ordinaryFailuresNotInDecisionInbox: false,
    evaluationPlanDoesNotStaleRatification: false,
    noDailyAutomationBudgetRequired: false,
    replayStable: false,
    canonicalResultComplete: false,
    immutableDecision: false,
    fingerprintCarriesFailureSite: false,
    siteIdentityOrderFreeAndRunInvariant: false,
    writerAndFallbackAgree: false,
    typedSiteDegradationObservable: false,
    historicalFingerprintsPreserved: false,
    productionWrites: false,
  },
  results: {},
};

after(async () => {
  await db.$disconnect();
  await pool.end();
  const finishedAt = new Date().toISOString();
  evidence.observationWindow.finishedAt = finishedAt;
  evidence.observationWindow.durationMilliseconds =
    Date.parse(finishedAt) - Date.parse(evidence.observationWindow.startedAt);
  mkdirSync(path.dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
});

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function realtime() {
  return new Proxy({}, {
    get: (_target, property) => property === 'waitForInbox'
      ? async () => undefined
      : () => undefined,
  });
}

const live = realtime();
const queue = { notifySessionQueued() {} };

function taskService() {
  return new TasksService(db, {}, live);
}

function runnerApi() {
  return new RunnerApiController(
    db,
    queue,
    live,
    {},
    {},
    {},
    { appendFor: async (_tx, _sessionId, content) => content },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { kick: async () => undefined },
  );
}

async function empty() {
  await pool.query(`
    TRUNCATE failure_continuation_route_decision,
             failure_continuation_wakeup_outbox,
             failure_continuation_obligation,
             failure_continuation_attempt_receipt,
             task, session, workspace, runner, project, "user"
    RESTART IDENTITY CASCADE
  `);
}

async function projectFixture(label, options = {}) {
  const ownerId = randomUUID();
  const runnerId = randomUUID();
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  await db.user.create({
    data: {
      id: ownerId,
      email: `${label}-${ownerId}@failure-routing.invalid`,
      name: label,
      passwordHash: 'fixture-only-not-a-credential',
    },
  });
  await db.runner.create({
    data: {
      id: runnerId,
      ownerId,
      name: `${label}-runner`,
      tokenHash: `fixture-${runnerId}`,
      status: RunnerStatus.ONLINE,
      capabilities: options.runnerCapabilities ?? [],
      capabilitiesReportedAt: new Date(),
    },
  });
  await db.workspace.create({
    data: {
      id: workspaceId,
      ownerId,
      runnerId,
      name: `${label}-workspace`,
      enabled: true,
    },
  });
  await db.project.create({
    data: {
      id: projectId,
      ownerId,
      title: `${label}-project`,
      goal: `${label} fixture goal`,
      coordinatorEnabled: true,
      coordinatorWorkspaceId: workspaceId,
      sessionBudgetPerDay: null,
    },
  });
  await db.projectRuntime.upsert({
    where: { projectId },
    create: { projectId },
    update: {},
  });
  return { ownerId, runnerId, workspaceId, projectId };
}

async function committedFailure(project, label, options = {}) {
  const command = options.command ?? DEFAULT_COMMAND;
  const rawOutput = options.rawOutput ?? DEFAULT_OUTPUT;
  const task = await taskService().create(project.ownerId, {
    title: `${label}-task`,
    projectId: project.projectId,
    assigneeId: project.workspaceId,
    completionCriterion: 'EXECUTABLE',
    acceptanceCriteria: 'The disposable fixture command exits with code zero.',
    acceptanceCommand: command,
    acceptanceExpectedExitCode: 0,
    acceptanceTimeoutSeconds: 120,
    acceptanceOwnerTimeoutCeilingSeconds: 120,
    requiredCapabilities: options.requiredCapabilities ?? [],
  });
  const sessionId = randomUUID();
  const messageTurnId = randomUUID();
  await db.session.create({
    data: {
      id: sessionId,
      ownerId: project.ownerId,
      creatorId: project.ownerId,
      taskId: task.id,
      workspaceId: project.workspaceId,
      assignedRunnerId: project.runnerId,
      title: label,
      prompt: label,
      provider: 'claude',
      status: RunStatus.RUNNING,
      engineTurnActive: true,
      dispatchOrigin: SessionDispatchOrigin.USER,
      startsTaskWork: true,
    },
  });
  await db.conversationTurn.create({
    data: {
      id: messageTurnId,
      sessionId,
      seq: 1,
      clientTurnId: `message:${messageTurnId}`,
      kind: 'message',
      content: 'finish the isolated fixture work',
      status: 'IN_FLIGHT',
    },
  });
  const api = runnerApi();
  await api.turnComplete({ id: project.runnerId }, sessionId, {
    turnId: messageTurnId,
    status: RunStatus.SUCCEEDED,
  });
  const delivery = await api.dequeueTurn(
    sessionId,
    project.runnerId,
    null,
    false,
    [],
    {
      schemaRevision: 2,
      capabilityRevision: 2,
      hardMaxSeconds: 3600,
      runnerSha: targetSha,
    },
  );
  assert.ok(delivery?.acceptancePlan, 'typed executable turn was not admitted');
  const started = await api.startExecutableAcceptanceAttempt(
    { id: project.runnerId },
    sessionId,
    delivery.acceptancePlan.admissionId,
  );
  const result = await api.turnComplete({ id: project.runnerId }, sessionId, {
    turnId: delivery.turnId,
    status: RunStatus.SUCCEEDED,
    subtype: 'shell',
    shellOutput: rawOutput,
    acceptanceAdmissionId: delivery.acceptancePlan.admissionId,
    acceptanceAttemptId: started.attemptId,
    acceptanceTerminationKind: options.terminationKind ?? 'EXITED',
    acceptanceActualExitCode: (options.terminationKind ?? 'EXITED') === 'EXITED' ? 9 : null,
    acceptanceSignal: options.signal ?? null,
  });
  assert.equal(result.status, (options.terminationKind ?? 'EXITED') === 'EXITED'
    ? RunStatus.FAILED
    : RunStatus.AWAITING_INPUT);
  const observedAt = new Date();
  const claims = await courier.claimDue(
    `failure-routing:${label}:${randomUUID()}`,
    observedAt,
    120,
    64,
  );
  const claim = claims.find((candidate) => candidate.taskId === task.id);
  assert.ok(claim, `canonical continuation for ${label} was not claimed`);
  return { ...project, taskId: task.id, sessionId, claim, observedAt, rawOutput };
}

async function routeFailure(project, label, observation, options = {}) {
  const failure = await committedFailure(project, label, options);
  const route = await controller.routeClaim(
    failure.claim,
    failure.observedAt,
    observation,
  );
  return { ...failure, route };
}

async function ratificationState(ownerId, projectId) {
  return (await pool.query(
    'SELECT project_owner_ratification_state_json($1::uuid,$2::uuid) AS result',
    [ownerId, projectId],
  )).rows[0].result;
}

async function ratify(project, state) {
  return (await pool.query(
    `SELECT project_owner_ratify_contract(
       $1::uuid,$2::uuid,'OWNER',$3,$4,$5::uuid,$6::uuid,'APPROVE',$7,false
     ) AS result`,
    [
      project.ownerId,
      project.projectId,
      project.ownerId,
      state.contractDigest,
      state.decisionRequest.id,
      state.decisionRequest.ctaToken,
      `failure-routing-ratification:${project.projectId}`,
    ],
  )).rows[0].result;
}

/**
 * The failing node sets of five consecutive real Release DAG acceptance attempts on this project,
 * in order.  Their successful-node counts were 10, 25, 31, 36 and 36: the first four converged.
 * Four of these sets are distinct and the last two are the same failure, so a fingerprint that
 * carries where the run failed must produce four values -- and the four-constant fingerprint this
 * suite replaces produced one.
 */
const RELEASE_DAG_FAILED_NODES = [
  ['prepare-postgres'],
  ['suite-bootstrap', 'suite-evaluator', 'suite-projection', 'suite-fact-ingress',
    'suite-auto-dispatch', 'suite-work-overview-readiness', 'suite-watchdog-111k',
    'full-api-shard-0', 'full-api-shard-1', 'full-api-shard-2', 'full-api-shard-3'],
  ['full-web', 'suite-watchdog-111k',
    'full-api-shard-0', 'full-api-shard-1', 'full-api-shard-2', 'full-api-shard-3'],
  ['full-api-shard-0', 'full-api-shard-1', 'full-api-shard-2', 'full-api-shard-3'],
  ['full-api-shard-0', 'full-api-shard-1', 'full-api-shard-2', 'full-api-shard-3'],
];
/** The one fingerprint all five of those attempts really carried before this suite. */
const COLLIDED_FINGERPRINT =
  '1a09b7ba0ad9ecf8c6b42e00eb7037e94120764ff0a658a42493838d28fbb153';
const SITE_MARKER = '##orbit-failure-sites:v1';
const FIXTURE_PLAN_DIGEST = sha256('failure-routing-site-fixture-plan');

function siteSummary(nodes, preamble = '') {
  return `${preamble}${SITE_MARKER} ${nodes.join(' ')}\n`;
}

/** What the Release DAG really writes: its attempt manifest, then the site summary line. */
function releaseDagOutput(nodes, run = 1) {
  const attempt = {
    kind: 'orbit.outcome-reconciler.release-dag-attempt',
    startedAt: new Date(1_756_000_000_000 + run * 97_003).toISOString(),
    runRoot: `/tmp/release-dag/${randomUUID()}`,
    failedNodes: nodes,
    timedOutNodes: [],
  };
  return siteSummary(nodes, `${JSON.stringify(attempt, null, 2)}\n`);
}

function siteFingerprint(rawOutput, overrides = {}) {
  return runtime.executableFailureFingerprint({
    evaluationPlanDigest: FIXTURE_PLAN_DIGEST,
    terminationKind: 'EXITED',
    actualExitCode: 1,
    signal: null,
    failureSiteDigest: runtime.executableFailureSiteIdentity(rawOutput).digest,
    ...overrides,
  });
}

async function attemptRows() {
  return (await pool.query(`
    SELECT id::text AS id, attempt_number, termination_kind::text AS termination_kind,
           actual_exit_code, failure_fingerprint, failure_site_source::text AS failure_site_source,
           failure_site_digest, raw_output
      FROM task_executable_attempt ORDER BY id
  `)).rows;
}

/**
 * One admitted attempt in the shape an attempt committed BEFORE the site columns existed: the one
 * constant fingerprint all five real Release DAG attempts carried, and nothing said about where it
 * failed.  No production path can write this row any more, so the fixture suspends the triggers for
 * exactly one insert inside its own transaction; every CHECK constraint still applies to it.
 */
async function seedPreSiteAttempt(failure) {
  const id = randomUUID();
  const admissionId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica'");
    await client.query(`
      INSERT INTO task_executable_admission (
        id, task_id, session_id, turn_id, runner_id, evaluation_plan_digest, command_digest,
        expected_exit_code, requested_timeout_seconds, owner_timeout_ceiling_seconds,
        policy_timeout_ceiling_seconds, required_schema_revision, required_capability_revision,
        runner_schema_revision, runner_capability_revision, runner_hard_max_seconds,
        decision, effective_timeout_seconds, effective_deadline, spawn_count
      ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,$7,0,120,120,3600,2,2,2,2,3600,
        'ADMITTED',120,now(),1)
    `, [admissionId, failure.taskId, failure.sessionId, randomUUID(), failure.runnerId,
      FIXTURE_PLAN_DIGEST, sha256('pre-site-historical-command')]);
    await client.query(`
      INSERT INTO task_executable_attempt (
        id, admission_id, task_id, session_id, attempt_number, evaluation_plan_digest,
        expected_exit_code, deadline_at, started_at, terminated_at, termination_kind,
        actual_exit_code, raw_output, output_truncated, failure_fingerprint
      ) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,64,$5,0,now(),now(),now(),'EXITED',1,$6,false,$7)
    `, [id, admissionId, failure.taskId, failure.sessionId, FIXTURE_PLAN_DIGEST,
      releaseDagOutput(RELEASE_DAG_FAILED_NODES[1]), COLLIDED_FINGERPRINT]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return id;
}

function assertCompleteRoute(route) {
  assert.match(route.failureFingerprint, /^[0-9a-f]{64}$/);
  assert.match(route.bindingDigest, /^[0-9a-f]{64}$/);
  assert.match(route.decisionDigest, /^[0-9a-f]{64}$/);
  assert.equal(route.canonicalReason.failureFingerprint, route.failureFingerprint);
  assert.equal(route.canonicalReason.failureDomain, route.failureDomain);
  assert.equal(route.canonicalReason.failureNode, route.failureNode);
  assert.ok(Array.isArray(route.evidenceSources) && route.evidenceSources.length >= 4);
  for (const source of route.evidenceSources) {
    assert.ok(source.kind && source.locator);
    assert.match(source.digest, /^[0-9a-f]{64}$/);
  }
  assert.ok(route.nextAction.kind);
  assert.ok(Array.isArray(route.nextAction.steps) && route.nextAction.steps.length > 0);
  assert.ok(Date.parse(route.deadlineAt) > Date.parse(route.decidedAt ?? '1970-01-01'));
  evidence.samples.deadlineBearingResults += 1;
}

test('the suite is bound to the declared disposable PostgreSQL identity', async () => {
  const identity = (await pool.query(`
    SELECT current_database() AS database, current_user AS "user",
           (SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier"
  `)).rows[0];
  assert.deepEqual(identity, {
    database: expectedDatabase,
    user: expectedUser,
    systemIdentifier: expectedSystemIdentifier,
  });
  assert.ok(evidence.postgres.migrations > 0);
  assert.equal(evidence.postgres.requiredMigrationApplied, true);
  evidence.postgres.connected = true;
  evidence.postgres.database = identity.database;
  evidence.postgres.user = identity.user;
  evidence.postgres.systemIdentifier = identity.systemIdentifier;
  evidence.coverage.isolatedDatabase = true;
});

test('the closed reducer assigns every failure domain one deterministic route', () => {
  const base = {
    terminationKind: 'EXITED',
    requiredCapability: null,
    availableCapabilities: [],
  };
  const cases = [
    [{ ...base, failureNode: 'EXTERNAL_SERVICE' }, 'TRANSIENT_EXTERNAL'],
    [{ ...base, failureNode: 'TEST_HARNESS' }, 'EVALUATION_HARNESS'],
    [{ ...base, failureNode: 'PRODUCT_BEHAVIOR' }, 'PRODUCT_ARTIFACT'],
    [{ ...base, failureNode: 'RUNTIME_CAPABILITY', requiredCapability: 'macos' },
      'CAPABILITY/ENVIRONMENT'],
    [{ ...base, failureNode: 'GOAL_BOUNDARY', ownerReason: 'GOAL_DECISION' },
      'OWNER_REQUIRED'],
  ];
  const observed = cases.map(([input, expected]) => {
    const domain = controllerContract.classifyFailureContinuationDomain(input);
    assert.equal(domain, expected);
    return domain;
  });
  assert.deepEqual(observed, controllerContract.FAILURE_CONTINUATION_DOMAINS);
  assert.equal(new Set(observed).size, controllerContract.FAILURE_CONTINUATION_DOMAINS.length);
  assert.equal(controllerContract.classifyFailureContinuationDomain({
    ...base,
    terminationKind: 'INFRASTRUCTURE_LOST',
    failureNode: 'PRODUCT_BEHAVIOR',
  }), 'CAPABILITY/ENVIRONMENT');
  assert.equal(controllerContract.classifyFailureContinuationDomain({
    ...base,
    failureNode: 'PRODUCT_BEHAVIOR',
    evaluationPlanChanged: true,
  }), 'EVALUATION_HARNESS');
  assert.throws(() => controllerContract.failureContinuationConvergenceRoute({
    domain: 'UNKNOWN_DOMAIN',
    fingerprintOccurrence: 1,
    unchangedEvidenceGenerations: 1,
  }), /FAILURE_CONTINUATION_DOMAIN_INVALID/);
  evidence.samples.failureDomains = observed.length;
  evidence.coverage.uniqueDeterministicDomains = true;
});

test('claimed canonical continuations persist all five routes with complete replay material',
  { timeout: 120_000 }, async () => {
    await empty();
    const cases = [
      ['transient', { failureNode: 'EXTERNAL_NETWORK' }, 'TRANSIENT_EXTERNAL', {}],
      ['harness', { failureNode: 'FIXTURE_SETUP' }, 'EVALUATION_HARNESS', {
        rawOutput: 'Cannot find module prisma/config in isolated fixture\n',
      }],
      ['product', { failureNode: 'PRODUCT_SOURCE' }, 'PRODUCT_ARTIFACT', {}],
      ['capability', {
        failureNode: 'RUNTIME_CAPABILITY', requiredCapability: 'macos',
      }, 'CAPABILITY/ENVIRONMENT', { requiredCapabilities: ['macos'] }],
      ['owner', {
        failureNode: 'GOAL_BOUNDARY', ownerReason: 'GOAL_DECISION',
      }, 'OWNER_REQUIRED', {}],
    ];
    const routes = [];
    for (const [label, observation, expected, options] of cases) {
      const project = await projectFixture(`domain-${label}`);
      const result = await routeFailure(project, `domain-${label}`, observation, options);
      assert.equal(result.route.failureDomain, expected);
      assertCompleteRoute(result.route);
      routes.push(result.route);
    }
    const persisted = (await pool.query(`
      SELECT failure_domain, count(*)::integer AS count
        FROM failure_continuation_route_decision
       GROUP BY failure_domain ORDER BY failure_domain
    `)).rows;
    assert.equal(persisted.length, 5);
    assert.ok(persisted.every((row) => row.count === 1));
    assert.equal(routes.filter((route) => route.ownerReason !== null).length, 1);
    evidence.samples.persistedRoutes = routes.length;
    evidence.coverage.typedTerminationConsumed = true;
    evidence.coverage.bindingAndCapabilityObserved = true;
    evidence.coverage.canonicalResultComplete = true;
    evidence.results.domainRoutes = routes.map((route) => ({
      domain: route.failureDomain,
      node: route.failureNode,
      path: route.diagnosticPath,
      nextAction: route.nextAction.kind,
      deadlineAt: route.deadlineAt,
    }));
  });

test('one unchanged retry is the maximum and generation three without evidence enters attention',
  { timeout: 120_000 }, async () => {
    await empty();
    const project = await projectFixture('convergence');
    const routes = [];
    for (let generation = 1; generation <= 3; generation += 1) {
      const result = await routeFailure(
        project,
        `convergence-${generation}`,
        { failureNode: 'EXTERNAL_SERVICE' },
        { command: DEFAULT_COMMAND, rawOutput: '503 service unavailable\n' },
      );
      routes.push(result.route);
    }
    assert.deepEqual(routes.map((route) => route.fingerprintOccurrence), [1, 2, 3]);
    assert.deepEqual(routes.map((route) => route.unchangedEvidenceGenerations), [1, 2, 3]);
    assert.equal(routes[0].nextAction.kind, 'RETRY_UNCHANGED_ONCE');
    assert.equal(routes[0].nextAction.allowsUnchangedRetry, true);
    assert.equal(routes[1].diagnosticPath, 'ALTERNATE_DIAGNOSIS');
    assert.equal(routes[1].nextAction.allowsUnchangedRetry, false);
    assert.equal(routes[1].nextAction.changesDiagnosticPath, true);
    assert.equal(routes[2].diagnosticPath, 'PROJECT_ATTENTION');
    assert.equal(routes[2].projectAttention, true);
    assert.equal(
      routes[2].canonicalReason.code,
      'FAILURE_CONTINUATION_NO_NEW_EVIDENCE_THREE_GENERATIONS',
    );
    const attention = (await pool.query(`
      SELECT count(*)::integer AS count FROM failure_continuation_project_attention
       WHERE goal_id=$1::uuid
    `, [project.projectId])).rows[0].count;
    const owner = (await pool.query(`
      SELECT count(*)::integer AS count FROM failure_continuation_owner_decision_inbox
       WHERE goal_id=$1::uuid
    `, [project.projectId])).rows[0].count;
    assert.equal(attention, 1);
    assert.equal(owner, 0);
    evidence.samples.convergenceGenerations = routes.length;
    evidence.samples.ordinaryRoutesOutsideInbox = routes.length;
    evidence.coverage.unchangedRetryBoundedOnce = true;
    evidence.coverage.secondFingerprintChangesPath = true;
    evidence.coverage.threeNoEvidenceAttention = true;
    evidence.coverage.ordinaryFailuresNotInDecisionInbox = true;
    evidence.results.convergence = routes.map((route) => ({
      generation: route.routeGeneration,
      occurrence: route.fingerprintOccurrence,
      unchangedEvidenceGenerations: route.unchangedEvidenceGenerations,
      path: route.diagnosticPath,
      action: route.nextAction.kind,
    }));
  });

test('exactly the four owner-only reasons enter the failure decision inbox',
  { timeout: 120_000 }, async () => {
    await empty();
    const reasonNodes = [
      ['GOAL_DECISION', 'GOAL_BOUNDARY'],
      ['RISK_ACCEPTANCE', 'RISK_BOUNDARY'],
      ['NEW_AUTHORIZATION', 'AUTHORIZATION_BOUNDARY'],
      ['EXTERNAL_IDENTITY', 'EXTERNAL_IDENTITY_BOUNDARY'],
    ];
    for (const [reason, failureNode] of reasonNodes) {
      const project = await projectFixture(`owner-${reason.toLowerCase()}`);
      const result = await routeFailure(project, `owner-${reason.toLowerCase()}`, {
        failureNode,
        ownerReason: reason,
      });
      assert.equal(result.route.failureDomain, 'OWNER_REQUIRED');
      assert.equal(result.route.ownerReason, reason);
      assert.equal(result.route.nextAction.requiresOwnerDecision, true);
      assert.equal(result.route.nextAction.ownerDecision.reason, reason);
    }
    const inbox = (await pool.query(`
      SELECT owner_reason FROM failure_continuation_owner_decision_inbox
       ORDER BY owner_reason
    `)).rows.map((row) => row.owner_reason);
    assert.deepEqual(inbox, reasonNodes.map(([reason]) => reason).sort());
    const invalidProject = await projectFixture('invalid-owner-reason');
    const invalid = await committedFailure(invalidProject, 'invalid-owner-reason');
    await assert.rejects(
      controller.routeClaim(invalid.claim, invalid.observedAt, {
        failureNode: 'PRODUCT_BEHAVIOR',
        ownerReason: 'ENGINEERING_FAILURE',
      }),
      /FAILURE_CONTINUATION_OWNER_REASON_FORBIDDEN/,
    );
    const genericOwnerRows = (await pool.query(`
      SELECT count(*)::integer AS outcome_count
        FROM outcome_coordinator_owner_decision_request
    `)).rows[0];
    assert.equal(genericOwnerRows.outcome_count, 0);
    evidence.samples.ownerOnlyReasons = inbox.length;
    evidence.coverage.fourOwnerReasonsOnly = true;
  });

test('evaluation-plan-only evolution preserves contract ratification and routes revalidation',
  { timeout: 120_000 }, async () => {
    await empty();
    const project = await projectFixture('evaluation-plan');
    const definitionId = randomUUID();
    await pool.query(`
      INSERT INTO project_acceptance_criterion_definition (
        id, project_id, ordinal, text, verification_method, completion_criterion, content_hash
      ) VALUES ($1::uuid,$2::uuid,1,$3,$4,'HUMAN_SIGNOFF'::task_completion_criterion,$5)
    `, [
      definitionId,
      project.projectId,
      'The isolated evaluation outcome is complete.',
      'run evaluation harness version one',
      sha256(`criterion:${definitionId}`),
    ]);
    const initial = await ratificationState(project.ownerId, project.projectId);
    assert.ok(initial.decisionRequest?.id && initial.decisionRequest?.ctaToken);
    const approved = await ratify(project, initial);
    assert.equal(approved.ok, true);
    const before = await ratificationState(project.ownerId, project.projectId);
    assert.equal(before.ratified, true);
    const failure = await committedFailure(project, 'evaluation-plan-failure');
    await pool.query(`
      UPDATE project_acceptance_criterion_definition
         SET verification_method='run evaluation harness version two'
       WHERE id=$1::uuid
    `, [definitionId]);
    const evolved = await ratificationState(project.ownerId, project.projectId);
    assert.equal(evolved.contractDigest, before.contractDigest);
    assert.notEqual(evolved.evaluationPlanDigest, before.evaluationPlanDigest);
    assert.equal(evolved.ratified, true);
    assert.equal(evolved.decisionRequest, null);
    const route = await controller.routeClaim(failure.claim, failure.observedAt, {
      failureNode: 'PRODUCT_BEHAVIOR',
    });
    assert.equal(route.contractRatificationState, 'CURRENT');
    assert.equal(route.projectEvaluationPlanChanged, true);
    assert.equal(route.failureDomain, 'EVALUATION_HARNESS');
    assert.equal(route.ownerReason, null);
    assert.equal(route.nextAction.kind, 'REVALIDATE_EVALUATION_PLAN');
    const pending = (await pool.query(`
      SELECT count(*)::integer AS count FROM project_owner_decision_request
       WHERE project_id=$1::uuid AND status='PENDING'
    `, [project.projectId])).rows[0].count;
    const routedOwner = (await pool.query(`
      SELECT count(*)::integer AS count FROM failure_continuation_owner_decision_inbox
       WHERE goal_id=$1::uuid
    `, [project.projectId])).rows[0].count;
    const budget = (await pool.query(
      'SELECT session_budget_per_day AS budget FROM project WHERE id=$1::uuid',
      [project.projectId],
    )).rows[0].budget;
    assert.equal(pending, 0);
    assert.equal(routedOwner, 0);
    assert.equal(budget, null);
    assertCompleteRoute(route);
    evidence.samples.evaluationPlanChanges = 1;
    evidence.coverage.evaluationPlanDoesNotStaleRatification = true;
    evidence.coverage.noDailyAutomationBudgetRequired = true;
    evidence.results.evaluationPlan = {
      contractDigest: evolved.contractDigest,
      beforeEvaluationPlanDigest: before.evaluationPlanDigest,
      afterEvaluationPlanDigest: evolved.evaluationPlanDigest,
      ratified: evolved.ratified,
      routedDomain: route.failureDomain,
      nextAction: route.nextAction.kind,
    };
  });

test('the five real Release DAG attempts do not collapse into one fingerprint',
  { timeout: 120_000 }, async () => {
    await empty();
    const project = await projectFixture('release-dag-sites');
    const fingerprints = [];
    for (const [index, nodes] of RELEASE_DAG_FAILED_NODES.entries()) {
      const failure = await committedFailure(project, `release-dag-${index}`, {
        rawOutput: releaseDagOutput(nodes, index + 1),
      });
      const attempt = await db.taskExecutableAttempt.findFirstOrThrow({
        where: { taskId: failure.taskId },
      });
      fingerprints.push(attempt.failureFingerprint.trim());
    }
    // Every other fingerprint input is a constant along this chain -- same command, same plan
    // digest, same EXITED exit code, no signal -- so anything that separates these five came from
    // where they failed.
    assert.equal(new Set(fingerprints).size, 4,
      'the five attempts carry one fingerprint per distinct failing-node set, not one in total');
    assert.equal(fingerprints[3], fingerprints[4],
      'the fourth and fifth attempts failed on the same shards and are the same failure');
    assert.equal(new Set(fingerprints.slice(0, 4)).size, 4);
    for (const value of fingerprints) assert.match(value, /^[0-9a-f]{64}$/);
    assert.ok(!fingerprints.includes(COLLIDED_FINGERPRINT));
    evidence.samples.releaseDagFailureSites = RELEASE_DAG_FAILED_NODES.length;
    evidence.samples.distinctReleaseDagFingerprints = new Set(fingerprints).size;
    evidence.coverage.fingerprintCarriesFailureSite = true;
    evidence.results.releaseDagFailureSites = RELEASE_DAG_FAILED_NODES.map((nodes, index) => ({
      nodes: nodes.length,
      fingerprint: fingerprints[index],
    }));
  });

test('the site identity is order-free, repeatable and free of run-varying material', () => {
  const nodes = RELEASE_DAG_FAILED_NODES[2];
  const identity = runtime.executableFailureSiteIdentity(siteSummary(nodes));
  assert.equal(identity.source, 'REPORTED');
  assert.deepEqual(identity.sites, [...nodes].sort());
  assert.match(identity.digest, /^[0-9a-f]{64}$/);

  const shuffled = [...nodes].reverse();
  assert.notDeepEqual(shuffled, [...nodes].sort());
  assert.equal(siteFingerprint(siteSummary(shuffled)), siteFingerprint(siteSummary(nodes)));
  assert.equal(siteFingerprint(siteSummary([...shuffled, nodes[0], nodes[1]])),
    siteFingerprint(siteSummary(nodes)));

  // Timestamps, paths, pids, nonces and log bodies all vary per run and none of them may reach the
  // digest, or every attempt would be its own failure and the fingerprint would stop discriminating.
  const noisy = (run) => siteSummary(nodes, [
    `started 2026-08-31T0${run}:15:0${run}Z pid=${9_000 + run} nonce=${randomUUID()}`,
    `/tmp/release-dag/${randomUUID()}/attempt-${run}.log`,
    'assertion failed: expected 0, got 1\n'.repeat(run),
  ].join('\n'));
  const noisyDigests = [1, 2, 3].map((run) =>
    runtime.executableFailureSiteIdentity(noisy(run)).digest);
  assert.equal(new Set(noisyDigests).size, 1, 'run-varying output changed the site identity');
  assert.equal(noisyDigests[0], identity.digest);

  const repeated = [0, 1, 2].map(() =>
    runtime.executableFailureSiteIdentity(releaseDagOutput(nodes)).digest);
  assert.equal(new Set(repeated).size, 1);
  assert.equal(repeated[0], identity.digest);

  const other = runtime.executableFailureSiteIdentity(siteSummary(RELEASE_DAG_FAILED_NODES[3]));
  assert.notEqual(other.digest, identity.digest);
  evidence.coverage.siteIdentityOrderFreeAndRunInvariant = true;
});

test('the TypeScript writer and the SQL fallback digest the same input identically',
  { timeout: 120_000 }, async () => {
    const outputs = [
      null,
      '',
      'the command never said where it failed\n',
      siteSummary([]),
      SITE_MARKER,
      siteSummary(RELEASE_DAG_FAILED_NODES[0]),
      siteSummary([...RELEASE_DAG_FAILED_NODES[1]].reverse()),
      releaseDagOutput(RELEASE_DAG_FAILED_NODES[2]),
      `noise\r\n${siteSummary(RELEASE_DAG_FAILED_NODES[3])}`,
      `${siteSummary(['early-node'])}later\n${siteSummary(RELEASE_DAG_FAILED_NODES[4])}`,
      `${SITE_MARKER}  full-web   suite-watchdog-111k \n`,
      `${SITE_MARKER} full-web /tmp/run 17!\n`,
      `${SITE_MARKER}suffix full-web\n`,
    ];
    let parityCases = 0;
    for (const rawOutput of outputs) {
      const identity = runtime.executableFailureSiteIdentity(rawOutput);
      const row = (await pool.query(
        'SELECT site_source, site_digest FROM executable_failure_site_identity($1::text)',
        [rawOutput],
      )).rows[0];
      assert.equal(row.site_source, identity.source, `site source differs for ${rawOutput}`);
      assert.equal(row.site_digest.trim(), identity.digest, `site digest differs for ${rawOutput}`);
      parityCases += 1;
    }
    for (const [terminationKind, actualExitCode, signal] of [
      ['EXITED', 1, null],
      ['EXITED', 0, null],
      ['TIMED_OUT', null, null],
      ['SIGNALED', null, 'signal: killed'],
      ['INFRASTRUCTURE_LOST', null, null],
    ]) {
      for (const rawOutput of outputs) {
        const failureSiteDigest = runtime.executableFailureSiteIdentity(rawOutput).digest;
        const written = runtime.executableFailureFingerprint({
          evaluationPlanDigest: FIXTURE_PLAN_DIGEST,
          terminationKind,
          actualExitCode,
          signal,
          failureSiteDigest,
        });
        const fallback = (await pool.query(
          'SELECT executable_failure_fingerprint($1::text,$2::text,$3::integer,$4::text,$5::text) AS value',
          [FIXTURE_PLAN_DIGEST, terminationKind, actualExitCode, signal, failureSiteDigest],
        )).rows[0].value.trim();
        assert.match(written, /^[0-9a-f]{64}$/);
        assert.equal(fallback, written,
          `the SQL fallback disagrees with the writer on ${terminationKind}`);
        parityCases += 1;
      }
    }
    evidence.samples.siteIdentityParityCases = parityCases;
    evidence.coverage.writerAndFallbackAgree = true;
  });

test('a committed attempt records its site identity and names every degradation',
  { timeout: 120_000 }, async () => {
    await empty();
    const project = await projectFixture('failure-site-record');
    const cases = [
      ['shards', releaseDagOutput(RELEASE_DAG_FAILED_NODES[3]), 'REPORTED'],
      ['web', releaseDagOutput(RELEASE_DAG_FAILED_NODES[2]), 'REPORTED'],
      ['silent', 'the command never said where it failed\n', 'ABSENT'],
      ['malformed', `${SITE_MARKER} full-web /tmp/run 17!\n`, 'UNPARSABLE'],
    ];
    const observed = [];
    for (const [label, rawOutput, source] of cases) {
      const failure = await committedFailure(project, `site-${label}`, { rawOutput });
      const attempt = await db.taskExecutableAttempt.findFirstOrThrow({
        where: { taskId: failure.taskId },
      });
      const identity = runtime.executableFailureSiteIdentity(rawOutput);
      assert.equal(identity.source, source);
      assert.equal(attempt.failureSiteSource, source, `${label} did not record a typed site source`);
      assert.equal(attempt.failureSiteDigest.trim(), identity.digest);
      assert.equal(attempt.failureFingerprint.trim(), runtime.executableFailureFingerprint({
        evaluationPlanDigest: attempt.evaluationPlanDigest,
        terminationKind: 'EXITED',
        actualExitCode: 9,
        signal: null,
        failureSiteDigest: identity.digest,
      }));
      const receipt = (await pool.query(
        'SELECT failure_fingerprint FROM failure_continuation_attempt_receipt WHERE attempt_id=$1::uuid',
        [attempt.id],
      )).rows[0];
      assert.equal(receipt.failure_fingerprint.trim(), attempt.failureFingerprint.trim(),
        'the database fallback reached a different value than the writer stored');
      observed.push({ label, source, fingerprint: attempt.failureFingerprint.trim() });
    }
    assert.notEqual(observed[0].fingerprint, observed[1].fingerprint,
      'two attempts that failed on different nodes share a fingerprint');
    // A degradation is a value of its own, not a quiet fall back onto whatever was reported.
    assert.equal(new Set(observed.map((entry) => entry.fingerprint)).size, 4);
    assert.deepEqual(observed.map((entry) => entry.source),
      ['REPORTED', 'REPORTED', 'ABSENT', 'UNPARSABLE']);
    evidence.samples.typedSiteDegradations =
      observed.filter((entry) => entry.source !== 'REPORTED').length;
    evidence.coverage.typedSiteDegradationObservable = true;
    evidence.results.recordedSiteSources = observed;
  });

test('no historical attempt row is backfilled or rewritten', { timeout: 120_000 }, async () => {
  await empty();
  const project = await projectFixture('history');
  const seed = await committedFailure(project, 'history-seed', {
    rawOutput: releaseDagOutput(RELEASE_DAG_FAILED_NODES[0]),
  });
  const historicalId = await seedPreSiteAttempt(seed);
  const before = await attemptRows();
  assert.equal(before.length, 2);

  const next = await committedFailure(project, 'history-next', {
    rawOutput: releaseDagOutput(RELEASE_DAG_FAILED_NODES[2]),
  });
  await controller.routeClaim(next.claim, next.observedAt, { failureNode: 'PRODUCT_BEHAVIOR' });
  const after = await attemptRows();
  assert.equal(after.length, before.length + 1);
  const standing = new Map(after.map((row) => [row.id, row]));
  for (const row of before) {
    assert.deepEqual(standing.get(row.id), row, `attempt ${row.id} was rewritten`);
  }
  const historical = standing.get(historicalId);
  assert.equal(historical.failure_fingerprint.trim(), COLLIDED_FINGERPRINT);
  assert.equal(historical.failure_site_source, null,
    'a historical attempt was backfilled with a site source it never reported');
  assert.equal(historical.failure_site_digest, null);
  const fresh = after.find((row) => !before.some((old) => old.id === row.id));
  assert.equal(fresh.failure_site_source, 'REPORTED');
  assert.notEqual(fresh.failure_fingerprint.trim(), COLLIDED_FINGERPRINT);
  evidence.samples.preservedHistoricalAttempts = before.length;
  evidence.coverage.historicalFingerprintsPreserved = true;
});

test('route replay is byte-stable and the persisted decision is append-only',
  { timeout: 120_000 }, async () => {
    await empty();
    const project = await projectFixture('replay');
    const failure = await committedFailure(project, 'replay');
    const first = await controller.routeClaim(failure.claim, failure.observedAt, {
      failureNode: 'PRODUCT_BEHAVIOR',
      evidenceFacts: { source: 'isolated-replay-fixture', revision: 1 },
    });
    const replay = await controller.routeClaim(failure.claim, failure.observedAt, {
      failureNode: 'PRODUCT_BEHAVIOR',
      evidenceFacts: { source: 'isolated-replay-fixture', revision: 1 },
    });
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    for (const key of [
      'decisionId', 'decisionDigest', 'bindingDigest', 'failureFingerprint',
      'failureDomain', 'failureNode', 'deadlineAt', 'idempotencyKey',
    ]) assert.equal(replay[key], first[key], `${key} changed on replay`);
    assert.deepEqual(replay.canonicalReason, first.canonicalReason);
    assert.deepEqual(replay.evidence, first.evidence);
    assert.deepEqual(replay.evidenceSources, first.evidenceSources);
    assert.deepEqual(replay.nextAction, first.nextAction);
    const rows = (await pool.query(`
      SELECT count(*)::integer AS count FROM failure_continuation_route_decision
       WHERE obligation_id=$1::uuid
    `, [failure.claim.obligationId])).rows[0].count;
    assert.equal(rows, 1);
    await assert.rejects(
      pool.query(`UPDATE failure_continuation_route_decision
                     SET reason_code='REWRITTEN'
                   WHERE obligation_id=$1::uuid`, [failure.claim.obligationId]),
      /OUTCOME_APPEND_ONLY_VIOLATION/,
    );
    const replayRead = (await pool.query(
      'SELECT failure_continuation_route_read($1::uuid) AS result',
      [failure.claim.obligationId],
    )).rows[0].result;
    assert.equal(replayRead.decisionDigest, first.decisionDigest);
    assert.deepEqual(replayRead.evidenceSources, first.evidenceSources);
    assert.equal(replayRead.nextAction.kind, first.nextAction.kind);
    assert.equal(replayRead.deadlineAt, first.deadlineAt);
    assertCompleteRoute(first);
    evidence.samples.replayReads = 2;
    evidence.coverage.replayStable = true;
    evidence.coverage.immutableDecision = true;
    evidence.coverage.productionWrites = false;
    assert.ok(Object.values(evidence.samples).every((count) => count > 0));
    assert.ok(Object.entries(evidence.coverage).every(([name, proven]) => (
      name === 'productionWrites' ? proven === false : proven === true
    )));
    evidence.outcome = 'PASS';
  });
