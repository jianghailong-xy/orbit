import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';

// Independent v1.4 review. These assertions deliberately prove that the published counterexamples
// are reachable; they are evidence tests, not implementation tests that may rewrite the contract
// until they turn green. Every PostgreSQL fixture lives in pcc_v14_review inside a disposable,
// identity-pinned database (coordinator-pg-test-safety.ts).
const REPO = path.resolve(__dirname, '../../../..');
const CONTRACT = readFileSync(path.join(REPO, 'docs/project-coordinator-contract.md'), 'utf8');
const PG_URL = process.env.COORDINATOR_PG_URL;

function section(number: string): string {
  const escaped = number.replace('.', '\\.');
  const start = new RegExp(`^##(?:#)?\\s+${escaped}(?:\\s|\\.)`, 'm').exec(CONTRACT);
  assert.ok(start, `section ${number} is missing`);
  const level = CONTRACT.slice(start.index).match(/^#+/)?.[0].length ?? 2;
  const rest = CONTRACT.slice(start.index + start[0].length);
  const end = new RegExp(`^#{1,${level}}\\s+\\d`, 'm').exec(rest);
  return CONTRACT.slice(start.index, end ? start.index + start[0].length + end.index : undefined);
}

test('PC-CX-28: lowering the cap after an admitted dispatch violates the frozen hard invariant', () => {
  // AU1-a explicitly permits this order: the coordinator commits under max=2, then the human
  // update "takes effect". Nothing in §9.6 makes the cap writer count or reject existing claims.
  const state = { maxConcurrentTasks: 2, inFlight: 1 };
  assert.ok(state.inFlight < state.maxConcurrentTasks);
  state.inFlight += 1; // coordinator-first admission is legal under the row lock
  state.maxConcurrentTasks = 1; // the queued human write then takes effect, per AU1-a

  assert.ok(state.inFlight > state.maxConcurrentTasks,
    'the shared lock orders the writes but cannot make a later cap decrease preserve inFlight <= max');
  assert.match(section('9.6'), /任何顺序下[^\n]*≤ `max_concurrent_tasks`/,
    'CAP3 is the invariant contradicted by this legal order');
});

test('PC-CX-29: commit-time recheck omits PAC execution-context revocation', () => {
  const snapshot = {
    coordinatorEnabled: true,
    automationPolicy: 'AUTO',
    maxConcurrentTasks: 3,
    assigneeEnabled: true,
  };
  const atCommit = { ...snapshot, assigneeEnabled: false };

  // AU1 replays only §9.2 plus §7.4 steps 6/7. Step 8 (resolveExecutionContext) is not replayed,
  // so all fields it actually checks still allow the stale action after the assignee is disabled.
  const au1Allows = atCommit.coordinatorEnabled && atCommit.automationPolicy === 'AUTO' &&
    atCommit.maxConcurrentTasks > 0;
  assert.equal(au1Allows, true);
  assert.equal(atCommit.assigneeEnabled, false);

  const gate = section('9.6');
  assert.match(gate, /重跑 §9\.2 与 §7\.4 的第 6、7 条/);
  assert.doesNotMatch(gate, /重跑[^\n]*第 8 条/,
    'the commit gate does not re-resolve agent/provider/workspace/runner authority');
  assert.match(section('4.3'), /\*\*I7（无越权）/,
    'the reachable stale dispatch contradicts the contract own no-escalation invariant');
});

test('PC-CX-30: the declared decision input omits action and turn history read by its own rules', () => {
  const input = section('6.1');
  const world = /"world"\s*:\s*\{([\s\S]*?)\n\s*\},\n\n\s*"evaluation"/.exec(input)?.[1] ?? '';
  assert.ok(world.length > 0, 'could not isolate the frozen world projection');
  assert.doesNotMatch(world, /"(?:project_)?actions?"\s*:/,
    'project_action history is absent from the declared world projection');

  // Yet guard 4 needs an unsettled acceptance action, while TR2/TR3 need prior turn action time,
  // identity and completion. Two database states therefore serialize to the same declared input
  // but require different state/action outcomes.
  assert.match(section('4.2'), /未收敛的 `RUN_PROJECT_ACCEPTANCE` 动作/);
  assert.match(section('7.6'), /同一 `\(generation, reasonCode\)` 在 \*\*60 秒\*\*内至多一次/);
  assert.match(section('7.6'), /上一次 turn \*\*还在飞\*\*/);

  const declaredInput = { project: { status: 'OPEN' }, tasks: [], blockers: [], sessions: [] };
  const runState = (_input: typeof declaredInput, hiddenAcceptanceAction: boolean): string =>
    hiddenAcceptanceAction ? 'ACCEPTANCE' : 'PLANNING';
  assert.deepEqual(declaredInput, structuredClone(declaredInput));
  assert.notEqual(runState(declaredInput, false), runState(declaredInput, true),
    'one declared decision input has two required run states depending on an undeclared row');
});

test('PC-CX-31: a rate-limited semantic turn has no durable recovery rule', () => {
  const turnRules = section('7.6');
  assert.match(turnRules, /TR2（限频/);

  const timing = section('10.4');
  const wakeList = timing.slice(timing.indexOf('取所有**适用项的最小值**'), timing.indexOf('**N-null'));
  assert.doesNotMatch(wakeList, /TR2|reasonCode|turn[^\n]*60s/,
    'the nextWakeAt closed list has no wake at the turn rate-limit boundary');

  // A second explicit manual request can have a fresh dedupe key but arrive 10s after the first.
  // TR2 refuses a new MANUAL turn. If its event is consumed, no fact preserves the request; if it
  // is left unconsumed, the contract supplies no nextAttemptAt/nextWakeAt rule for the 50s wait.
  const secondRequest = { signal: 'manual:request-2', secondsSinceLastManualTurn: 10 };
  const rateLimited = secondRequest.secondsSinceLastManualTurn < 60;
  assert.equal(rateLimited, true);
  const specifiedRecovery = wakeList.includes('TR2') || wakeList.includes('reasonCode');
  assert.equal(specifiedRecovery, false,
    'the manual request has neither a persistent pending state nor a deterministic wake at t+60s');
});

type ClientCtor = new (config: { connectionString?: string }) => Client;
async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(PG_URL);
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const client = new Ctor({ connectionString: PG_URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

async function resetPgFixture(client: Client): Promise<void> {
  await client.query('DROP SCHEMA IF EXISTS pcc_v14_review CASCADE');
  await client.query('CREATE SCHEMA pcc_v14_review');
  await client.query('SET search_path TO pcc_v14_review, public');
  await client.query(`
    CREATE TABLE project (
      id text PRIMARY KEY,
      coordinator_enabled boolean NOT NULL,
      automation_policy text NOT NULL,
      max_concurrent_tasks integer NOT NULL
    );
    CREATE TABLE agent_member (id text PRIMARY KEY, enabled boolean NOT NULL);
    CREATE TABLE task (
      id text PRIMARY KEY,
      project_id text NOT NULL REFERENCES project(id),
      assignee_id text NOT NULL REFERENCES agent_member(id)
    );
    CREATE TABLE session (
      id text PRIMARY KEY,
      task_id text NOT NULL REFERENCES task(id),
      resolved_agent_id text NOT NULL,
      status text NOT NULL
    );
  `);
}

test('PC-CX-28 on isolated Postgres: coordinator-first then cap-lower commits inFlight above cap',
  { skip: PG_URL ? false : 'set COORDINATOR_PG_URL and the three expected identity variables to run' }, async () => {
    const setup = await connect();
    const loop = await connect();
    const human = await connect();
    try {
      await resetPgFixture(setup);
      for (const c of [loop, human]) await c.query('SET search_path TO pcc_v14_review, public');
      await setup.query(`
        INSERT INTO project VALUES ('p1', true, 'AUTO', 2);
        INSERT INTO agent_member VALUES ('a1', true);
        INSERT INTO task VALUES ('t0', 'p1', 'a1'), ('t1', 'p1', 'a1');
        INSERT INTO session VALUES ('s0', 't0', 'a1', 'RUNNING');
      `);

      await loop.query('BEGIN');
      const cap = (await loop.query<{ max_concurrent_tasks: number }>(
        `SELECT max_concurrent_tasks FROM project WHERE id = 'p1' FOR NO KEY UPDATE`)).rows[0].max_concurrent_tasks;
      const before = Number((await loop.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM session s JOIN task t ON t.id=s.task_id
          WHERE t.project_id='p1' AND s.status IN ('PENDING','RUNNING')`)).rows[0].n);
      assert.ok(before < cap);
      await loop.query(`INSERT INTO session VALUES ('s1', 't1', 'a1', 'PENDING')`);
      await loop.query('COMMIT');

      // AU1-a says a human write queued after the coordinator may take effect without another gate.
      await human.query(`UPDATE project SET max_concurrent_tasks = 1 WHERE id = 'p1'`);
      const final = (await setup.query<{ max: number; n: string }>(`
        SELECT p.max_concurrent_tasks AS max, count(s.id)::text AS n
          FROM project p JOIN task t ON t.project_id=p.id JOIN session s ON s.task_id=t.id
         WHERE p.id='p1' AND s.status IN ('PENDING','RUNNING') GROUP BY p.max_concurrent_tasks
      `)).rows[0];
      assert.equal(Number(final.n), 2);
      assert.equal(final.max, 1);
      assert.ok(Number(final.n) > final.max, 'the committed state violates I16/CAP3');
    } finally {
      await Promise.all([setup.end(), loop.end(), human.end()]);
    }
  });

test('PC-CX-29 on isolated Postgres: disabling the assignee does not conflict with the AU1 project gate',
  { skip: PG_URL ? false : 'set COORDINATOR_PG_URL and the three expected identity variables to run' }, async () => {
    const setup = await connect();
    const loop = await connect();
    const human = await connect();
    try {
      await resetPgFixture(setup);
      for (const c of [loop, human]) await c.query('SET search_path TO pcc_v14_review, public');
      await setup.query(`
        INSERT INTO project VALUES ('p1', true, 'AUTO', 2);
        INSERT INTO agent_member VALUES ('a1', true);
        INSERT INTO task VALUES ('t1', 'p1', 'a1');
      `);

      const snapshotEnabled = (await loop.query<{ enabled: boolean }>(
        `SELECT enabled FROM agent_member WHERE id='a1'`)).rows[0].enabled;
      assert.equal(snapshotEnabled, true);
      await human.query(`UPDATE agent_member SET enabled=false WHERE id='a1'`);

      await loop.query('BEGIN');
      const gate = (await loop.query<{ coordinator_enabled: boolean; automation_policy: string }>(
        `SELECT coordinator_enabled, automation_policy FROM project WHERE id='p1' FOR NO KEY UPDATE`)).rows[0];
      assert.deepEqual(gate, { coordinator_enabled: true, automation_policy: 'AUTO' });
      await loop.query(`INSERT INTO session VALUES ('stale-dispatch', 't1', 'a1', 'PENDING')`);
      await loop.query('COMMIT');

      const final = (await setup.query<{ enabled: boolean; sessions: string }>(`
        SELECT a.enabled, count(s.id)::text AS sessions
          FROM agent_member a LEFT JOIN session s ON s.resolved_agent_id=a.id
         WHERE a.id='a1' GROUP BY a.enabled
      `)).rows[0];
      assert.equal(final.enabled, false);
      assert.equal(Number(final.sessions), 1,
        'the stated gate allows a new session resolved to an agent the user already disabled');
    } finally {
      await Promise.all([setup.end(), loop.end(), human.end()]);
    }
  });
