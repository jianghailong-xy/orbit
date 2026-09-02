import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * What keeps the automatic-dispatch OBLIGATION deleted, and automatic dispatch itself standing.
 *
 * `0205_task_auto_dispatch_obligation` installed five relations, six declared indexes and two
 * stored functions to answer one question durably: WHY has a ready task not started yet. Its
 * product was an `AUTO_DISPATCH_BLOCKED` fact with a reason code, an owner, a next action, an
 * observation count and a committed wake instant, surfaced on task and project reads as
 * `controlPlaneObligations`. It worked: on 2026-09-01 a task sat for a day under
 * `OWNER_RATIFICATION_REQUIRED` with `observationCount: 8` and started four seconds after the
 * account owner approved it.
 *
 * 0218 removed that reason. 0224 removes the framework, and the account owner's line is that
 * deleting the EXPLANATION must not delete the DISPATCH. Everything the two share stays: the
 * candidate predicate in `AUTO_RUN_READY_SQL`, `execute()`, the `task_dispatch_epoch` fence,
 * `task_run_request` and the unique live-session claim, `task.dispatch_attempt`, and
 * `task_dependency`, which predates this project entirely.
 *
 * What is accepted in exchange, stated so it is not discovered later: a refusal is now a log line.
 * A task that is ready but cannot start — no provider quota, the runner short of disk, inside the
 * automatic-retry backoff, no free materialisation slot — leaves no typed row and no wake behind,
 * so "why is this not running" is answered by the server log rather than by an API read. The
 * damping that let a committed wake keep a refused candidate out of the next sweep goes with it:
 * such a task is re-offered every sweep and refused again by the same boundary.
 *
 * Everything here is derived from the tree — relations and functions are replayed out of
 * `prisma/migrations`, and every scan reads the same text a reviewer reads. The behavioural proof,
 * against the actually-migrated schema, is `tasks/auto-dispatch-obligation-removal.pg.spec.ts`.
 */
const API = path.resolve(__dirname, '../..');
const REPO = path.resolve(API, '../..');
const MIGRATIONS = path.join(API, 'prisma/migrations');

const CREATED_BY = '0205_task_auto_dispatch_obligation';
const REMOVED_BY = '0224_task_auto_dispatch_obligation_removal';

/** The five relations 0205 created. */
const DISPATCH_TABLES = [
  'task_auto_dispatch_attempt',
  'task_auto_dispatch_event',
  'task_auto_dispatch_obligation_revision',
  'task_auto_dispatch_state',
  'task_auto_dispatch_wakeup',
];

/** The six indexes 0205 declared by name. Primary keys and uniques go with their relation. */
const DISPATCH_INDEXES = [
  'task_auto_dispatch_attempt_tenant_project_idx',
  'task_auto_dispatch_obligation_identity_idx',
  'task_auto_dispatch_state_active_task_idx',
  'task_auto_dispatch_state_active_project_idx',
  'task_auto_dispatch_event_trace_idx',
  'task_auto_dispatch_wakeup_due_idx',
];

/** Both stored functions. */
const DISPATCH_FUNCTIONS = [
  'task_auto_dispatch_record',
  'task_auto_dispatch_reconcile_sessions',
];

/**
 * The TypeScript the obligation was spelled in. `AUTO_DISPATCH_BLOCKED` and `task.auto-dispatch`
 * are the wire vocabulary a client would have read; the rest is the module pair that produced it.
 */
const DISPATCH_IDENTIFIERS = [
  'auto-dispatch-obligation',
  'control-plane-obligation',
  'AutoDispatchObligation',
  'AutoDispatchDisposition',
  'AutoDispatchObservation',
  'recordAutoDispatchObservation',
  'readAutoDispatchObligations',
  'autoDispatchObligationsBy',
  'autoDispatchFailureDisposition',
  'autoDispatchSkippedDisposition',
  'autoDispatchAttemptingDisposition',
  'recordReadySweepRefusal',
  'reconcileAutoDispatchReceipts',
  'readControlPlaneObligations',
  'controlPlaneObligationsBy',
  'ControlPlaneObligationScope',
  'AUTO_DISPATCH_WAKE_DELAY_MS',
  'AUTO_DISPATCH_IN_FLIGHT_WAKE_DELAY_MS',
  'AUTO_DISPATCH_BLOCKED',
  'task.auto-dispatch',
];

/** The named suite that existed only to test this framework. */
const REMOVED_SUITE_FILES = [
  'scripts/outcome-reconciler-auto-dispatch.sh',
  'scripts/outcome-reconciler-auto-dispatch-manifest.mjs',
  'scripts/outcome-reconciler-auto-dispatch-integration.sh',
  'scripts/outcome-reconciler-auto-dispatch-integration.mjs',
  'scripts/outcome-reconciler-deployment-attestation.mjs',
  'test/outcome-reconciler-auto-dispatch.test.mjs',
  'src/apiserver/src/common/auto-dispatch-obligation.ts',
  'src/apiserver/src/common/control-plane-obligation.ts',
];

const REMOVED_SUITE_ALIASES = [
  'test:outcome-reconciler:auto-dispatch',
  'test:outcome-reconciler:auto-dispatch:integration',
];

const REMOVED_DAG_NODES = ['suite-auto-dispatch', 'suite-auto-dispatch-integration'];

/** Every `project_acceptance_*` relation. None of them is this task's to touch. */
const ACCEPTANCE_TABLES = [
  'project_acceptance_audit',
  'project_acceptance_conclusion',
  'project_acceptance_criteria_confirmation',
  'project_acceptance_criterion',
  'project_acceptance_criterion_definition',
  'project_acceptance_run',
];

/** What automatic dispatch still runs on, and must therefore survive the removal. */
const DISPATCH_KEPT_TABLES = ['task_dependency', 'task_dispatch_epoch', 'task_run_request'];

function migrations(): Array<{ dir: string; sql: string }> {
  return readdirSync(MIGRATIONS)
    .filter((dir) => /^\d{4}_/.test(dir))
    .sort()
    .flatMap((dir) => {
      const file = path.join(MIGRATIONS, dir, 'migration.sql');
      try {
        return [{ dir, sql: readFileSync(file, 'utf8') }];
      } catch {
        return [];
      }
    });
}

/** The last migration that creates or drops `object`, and which of the two it did. */
function lastVerdict(
  created: RegExp,
  dropped: RegExp,
): { dir: string; verdict: 'CREATED' | 'DROPPED' } | null {
  let standing: { dir: string; verdict: 'CREATED' | 'DROPPED' } | null = null;
  for (const { dir, sql } of migrations()) {
    if (created.test(sql)) standing = { dir, verdict: 'CREATED' };
    if (dropped.test(sql)) standing = { dir, verdict: 'DROPPED' };
  }
  return standing;
}

const tableCreate = (name: string) =>
  new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${name}"?[\\s(]`, 'i');
const tableDrop = (name: string) =>
  new RegExp(`DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?"?${name}"?\\s*(?:CASCADE|RESTRICT)?\\s*[;,]`, 'i');

function removalMigration(): string {
  return readFileSync(path.join(MIGRATIONS, REMOVED_BY, 'migration.sql'), 'utf8');
}

function read(relative: string): string {
  return readFileSync(path.join(REPO, relative), 'utf8');
}

function exists(relative: string): boolean {
  return statSync(path.join(REPO, relative), { throwIfNoEntry: false }) !== undefined;
}

// (a) ---------------------------------------------------------------------------------------------
test('(a) all five relations are created by 0205 and dropped by 0224', () => {
  for (const table of DISPATCH_TABLES) {
    const standing = lastVerdict(tableCreate(table), tableDrop(table));
    assert.ok(standing, `${table} is named by no migration at all`);
    assert.equal(standing.verdict, 'DROPPED', `${table} is still installed by ${standing.dir}`);
    assert.equal(standing.dir, REMOVED_BY);
    assert.ok(standing.dir > CREATED_BY);
  }
});

test('(a) the six declared indexes go with their relations, and no later migration rebuilds one', () => {
  for (const index of DISPATCH_INDEXES) {
    const standing = lastVerdict(
      new RegExp(`CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:CONCURRENTLY\\s+)?(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${index}"?`, 'i'),
      new RegExp(
        `DROP\\s+(?:TABLE\\s+(?:IF\\s+EXISTS\\s+)?"?(?:${DISPATCH_TABLES.join('|')})"?`
          + `|INDEX\\s+(?:IF\\s+EXISTS\\s+)?"?${index}"?)`, 'i'),
    );
    assert.ok(standing, `${index} is named by no migration`);
    assert.equal(standing.verdict, 'DROPPED', `${index} is still installed by ${standing.dir}`);
  }
});

test('(a) both stored functions are dropped, and 0205 installed no trigger and no view', () => {
  for (const fn of DISPATCH_FUNCTIONS) {
    const standing = lastVerdict(
      new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+"?${fn}"?\\s*\\(`, 'i'),
      new RegExp(`DROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?"?${fn}"?\\s*\\(`, 'i'),
    );
    assert.ok(standing, `${fn} is named by no migration at all`);
    assert.equal(standing.verdict, 'DROPPED', `${fn} is still installed by ${standing.dir}`);
    assert.equal(standing.dir, REMOVED_BY);
  }
  // Stated rather than assumed, because the account owner's criterion names triggers: 0205
  // installed none, so "its triggers are gone" is a fact about an empty set and a reader should
  // not go looking for one. The recorder was called from TypeScript, never from a trigger.
  const { sql } = migrations().find((migration) => migration.dir === CREATED_BY)!;
  assert.doesNotMatch(sql, /CREATE\s+(?:CONSTRAINT\s+)?TRIGGER/i, '0205 installed a trigger');
  assert.doesNotMatch(sql, /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW/i, '0205 installed a view');
});

test('(a) the Prisma schema no longer models a single one of the five relations', () => {
  const schema = read('src/apiserver/prisma/schema.prisma');
  for (const table of DISPATCH_TABLES) {
    assert.equal(schema.includes(table), false, `schema.prisma still maps ${table}`);
  }
  assert.doesNotMatch(schema, /model\s+TaskAutoDispatch/, 'a TaskAutoDispatch model survives');
});

// (b) ---------------------------------------------------------------------------------------------

/** Every tracked file a reviewer would read, minus the append-only migration history. */
function liveSources(): Array<{ rel: string; text: string }> {
  const roots = ['src/apiserver/src', 'src/apiserver/prisma/schema.prisma', 'src/shared/src',
    'src/web/src', 'src/runner-go', 'scripts', 'test', 'contracts', 'docs', 'package.json'];
  const out: Array<{ rel: string; text: string }> = [];
  const walk = (abs: string) => {
    const stat = statSync(abs, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isDirectory()) {
      for (const entry of readdirSync(abs)) {
        if (entry === 'node_modules' || entry === 'build' || entry === 'dist') continue;
        walk(path.join(abs, entry));
      }
      return;
    }
    if (!/\.(ts|tsx|mts|mjs|js|json|sql|sh|go|md|yml|yaml|prisma)$/.test(abs)) return;
    out.push({ rel: path.relative(REPO, abs), text: readFileSync(abs, 'utf8') });
  };
  for (const root of roots) walk(path.join(REPO, root));
  return out;
}

/**
 * The files whose JOB is to name what is gone. Enumerated rather than pattern-matched: an
 * exemption that grew by accident would be a hole in the scan below.
 */
const REMOVAL_WITNESSES = [
  'src/apiserver/src/outcome-reconciler/auto-dispatch-obligation-removal.spec.ts',
  'src/apiserver/src/tasks/auto-dispatch-obligation-removal.pg.spec.ts',
  'test/outcome-reconciler-v2.ratification.test.mjs',
];

test('(b) no live source hands a dropped relation or routine to PostgreSQL', () => {
  const names = [...DISPATCH_TABLES, ...DISPATCH_INDEXES, ...DISPATCH_FUNCTIONS];
  const sources = liveSources();
  assert.ok(sources.length > 1_000, `the scan must actually have read the tree: ${sources.length}`);
  for (const witness of REMOVAL_WITNESSES) {
    assert.ok(sources.some(({ rel }) => rel === witness), `${witness} is not in the scan`);
  }
  const offenders: string[] = [];
  for (const { rel, text } of sources) {
    if (REMOVAL_WITNESSES.includes(rel)) continue;
    text.split('\n').forEach((line, index) => {
      // Naming the migration that created something, on the same line, is a citation of the
      // history rather than a use of it: `prisma/migrations` is append-only.
      if (line.includes('prisma/migrations/')) return;
      for (const name of names) {
        if (line.includes(name)) offenders.push(`${rel}:${index + 1}: ${name}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'a dropped relation or routine is still named outside the migration history — raw SQL in '
      + '`$queryRaw` is not type-checked, so this scan is the only thing that would catch it');
});

test('(b) the obligation vocabulary has no implementation left anywhere', () => {
  const offenders: string[] = [];
  for (const { rel, text } of liveSources()) {
    if (REMOVAL_WITNESSES.includes(rel)) continue;
    for (const name of DISPATCH_IDENTIFIERS) {
      if (text.includes(name)) offenders.push(`${rel}: ${name}`);
    }
  }
  assert.deepEqual(offenders, [],
    'the obligation is half-removed: a name of it still has an implementation or a caller');
});

test('(b) both modules and the suite that only tested them are deleted', () => {
  for (const file of REMOVED_SUITE_FILES) {
    assert.equal(exists(file), false, `${file} must be deleted`);
  }
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  for (const alias of REMOVED_SUITE_ALIASES) {
    assert.equal(alias in scripts, false, `${alias} still names a script that does not exist`);
  }
  // Every remaining suite alias has to resolve to a file, or the release DAG schedules a ghost.
  for (const [alias, command] of Object.entries(scripts)) {
    if (!alias.startsWith('test:outcome-reconciler:')) continue;
    for (const token of command.split(/\s+/)) {
      if (!token.startsWith('scripts/')) continue;
      assert.equal(exists(token), true, `${alias} runs missing ${token}`);
    }
  }
});

test('(b) the release DAG no longer schedules either removed node', () => {
  const plan = JSON.parse(read('contracts/outcome-reconciler-release-dag.json')) as {
    nodes: Array<{ id: string; dependsOn: string[]; kind: string }>;
    legacyEntrypoints: Array<{ nodeId: string }>;
    timeoutCalibration: { observedMaximumSeconds: Record<string, number> };
    postgresIsolation: { nodes: Record<string, unknown> };
  };
  const frontier = JSON.parse(read('contracts/outcome-reconciler-release-frontier.json')) as {
    namedSuites: Array<{ name: string }>;
  };
  const ids = new Set(plan.nodes.map((node) => node.id));
  for (const removed of REMOVED_DAG_NODES) {
    assert.equal(ids.has(removed), false, `${removed} is still a node`);
    assert.equal(removed in plan.timeoutCalibration.observedMaximumSeconds, false);
    assert.equal(removed in plan.postgresIsolation.nodes, false);
  }
  for (const node of plan.nodes) {
    for (const dependency of node.dependsOn) {
      assert.ok(ids.has(dependency), `${node.id} depends on missing ${dependency}`);
    }
  }
  for (const entry of plan.legacyEntrypoints) assert.ok(ids.has(entry.nodeId), entry.nodeId);
  assert.deepEqual(frontier.namedSuites.filter((suite) => /auto-dispatch/.test(suite.name)), []);
});

test('(b) task and project reads no longer project a control-plane obligation', () => {
  // The overlay had exactly two producers and no client: `readControlPlaneObligations` returned
  // nothing for a session scope, and no web, iOS or Go surface ever read the field. Scanned by
  // field name here rather than by identifier, so a hand-rolled replacement is caught too.
  for (const relative of ['src/apiserver/src/tasks/tasks.service.ts',
    'src/apiserver/src/projects/projects.service.ts']) {
    assert.doesNotMatch(read(relative), /controlPlaneObligations/,
      `${relative} still projects the obligation overlay`);
  }
  // `blocked` was `!canRun(state) || obligations.length > 0`. With the second half gone it must be
  // the dependency predicate alone rather than a constant.
  const tasks = read('src/apiserver/src/tasks/tasks.service.ts');
  assert.ok(tasks.includes('blocked: !canRun(dependencyState)'),
    'the task reads must still derive `blocked` from dependency readiness');
});

// (i) ---------------------------------------------------------------------------------------------
test('(i) 0224 is subtraction: it only takes machinery away', () => {
  const sql = removalMigration();
  for (const forbidden of [/CREATE\s+TABLE/i, /CREATE\s+(?:CONSTRAINT\s+)?TRIGGER/i,
    /CREATE\s+(?:UNIQUE\s+)?INDEX/i, /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW/i, /CREATE\s+TYPE/i,
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i, /ALTER\s+TABLE/i]) {
    assert.equal(forbidden.test(sql), false,
      `the removal migration installs ${forbidden} — it must only take machinery away`);
  }
  const ddl = [...sql.matchAll(/^(?:CREATE|ALTER|DROP)(?: OR REPLACE)? [A-Z]+/gm)].map((m) => m[0]);
  assert.deepEqual([...new Set(ddl)].sort(), ['DROP FUNCTION', 'DROP TABLE']);
  assert.doesNotMatch(sql, /pg_cron|CREATE EXTENSION|LISTEN |NOTIFY /,
    'the migration starts nothing that keeps running after it commits');
});

test('(i) the removal deletes far more than it writes, measured from the tree', () => {
  // Deliberately NOT `git diff --numstat main...HEAD`. That measures where a branch is standing
  // rather than whether the change is a subtraction: it reads 15,905-against-1,809 on a branch and
  // 0-against-0 the instant it merges, so the assertion inverts on the one tree it protects.
  // Pinning a baseline SHA only moves the problem. Everything below is read out of the worktree
  // and says the same thing before a merge, after one, and on an export with no history at all.
  const ledger = migrations();
  const retired = ledger.filter(({ dir }) => dir === CREATED_BY)
    .reduce((total, { sql }) => total + sql.split('\n').length, 0);
  assert.ok(retired > 500, `expected the 548 lines that installed this machinery, saw ${retired}`);

  // What it spent: 0224, plus any later migration that returns to the same vocabulary. A
  // compatibility shim for the machinery being removed goes on the removal's bill; an unrelated
  // migration that merely lands on top of it does not.
  const spending = ledger.filter(({ dir }) => dir >= REMOVED_BY)
    .filter(({ sql }) => [...DISPATCH_TABLES, ...DISPATCH_FUNCTIONS].some((n) => sql.includes(n)));
  const spent = spending.reduce((total, { sql }) => total + sql.split('\n').length, 0);
  assert.ok(spent * 3 < retired, `the removal spent ${spent} lines `
    + `(${spending.map(({ dir }) => dir).join(', ')}) to retire ${retired}`);

  // And none of it went back. A removal that re-creates what it dropped is a net addition however
  // the line counts come out, so this half is absolute rather than a ratio.
  for (const { dir, sql } of spending) {
    for (const table of DISPATCH_TABLES) {
      assert.equal(tableCreate(table).test(sql), false, `${dir} re-creates ${table}`);
    }
    for (const fn of DISPATCH_FUNCTIONS) {
      assert.equal(
        new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+"?${fn}"?\\s*\\(`, 'i').test(sql),
        false, `${dir} re-creates ${fn}`);
    }
  }
});

test('(i) the removal adds no compose service and no resident process', () => {
  const compose = read('docker-compose.yml');
  const services = [...compose.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]);
  assert.deepEqual(services.sort(),
    ['apiserver', 'gateway', 'pg-socket', 'pgbackup', 'postgres', 'web'],
    'the deployment is exactly the services it already had');
  const apiserver = JSON.parse(read('src/apiserver/package.json')) as
    { scripts: Record<string, string> };
  assert.deepEqual(Object.keys(apiserver.scripts).filter((n) => n.startsWith('start:')).sort(),
    ['start:dev'], 'no new long-running entry point');
  // The one timer TasksService owns still carries three sweeps and is still one interval. 0224
  // removed a leg from its chain; adding a second timer is how this reconciler once ran twice a
  // minute and dispatched twice.
  const tasks = read('src/apiserver/src/tasks/tasks.service.ts');
  assert.equal((tasks.match(/setInterval\(/g) ?? []).length, 1,
    'TasksService must own exactly one interval');
});

// (g)(h) ------------------------------------------------------------------------------------------
test('(g) the dependency mechanism and the dispatch fences are still installed', () => {
  for (const table of DISPATCH_KEPT_TABLES) {
    const standing = lastVerdict(tableCreate(table), tableDrop(table));
    assert.ok(standing, `${table} is named by no migration`);
    assert.equal(standing.verdict, 'CREATED', `${table} was dropped by ${standing.dir}`);
  }
  // Nor can 0224 have reached one: it names none of them in any statement.
  for (const line of removalMigration().split('\n')) {
    if (line.trimStart().startsWith('--')) continue;
    for (const table of DISPATCH_KEPT_TABLES) {
      assert.equal(line.includes(table), false,
        `the removal migration names ${table} in a statement: ${line.trim()}`);
    }
  }
  // The candidate predicate still anchors on HAVING an edge and on those edges being satisfied.
  const tasks = read('src/apiserver/src/tasks/tasks.service.ts');
  assert.match(tasks, /AND EXISTS \(SELECT 1 FROM task_dependency d WHERE d\.task_id = t\.id\)/,
    'the auto-run sweep no longer anchors on the task having a prerequisite');
  assert.match(tasks, /AND t\.dispatch_hold = false/,
    'the auto-run sweep no longer honours dispatch_hold');
  assert.match(tasks, /AND t\.auto_run_when_ready = true/,
    'the auto-run sweep no longer honours the task\'s own opt-in');
});

test('(h) every project_acceptance_* relation is untouched, field for field', () => {
  const sql = removalMigration();
  for (const table of ACCEPTANCE_TABLES) {
    const standing = lastVerdict(tableCreate(table), tableDrop(table));
    assert.ok(standing, `${table} is named by no migration`);
    assert.equal(standing.verdict, 'CREATED', `${table} was dropped by ${standing.dir}`);
  }
  // "Field for field" is provable rather than merely intended: 0224 carries no statement that
  // names an acceptance relation at all, and its only DDL verbs are DROP TABLE and DROP FUNCTION,
  // so no column of one can have moved by a byte.
  for (const line of sql.split('\n')) {
    if (line.trimStart().startsWith('--')) continue;
    assert.equal(/project_acceptance/.test(line), false,
      `the removal migration names an acceptance relation in a statement: ${line.trim()}`);
  }
  const gate = lastVerdict(
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+"?project_acceptance_done_gate"?\s*\(/i,
    /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?"?project_acceptance_done_gate"?/i,
  );
  assert.ok(gate);
  assert.equal(gate.verdict, 'CREATED', `the DONE gate was dropped by ${gate.dir}`);
});
