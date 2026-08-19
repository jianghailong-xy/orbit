import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import type { Client } from 'pg';

const REPO = path.resolve(__dirname, '../../../..');
const CONTRACT = readFileSync(path.join(REPO, 'docs/project-coordinator-contract.md'), 'utf8');
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

function i11Holds(s: DispatchAttribution): boolean {
  return (
    s.actionStatus === 'APPLIED' &&
    s.actionSubjectId === s.taskId &&
    s.actionProjectId === s.taskProjectId &&
    s.actionToken === s.runtimeToken
  );
}

test('PC-CX-21 counterexample: the next legitimate lease invalidates a still-live session under I11', () => {
  const committed: DispatchAttribution = {
    actionProjectId: 'p1',
    actionStatus: 'APPLIED',
    actionSubjectId: 't1',
    actionToken: 42,
    runtimeToken: 42,
    taskId: 't1',
    taskProjectId: 'p1',
  };
  assert.equal(i11Holds(committed), true, 'D9 admits the dispatch at its own commit');

  // A normal timer/event reconcile acquires the next lease while this task session is still live.
  // §8.1 requires every successful acquisition to increment the runtime token.
  const afterNextLease = { ...committed, runtimeToken: 43 };
  assert.equal(i11Holds(afterNextLease), false, 'the action token is historical but D9 compares it with the current token');
});

test('PC-CX-21 counterexample: D9 is not closed over rows it reads', () => {
  const committed: DispatchAttribution = {
    actionProjectId: 'p1',
    actionStatus: 'APPLIED',
    actionSubjectId: 't1',
    actionToken: 42,
    runtimeToken: 42,
    taskId: 't1',
    taskProjectId: 'p1',
  };
  assert.equal(i11Holds(committed), true);

  // AE10 explicitly permits this write. D9 is declared only on INSERT/UPDATE OF three session
  // columns, so changing task.project_id does not schedule the deferred check again.
  const afterMove = { ...committed, taskProjectId: 'p2' };
  assert.equal(i11Holds(afterMove), false, 'a live task move detaches the session from its dispatch project');
});

test('PC-CX-21 on real Postgres: D9 allows later token advance and task move to falsify I11', { skip: PG_URL ? false : 'set COORDINATOR_PG_URL to run' }, async () => {
  const c = await connect();
  try {
    await c.query(`
      DROP SCHEMA IF EXISTS pcc_v13_adversarial CASCADE;
      CREATE SCHEMA pcc_v13_adversarial;
      SET search_path TO pcc_v13_adversarial;
      DROP TABLE IF EXISTS session, project_action, task, project_runtime, project CASCADE;
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

      CREATE OR REPLACE FUNCTION session_dispatch_attribution_check() RETURNS trigger AS $fn$
      DECLARE ok boolean;
      BEGIN
        IF NEW.dispatch_origin <> 'COORDINATOR' THEN RETURN NULL; END IF;
        SELECT EXISTS (
          SELECT 1
            FROM project_action a
            JOIN task t ON t.id = NEW.task_id
            JOIN project_runtime r ON r.project_id = a.project_id
           WHERE a.id = NEW.project_action_id
             AND a.type = 'DISPATCH_TASK'
             AND a.status = 'APPLIED'
             AND a.subject_type = 'TASK'
             AND a.subject_id = NEW.task_id
             AND a.project_id = t.project_id
             AND a.fencing_token = r.fencing_token
        ) INTO ok;
        IF NOT ok THEN RAISE EXCEPTION 'DISPATCH_ATTRIBUTION_VIOLATION'; END IF;
        RETURN NULL;
      END;
      $fn$ LANGUAGE plpgsql;

      CREATE CONSTRAINT TRIGGER session_dispatch_attribution_check
        AFTER INSERT OR UPDATE OF project_action_id, dispatch_origin, task_id ON session
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION session_dispatch_attribution_check();

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

    const invariant = async (sessionId: string): Promise<boolean> => {
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
             AND a.fencing_token = r.fencing_token
        ) AS ok
      `, [sessionId]);
      return q.rows[0].ok;
    };

    assert.equal(await invariant('s1'), true, 'the initial committed row satisfies D9');
    await c.query(`UPDATE project_runtime SET fencing_token = 43 WHERE project_id = 'p1'`);
    assert.equal(await invariant('s1'), false, 'a later lease commits without firing the session trigger');

    await c.query(`UPDATE project_runtime SET fencing_token = 42 WHERE project_id = 'p1'`);
    assert.equal(await invariant('s2'), true);
    await c.query(`UPDATE task SET project_id = 'p2' WHERE id = 't2'`);
    assert.equal(await invariant('s2'), false, 'AE10 task movement also commits without firing the session trigger');
  } finally {
    await c.end();
  }
});

test('PC-CX-22 counterexample: the frozen snapshot omits inputs required by its own decisions', () => {
  const snapshot = /### 6\.1[\s\S]*?### 6\.2/.exec(CONTRACT)?.[0] ?? '';
  assert.ok(snapshot.length > 0, '§6.1 must exist');

  for (const required of ['dispatchAttempt', 'verdictRevision', 'acceptanceAttempt', 'lifecycleGeneration', 'conditionVersion', 'firstSeenAt', 'escalatedAt', 'mergeEvidence']) {
    assert.equal(snapshot.includes(required), false, `the frozen snapshot unexpectedly contains ${required}`);
  }

  const visible = { projectId: 'p1', taskId: 't1', taskStatus: 'OPEN', runAt: '2026-08-19T10:00:00Z' };
  const before = { visible, dispatchAttempt: 1, now: '2026-08-19T09:59:00Z', manualEvent: false };
  const after = { visible, dispatchAttempt: 2, now: '2026-08-19T10:01:00Z', manualEvent: true };
  assert.equal(JSON.stringify(before.visible), JSON.stringify(after.visible), 'S3 hashes only the visible projection here');
  assert.notEqual(`dispatch:t1:${before.dispatchAttempt}`, `dispatch:t1:${after.dispatchAttempt}`, 'the required idempotency key changes');
  assert.notEqual(before.now >= visible.runAt, after.now >= visible.runAt, 'the required dispatch decision changes with excluded time');
  assert.notEqual(before.manualEvent, after.manualEvent, 'the MANUAL turn changes with events that S3 excludes from snapshotHash');
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

function turnReasons(s: TriggerSnapshot): string[] {
  const reasons: string[] = [];
  if (s.runState === 'PLANNING' && !s.readyTask && s.openBlockerKinds.length === 0) reasons.push('REPLAN');
  if (s.verdict && s.verdictApplied) reasons.push('VERDICT');
  if (s.openBlockerKinds.some((k) => ['WHO_UNRESOLVED', 'MERGE_CONFLICT', 'VERIFICATION_FAILED', 'DEPENDENCY_CYCLE'].includes(k))) {
    reasons.push('BLOCKER_DECISION');
  }
  if (s.allTasksSettled) reasons.push('ACCEPTANCE');
  if (s.manual) reasons.push('MANUAL');
  return reasons;
}

test('PC-CX-23 counterexample: semantic turn triggers overlap but the contract requires one turn', () => {
  assert.deepEqual(turnReasons({
    runState: 'PLANNING', readyTask: false, openBlockerKinds: [], allTasksSettled: true,
    verdictApplied: false, manual: false,
  }), ['REPLAN', 'ACCEPTANCE'], 'all-settled is also the literal REPLAN guard');

  assert.deepEqual(turnReasons({
    runState: 'BLOCKED', readyTask: false, openBlockerKinds: ['VERIFICATION_FAILED'], allTasksSettled: false,
    verdict: 'FAIL', verdictApplied: true, manual: false,
  }), ['VERDICT', 'BLOCKER_DECISION'], 'FAIL creates the blocker that independently opens another turn');
});

test('PC-CX-24 counterexample: a cleared and recurring blocker is misclassified as no progress', () => {
  const generation = 7;
  const conditionVersion = 'same-conflict-content';
  const turnKey = (lifecycleGeneration: number): string => {
    // TF2 includes kind/subject/conditionVersion, but not the lifecycle generation.
    void lifecycleGeneration;
    return `turn:${generation}:MERGE_CONFLICT:file:${conditionVersion}`;
  };

  const first = turnKey(1);
  const recurrence = turnKey(2);
  assert.equal(recurrence, first, 'a genuinely new blocker episode reuses the old permanent turn key');
  const tr3Outcome = recurrence === first ? 'COORDINATOR_NO_PROGRESS' : 'OPEN_COORDINATOR_TURN';
  assert.equal(tr3Outcome, 'COORDINATOR_NO_PROGRESS', 'TR3 cannot distinguish recurrence from a turn that made no progress');
});

test('PC-CX-25 counterexample: an old writer can stale the authority projection and bypass D6', () => {
  const task = { projectId: null as string | null, dispatchAuthority: 'LEGACY' as 'LEGACY' | 'COORDINATOR' };
  const project = { id: 'p1', coordinatorEnabled: true };

  // A pre-compatibility binary knows projectId but not dispatchAuthority, so D3's service primitive
  // is absent. The database has no projection trigger in the frozen object list.
  task.projectId = project.id;
  const desiredAuthority = project.coordinatorEnabled ? 'COORDINATOR' : 'LEGACY';
  assert.equal(desiredAuthority, 'COORDINATOR');
  assert.equal(task.dispatchAuthority, 'LEGACY', 'the projection is stale after the old write');

  const d6AllowsLegacySweep = task.dispatchAuthority === 'LEGACY';
  assert.equal(d6AllowsLegacySweep, true, 'D6 enforces the stale projection and therefore admits the old sweep');
});

test('PC-CX-26 counterexample: policy revocation and project concurrency have no commit-time gate', () => {
  const runtime = { fencingToken: 9 };
  const snapshot = { coordinatorEnabled: true, policy: 'AUTO', inFlight: 0, maxConcurrentTasks: 1, token: 9 };

  // The human commits after the snapshot but before the coordinator outcome. Neither write changes
  // project_runtime.fencing_token, which is the only commit predicate frozen by F1.
  const projectAtCommit = { coordinatorEnabled: false, policy: 'MANUAL' };
  const coordinatorTokenCheck = runtime.fencingToken === snapshot.token;
  assert.equal(coordinatorTokenCheck, true, 'the stale AUTO decision is still allowed to commit');
  assert.deepEqual(projectAtCommit, { coordinatorEnabled: false, policy: 'MANUAL' });

  // The same absent gate applies to a human start on another task: D5 is per task, not per Project.
  const manualStarts = 1;
  const coordinatorStarts = coordinatorTokenCheck ? 1 : 0;
  assert.equal(snapshot.inFlight + manualStarts + coordinatorStarts, 2);
  assert.ok(snapshot.inFlight + manualStarts + coordinatorStarts > snapshot.maxConcurrentTasks, 'the project-wide cap is exceeded');
});

test('PC-CX-27 counterexample: stale normative clauses still prescribe both sides of two fixes', () => {
  assert.match(CONTRACT, /AG1[\s\S]*?幂等键的 epoch 取子状态摘要/, 'AG1 still prescribes the removed aggregate key');
  assert.match(CONTRACT, /AG5（聚合没有幂等键/, 'AG5 says the opposite');
  assert.match(CONTRACT, /AE6-a[\s\S]*?FOR NO KEY UPDATE/, 'AE6 freezes the stronger lock');
  assert.match(CONTRACT, /AE8[\s\S]*?持有 AE6 那把 `FOR SHARE`/, 'AE8 still prescribes the deadlocking v1.2 lock');
});
