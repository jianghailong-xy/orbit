import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { Client } from 'pg';

import { assertCoordinatorPgUrlIsIsolated, verifyCoordinatorPgIdentity } from './coordinator-pg-test-safety';

// Unit 02 wrote this file against v1.6, and every assertion in it proved a defect: D11 froze the
// columns v1.4 knew about and not the three v1.5 added, I17-A asserted an equality that PAC's own
// freeze points falsify twice in a normal lifecycle, W5 sorted on two keys where two candidates can
// share both, the wake floor read a clock that is not in the hash, I19 quantified over events its
// two branches deliberately exclude, and EC2 was asked to answer both "is this still authorized"
// and "is this still the same result".
//
// v1.7 closes all six (§25), and an assertion that proves a defect exists must go red the moment
// the defect is fixed. So the file is **flipped, not deleted** — the same discipline §22.9 / §23.5 /
// §24.6 applied to the v1.3, v1.4 and v1.5 adversarial specs. Each test now asserts the *closed*
// shape, and each keeps the v1.6 shape beside it as a **reverse control**: "this really was broken"
// and "it really is closed now" are both stated, in the same test, over the same rows.
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

type ClientCtor = new (config: { connectionString?: string }) => Client;

async function connect(): Promise<Client> {
  assertCoordinatorPgUrlIsIsolated(PG_URL);
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const client = new Ctor({ connectionString: PG_URL });
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

test('PC-CX-37: D11 freezes every column of an APPLIED row except a two-column allowlist', () => {
  const d11 = between('#### D11 ', '#### D12 ');
  const body = d11.slice(d11.indexOf('CREATE OR REPLACE FUNCTION'), d11.indexOf('CREATE TRIGGER'));

  // The closed shape: one comparison over the whole row, and an allowlist that has to be written
  // down. A column added by the next revision is frozen without anyone remembering to come back.
  assert.match(body, /writable text\[\] := ARRAY\['result_session_id', 'detail'\]/,
    'the writable set has to be a declared allowlist');
  assert.match(body, /\(to_jsonb\(NEW\) - writable\) IS DISTINCT FROM \(to_jsonb\(OLD\) - writable\)/,
    'and everything else has to be compared by construction, not by name');
  for (const column of ['execution_context', 'execution_context_digest', 'reason_code']) {
    assert.ok(d11.includes(column), `D11 no longer explains that ${column} is one of the columns it protects`);
  }
  assert.ok(d11.includes('**D11-d（'), 'the choice of allowlist over denylist has to be argued');
  assert.match(d11, /information_schema\.columns/, 'and the testable form has to be driven by the schema');

  // Reverse control — the v1.6 body, kept verbatim: a per-column denylist cannot mention a column
  // that did not exist when it was written, and no live sentence may specify one again.
  const v16Denylist = ['type', 'subject_type', 'subject_id', 'project_id', 'fencing_token', 'idempotency_key'];
  const refusesUnderV16 = (column: string): boolean => v16Denylist.includes(column) || column === 'status';
  assert.equal(v16Denylist.some((c) => ['execution_context', 'execution_context_digest', 'reason_code'].includes(c)), false,
    'the v1.6 list did not contain the columns v1.5 added — that is the P0');
  for (const column of ['execution_context', 'execution_context_digest', 'reason_code']) {
    assert.equal(refusesUnderV16(column), false, `${column} was rewritable under v1.6`);
  }
  const normative = CONTRACT.slice(0, CONTRACT.indexOf('\n## 19. '));
  const stale = normative.split('\n').map((l) => l.replace(/[`*]/g, ''))
    .filter((l) => l.includes('NEW.fencing_token IS DISTINCT FROM OLD.fencing_token') && !/v1\.[1-7]|PC-CX-\d\d/.test(l));
  assert.deepEqual(stale, [], 'a normative line still enumerates D11 column by column');
});

test('PC-CX-37 on isolated Postgres: the specified D11 refuses the snapshot and window-identity rewrites',
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
      `);
      const v17Guard = `
        CREATE OR REPLACE FUNCTION project_action_applied_immutable_guard() RETURNS trigger AS $fn$
        DECLARE writable text[] := ARRAY['result_session_id', 'detail'];
        BEGIN
          IF OLD.status <> 'APPLIED' THEN RETURN NEW; END IF;
          IF (to_jsonb(NEW) - writable) IS DISTINCT FROM (to_jsonb(OLD) - writable) THEN
            RAISE EXCEPTION 'ACTION_APPLIED_IMMUTABLE';
          END IF;
          RETURN NEW;
        END;
        $fn$ LANGUAGE plpgsql;`;
      const v16Guard = `
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
        $fn$ LANGUAGE plpgsql;`;
      await c.query(`${v17Guard}
        CREATE TRIGGER project_action_applied_immutable_guard
          BEFORE UPDATE ON project_action
          FOR EACH ROW EXECUTE FUNCTION project_action_applied_immutable_guard();`);

      const oldContext = ['a1', 'm1', 't1', 'a1', 'claude', 'opus', 'w1', 'r1', 'cw1'];
      const changed = [...oldContext];
      changed[4] = 'codex';
      const seed = async (): Promise<void> => {
        await c.query('DELETE FROM session; DELETE FROM project_action');
        await c.query(`
          INSERT INTO project_action VALUES
            ('act1','pc:v1:p1:turn:0:d1','p1','DISPATCH_TASK','APPLIED','TASK','t1',1,NULL,NULL,$1,$2,'MANUAL')
        `, [oldContext, sha256(oldContext)]);
        await c.query(`INSERT INTO session VALUES ('s1','act1','COORDINATOR','PENDING','a1','claude','opus','w1','r1')`);
      };
      const rewrite = async (): Promise<string> => {
        try {
          await c.query(`UPDATE project_action
                            SET execution_context=$1, execution_context_digest=$2, reason_code='REPLAN'
                          WHERE id='act1'`, [changed, sha256(changed)]);
          return '';
        } catch (error) {
          return (error as Error).message;
        }
      };
      const observation = async (): Promise<Record<string, string>> => (await c.query<{
        reason_code: string; provider: string; frozen_provider: string;
      }>(`
        SELECT a.reason_code, s.provider, a.execution_context[5] AS frozen_provider
          FROM session s JOIN project_action a ON a.id=s.project_action_id WHERE s.id='s1'`)).rows[0];
      const i17aMismatches = async (): Promise<string> => (await c.query<{ n: string }>(`
        SELECT count(*)::text AS n FROM session s JOIN project_action a ON a.id=s.project_action_id
         WHERE s.provider IS DISTINCT FROM a.execution_context[5]`)).rows[0].n;

      // The closed shape: the review's UPDATE is refused, the frozen row is still what was frozen,
      // and I17-A's zero-row query is still zero.
      await seed();
      assert.match(await rewrite(), /ACTION_APPLIED_IMMUTABLE/, 'the specified D11 must refuse this UPDATE');
      assert.deepEqual(await observation(), { reason_code: 'MANUAL', provider: 'claude', frozen_provider: 'claude' });
      assert.equal(await i17aMismatches(), '0', 'and no committed state violates I17-A');

      // …and the allowlist is really an allowlist: the two writable columns still commit.
      await c.query(`UPDATE project_action SET result_session_id = 's1', detail = 'backfilled' WHERE id = 'act1'`);
      assert.equal((await c.query<{ result_session_id: string }>(
        `SELECT result_session_id FROM project_action WHERE id = 'act1'`)).rows[0].result_session_id, 's1');

      // Reverse control — the v1.6 function, rebuilt verbatim. Same trigger, same statement, and the
      // review's exact committed observation comes back.
      await c.query(v16Guard);
      await seed();
      assert.equal(await rewrite(), '', 'the v1.6 shape must still be reproducible');
      assert.deepEqual(await observation(), { reason_code: 'REPLAN', provider: 'claude', frozen_provider: 'codex' });
      assert.equal(await i17aMismatches(), '1', 'a committed state violates the I17-A zero-row query');
    } finally {
      await c.end();
    }
  });

test('PC-CX-38: I17 is stated per PAC freeze point, with a phase and a generation', () => {
  const invariants = between('**I17（', '- **I18（');
  const standing = invariants.slice(invariants.indexOf('**I17-A（'), invariants.indexOf('**I17-A2（'));

  // The closed shape: the standing equality covers only what PAC §6 freezes at Session create, and
  // the two columns it freezes at first claim get their own phase-indexed statement.
  assert.match(standing, /create 冻结列/, 'I17-A must name the freeze point it compares');
  for (const createFrozen of ['agent_id', 'workspace_id', 'assigned_runner_id', 'provider']) {
    assert.ok(standing.includes(createFrozen), `I17-A does not compare ${createFrozen}`);
  }
  assert.ok(!standing.includes('`model`'), 'I17-A must not compare model: PAC §6 freezes it at first claim');
  assert.ok(invariants.includes('**I17-A2（'), 'the claim-frozen columns need their own standing statement');
  assert.match(invariants, /execution_pin_generation/, 'the phase has to be a persistent column');
  assert.match(PAC, /`model` \| \*\*首次 claim\*\*/, 'PAC still materializes model at first claim');
  assert.match(PAC, /模型被 runtime 彻底下架（`retiredPin`）时改写一次/, 'PAC still permits the one legal post-freeze rewrite');

  // Reverse control — the v1.6 equality, replayed over the review's three-step sequence. Every step
  // is legal, and two of the three committed states make it false.
  const actionModel = 'model-v1';
  const lifecycle = [
    { phase: 'created', model: null as string | null, generation: 0 },
    { phase: 'first claim', model: 'model-v1', generation: 1 },
    { phase: 'retiredPin', model: 'model-v2', generation: 2 },
  ];
  const v16Holds = (s: { model: string | null }): boolean => s.model === actionModel;
  const v17Holds = (s: { model: string | null; generation: number }): boolean =>
    s.generation === 0 ? s.model === null : s.generation === 1 ? s.model === actionModel : s.model !== actionModel;
  assert.deepEqual(lifecycle.map(v16Holds), [false, true, false],
    'the v1.6 statement is false on two of the three states of a normal lifecycle');
  assert.deepEqual(lifecycle.map(v17Holds), [true, true, true],
    'the phase-indexed statement holds on all three, with no illegal mutator anywhere');
});

interface WakeCandidate {
  at: number;
  source: number;
  subjectType: string;
  subjectId: string;
  reason: string;
}

/** §10.4 W5 step 2/3 at both versions: v1.6 sorted on two keys and floored against the wall clock. */
function chooseWake(candidates: WakeCandidate[], epoch: number, wallNow: number, version: 'v16' | 'v17'):
{ reason: string; wakeAt: number } {
  const ordered = [...candidates].sort((a, b) => {
    if (a.at !== b.at) return a.at - b.at;
    if (a.source !== b.source) return a.source - b.source;
    if (version === 'v16') return 0;
    if (a.subjectType !== b.subjectType) return a.subjectType < b.subjectType ? -1 : 1;
    return a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : 0;
  });
  const chosen = ordered[0];
  const floor = version === 'v16' ? wallNow : epoch;
  return { reason: chosen.reason, wakeAt: Math.max(chosen.at, floor + 5_000) };
}

test('PC-CX-39: W5 arbitrates two candidates from one source by a persistent total order', () => {
  const tied: WakeCandidate[] = [
    { at: 60_000, source: 1, subjectType: 'BLOCKER', subjectId: 'b1', reason: 'provider blocker b1' },
    { at: 60_000, source: 1, subjectType: 'BLOCKER', subjectId: 'b2', reason: 'runner blocker b2' },
  ];

  // The closed shape: the same table in either order gives the same reason, decided by keys that
  // are rows in the database rather than positions in an array.
  const forward = chooseWake(tied, 30_000, 30_000, 'v17');
  const reverse = chooseWake([...tied].reverse(), 30_000, 30_000, 'v17');
  assert.deepEqual(forward, reverse, 'nextWakeReason must not depend on enumeration order');
  assert.equal(forward.reason, 'provider blocker b1', 'and b1 wins by bytes');
  const w5 = between('**W5（', '\n---\n\n## 11.');
  assert.match(w5, /\(at, source, subjectType, subjectId\)/, 'W5 must state a four-key order');
  assert.match(w5, /COLLATE "C"/, 'and pin the comparison to bytes rather than a collation');
  assert.ok(w5.includes('**W5-2a（'), 'and prove the order is total rather than assert it');

  // Reverse control — the v1.6 keys, kept verbatim: the timestamp is unique, the reason is not.
  const v16Forward = chooseWake(tied, 30_000, 30_000, 'v16');
  const v16Reverse = chooseWake([...tied].reverse(), 30_000, 30_000, 'v16');
  assert.equal(v16Forward.wakeAt, v16Reverse.wakeAt, 'the timestamp happened to be unique');
  assert.notEqual(v16Forward.reason, v16Reverse.reason,
    'but nextWakeReason depended on row/enumeration order because (at, source) is not total');
});

test('PC-CX-40: W5 reads the frozen evaluation clock, so one decisionInputHash has one nextWakeAt', () => {
  const decisionInput = { world: { candidateAt: 60_000 }, evaluation: { epoch: 58 }, signals: [] };
  const inputHash = sha256(decisionInput);
  const candidate: WakeCandidate[] = [
    { at: 60_000, source: 7, subjectType: 'TURN_WINDOW', subjectId: 'MANUAL', reason: 'manual' },
  ];
  const epoch = decisionInput.evaluation.epoch * 1_000;

  // The closed shape: the wall clock the reconcile happens to run at cannot move the answer.
  const runs = [58_000, 59_000, 62_000].map((wall) => chooseWake(candidate, epoch, wall, 'v17').wakeAt);
  assert.equal(new Set(runs).size, 1, 'the same declared input must yield exactly one nextWakeAt');
  assert.equal(runs[0], 63_000, 'and it is the one the frozen epoch determines');
  assert.equal(sha256(decisionInput), inputHash, 'the declared input did not change while we looked at it');
  assert.match(CONTRACT, /nextWakeAt = max\(chosen\.at, evaluation\.epoch \+ 5s\)/,
    'W5 must floor against the frozen clock');
  assert.match(CONTRACT, /`evaluation\.epoch` 是\*\*唯一\*\*允许读时钟的地方/, 'S5 still says there is one clock');
  assert.match(CONTRACT, /相同 hash 必须给出逐字相同的机械决策[\s\S]*相同的 `nextWakeAt`/, 'S3 still asks for one wake');

  // Reverse control — the v1.6 floor, kept verbatim: the same input, two wall clocks, two answers.
  const fast = chooseWake(candidate, epoch, 58_000, 'v16');
  const slow = chooseWake(candidate, epoch, 59_000, 'v16');
  assert.notEqual(fast.wakeAt, slow.wakeAt,
    'the same declared input yielded 63s or 64s solely from an un-hashed wall clock');
  assert.deepEqual([fast.wakeAt, slow.wakeAt], [63_000, 64_000]);
});

test('PC-CX-41: I19 owns disabled and settled projects too', () => {
  interface Project { status: string; enabled: boolean; runState: string }
  const branchOf = (p: Project, version: 'v16' | 'v17'): string => {
    const inLoop = p.status === 'OPEN' && p.enabled && p.runState !== 'SETTLED';
    if (inLoop) return 'in-loop-or-backstop';
    return version === 'v17' ? 'out-of-loop' : 'NONE';
  };
  const legacy: Project = { status: 'OPEN', enabled: false, runState: 'PLANNING' };
  const settled: Project = { status: 'DONE', enabled: true, runState: 'SETTLED' };

  // The closed shape: every committed unconsumed event has exactly one owner, and the third branch
  // is a discard rather than a reconcile — so I6's silence is untouched.
  assert.equal(branchOf(legacy, 'v17'), 'out-of-loop');
  assert.equal(branchOf(settled, 'v17'), 'out-of-loop');
  const disposition = between('### 5.5 ', '\n---\n\n## 6. ');
  assert.match(disposition, /DISCARDED_OUT_OF_LOOP/, '§5.5 must name the terminal disposition');
  assert.match(disposition, /不取租约/, 'and say that the discard is not a reconcile');
  assert.match(CONTRACT, /I19-c（出环/, 'I19 must carry the third branch');
  assert.match(CONTRACT, /没有第四支/, 'and be stated as a closed partition');
  assert.match(between('**W4-b（', '**W4-a（'), /互补/, 'W4 must say where the out-of-loop rows went');

  // Reverse control — the v1.6 quantification, kept verbatim: I6 forbids consuming, §10.3 and W4
  // both exclude it, and N1 still produces the event.
  assert.equal(branchOf(legacy, 'v16'), 'NONE',
    'I6 required legacy projects not to reconcile, while I19 quantified over their events');
  assert.equal(branchOf(settled, 'v16'), 'NONE',
    'W4 and §10.3 both excluded a settled project even if an event was still unconsumed');
  assert.match(CONTRACT, /I6（旧项目静默[\s\S]*不 reconcile/, 'I6 still keeps old projects silent');
  assert.match(between('**W4（', '**W4-b（'), /p\.status = 'OPEN' AND p\.coordinator_enabled/,
    'and W4 still only scans in-loop projects — that is deliberate, not an oversight');
});

test('PC-CX-42: the commit gate compares a result digest as well as an identity digest', () => {
  const identities = {
    agent: 'a1', member: 'm1', task: 't1', assignee: 'a1', provider: 'claude', model: 'opus',
    workspace: 'w1', runner: 'r1', coordinatorWorkspace: 'cw1',
  };
  const atDecision = { ...identities, effort: 'high', requiredCapabilities: ['linux'] };
  const atCommit = { ...identities, effort: 'low', requiredCapabilities: ['linux', 'docker'] };

  // The closed shape: two digests, two questions. The identities are unchanged — that is exactly
  // why the second one has to exist, and why its refusal is a different code with no blocker.
  assert.equal(sha256(identities), sha256(identities), 'the EC2-a identity digest is unchanged');
  assert.notEqual(sha256(atDecision), sha256(atCommit), 'and EC2-b separates the two dispatches');
  const dispatch = between('**EC2（', '**EC3（');
  assert.match(dispatch, /\*\*EC2-a（/, '§7.4 must state the authorization digest');
  assert.match(dispatch, /\*\*EC2-b（/, '§7.4 must state the result digest');
  assert.match(dispatch, /requiredCapabilities/, 'and EC2-b must cover what PAC freezes into the session');
  assert.match(CONTRACT, /EXECUTION_RESULT_CHANGED/, 'a result that changed without a revocation needs its own code');
  assert.match(CONTRACT, /\*\*EC6（/, 'and the session has to be built from the frozen context, not re-resolved');

  // Reverse control — the v1.6 gate, kept verbatim: one digest, and it is the one that did not move.
  const v16Gate = sha256(identities) === sha256(identities);
  assert.equal(v16Gate, true, 'v1.6 admitted it: the nine identities were the whole comparison');
  assert.notDeepEqual(atDecision, atCommit,
    'while PAC freezes effort and requiredCapabilities into the Session, so the required outcome had changed');
  const s10e = between('- **S10-e（', '- **S10-d（');
  assert.match(s10e, /`defaultEffort`/, 'S10-e already knew effort changes the result');
  assert.match(s10e, /不进\*\* EC2 的九个分量/, 'and that it is not one of the nine — v1.7 turns that note into a mechanism');
});

test('v1.6 independent counterexample inventory is complete, and every finding is closed', () => {
  const ids = ['PC-CX-37', 'PC-CX-38', 'PC-CX-39', 'PC-CX-40', 'PC-CX-41', 'PC-CX-42'];
  assert.equal(new Set(ids).size, ids.length);
  // Each one is answered in §25, exactly once, and the review that raised them is unedited.
  const closure = between('## 25. ', '### 25.7 ');
  for (const id of ids) assert.ok(closure.includes(`\`${id}\``), `§25 does not close ${id}`);
  const review = readFileSync(path.join(REPO, 'docs/project-coordinator-contract-review-02-v1.6.md'), 'utf8');
  assert.match(review, /FAIL \/ BLOCKED/, 'the review is evidence, not a draft');
  for (const id of ids) assert.ok(review.includes(id), `the review no longer raises ${id}`);
});
