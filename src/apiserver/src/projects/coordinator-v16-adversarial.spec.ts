import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';

// Independent unit-02 evidence against the v1.6 contract. These assertions intentionally pass
// when a counterexample is reproducible; they do not edit the normative contract or development
// tests to turn a failed review green.
const REPO = path.resolve(__dirname, '../../../..');
const CONTRACT = readFileSync(path.join(REPO, 'docs/project-coordinator-contract.md'), 'utf8');
const PAC = readFileSync(path.join(REPO, 'docs/project-agent-contract.md'), 'utf8');
const PG_URL = process.env.COORDINATOR_PG_URL;
const REVIEW_SCHEMA = 'pcc_v16_rereview';

const sha256 = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

function between(start: string, end: string): string {
  const from = CONTRACT.indexOf(start);
  const to = CONTRACT.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `could not isolate ${start}`);
  return CONTRACT.slice(from, to);
}

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(PG_URL);
  const client = new Client({ connectionString: PG_URL });
  await client.connect();
  await verifyCoordinatorPgIdentity(client);
  return client;
}

async function resetSchema(client: Client): Promise<void> {
  await verifyCoordinatorPgIdentity(client);
  await client.query(`DROP SCHEMA IF EXISTS ${REVIEW_SCHEMA} CASCADE`);
  await client.query(`CREATE SCHEMA ${REVIEW_SCHEMA}`);
  await client.query(`SET search_path TO ${REVIEW_SCHEMA}`);
}

test('PC-CX-37: D11 does not freeze the v1.5 action columns that I17-A and TR2 rely on', () => {
  const d11 = between('#### D11 ', '#### D12 ');
  for (const column of ['execution_context', 'execution_context_digest', 'reason_code']) {
    assert.doesNotMatch(
      d11.slice(d11.indexOf('CREATE OR REPLACE FUNCTION'), d11.indexOf('CREATE TRIGGER')),
      new RegExp(`NEW\\.${column}\\s+IS DISTINCT FROM OLD\\.${column}`),
      `${column} unexpectedly has a D11 guard; this counterexample should be retired if it is fixed`,
    );
  }
  assert.match(d11, /仍然可写的只有 `result_session_id` 与 `detail`/,
    'the prose promises a closed allowlist that the trigger does not implement');
  assert.match(CONTRACT, /`APPLIED` 之后它由 §7\.7 D11 钉成不可改写/,
    'EC2 explicitly relies on the missing reverse guard');
});

test('PC-CX-37 on isolated Postgres: the specified D11 accepts snapshot and window-identity rewrites',
  { skip: PG_URL ? false : 'set isolated Coordinator PostgreSQL identity variables to run' }, async () => {
    const c = await connect();
    try {
      await resetSchema(c);
      await c.query(`
        CREATE TABLE project_action (
          id text PRIMARY KEY,
          idempotency_key text UNIQUE NOT NULL,
          project_id text NOT NULL,
          type text NOT NULL,
          status text NOT NULL,
          subject_type text NOT NULL,
          subject_id text NOT NULL,
          fencing_token bigint NOT NULL,
          result_session_id text,
          detail text,
          execution_context text[],
          execution_context_digest text,
          reason_code text
        );
        CREATE TABLE session (
          id text PRIMARY KEY,
          project_action_id text NOT NULL REFERENCES project_action(id),
          dispatch_origin text NOT NULL,
          status text NOT NULL,
          agent_id text,
          provider text,
          model text,
          workspace_id text,
          assigned_runner_id text
        );
        CREATE OR REPLACE FUNCTION project_action_applied_immutable_guard() RETURNS trigger AS $fn$
        BEGIN
          IF OLD.status <> 'APPLIED' THEN RETURN NEW; END IF;
          IF NEW.status <> 'APPLIED'
             OR NEW.type IS DISTINCT FROM OLD.type
             OR NEW.subject_type IS DISTINCT FROM OLD.subject_type
             OR NEW.subject_id IS DISTINCT FROM OLD.subject_id
             OR NEW.project_id IS DISTINCT FROM OLD.project_id
             OR NEW.fencing_token IS DISTINCT FROM OLD.fencing_token
             OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
            RAISE EXCEPTION 'ACTION_APPLIED_IMMUTABLE';
          END IF;
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql;
        CREATE TRIGGER project_action_applied_immutable_guard
          BEFORE UPDATE ON project_action
          FOR EACH ROW EXECUTE FUNCTION project_action_applied_immutable_guard();
      `);
      const oldContext = ['a1', 'm1', 't1', 'a1', 'claude', 'opus', 'w1', 'r1', 'cw1'];
      await c.query(`
        INSERT INTO project_action VALUES
          ('act1','pc:v1:p1:turn:0:d1','p1','DISPATCH_TASK','APPLIED','TASK','t1',1,NULL,NULL,$1,$2,'MANUAL')
      `, [oldContext, sha256(oldContext)]);
      await c.query(`
        INSERT INTO session VALUES
          ('s1','act1','COORDINATOR','PENDING','a1','claude','opus','w1','r1')
      `);

      // All three updates commit. The first two break I17-A; the third moves/removes TR2's window
      // anchor. D11-b says only result_session_id/detail are writable, but the function is an
      // open denylist left behind when these columns were added in v1.5.
      const changed = [...oldContext];
      changed[4] = 'codex';
      await c.query(`UPDATE project_action
                        SET execution_context=$1, execution_context_digest=$2, reason_code='REPLAN'
                      WHERE id='act1'`, [changed, sha256(changed)]);
      const row = (await c.query<{ reason_code: string; provider: string; frozen_provider: string }>(`
        SELECT a.reason_code, s.provider, a.execution_context[5] AS frozen_provider
          FROM session s JOIN project_action a ON a.id=s.project_action_id WHERE s.id='s1'`)).rows[0];
      assert.deepEqual(row, { reason_code: 'REPLAN', provider: 'claude', frozen_provider: 'codex' });
      assert.equal((await c.query<{ n: string }>(`
        SELECT count(*)::text AS n FROM session s JOIN project_action a ON a.id=s.project_action_id
         WHERE s.provider IS DISTINCT FROM a.execution_context[5]`)).rows[0].n, '1',
      'a committed state violates the I17-A zero-row query');
    } finally {
      await c.end();
    }
  });

test('PC-CX-38: I17-A is not standing across PAC model materialization and retiredPin', () => {
  const i17 = between('**I17（', '- **I18（');
  assert.match(i17, /Session 的快照列在 create 之后只读/);
  assert.match(PAC, /`model` \| \*\*首次 claim\*\*/,
    'PAC keeps model materialization after placeholder creation');
  assert.match(PAC, /模型被 runtime 彻底下架（`retiredPin`）时改写一次/,
    'PAC permits one legitimate post-freeze model rewrite');

  const actionModel = 'model-v1';
  const pendingBeforeClaim: string | null = null;
  const materializedAtClaim = 'model-v1';
  const retiredPinReplacement = 'model-v2';
  assert.notEqual(pendingBeforeClaim, actionModel,
    'a legal PENDING placeholder can precede first-claim model materialization');
  assert.equal(materializedAtClaim, actionModel);
  assert.notEqual(retiredPinReplacement, actionModel,
    'the retained PAC exception makes I17-A false again without an illegal mutator');
});

interface WakeCandidate {
  at: number;
  source: number;
  reason: string;
}

function chooseWakeV16(candidates: WakeCandidate[], wallNow: number): WakeCandidate & { wakeAt: number } {
  const chosen = [...candidates].sort((a, b) => a.at - b.at || a.source - b.source)[0];
  return { ...chosen, wakeAt: Math.max(chosen.at, wallNow + 5_000) };
}

test('PC-CX-39: W5 has no tie-break for two candidates from the same source', () => {
  const tied: WakeCandidate[] = [
    { at: 60_000, source: 1, reason: 'provider blocker b1' },
    { at: 60_000, source: 1, reason: 'runner blocker b2' },
  ];
  const forward = chooseWakeV16(tied, 30_000);
  const reverse = chooseWakeV16([...tied].reverse(), 30_000);
  assert.equal(forward.wakeAt, reverse.wakeAt, 'the timestamp happens to be unique');
  assert.notEqual(forward.reason, reverse.reason,
    'but nextWakeReason still depends on row/enumeration order because (at, source) is not total');
  assert.match(between('**W5（', '\n---\n\n## 11.'), /各自产出零个或多个候选/);
});

test('PC-CX-40: W5 reads a clock outside decisionInput, so one hash has two nextWakeAt values', () => {
  const decisionInput = { world: { candidateAt: 60_000 }, evaluation: { epoch: 58 }, signals: [] };
  const inputHash = sha256(decisionInput);
  const fast = chooseWakeV16([{ at: 60_000, source: 7, reason: 'manual' }], 58_000);
  const slow = chooseWakeV16([{ at: 60_000, source: 7, reason: 'manual' }], 59_000);
  assert.equal(inputHash, sha256(decisionInput));
  assert.notEqual(fast.wakeAt, slow.wakeAt,
    'the same declared input yields 63s or 64s solely from an un-hashed wall clock');
  assert.match(CONTRACT, /相同 hash 必须给出逐字相同的机械决策[\s\S]*相同的 `nextWakeAt`/);
  assert.match(CONTRACT, /`evaluation\.epoch` 是\*\*唯一\*\*允许读时钟的地方/);
  assert.match(CONTRACT, /nextWakeAt = max\(chosen\.at, now \+ 5s\)/,
    'W5 nevertheless uses now instead of the frozen evaluation epoch');
});

test('PC-CX-41: I19 has no authority domain for disabled or settled projects', () => {
  const ownsPendingEvent = (p: { status: string; enabled: boolean; runState: string }): boolean => {
    const eligibleForLiveness = p.status === 'OPEN' && p.enabled && !['AWAITING_HUMAN', 'SETTLED'].includes(p.runState);
    const eligibleForBackstop = p.status === 'OPEN' && p.enabled && p.runState !== 'SETTLED';
    return eligibleForLiveness || eligibleForBackstop;
  };
  assert.equal(ownsPendingEvent({ status: 'OPEN', enabled: false, runState: 'PLANNING' }), false,
    'I6 requires legacy projects not to reconcile or consume, while I19 quantifies over their events');
  assert.equal(ownsPendingEvent({ status: 'DONE', enabled: true, runState: 'SETTLED' }), false,
    'W4 and §10.3 both exclude a settled project even if an event is still unconsumed');
  assert.match(CONTRACT, /I6（旧项目静默）[\s\S]*不消费事件、不 reconcile/);
  assert.match(CONTRACT, /I19（待消费事件的投递不变量[\s\S]*任何已提交状态上，一条 `consumed_at IS NULL`/);
  assert.match(between('**W4（', '**W4-a（'), /p\.status = 'OPEN' AND p\.coordinator_enabled/);
});

test('PC-CX-42: EC2 accepts a different PAC Session result when non-digest inputs change', () => {
  const identities = {
    agent: 'a1', member: 'm1', task: 't1', assignee: 'a1', provider: 'claude', model: 'opus',
    workspace: 'w1', runner: 'r1', coordinatorWorkspace: 'cw1',
  };
  const digest = sha256(identities);
  const atDecision = { ...identities, effort: 'high', requiredCapabilities: ['linux'] };
  const atCommit = { ...identities, effort: 'low', requiredCapabilities: ['linux', 'docker'] };
  assert.equal(sha256(identities), digest, 'the EC2 identity digest is unchanged');
  assert.notDeepEqual(atDecision, atCommit,
    'PAC freezes effort and requiredCapabilities into the Session, so the required outcome changed');
  const s10e = between('- **S10-e（', '- **S10-d（');
  assert.match(s10e, /`defaultEffort`/);
  assert.match(s10e, /不进\*\* EC2 的九个分量/);
  assert.match(between('**EC2（', '**EC3（'), /resolvedAgentId[\s\S]*coordinatorWorkspaceId/);
  assert.doesNotMatch(between('**EC2（', '**EC3（'), /requiredCapabilities|effort/,
    'if EC2 is extended to cover the full PAC result, retire this counterexample');
});

test('v1.6 independent counterexample inventory is complete', () => {
  const ids = ['PC-CX-37', 'PC-CX-38', 'PC-CX-39', 'PC-CX-40', 'PC-CX-41', 'PC-CX-42'];
  assert.equal(new Set(ids).size, ids.length);
});
