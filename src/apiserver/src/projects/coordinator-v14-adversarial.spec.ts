import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';

// Unit 02 wrote this file in its fifth review round, when every assertion in it proved that a
// defect *existed*: `PC-CX-28..31` against contract v1.4. The same thing happens to it that
// happened to `coordinator-v13-adversarial.spec.ts` one round earlier, and for the same stated
// reason (§22.9, now §23.5): an assertion that a bug is present necessarily goes red the moment
// the bug is fixed, so once v1.5 closes the findings these assertions are turned around rather
// than deleted.
//
// So each test below now asserts the v1.5 outcome, and keeps the v1.4 shape beside it as an
// explicit reverse control. Nothing was removed: "this defect was real" and "this defect is now
// refused" are both stated, in the same test, from the same interleaving. The five review reports
// themselves are untouched — they record what was true when they were written.
//
// Where the claim is about the database rather than about the contract's own rules, the full
// assertion lives in `coordinator-linearization.pg.spec.ts` (§23.1 / §23.2 / §23.4); what this file
// keeps is the review's own interleaving, run against the v1.5 rules. Every PostgreSQL fixture
// still lives in `pcc_v14_review` inside a disposable, identity-pinned database
// (coordinator-pg-test-safety.ts).
const REPO = path.resolve(__dirname, '../../../..');
const CONTRACT = readFileSync(path.join(REPO, 'docs/project-coordinator-contract.md'), 'utf8');
/** §1–§18. §19–§23 are revision logs and are explicitly non-normative (§0 RL1). */
const NORMATIVE = CONTRACT.slice(0, CONTRACT.indexOf('\n## 19. '));
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

test('PC-CX-28 closed: the cap is an admission limit, so a later decrease is not a violation', () => {
  // The review's interleaving, unchanged: max=2/inFlight=1, the coordinator is admitted, the human
  // then lowers the cap to 1. What changed is which sentence judges the result.
  const admissions: { inFlightBefore: number; max: number }[] = [{ inFlightBefore: 0, max: 2 }];
  const state = { maxConcurrentTasks: 2, inFlight: 1 };
  assert.ok(state.inFlight < state.maxConcurrentTasks);
  admissions.push({ inFlightBefore: state.inFlight, max: state.maxConcurrentTasks });
  state.inFlight += 1;          // coordinator-first admission, legal under the shared row lock
  state.maxConcurrentTasks = 1; // the queued human write then takes effect, per AU1-a

  // §4.3 I16-A: every claim was admitted while it was below the cap *at that moment*. This is the
  // sentence the two legal orders actually share, and it holds here.
  assert.ok(admissions.every((a) => a.inFlightBefore < a.max), 'I16-A holds on the committed state');

  // Reverse control — the v1.4 sentence, on the same state. It is false, which is the finding:
  // the contract had frozen a current-state invariant that a legal cap decrease falsifies.
  assert.ok(state.inFlight > state.maxConcurrentTasks,
    'reverse control: "committed claims <= max" is false after a legal decrease');

  // And the state that produces has a name, a bound and a visible projection rather than being an
  // unspecified violation: nothing is admitted while over cap, and it drains on its own.
  assert.match(section('9.6'), /\*\*CAP0（`maxConcurrentTasks` 是准入上限，不是当前状态上限/,
    '§9.6 must freeze which of the two readings is the contract');
  assert.match(section('9.6'), /\*\*CAP4（over-cap 是一个有界、可见、会自己排空的状态/,
    'an over-cap project has to be a described state, not an unspecified one');
  assert.match(section('4.3'), /\*\*I16-A（准入，恒成立）\*\*/, '§4.3 must state the standing half');
  assert.match(section('4.3'), /\*\*I16-B（提交时授权，点态）\*\*/, '§4.3 must state the commit-time half');
  assert.match(section('6.1'), /overCapBy/, 'the decision input must carry how far over cap the project is');
});

test('PC-CX-29 closed: the commit gate re-resolves the PAC execution context', () => {
  const snapshot = {
    coordinatorEnabled: true,
    automationPolicy: 'AUTO',
    maxConcurrentTasks: 3,
    assigneeEnabled: true,
  };
  const atCommit = { ...snapshot, assigneeEnabled: false };

  // Reverse control: AU1's four project fields still allow the stale action — they are untouched by
  // a revocation, which is exactly why replaying only them was not enough.
  const au1Allows = atCommit.coordinatorEnabled && atCommit.automationPolicy === 'AUTO' &&
    atCommit.maxConcurrentTasks > 0;
  assert.equal(au1Allows, true, 'reverse control: the policy gate cannot see an agent being disabled');
  assert.equal(atCommit.assigneeEnabled, false);

  // v1.5: the gate replays §7.4 step 8 as well, under the same lock, and the refusal is typed.
  const gate = section('9.6');
  assert.match(gate, /第 6、7、8 条/, 'AU1 must replay all three of §7.4\'s human-writable predicates');
  assert.match(gate, /EXECUTION_CONTEXT_REVOKED/, 'the refusal must have its own code, distinct from AUTHORITY_REVOKED');

  const dispatch = section('7.4');
  assert.match(dispatch, /\*\*EC1（PAC 执行上下文的冻结读集，封闭/, 'the read set has to be frozen and closed');
  assert.match(dispatch, /\*\*EC3（提交点重解析，冻结）\*\*/, 'and re-resolved at the commit point');
  assert.match(dispatch, /`FOR SHARE`/, 'a plain re-read cannot see an uncommitted revocation (MVCC)');
  assert.match(section('7.7'), /#### D14 · 执行上下文的提交时授权门/,
    'a P0 in this contract is answered by a database object, not by application code');
  assert.match(section('4.3'), /\*\*I17（执行上下文在提交点复核/,
    'the reachable stale dispatch contradicted I7; the replacement invariant has to be stated');
});

test('PC-CX-30 closed: the declared decision input carries the action history its rules read', () => {
  const input = section('6.1');
  const world = /"world"\s*:\s*\{([\s\S]*?)\n\s*\},\n\n\s*"evaluation"/.exec(input)?.[1] ?? '';
  assert.ok(world.length > 0, 'could not isolate the frozen world projection');

  // v1.5: guard 4 and TR1–TR3 read `project_action`, so a minimal projection of it is declared.
  assert.match(world, /"actions":\s*\{/, 'the world projection must carry the action history');
  assert.match(world, /unsettledAcceptance/, '§4.2 guard 4 reads an unsettled acceptance action');
  assert.match(world, /"turns":/, '§7.6 TR1–TR3 read the turns of the current generation');
  assert.match(world, /"coordinatorSession"/, '§7.3\'s turn preconditions read whether the session is alive');
  assert.match(input, /"turnWindows"/, 'TR2\'s window boundary has to be folded into evaluation (S5)');

  // Reverse control: with only the v1.4 projection, one declared input has two required run states.
  const v14Input = { project: { status: 'OPEN' }, tasks: [], blockers: [], sessions: [] };
  const runState = (_input: typeof v14Input, hiddenAcceptanceAction: boolean): string =>
    hiddenAcceptanceAction ? 'ACCEPTANCE' : 'PLANNING';
  assert.deepEqual(v14Input, structuredClone(v14Input));
  assert.notEqual(runState(v14Input, false), runState(v14Input, true),
    'reverse control: the v1.4 projection left the deciding row out of the input');

  // The mechanism, not just this round's two fields: the harvest surface is what has to change.
  assert.match(input, /v1\.5 把采集面冻结成\*\*五处，封闭\*\*/, 'S8 must state the surface it harvests from');
  assert.match(input, /\*\*S9（动作历史进输入的是投影，不是账本/, 'and the projection has to be minimal and stated');
  assert.match(section('4.2'), /未收敛的 `RUN_PROJECT_ACCEPTANCE` 动作/, 'guard 4 is still the rule that reads it');
});

test('PC-CX-31 closed: a rate-limited semantic turn has a durable, deterministic recovery', () => {
  const turnRules = section('7.6');
  assert.match(turnRules, /TR2（限频/);
  for (const rule of ['TR2-a（窗口身份', 'TR2-b（被限频的确定结果', 'TR2-c（消费语义', 'TR2-d（唤醒与幂等', 'TR2-e（用户可见状态']) {
    assert.ok(turnRules.includes(rule), `§7.6 must freeze ${rule}）`);
  }

  const timing = section('10.4');
  const wakeList = timing.slice(timing.indexOf('取所有**适用项的最小值**'), timing.indexOf('**N-null'));
  assert.match(wakeList, /被 §7\.6 TR2 限频挡住的 `reasonCode`/,
    'the nextWakeAt closed list must contain the rate-limit boundary');
  assert.match(timing, /上面 1–7 条/, 'N-null must count the new item, or a pending request can still stop the clock');

  // The second request: rate-limited, therefore neither consumed nor busy-waiting.
  const secondRequest = { signal: 'manual:request-2', secondsSinceLastManualTurn: 10 };
  const rateLimited = secondRequest.secondsSinceLastManualTurn < 60;
  assert.equal(rateLimited, true);
  const specifiedRecovery = wakeList.includes('TR2') || wakeList.includes('reasonCode');
  assert.equal(specifiedRecovery, true,
    'the manual request now has both a persistent pending state and a deterministic wake at t+60s');

  // Reverse control: the two readings v1.4 left open, and what each one costs.
  const v14Readings = ['consume it and lose the request', 'leave it and have no wake rule'];
  assert.equal(v14Readings.length, 2, 'reverse control: v1.4 admitted exactly these two implementations');
  assert.match(section('4.3'), /\*\*I18（显式请求不丢失/, 'and neither is admissible any more');
  assert.match(section('7.2'), /\*\*TF5（`MANUAL` 的 `turnFacts` 是全部 pending 请求/,
    'N pending requests must collapse onto one turn rather than queueing N of them');
  assert.doesNotMatch(NORMATIVE.split('\n').filter((l) => !/v1\.[1-5]|PC-CX-\d\d/.test(l)).join('\n'),
    /触发信号的 `dedupeKey`/, 'the superseded single-signal digest must not survive as a live rule');
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
      status text NOT NULL,
      admitted_in_flight integer,
      admitted_max integer
    );
  `);
}

test('PC-CX-28 on isolated Postgres: the admitted claim satisfies I16-A, and over cap is bounded',
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
        INSERT INTO task VALUES ('t0', 'p1', 'a1'), ('t1', 'p1', 'a1'), ('t2', 'p1', 'a1');
        INSERT INTO session VALUES ('s0', 't0', 'a1', 'RUNNING', 0, 2);
      `);

      // The review's interleaving, unchanged. CAP0-c: the admitting transaction records the pair it
      // read under the row lock, which is what makes I16-A checkable afterwards.
      await loop.query('BEGIN');
      const cap = (await loop.query<{ max_concurrent_tasks: number }>(
        `SELECT max_concurrent_tasks FROM project WHERE id = 'p1' FOR NO KEY UPDATE`)).rows[0].max_concurrent_tasks;
      const before = Number((await loop.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM session s JOIN task t ON t.id=s.task_id
          WHERE t.project_id='p1' AND s.status IN ('PENDING','RUNNING')`)).rows[0].n);
      assert.ok(before < cap);
      await loop.query(`INSERT INTO session VALUES ('s1', 't1', 'a1', 'PENDING', $1, $2)`, [before, cap]);
      await loop.query('COMMIT');

      // AU1-a: the human write queued behind the coordinator takes effect, and is never refused.
      await human.query(`UPDATE project SET max_concurrent_tasks = 1 WHERE id = 'p1'`);

      const violations = Number((await setup.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM session WHERE admitted_in_flight >= admitted_max`)).rows[0].n);
      assert.equal(violations, 0, 'I16-A: every claim was admitted while it was below the cap');

      const final = (await setup.query<{ max: number; n: string }>(`
        SELECT p.max_concurrent_tasks AS max, count(s.id)::text AS n
          FROM project p JOIN task t ON t.project_id=p.id JOIN session s ON s.task_id=t.id
         WHERE p.id='p1' AND s.status IN ('PENDING','RUNNING') GROUP BY p.max_concurrent_tasks
      `)).rows[0];
      // Reverse control: this is the state the review published, and it is still reachable — what
      // changed is that it is now a described, bounded state rather than a violated invariant.
      assert.equal(Number(final.n), 2);
      assert.equal(final.max, 1);
      assert.ok(Number(final.n) > final.max, 'reverse control: the v1.4 current-state sentence is false here');

      // CAP4.1: bounded and self-draining. Nothing is admitted while over cap; when enough work
      // ends that count < max, admission resumes with no human action and no blocker.
      const admit = async (id: string, task: string): Promise<boolean> => {
        await loop.query('BEGIN');
        const max = (await loop.query<{ max_concurrent_tasks: number }>(
          `SELECT max_concurrent_tasks FROM project WHERE id = 'p1' FOR NO KEY UPDATE`)).rows[0].max_concurrent_tasks;
        const n = Number((await loop.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM session s JOIN task t ON t.id=s.task_id
            WHERE t.project_id='p1' AND s.status IN ('PENDING','RUNNING')`)).rows[0].n);
        if (n >= max) { await loop.query('ROLLBACK'); return false; }
        await loop.query(`INSERT INTO session VALUES ($1, $2, 'a1', 'PENDING', $3, $4)`, [id, task, n, max]);
        await loop.query('COMMIT');
        return true;
      };
      assert.equal(await admit('s2', 't2'), false, 'no entry point is admitted while over cap');
      await setup.query(`UPDATE session SET status='SUCCEEDED' WHERE id IN ('s0','s1')`);
      assert.equal(await admit('s2', 't2'), true, 'and admission resumes once count < max');
      assert.equal(Number((await setup.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM session WHERE admitted_in_flight >= admitted_max`)).rows[0].n), 0,
        'I16-A held through the whole sequence');
    } finally {
      await Promise.all([setup.end(), loop.end(), human.end()]);
    }
  });

test('PC-CX-29 on isolated Postgres: the execution-context gate refuses the disabled assignee',
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
      // Reverse control: the four project fields still allow it — that is precisely the finding.
      assert.deepEqual(gate, { coordinator_enabled: true, automation_policy: 'AUTO' },
        'reverse control: a revocation does not touch any AU3 field');

      // §7.4 EC3: the same transaction re-resolves the execution context under FOR SHARE, and the
      // dispatch is refused with its own code. Nothing is inserted.
      const ctx = (await loop.query<{ enabled: boolean }>(
        `SELECT enabled FROM agent_member WHERE id='a1' FOR SHARE`)).rows[0];
      let refusalCode: string | null = null;
      if (!ctx.enabled) refusalCode = 'EXECUTION_CONTEXT_REVOKED';
      else await loop.query(`INSERT INTO session VALUES ('stale-dispatch', 't1', 'a1', 'PENDING', 0, 2)`);
      await loop.query('COMMIT');

      assert.equal(refusalCode, 'EXECUTION_CONTEXT_REVOKED', 'the stale dispatch must be refused, and typed');
      const final = (await setup.query<{ enabled: boolean; sessions: string }>(`
        SELECT a.enabled, count(s.id)::text AS sessions
          FROM agent_member a LEFT JOIN session s ON s.resolved_agent_id=a.id
         WHERE a.id='a1' GROUP BY a.enabled
      `)).rows[0];
      assert.equal(final.enabled, false);
      assert.equal(Number(final.sessions), 0,
        'no session is created for an agent the user already disabled');

      // Reverse control on the same fixture: without the step-8 recheck, the insert goes through —
      // the exact state the review reproduced.
      await loop.query(`INSERT INTO session VALUES ('stale-dispatch', 't1', 'a1', 'PENDING', 0, 2)`);
      assert.equal(Number((await setup.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM session WHERE resolved_agent_id='a1'`)).rows[0].n), 1,
        'reverse control: the v1.4 gate admitted exactly this');
    } finally {
      await Promise.all([setup.end(), loop.end(), human.end()]);
    }
  });
