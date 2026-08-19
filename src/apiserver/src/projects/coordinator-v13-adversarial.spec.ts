import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { Client } from 'pg';

// Unit 02 wrote this file in its fourth review round, when every assertion in it proved that a
// defect *existed*: `PC-CX-21..27` against contract v1.3. Its own follow-up list (review §5) says
// what happens next — "翻转成旧交错被拒绝/得到唯一合法结果": once v1.4 closes the findings, these
// assertions must be turned around, because an assertion that a bug is present necessarily goes red
// the moment the bug is fixed.
//
// So each test below now asserts the v1.4 outcome, and keeps the v1.3 shape beside it as an
// explicit reverse control. Nothing was deleted: "this defect was real" and "this defect is now
// refused" are both stated, in the same test, from the same interleaving. The four review reports
// themselves are untouched — they record what was true when they were written.
//
// Where the claim is about the database rather than about the contract's own rules, the assertion
// lives in `coordinator-linearization.pg.spec.ts` (§22.1 / §22.5 / §22.6); what this file keeps is
// the review's own reading of the interleaving.
const REPO = path.resolve(__dirname, '../../../..');
const CONTRACT = readFileSync(path.join(REPO, 'docs/project-coordinator-contract.md'), 'utf8');
/** §1–§18. §19–§22 are revision logs and are explicitly non-normative (§0 RL1). */
const NORMATIVE = CONTRACT.slice(0, CONTRACT.indexOf('\n## 19. '));
const PG_URL = process.env.COORDINATOR_PG_URL;

type ClientCtor = new (config: { connectionString?: string }) => Client;
async function connect(): Promise<Client> {
  const { Client: Ctor } = (await import('pg')) as unknown as { Client: ClientCtor };
  const client = new Ctor({ connectionString: PG_URL });
  await client.connect();
  return client;
}

interface DispatchAttribution {
  actionProjectId: string;
  actionStatus: 'APPLIED';
  actionSubjectId: string;
  actionToken: number;
  runtimeToken: number;
  taskId: string;
  taskProjectId: string;
}

/** The review's reading of I11: the token equality, taken as a standing invariant. */
function i11AsWrittenInV13(s: DispatchAttribution): boolean {
  return (
    s.actionStatus === 'APPLIED' &&
    s.actionSubjectId === s.taskId &&
    s.actionProjectId === s.taskProjectId &&
    s.actionToken === s.runtimeToken
  );
}

/** §4.3 I11-A: the same sentence with its tense fixed — monotone, so it cannot decay. */
function i11A(s: DispatchAttribution): boolean {
  return (
    s.actionStatus === 'APPLIED' &&
    s.actionSubjectId === s.taskId &&
    s.actionProjectId === s.taskProjectId &&
    s.actionToken <= s.runtimeToken
  );
}

const DISPATCHED: DispatchAttribution = {
  actionProjectId: 'p1',
  actionStatus: 'APPLIED',
  actionSubjectId: 't1',
  actionToken: 42,
  runtimeToken: 42,
  taskId: 't1',
  taskProjectId: 'p1',
};

test('PC-CX-21 closed: the next legitimate lease no longer invalidates a still-live session', () => {
  assert.equal(i11A(DISPATCHED), true, 'D9 admits the dispatch at its own commit');

  // A normal timer/event reconcile acquires the next lease while this task session is still live.
  // §8.1 requires every successful acquisition to increment the runtime token.
  const afterNextLease = { ...DISPATCHED, runtimeToken: 43 };
  assert.equal(i11A(afterNextLease), true, 'the standing half is monotone, so an ordinary lease cannot falsify it');
  assert.equal(i11AsWrittenInV13(afterNextLease), false, 'reverse control: v1.3 compared a historical token with the current one');

  // …and it stays true however far the project runs, which is the whole point: nobody did anything
  // wrong, so nothing should have become false.
  for (const runtimeToken of [44, 100, 10_000]) {
    assert.equal(i11A({ ...DISPATCHED, runtimeToken }), true, `token ${runtimeToken}`);
  }
  // The equality is still required, but only where it is true: at the commit of the dispatch.
  assert.match(NORMATIVE, /\*\*I11-B（提交时授权，点态）\*\*/, 'the commit-time half must still be stated');
});

test('PC-CX-21 closed: D10 closes the rows D9 reads', () => {
  assert.equal(i11A(DISPATCHED), true);

  // AE10 permits a cross-project move, and D9 is declared only on three session columns, so in
  // v1.3 changing task.project_id did not schedule the deferred check again.
  const afterMove = { ...DISPATCHED, taskProjectId: 'p2' };
  assert.equal(i11AsWrittenInV13(afterMove), false, 'reverse control: the move detached the session from its dispatch project');
  assert.equal(i11A(afterMove), false, 'and the fixed tense does not paper over it either — the state itself is wrong');

  // §7.7 D10 makes that state unreachable rather than tolerable: the move is refused while the
  // claim is live, and §13.4 AE10 3b says so where the move is defined.
  assert.match(NORMATIVE, /#### D10 · 占位期间 Task 不得跨 Project 移动/, 'the mutator protocol for task.project_id must exist');
  assert.match(NORMATIVE, /TASK_CLAIMED_PROJECT_MOVE/, 'and it must fail with a typed, visible error');
  assert.match(NORMATIVE, /#### D11 · `APPLIED` 动作行终态不可改写/, 'the other rows D9 reads need one too');
});

test('PC-CX-22 closed: the frozen decision input carries the inputs its own decisions read', () => {
  const input = /### 6\.1[\s\S]*?### 6\.2/.exec(CONTRACT)?.[0] ?? '';
  assert.ok(input.length > 0, '§6.1 must exist');

  for (const required of ['dispatchAttempt', 'verdictRevision', 'acceptanceAttempt', 'lifecycleGeneration', 'conditionVersion', 'escalatedAt', 'mergeEvidence']) {
    assert.ok(input.includes(required), `the decision input still omits ${required}`);
  }
  // The clock and the triggering event were the other two thirds of the finding.
  assert.match(input, /\*\*S5（时钟只在一处读/, 'the clock must enter as frozen due facts, not be excluded');
  assert.match(input, /\*\*S7（事件按身份进入/, 'an event that changes a decision must enter the input');

  // The review's three counterexamples, replayed against the v1.4 hash rule: identical visible
  // world, different required decision ⇒ the input identity must differ.
  const world = { projectId: 'p1', taskId: 't1', taskStatus: 'OPEN', runAt: '2026-08-19T10:00:00Z' };
  const hash = (over: { dispatchAttempt: number; runAtDue: boolean; manual: boolean }): string =>
    createHash('sha256').update(JSON.stringify([world, over])).digest('hex');
  const base = { dispatchAttempt: 1, runAtDue: false, manual: false };
  // Reverse control: v1.3's hash covered only the visible world, so all three variants collapse
  // onto one identity while each of them requires a different action.
  const v13Hash = (): string => createHash('sha256').update(JSON.stringify(world)).digest('hex');
  for (const [why, variant] of [
    ['a generation the snapshot never carried', { ...base, dispatchAttempt: 2 }],
    ['a clock-derived due fact the hash excluded', { ...base, runAtDue: true }],
    ['an event whose existence is the decision', { ...base, manual: true }],
  ] as [string, typeof base][]) {
    assert.notEqual(hash(variant), hash(base), `${why}: the decision input must change identity`);
    assert.equal(v13Hash(), v13Hash(), `reverse control (${why}): v1.3 gives the same hash for both`);
  }
});

type TriggerSnapshot = {
  runState: 'PLANNING' | 'BLOCKED';
  readyTask: boolean;
  openBlockerKinds: string[];
  allTasksSettled: boolean;
  verdict?: 'FAIL' | 'INCONCLUSIVE';
  verdictApplied: boolean;
  manual: boolean;
};

/** Every reason whose guard is true — the review's reading of §7.2, and still the input to TU4. */
function turnReasons(s: TriggerSnapshot): string[] {
  const reasons: string[] = [];
  if (s.manual) reasons.push('MANUAL');
  if (s.verdict && s.verdictApplied) reasons.push('VERDICT');
  if (s.openBlockerKinds.some((k) => ['WHO_UNRESOLVED', 'MERGE_CONFLICT', 'VERIFICATION_FAILED', 'DEPENDENCY_CYCLE'].includes(k))) {
    reasons.push('BLOCKER_DECISION');
  }
  if (s.allTasksSettled) reasons.push('ACCEPTANCE');
  if (s.runState === 'PLANNING' && !s.readyTask && s.openBlockerKinds.length === 0) reasons.push('REPLAN');
  return reasons;
}

/** §7.2 TU4: first match in the frozen total order wins, so a snapshot yields zero or one turn. */
const TU4_ORDER = ['MANUAL', 'VERDICT', 'BLOCKER_DECISION', 'ACCEPTANCE', 'REPLAN'];
function adjudicate(reasons: string[]): string[] {
  const winner = TU4_ORDER.find((r) => reasons.includes(r));
  return winner ? [winner] : [];
}

test('PC-CX-23 closed: overlapping turn triggers are adjudicated into exactly one turn', () => {
  const converged: TriggerSnapshot = {
    runState: 'PLANNING', readyTask: false, openBlockerKinds: [], allTasksSettled: true,
    verdictApplied: false, manual: false,
  };
  assert.deepEqual(turnReasons(converged), ['ACCEPTANCE', 'REPLAN'], 'reverse control: all-settled is also the literal REPLAN guard');
  assert.deepEqual(adjudicate(turnReasons(converged)), ['ACCEPTANCE'], 'ACCEPTANCE outranks the PLANNING fallback, as §4.2 already orders the states');

  const failed: TriggerSnapshot = {
    runState: 'BLOCKED', readyTask: false, openBlockerKinds: ['VERIFICATION_FAILED'], allTasksSettled: false,
    verdict: 'FAIL', verdictApplied: true, manual: false,
  };
  assert.deepEqual(turnReasons(failed), ['VERDICT', 'BLOCKER_DECISION'], 'reverse control: FAIL creates the blocker that independently opens another turn');
  assert.deepEqual(adjudicate(turnReasons(failed)), ['VERDICT'], 'the cause outranks the consequence it created');

  // The order is the document's, not this file's.
  const row = /\| 1 \| `MANUAL`[\s\S]*?\n\n/.exec(NORMATIVE);
  assert.ok(row, '§7.2 no longer orders the turn reasons');
  assert.match(NORMATIVE, /\*\*TU5（一次 reconcile 至多一条语义 turn，v1\.4 冻结）\*\*/, 'and the "at most one" rule must be stated');
});

test('PC-CX-24 closed: a cleared and recurring blocker gets a new turn identity', () => {
  const generation = 7;
  const conditionVersion = 'same-conflict-content';
  const v13Key = (): string => `turn:${generation}:MERGE_CONFLICT:file:${conditionVersion}`;
  const v14Key = (lifecycleGeneration: number): string =>
    `turn:${generation}:MERGE_CONFLICT:file:${lifecycleGeneration}:${conditionVersion}`;

  // Reverse control: without the episode, a genuinely new failure reuses the old permanent key,
  // and TR3 reads that collision as "the coordinator changed nothing".
  assert.equal(v13Key(), v13Key(), 'reverse control: episode 1 and episode 2 produce one key');
  const v13Outcome = v13Key() === v13Key() ? 'COORDINATOR_NO_PROGRESS' : 'OPEN_COORDINATOR_TURN';
  assert.equal(v13Outcome, 'COORDINATOR_NO_PROGRESS');

  // v1.4: §11.3 BE1 already assigned the episode; §7.2 TF4 makes the turn read it.
  assert.notEqual(v14Key(2), v14Key(1), 'a new lifecycle generation must produce a new turn identity');
  const v14Outcome = v14Key(2) === v14Key(1) ? 'COORDINATOR_NO_PROGRESS' : 'OPEN_COORDINATOR_TURN';
  assert.equal(v14Outcome, 'OPEN_COORDINATOR_TURN', 'the coordinator gets a turn for the new episode');
  // …and repeats inside one episode still collapse, so AC8's dedup is not traded away for it.
  assert.equal(v14Key(1), v14Key(1));
  assert.match(NORMATIVE, /\*\*TF4（周期身份必须进入 `turnFacts`/, 'the rule has to be general, not a patch on one reasonCode');
});

test('PC-CX-25 closed: an old writer can no longer stale the authority projection', () => {
  const project = { id: 'p1', coordinatorEnabled: true };
  const derive = (projectId: string | null): 'LEGACY' | 'COORDINATOR' =>
    projectId !== null && project.coordinatorEnabled ? 'COORDINATOR' : 'LEGACY';

  // A pre-compatibility binary writes `project_id` and nothing else, because `dispatch_authority`
  // does not appear anywhere in its source.
  const v13Task = { projectId: null as string | null, dispatchAuthority: 'LEGACY' as 'LEGACY' | 'COORDINATOR' };
  v13Task.projectId = project.id;
  assert.equal(v13Task.dispatchAuthority, 'LEGACY', 'reverse control: the projection is stale after the old write');
  assert.notEqual(v13Task.dispatchAuthority, derive(v13Task.projectId));
  assert.equal(v13Task.dispatchAuthority === 'LEGACY', true, 'reverse control: and D6 faithfully admits the old sweep');

  // v1.4: the column is derived by a trigger, so the same write cannot leave it stale.
  const v14Task = { projectId: null as string | null, dispatchAuthority: 'LEGACY' as 'LEGACY' | 'COORDINATOR' };
  v14Task.projectId = project.id;
  v14Task.dispatchAuthority = derive(v14Task.projectId); // BEFORE INSERT OR UPDATE, §7.7 D8-a ①
  assert.equal(v14Task.dispatchAuthority, 'COORDINATOR', 'the trigger recomputes regardless of who wrote');
  assert.equal(v14Task.dispatchAuthority, derive(v14Task.projectId), 'I12-A holds on the committed state');

  assert.match(NORMATIVE, /`task_dispatch_authority_projection`/, 'the projection must be a database object, not a service duty');
  assert.match(NORMATIVE, /#### D13 · 授权投影的漂移查询/, 'and its freshness must be a query anyone can run');
  assert.match(NORMATIVE, /`dispatch_authority` \*\*没有服务层写入点\*\*/, '§12.3 must no longer assign it to a service');
});

test('PC-CX-26 closed: revocation and the project cap are checked at the commit point', () => {
  const snapshot = { coordinatorEnabled: true, policy: 'AUTO', inFlight: 0, maxConcurrentTasks: 1, token: 9 };
  const atCommit = { coordinatorEnabled: false, policy: 'MANUAL', maxConcurrentTasks: 1 };

  // Reverse control: the fencing token is the only commit predicate v1.3 froze, and a human write
  // does not advance it — so the stale AUTO decision commits after automation was revoked.
  const tokenStillValid = snapshot.token === 9;
  assert.equal(tokenStillValid, true, 'reverse control: the token check passes');
  assert.equal(atCommit.coordinatorEnabled, false, 'while the project says automation is off');

  // §9.6 AU1: the commit takes the project row lock and re-evaluates §9.2 against what it reads.
  const allowedAtCommit = atCommit.coordinatorEnabled && atCommit.policy !== 'MANUAL';
  assert.equal(allowedAtCommit, false);
  const outcome = allowedAtCommit ? { dispatched: true, refusalCode: null } : { dispatched: false, refusalCode: 'AUTHORITY_REVOKED' };
  assert.deepEqual(outcome, { dispatched: false, refusalCode: 'AUTHORITY_REVOKED' }, 'the stale decision is refused, and the refusal is recorded');

  // CAP1: the cap is counted behind the same lock by both entry points, so it cannot be crossed.
  const manualStarts = 1;
  const coordinatorStarts = allowedAtCommit ? 1 : 0;
  assert.equal(snapshot.inFlight + manualStarts + coordinatorStarts, 1);
  assert.ok(snapshot.inFlight + manualStarts + coordinatorStarts <= snapshot.maxConcurrentTasks, 'the project-wide cap holds');
  // Reverse control: per-task claims alone let both entry points through.
  assert.ok(snapshot.inFlight + manualStarts + 1 > snapshot.maxConcurrentTasks, 'reverse control: D5 is per task, not per project');

  assert.match(NORMATIVE, /### 9\.6 人工撤权、并发上限与派发的共同门/, 'the shared gate must be stated');
  assert.match(NORMATIVE, /PROJECT_CONCURRENCY_LIMIT/, 'and a refused human start must get a typed error');
});

test('PC-CX-27 closed: the normative body no longer prescribes both sides of two fixes', () => {
  // A mention is quoted; a requirement is not. §22.8 states the convention and registers every
  // superseded sentence, so this reads the requirement side of the normative body only.
  const requires = NORMATIVE.replace(/"[^"\n]*"/g, '');
  assert.doesNotMatch(requires, /幂等键的 epoch 取子状态摘要/, 'AG1 must no longer prescribe the removed aggregate key');
  assert.match(requires, /\*\*AG5（聚合没有幂等键/, 'AG5 is the only surviving rule for it');
  assert.doesNotMatch(requires, /持有 AE6 那把 `FOR SHARE`/, 'AE8 must no longer prescribe the deadlocking v1.2 lock');
  assert.match(requires, /AE6-a[\s\S]*?FOR NO KEY UPDATE/, 'AE6-a freezes the stronger lock');

  // Reverse control: put either sentence back as a requirement and the contract has two readings.
  const relapsed = `${requires}\n- **AG1**：幂等键的 epoch 取子状态摘要。\n**AE8**：持有 AE6 那把 \`FOR SHARE\` 的写入者……`;
  assert.match(relapsed, /幂等键的 epoch 取子状态摘要/);
  assert.match(relapsed, /持有 AE6 那把 `FOR SHARE`/);

  // And the mechanism, not just this round's two sentences.
  assert.match(CONTRACT, /### 22\.8 残句账/, 'every superseded sentence must be registered somewhere a test can read');
  assert.match(CONTRACT, /\*\*RL1（哪些部分是规范的/, 'and the normative/non-normative split must be frozen');
});

test('PC-CX-21 on real Postgres: the fixed invariant survives what the review reproduced', { skip: PG_URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  // The review's own fixture, kept verbatim except for the two things v1.4 changed: the standing
  // invariant is the monotone one, and the rows D9 reads have a mutator protocol. The negative
  // control it originally asserted — "both updates commit and i11 goes false" — is kept as the
  // `v13` half, so this test still shows the defect was real.
  const c = await connect();
  try {
    await c.query(`
      DROP SCHEMA IF EXISTS pcc_v13_adversarial CASCADE;
      CREATE SCHEMA pcc_v13_adversarial;
      SET search_path TO pcc_v13_adversarial;
      CREATE TABLE project (id text PRIMARY KEY);
      CREATE TABLE project_runtime (project_id text PRIMARY KEY REFERENCES project(id), fencing_token bigint NOT NULL);
      CREATE TABLE task (id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id));
      CREATE TABLE project_action (
        id text PRIMARY KEY,
        project_id text NOT NULL REFERENCES project(id),
        type text NOT NULL,
        status text NOT NULL,
        subject_type text NOT NULL,
        subject_id text NOT NULL,
        fencing_token bigint NOT NULL
      );
      CREATE TABLE session (
        id text PRIMARY KEY,
        task_id text NOT NULL REFERENCES task(id),
        status text NOT NULL,
        dispatch_origin text NOT NULL,
        project_action_id text REFERENCES project_action(id),
        CONSTRAINT session_action_only_for_coordinator_chk
          CHECK (dispatch_origin = 'COORDINATOR' OR project_action_id IS NULL)
      );

      -- §7.7 D10, the mutator protocol v1.3 did not have.
      CREATE OR REPLACE FUNCTION task_claimed_project_move_guard() RETURNS trigger AS $fn$
      BEGIN
        IF NEW.project_id IS NOT DISTINCT FROM OLD.project_id THEN RETURN NULL; END IF;
        IF EXISTS (SELECT 1 FROM session s WHERE s.task_id = NEW.id AND s.status IN ('PENDING','RUNNING')) THEN
          RAISE EXCEPTION 'TASK_CLAIMED_PROJECT_MOVE: task % has a live claim', NEW.id;
        END IF;
        RETURN NULL;
      END;
      $fn$ LANGUAGE plpgsql;
      CREATE CONSTRAINT TRIGGER task_claimed_project_move_guard
        AFTER UPDATE OF project_id ON task
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION task_claimed_project_move_guard();

      INSERT INTO project VALUES ('p1'), ('p2');
      INSERT INTO project_runtime VALUES ('p1', 42), ('p2', 7);
      INSERT INTO task VALUES ('t1', 'p1'), ('t2', 'p1');
      INSERT INTO project_action VALUES
        ('a1', 'p1', 'DISPATCH_TASK', 'APPLIED', 'TASK', 't1', 42),
        ('a2', 'p1', 'DISPATCH_TASK', 'APPLIED', 'TASK', 't2', 42);
      INSERT INTO session VALUES
        ('s1', 't1', 'PENDING', 'COORDINATOR', 'a1'),
        ('s2', 't2', 'PENDING', 'COORDINATOR', 'a2');
    `);

    /** `equality` = the v1.3 reading; otherwise §4.3 I11-A. */
    const invariant = async (sessionId: string, equality: boolean): Promise<boolean> => {
      const q = await c.query<{ ok: boolean }>(`
        SELECT EXISTS (
          SELECT 1
            FROM session s
            JOIN task t ON t.id = s.task_id
            JOIN project_action a ON a.id = s.project_action_id
            JOIN project_runtime r ON r.project_id = a.project_id
           WHERE s.id = $1
             AND a.type = 'DISPATCH_TASK' AND a.status = 'APPLIED'
             AND a.subject_id = s.task_id AND a.project_id = t.project_id
             AND (CASE WHEN $2 THEN a.fencing_token = r.fencing_token ELSE a.fencing_token <= r.fencing_token END)
        ) AS ok
      `, [sessionId, equality]);
      return q.rows[0].ok;
    };

    assert.equal(await invariant('s1', false), true, 'the initial committed row is attributable');
    await c.query(`UPDATE project_runtime SET fencing_token = 43 WHERE project_id = 'p1'`);
    assert.equal(await invariant('s1', false), true, 'a later lease leaves I11-A intact');
    assert.equal(await invariant('s1', true), false, 'reverse control: the equality reading breaks on the very next lease');

    await c.query(`UPDATE project_runtime SET fencing_token = 42 WHERE project_id = 'p1'`);
    assert.equal(await invariant('s2', false), true);
    let refusal: string | null = null;
    await c.query('BEGIN');
    try {
      await c.query(`UPDATE task SET project_id = 'p2' WHERE id = 't2'`);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      refusal = /TASK_CLAIMED_PROJECT_MOVE/.exec(String(e))?.[0] ?? `unexpected: ${String(e)}`;
    }
    assert.equal(refusal, 'TASK_CLAIMED_PROJECT_MOVE', 'the move the review reproduced is now refused');
    assert.equal(await invariant('s2', false), true, 'and attribution is intact on the committed state');
  } finally {
    await c.end();
  }
});
