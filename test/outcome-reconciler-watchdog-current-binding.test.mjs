import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test, { after, before } from 'node:test';

const require = createRequire(import.meta.url);
const { Pool } = require('pg');

const URL = process.env.WATCHDOG_CURRENT_BINDING_PG_URL;
const EXPECTED_DATABASE = process.env.WATCHDOG_CURRENT_BINDING_PG_EXPECTED_DATABASE;
const EXPECTED_USER = process.env.WATCHDOG_CURRENT_BINDING_PG_EXPECTED_USER;
const EXPECTED_SYSTEM_IDENTIFIER =
  process.env.WATCHDOG_CURRENT_BINDING_PG_EXPECTED_SYSTEM_IDENTIFIER;
const EVIDENCE_PATH = process.env.WATCHDOG_CURRENT_BINDING_EVIDENCE_PATH;
const TARGET_SHA = process.env.WATCHDOG_CURRENT_BINDING_TARGET_SHA;
const STARTED_AT = process.env.WATCHDOG_CURRENT_BINDING_STARTED_AT;
const MIGRATION_COUNT = process.env.WATCHDOG_CURRENT_BINDING_MIGRATION_COUNT;
const LAST_MIGRATION = process.env.WATCHDOG_CURRENT_BINDING_LAST_MIGRATION;
const REQUIRED_MIGRATION_APPLIED =
  process.env.WATCHDOG_CURRENT_BINDING_REQUIRED_MIGRATION_APPLIED;

for (const [name, value] of Object.entries({
  WATCHDOG_CURRENT_BINDING_PG_URL: URL,
  WATCHDOG_CURRENT_BINDING_PG_EXPECTED_DATABASE: EXPECTED_DATABASE,
  WATCHDOG_CURRENT_BINDING_PG_EXPECTED_USER: EXPECTED_USER,
  WATCHDOG_CURRENT_BINDING_PG_EXPECTED_SYSTEM_IDENTIFIER: EXPECTED_SYSTEM_IDENTIFIER,
  WATCHDOG_CURRENT_BINDING_EVIDENCE_PATH: EVIDENCE_PATH,
  WATCHDOG_CURRENT_BINDING_TARGET_SHA: TARGET_SHA,
  WATCHDOG_CURRENT_BINDING_STARTED_AT: STARTED_AT,
  WATCHDOG_CURRENT_BINDING_MIGRATION_COUNT: MIGRATION_COUNT,
  WATCHDOG_CURRENT_BINDING_LAST_MIGRATION: LAST_MIGRATION,
  WATCHDOG_CURRENT_BINDING_REQUIRED_MIGRATION_APPLIED: REQUIRED_MIGRATION_APPLIED,
})) assert.ok(value, `${name} is required`);

assert.match(TARGET_SHA, /^[0-9a-f]{40}$/);
assert.match(LAST_MIGRATION, /^\d{4}_[a-z0-9_]+$/);
assert.equal(REQUIRED_MIGRATION_APPLIED, '1');

const pool = new Pool({ connectionString: URL, max: 12 });
const component = 'outcome-watchdog';
const moduleDigest = sha('watchdog-current-binding-module');
const oldInstanceId = 'c4bc5303e476:1';
const oldSourceSha = '88f6be57dd121000fcd94fa2d6543e2a022e4114';
const oldHeartbeatDigest = '1e4f97715b3623ea05de7c1f56da442c64fd2c0e28898be6fdc665f14891d2c6';
const targetRef = 'refs/heads/main';

const state = {
  first: null,
  second: null,
  winner: null,
  loser: null,
  projectionBefore: null,
};

const evidence = {
  schemaVersion: 1,
  suite: 'outcome-reconciler-watchdog-current-binding',
  targetSha: TARGET_SHA,
  outcome: 'FAIL',
  postgres: {
    required: true,
    connected: false,
    database: null,
    user: null,
    version: null,
    systemIdentifier: null,
    migrations: Number(MIGRATION_COUNT),
    lastMigration: LAST_MIGRATION,
    requiredMigrationApplied: true,
  },
  observationWindow: {
    startedAt: STARTED_AT,
    finishedAt: null,
    durationMilliseconds: null,
    startupRegistrationMilliseconds: null,
  },
  samples: {
    startupRegistrations: 0,
    heartbeatAdvances: 0,
    rollingReplacements: 0,
    dualInstanceRegistrations: 0,
    staleDerivations: 0,
    projectAcceptanceReads: 0,
    obsoleteLegacyFacts: 0,
  },
  coverage: {
    startupRegisteredWithinWindow: false,
    heartbeatWatermarkMonotonic: false,
    rollingFactsPreserved: false,
    oldBindingExplicitlySuperseded: false,
    legacyHeartbeatExplicitlyObsolete: false,
    dualInstanceExactlyOneCurrent: false,
    supersededInstanceCannotHeartbeat: false,
    deadManDerivesCurrentStale: false,
    recoveryClearsCurrentStale: false,
    projectReadExcludesOldHeartbeat: false,
    appendOnlyHistoryEnforced: false,
    productionProjectionWrites: false,
  },
  results: {},
};

function sha(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function fullSha(label) {
  return sha(label).slice(0, 40);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

async function projectionSnapshot() {
  const tables = (await pool.query(`
    SELECT table_name
      FROM information_schema.tables
     WHERE table_schema = 'outcome_projection' AND table_type = 'BASE TABLE'
     ORDER BY table_name
  `)).rows.map((row) => row.table_name);
  const snapshot = {};
  for (const table of tables) {
    const quoted = quoteIdentifier(table);
    const row = (await pool.query(`
      SELECT count(*)::integer AS count,
             md5(COALESCE(string_agg(to_jsonb(value)::text, '|' ORDER BY to_jsonb(value)::text), ''))
               AS digest
        FROM outcome_projection.${quoted} value
    `)).rows[0];
    snapshot[table] = row;
  }
  return snapshot;
}

async function expectGeneration({ instanceId, generation, sourceSha }) {
  return (await pool.query(`
    SELECT executable_runtime_expect_generation(
      $1::text, $2::text, $3::uuid, $4::text, $5::text,
      60, $6::text, $7::jsonb
    ) AS result
  `, [
    component,
    instanceId,
    generation,
    sourceSha,
    moduleDigest,
    `watchdog-current-binding:expect:${generation}`,
    JSON.stringify({ fixture: 'watchdog-current-binding', targetSha: sourceSha }),
  ])).rows[0].result;
}

async function registerBinding({ instanceId, generation, sourceSha, targetSha = sourceSha }) {
  return (await pool.query(`
    SELECT executable_runtime_register_current_binding(
      $1::text, $2::text, $3::uuid, $4::text, $5::text, $6::text, $7::text
    ) AS result
  `, [component, instanceId, generation, sourceSha, targetSha, targetRef, moduleDigest]))
    .rows[0].result;
}

async function appendHeartbeat(binding, { stale = false, label = randomUUID() } = {}) {
  const observedAt = stale ? new Date(Date.now() - 31_000) : new Date();
  const deadlineAt = stale
    ? new Date(Date.now() - 1_000)
    : new Date(observedAt.getTime() + 30_000);
  return (await pool.query(`
    SELECT executable_runtime_append_current_heartbeat(
      $1::text, $2::text, $3::uuid, $4::text, $5::text,
      $6::timestamptz, $7::timestamptz, $8::jsonb
    ) AS result
  `, [
    component,
    binding.instanceId,
    binding.generation,
    binding.sourceSha,
    moduleDigest,
    observedAt.toISOString(),
    deadlineAt.toISOString(),
    JSON.stringify({ schemaVersion: 1, targetSha: binding.targetSha, label }),
  ])).rows[0].result;
}

async function currentBinding() {
  return (await pool.query(`
    SELECT binding_digest::text AS "bindingDigest",
           expectation_generation::text AS generation,
           instance_id AS "instanceId", source_sha AS "sourceSha",
           target_sha AS "targetSha", target_ref AS "targetRef",
           registered_at AS "registeredAt",
           registered_logical_time::text AS "registeredLogicalTime",
           heartbeat_sequence::text AS "heartbeatSequence",
           heartbeat_digest::text AS "heartbeatDigest",
           evaluated_through_logical_time::text AS "evaluatedThroughLogicalTime",
           state
      FROM executable_runtime_current_binding
  `)).rows;
}

before(async () => {
  const identity = (await pool.query(`
    SELECT current_database() AS database, current_user AS "user",
           current_setting('server_version') AS version,
           (SELECT system_identifier::text FROM pg_control_system()) AS "systemIdentifier"
  `)).rows[0];
  assert.equal(identity.database, EXPECTED_DATABASE);
  assert.equal(identity.user, EXPECTED_USER);
  assert.equal(identity.systemIdentifier, EXPECTED_SYSTEM_IDENTIFIER);
  Object.assign(evidence.postgres, identity, { connected: true });
  const fixtureRows = (await pool.query(`
    SELECT
      (SELECT count(*) FROM executable_runtime_binding_fact)::integer AS binding_facts,
      (SELECT count(*) FROM executable_runtime_binding)::integer AS bindings,
      (SELECT count(*) FROM executable_runtime_heartbeat)::integer AS heartbeats,
      (SELECT count(*) FROM executable_runtime_expectation)::integer AS expectations,
      (SELECT count(*) FROM project)::integer AS projects
  `)).rows[0];
  assert.deepEqual(fixtureRows, {
    binding_facts: 0,
    bindings: 0,
    heartbeats: 0,
    expectations: 0,
    projects: 0,
  }, 'disposable PostgreSQL was not empty before the lifecycle fixture');
  state.projectionBefore = await projectionSnapshot();
});

after(async () => {
  const projectionAfter = await projectionSnapshot();
  assert.deepEqual(projectionAfter, state.projectionBefore,
    'the lifecycle fixture wrote disposable outcome_projection tables');
  evidence.coverage.productionProjectionWrites = false;
  const finishedAt = new Date().toISOString();
  evidence.observationWindow.finishedAt = finishedAt;
  evidence.observationWindow.durationMilliseconds =
    Date.parse(finishedAt) - Date.parse(evidence.observationWindow.startedAt);
  evidence.outcome = Object.entries(evidence.coverage).every(([name, value]) =>
    name === 'productionProjectionWrites' ? value === false : value === true)
    ? 'PASS'
    : 'FAIL';
  await pool.end();
  mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
});

test('startup registration creates one current binding and obsoletes legacy identity', async () => {
  const legacyPayload = { schemaVersion: 1, fixture: 'legacy-watchdog' };
  await pool.query(`
    INSERT INTO executable_runtime_heartbeat(
      id, component, instance_id, sequence, source_sha, module_graph_digest,
      observed_at, deadline_at, payload, payload_digest, previous_digest,
      heartbeat_digest, expectation_generation
    ) VALUES (
      gen_random_uuid(), $1, $2, 1143, $3, $4,
      now() - interval '2 minutes', now() - interval '90 seconds', $5::jsonb,
      encode(digest($5::jsonb::text, 'sha256'), 'hex'), NULL, $6, NULL
    )
  `, [component, oldInstanceId, oldSourceSha, sha('legacy-module'),
    JSON.stringify(legacyPayload), oldHeartbeatDigest]);

  const started = Date.now();
  const generation = randomUUID();
  const instanceId = 'fixture:watchdog-a';
  const sourceSha = fullSha('watchdog-a');
  await expectGeneration({ instanceId, generation, sourceSha });
  const registered = await registerBinding({ instanceId, generation, sourceSha });
  const registrationMilliseconds = Date.now() - started;
  assert.ok(registrationMilliseconds >= 0 && registrationMilliseconds <= 2_000,
    `startup registration took ${registrationMilliseconds}ms`);
  assert.equal(registered.replayed, false);
  assert.equal(registered.obsoletedLegacyInstances, 1);
  const current = await currentBinding();
  assert.equal(current.length, 1);
  assert.equal(current[0].bindingDigest, registered.bindingDigest);
  const obsolete = (await pool.query(`
    SELECT fact_digest::text AS "factDigest", heartbeat_digest::text AS "heartbeatDigest",
           subject_instance_id AS "instanceId", subject_source_sha AS "sourceSha",
           superseded_by_binding_digest::text AS "supersededByBindingDigest"
      FROM executable_runtime_binding_fact
     WHERE kind = 'OBSOLETED' AND heartbeat_digest = $1
  `, [oldHeartbeatDigest])).rows;
  assert.deepEqual(obsolete.map((row) => [row.heartbeatDigest, row.instanceId, row.sourceSha,
    row.supersededByBindingDigest]), [[oldHeartbeatDigest, oldInstanceId, oldSourceSha,
    registered.bindingDigest]]);
  assert.equal((await pool.query(`
    SELECT count(*)::integer AS count FROM executable_runtime_heartbeat
     WHERE heartbeat_digest = $1
  `, [oldHeartbeatDigest])).rows[0].count, 1, 'legacy heartbeat history was removed');

  state.first = { instanceId, generation, sourceSha, targetSha: sourceSha,
    bindingDigest: registered.bindingDigest };
  evidence.observationWindow.startupRegistrationMilliseconds = registrationMilliseconds;
  evidence.samples.startupRegistrations = 1;
  evidence.samples.obsoleteLegacyFacts = obsolete.length;
  evidence.coverage.startupRegisteredWithinWindow = true;
  evidence.coverage.legacyHeartbeatExplicitlyObsolete = true;
  evidence.results.startup = { ...registered, registrationMilliseconds };
});

test('bound heartbeat facts advance evaluated-through watermark monotonically', async () => {
  const first = await appendHeartbeat(state.first, { label: 'first' });
  const second = await appendHeartbeat(state.first, { label: 'second' });
  assert.equal(first.bindingDigest, state.first.bindingDigest);
  assert.equal(second.bindingDigest, state.first.bindingDigest);
  assert.ok(BigInt(first.evaluatedThroughLogicalTime)
    > BigInt((await currentBinding())[0].registeredLogicalTime));
  assert.ok(BigInt(second.evaluatedThroughLogicalTime)
    > BigInt(first.evaluatedThroughLogicalTime));
  assert.equal(BigInt(second.sequence), BigInt(first.sequence) + 1n);
  const facts = (await pool.query(`
    SELECT logical_time::text AS "logicalTime", heartbeat_digest::text AS "heartbeatDigest"
      FROM executable_runtime_binding_fact
     WHERE kind = 'HEARTBEAT_INGESTED' AND binding_digest = $1
     ORDER BY logical_time
  `, [state.first.bindingDigest])).rows;
  assert.equal(facts.length, 2);
  assert.deepEqual(facts.map((row) => row.heartbeatDigest),
    [first.heartbeatDigest, second.heartbeatDigest]);
  evidence.samples.heartbeatAdvances = facts.length;
  evidence.coverage.heartbeatWatermarkMonotonic = true;
  evidence.results.heartbeat = { first, second };
});

test('rolling replacement preserves old facts and appends explicit supersession', async () => {
  const generation = randomUUID();
  const instanceId = 'fixture:watchdog-b';
  const sourceSha = fullSha('watchdog-b');
  const targetSha = fullSha('target-b');
  await expectGeneration({ instanceId, generation, sourceSha });
  const registered = await registerBinding({ instanceId, generation, sourceSha, targetSha });
  const current = await currentBinding();
  assert.equal(current.length, 1);
  assert.equal(current[0].bindingDigest, registered.bindingDigest);
  assert.equal(current[0].targetSha, targetSha);
  const prior = (await pool.query(`
    SELECT binding_digest::text AS "bindingDigest",
           count(*) FILTER (WHERE kind = 'CURRENT_REGISTERED')::integer AS registered,
           count(*) FILTER (WHERE kind = 'HEARTBEAT_INGESTED')::integer AS heartbeats,
           count(*) FILTER (WHERE kind = 'SUPERSEDED')::integer AS superseded
      FROM executable_runtime_binding_fact
     WHERE binding_digest = $1
     GROUP BY binding_digest
  `, [state.first.bindingDigest])).rows[0];
  assert.deepEqual(prior, {
    bindingDigest: state.first.bindingDigest,
    registered: 1,
    heartbeats: 2,
    superseded: 1,
  });
  assert.equal((await pool.query(`
    SELECT count(*)::integer AS count FROM executable_runtime_binding
  `)).rows[0].count, 2);
  const live = (await pool.query(`
    SELECT instance_id AS "instanceId" FROM executable_runtime_liveness
     WHERE component = 'outcome-watchdog'
  `)).rows;
  assert.deepEqual(live.map((row) => row.instanceId), [instanceId]);

  state.second = { instanceId, generation, sourceSha, targetSha,
    bindingDigest: registered.bindingDigest };
  evidence.samples.rollingReplacements = 1;
  evidence.coverage.rollingFactsPreserved = true;
  evidence.coverage.oldBindingExplicitlySuperseded = true;
  evidence.results.rolling = { current: current[0], prior };
});

test('two instance registrations serialize to exactly one current binding', async () => {
  const candidates = [
    {
      instanceId: 'fixture:watchdog-race-a', generation: randomUUID(),
      sourceSha: fullSha('race-a'), targetSha: fullSha('race-target-a'),
    },
    {
      instanceId: 'fixture:watchdog-race-b', generation: randomUUID(),
      sourceSha: fullSha('race-b'), targetSha: fullSha('race-target-b'),
    },
  ];
  await Promise.all(candidates.map((candidate) => expectGeneration(candidate)));
  const receipts = await Promise.all(candidates.map((candidate) => registerBinding(candidate)));
  const current = await currentBinding();
  assert.equal(current.length, 1);
  const winnerIndex = candidates.findIndex((candidate) =>
    candidate.generation === current[0].generation);
  assert.notEqual(winnerIndex, -1);
  const loserIndex = winnerIndex === 0 ? 1 : 0;
  state.winner = { ...candidates[winnerIndex], bindingDigest: receipts[winnerIndex].bindingDigest };
  state.loser = { ...candidates[loserIndex], bindingDigest: receipts[loserIndex].bindingDigest };
  const superseded = (await pool.query(`
    SELECT count(*)::integer AS count FROM executable_runtime_binding_fact
     WHERE kind = 'SUPERSEDED' AND binding_digest = $1
       AND superseded_by_binding_digest = $2
  `, [state.loser.bindingDigest, state.winner.bindingDigest])).rows[0].count;
  assert.equal(superseded, 1);
  await assert.rejects(
    appendHeartbeat(state.loser, { label: 'superseded-must-fail' }),
    /EXECUTABLE_RUNTIME_HEARTBEAT_BINDING_NOT_CURRENT/,
  );
  const healthy = await appendHeartbeat(state.winner, { label: 'race-winner' });
  assert.equal(healthy.bindingDigest, state.winner.bindingDigest);
  evidence.samples.dualInstanceRegistrations = receipts.length;
  evidence.coverage.dualInstanceExactlyOneCurrent = true;
  evidence.coverage.supersededInstanceCannotHeartbeat = true;
  evidence.results.race = {
    candidates: candidates.map((candidate, index) => ({
      ...candidate, bindingDigest: receipts[index].bindingDigest,
    })),
    winner: current[0],
  };
});

test('dead-man stales only current binding and project read never revives old heartbeat', async () => {
  const stale = await appendHeartbeat(state.winner, { stale: true, label: 'current-stale' });
  let current = await currentBinding();
  assert.deepEqual([current.length, current[0].bindingDigest, current[0].state],
    [1, state.winner.bindingDigest, 'WATCHDOG_STALE']);
  const deadMan = (await pool.query(`
    SELECT executable_runtime_record_expectation_observation(
      $1::text, $2::text, $3::uuid, 'WATCHDOG_STALE', $4::text,
      $5::text, $6::text
    ) AS result
  `, [
    component, state.winner.instanceId, state.winner.generation, stale.heartbeatDigest,
    fullSha('external-dead-man'), `watchdog-current-binding:stale:${stale.heartbeatDigest}`,
  ])).rows[0].result;
  assert.equal(deadMan.replayed, false);

  const ownerId = randomUUID();
  const projectId = randomUUID();
  await pool.query(`
    INSERT INTO "user"(id,email,name,password_hash)
    VALUES ($1,$2,'watchdog binding owner','x')
  `, [ownerId, `watchdog-binding-${ownerId}@acceptance.invalid`]);
  await pool.query(`
    INSERT INTO project(
      id, owner_id, title, goal, coordinator_enabled, automation_policy,
      max_concurrent_tasks, session_budget_per_day, updated_at
    ) VALUES ($1,$2,'watchdog binding project','verify current binding',true,
      'GUARDED_AUTO'::project_automation_policy,3,10,now())
  `, [projectId, ownerId]);
  await pool.query(`
    INSERT INTO outcome_fact_stream(tenant_id,project_id) VALUES ($1,$2)
  `, [ownerId, projectId]);

  const staleRead = (await pool.query(`
    SELECT executable_runtime_overlay_read_surface(
      project_canonical_done_gate($1::uuid, 'PROJECT', $1::text), 'DONE_GATE'
    ) AS result
  `, [projectId])).rows[0].result;
  const staleJson = JSON.stringify(staleRead);
  assert.doesNotMatch(staleJson, new RegExp(oldInstanceId.replaceAll(':', '\\:')));
  assert.doesNotMatch(staleJson, new RegExp(oldHeartbeatDigest));
  assert.equal(staleRead.runtimeBindings.length, 1);
  assert.equal(staleRead.runtimeBindings[0].bindingDigest, state.winner.bindingDigest);
  assert.equal(staleRead.runtimeLiveness.length, 1);
  assert.equal(staleRead.runtimeLiveness[0].binding.bindingDigest,
    state.winner.bindingDigest);

  const recoveredHeartbeat = await appendHeartbeat(state.winner, { label: 'current-recovered' });
  const recovery = (await pool.query(`
    SELECT executable_runtime_record_expectation_observation(
      $1::text, $2::text, $3::uuid, 'WATCHDOG_RECOVERED', $4::text,
      $5::text, $6::text
    ) AS result
  `, [
    component, state.winner.instanceId, state.winner.generation,
    recoveredHeartbeat.heartbeatDigest, fullSha('external-dead-man'),
    `watchdog-current-binding:recovered:${recoveredHeartbeat.heartbeatDigest}`,
  ])).rows[0].result;
  assert.equal(recovery.replayed, false);
  current = await currentBinding();
  assert.equal(current[0].state, 'HEALTHY');
  const recoveredRead = (await pool.query(`
    SELECT executable_runtime_overlay_read_surface(
      project_canonical_done_gate($1::uuid, 'PROJECT', $1::text), 'DONE_GATE'
    ) AS result
  `, [projectId])).rows[0].result;
  const recoveredJson = JSON.stringify(recoveredRead);
  assert.doesNotMatch(recoveredJson, new RegExp(oldInstanceId.replaceAll(':', '\\:')));
  assert.doesNotMatch(recoveredJson, new RegExp(oldHeartbeatDigest));
  assert.deepEqual(recoveredRead.runtimeLiveness ?? [], []);
  assert.equal(recoveredRead.runtimeBindings.length, 1);
  assert.equal(recoveredRead.runtimeBindings[0].state, 'HEALTHY');
  assert.equal(recoveredRead.reason.code, 'CURRENT_BINDING_MISSING',
    'the remaining canonical model gap must not be misreported as the old runtime heartbeat');

  await assert.rejects(
    pool.query(`UPDATE executable_runtime_binding_fact SET logical_time = 999 WHERE true`),
    /append.only/i,
  );
  await assert.rejects(
    pool.query(`DELETE FROM executable_runtime_heartbeat WHERE heartbeat_digest = $1`,
      [oldHeartbeatDigest]),
    /append.only/i,
  );

  evidence.samples.staleDerivations = 1;
  evidence.samples.projectAcceptanceReads = 2;
  evidence.coverage.deadManDerivesCurrentStale = true;
  evidence.coverage.recoveryClearsCurrentStale = true;
  evidence.coverage.projectReadExcludesOldHeartbeat = true;
  evidence.coverage.appendOnlyHistoryEnforced = true;
  evidence.results.deadMan = {
    staleHeartbeat: stale,
    staleEvent: deadMan,
    recoveredHeartbeat,
    recoveryEvent: recovery,
    currentBinding: current[0],
    projectRead: {
      staleReason: staleRead.reason.code,
      recoveredReason: recoveredRead.reason.code,
      oldInstancePresent: false,
      oldHeartbeatPresent: false,
    },
  };
});
