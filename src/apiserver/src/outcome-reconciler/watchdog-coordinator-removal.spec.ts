import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * 0221 removed the independently deployed watchdog (0199, 0214), the persistent obligation
 * coordinator (0198) and the watchdog's current-binding ledger (0206). This is the static half of
 * that removal: what the migration text says, what no live source may say any more, and the proof
 * that it is subtraction. The live half — that the objects are actually gone from a migrated
 * database and that the load-bearing walls beside them still work — is the .pg sibling.
 *
 * It reads text rather than trusting `tsc` for the reason the 0218 and 0220 removal suites give:
 * this codebase reaches PostgreSQL through `$queryRaw`, so a dropped relation survives compilation
 * and fails in production. `prisma/migrations` is excluded throughout because it is the append-only
 * record of how the schema got here: 0198 must still create what 0221 drops.
 */

const ROOT = path.resolve(__dirname, '../../../..');
const API = path.resolve(__dirname, '../..');
const MIGRATIONS = path.join(API, 'prisma/migrations');
const REMOVAL_DIR = '0221_watchdog_persistent_coordinator_removal';

/** The four migrations that installed what 0221 took out. The ledger is append-only: these stay. */
const INSTALLERS = [
  '0198_outcome_persistent_coordinator',
  '0199_outcome_independent_watchdog_slo_security',
  '0206_watchdog_current_binding',
  '0214_watchdog_goal_progress_channel',
];

function migrationSql(dir: string): string {
  return readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
}

/** Every `NNNN_` directory in the ledger, in the order PostgreSQL replayed them. */
function ledger(): string[] {
  return readdirSync(MIGRATIONS).filter((name) => /^\d{4}_/.test(name)).sort();
}

const REMOVAL_SQL = migrationSql(REMOVAL_DIR);

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

/**
 * Every file the worktree actually has, tracked or merely known about, minus the migration ledger
 * and build output. `--others --exclude-standard` is load-bearing: plain `git ls-files` reports the
 * INDEX, so a file written but not yet staged is invisible and the scan goes green on a tree it
 * never read. The 0220 removal suite was bitten by exactly that and documents it at length; this is
 * the same enumeration rather than a second, weaker one.
 */
function sourceFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).split('\n').filter(Boolean);
  return [...new Set(listed)]
    .filter((file) => !file.startsWith('src/apiserver/prisma/migrations/'))
    .filter((file) => existsSync(path.join(ROOT, file)) && statSync(path.join(ROOT, file)).isFile());
}

/** A line that is prose end to end: a removal suite has to be able to say what it removed. */
function isProseLine(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*|--)/.test(line);
}

/** The thirteen tables 0198 created, exactly as the catalog named them. */
const COORDINATOR_TABLES = [
  'outcome_coordinator_attempt_result',
  'outcome_coordinator_clock',
  'outcome_coordinator_event',
  'outcome_coordinator_external_wait',
  'outcome_coordinator_failure_fingerprint',
  'outcome_coordinator_lease',
  'outcome_coordinator_obligation',
  'outcome_coordinator_obligation_revision',
  'outcome_coordinator_owner_decision_request',
  'outcome_coordinator_project_fairness',
  'outcome_coordinator_scheduler',
  'outcome_coordinator_wake',
  'outcome_coordinator_wake_delivery',
];

/** 0198's entry points, plus the one 0199_outcome_actor_surfaces put on its request table. */
const COORDINATOR_FUNCTIONS = [
  'outcome_advance_coordinator_clock',
  'outcome_append_coordinator_event',
  'outcome_apply_coordinator_failure',
  'outcome_claim_next_coordination',
  'outcome_coordinator_liveness_audit',
  'outcome_coordinator_now',
  'outcome_coordinator_owner_request_binding_trigger',
  'outcome_decide_coordinator_owner_request',
  'outcome_deliver_coordinator_wake',
  'outcome_reconcile_active_obligations',
  'outcome_record_coordinator_result',
  'outcome_register_coordinator_obligation',
  'outcome_renew_coordinator_lease',
  'outcome_request_coordinator_owner_decision',
  'outcome_schedule_coordinator_wake',
  'outcome_sweep_coordinator',
  'outcome_terminalize_coordination',
];

/** What 0206 created: three tables, one view and two entry points. */
const BINDING_TABLES = [
  'executable_runtime_binding_fact',
  'executable_runtime_binding',
  'executable_runtime_binding_stream',
];

/**
 * Every name that must not reach PostgreSQL from live source any more. Deliberately NOT including
 * the `outcome-watchdog` string itself: it is still a legal value of
 * `executable_runtime_expectation.component`, whose rows are audit history on a table that stays.
 */
const DROPPED_NAMES = [
  ...COORDINATOR_TABLES,
  ...COORDINATOR_FUNCTIONS,
  ...BINDING_TABLES,
  'executable_runtime_current_binding',
  'executable_runtime_register_current_binding',
  'executable_runtime_append_current_heartbeat',
  'outcome_watchdog.',
  'runtime_binding_digest',
  'runtime_binding_logical_time',
];

/**
 * A live reference is a line that would hand one of these names to PostgreSQL. An absence check —
 * `to_regclass(...) IS NULL`, `proname = '...'`, `relname LIKE '...'` — names the thing precisely
 * in order to prove it is gone, which is the opposite of using it, so those lines are let through.
 * Prose is let through for the reason the 0220 suite documents: a removal suite has to be able to
 * say what it removed.
 */
function livesOn(line: string): string[] {
  if (isProseLine(line)) return [];
  if (/to_regclass|pg_proc|pg_class|proname|relname|indexname|migration_name|DROP\s|doesNotMatch/i
    .test(line)) {
    return [];
  }
  return DROPPED_NAMES.filter((name) => line.includes(name));
}

/**
 * The removal suites are exempt as files, not line by line. Each one exists to name the objects a
 * migration took away and to assert, against that migration's own text, that it named them: every
 * such line is a quotation of history rather than a call. The 0220 suite exempted two of its six
 * siblings by literal path and its own acceptance run went red on the other four; the rule is
 * stated once here instead.
 */
function isRemovalSuite(file: string): boolean {
  return /-removal(\.pg)?\.spec\.ts$/.test(file);
}

// (a) ---------------------------------------------------------------------------------------------
test('(a) 0221 drops every table, view, function and trigger the four migrations installed', () => {
  for (const table of [...COORDINATOR_TABLES, ...BINDING_TABLES]) {
    assert.match(REMOVAL_SQL, new RegExp(`DROP TABLE ${table};`), `${table} must be dropped by name`);
  }
  for (const fn of COORDINATOR_FUNCTIONS) {
    assert.match(REMOVAL_SQL, new RegExp(`DROP FUNCTION ${fn}\\(`), `${fn} must be dropped by name`);
  }
  for (const fn of ['executable_runtime_append_current_heartbeat',
    'executable_runtime_register_current_binding']) {
    assert.match(REMOVAL_SQL, new RegExp(`DROP FUNCTION ${fn}\\(`));
  }
  assert.match(REMOVAL_SQL, /DROP VIEW executable_runtime_current_binding;/);
  // 0214 only replaced outcome_watchdog.collect, and 0199's three tables, two triggers and
  // fourteen functions are all named inside that schema, so one CASCADE removes exactly that set.
  assert.match(REMOVAL_SQL, /DROP SCHEMA outcome_watchdog CASCADE;/);
  assert.match(REMOVAL_SQL, /DROP INDEX outcome_fact_stream_watchdog_recent_idx;/);
  assert.match(REMOVAL_SQL,
    /DROP INDEX outcome_projection\.outcome_projection_reconciler_watchdog_sample_idx;/);
  // 0206 also widened a table that stays; the columns, both constraints and both indexes go back.
  for (const fragment of [/DROP COLUMN runtime_binding_digest/, /DROP COLUMN runtime_binding_logical_time/,
    /DROP CONSTRAINT executable_runtime_heartbeat_binding_fk/,
    /DROP CONSTRAINT executable_runtime_heartbeat_binding_shape_chk/,
    /DROP INDEX executable_runtime_heartbeat_binding_watermark_idx;/,
    /DROP INDEX executable_runtime_heartbeat_binding_latest_idx;/]) {
    assert.match(REMOVAL_SQL, fragment);
  }
});

test('(a) the four migrations stay in the ledger and nothing replays them after the removal', () => {
  const names = ledger();
  assert.ok(names.includes(REMOVAL_DIR), 'the removal itself must remain in the ledger');
  // Later migrations are allowed — 0222 removed the obligation algebra after this — but none of
  // them may put back what this one took away. `CREATE OR REPLACE` in a later file is exactly the
  // way a removal silently un-happens, so the check is on what comes after, not on being last.
  for (const later of names.filter((name) => name > REMOVAL_DIR)) {
    const sql = readFileSync(path.join(MIGRATIONS, later, 'migration.sql'), 'utf8');
    for (const name of [...COORDINATOR_TABLES, ...BINDING_TABLES, ...COORDINATOR_FUNCTIONS]) {
      assert.doesNotMatch(sql, new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:TABLE|FUNCTION|VIEW)\\s+"?${name}"?`),
        `${later} re-creates ${name}, which ${REMOVAL_DIR} removed`);
    }
    assert.doesNotMatch(sql, /CREATE\s+SCHEMA\s+outcome_watchdog/);
  }
  for (const retired of INSTALLERS) {
    assert.ok(names.includes(retired), `${retired} must remain in the append-only ledger`);
  }
});

// (b) ---------------------------------------------------------------------------------------------
test('(b) both worker directories are gone and nothing imports what they held', () => {
  assert.equal(existsSync(path.join(API, 'src/outcome-watchdog')), false);
  assert.equal(existsSync(path.join(API, 'src/outcome-coordinator')), false);
  for (const file of ['src/apiserver/src/outcome-reconciler/outcome-coordinator.service.ts',
    'src/apiserver/src/outcome-reconciler/outcome-coordinator.ts']) {
    assert.equal(existsSync(path.join(ROOT, file)), false, `${file} must be deleted`);
  }
  const dangling: string[] = [];
  for (const file of sourceFiles().filter((name) => /^src\/apiserver\/src\/.*\.ts$/.test(name))) {
    const source = read(file);
    for (const match of source.matchAll(/from\s+'(\.[^'?\\]*)'/g)) {
      const base = path.resolve(path.dirname(path.join(ROOT, file)), match[1]);
      const resolved = [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]
        .some((candidate) => existsSync(candidate) && statSync(candidate).isFile());
      if (!resolved) dangling.push(`${file} -> ${match[1]}`);
    }
  }
  assert.deepEqual(dangling, []);
});

test('(b) the payload redaction the canary borrowed survived the module it lived in', () => {
  // outcome-canary is a different subsystem that imported one pure function from the watchdog
  // module. Deleting the module without re-homing the function would have taken the canary with it.
  const relocated = 'src/apiserver/src/outcome-reconciler/outcome-payload-redaction.ts';
  assert.ok(existsSync(path.join(ROOT, relocated)));
  assert.match(read(relocated), /export function sanitizeWatchdogPayload\(/);
  assert.match(read('src/apiserver/src/outcome-reconciler/outcome-canary.ts'),
    /from '\.\/outcome-payload-redaction'/);
  assert.match(read('scripts/outcome-reconciler-canary.sh'), /outcome-payload-redaction\.ts/);
});

// (c) ---------------------------------------------------------------------------------------------
test('(c) no live source still hands a dropped relation or function to PostgreSQL', () => {
  const hits: string[] = [];
  for (const file of sourceFiles()) {
    if (isRemovalSuite(file) || file.startsWith('build/') || file.startsWith('docs/')) continue;
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    if (!DROPPED_NAMES.some((name) => source.includes(name))) continue;
    source.split('\n').forEach((line, index) => {
      for (const name of livesOn(line)) hits.push(`${file}:${index + 1} ${name}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('(c) the four named suites that only tested this machinery are gone with it', () => {
  for (const file of ['scripts/outcome-reconciler-watchdog.sh',
    'scripts/outcome-reconciler-watchdog-manifest.mjs',
    'scripts/outcome-reconciler-coordinator.sh',
    'scripts/outcome-reconciler-coordinator-manifest.mjs',
    'scripts/outcome-reconciler-watchdog-current-binding.sh',
    'scripts/outcome-reconciler-watchdog-current-binding-regression.sh',
    'scripts/outcome-reconciler-watchdog-current-binding-manifest.mjs',
    'scripts/outcome-reconciler-watchdog-current-binding-integration.mjs',
    'test/outcome-reconciler-v2.watchdog.test.mjs',
    'test/outcome-reconciler-v2.coordinator.test.mjs',
    'test/outcome-reconciler-watchdog-current-binding.test.mjs',
    'contracts/outcome-reconciler-v2-watchdog-slo.json']) {
    assert.equal(existsSync(path.join(ROOT, file)), false, `${file} must be deleted`);
  }
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  for (const alias of ['test:outcome-reconciler:watchdog', 'test:outcome-reconciler:coordinator',
    'test:outcome-reconciler:watchdog-current-binding',
    'test:outcome-reconciler:watchdog-current-binding:regression']) {
    assert.equal(alias in scripts, false, `${alias} still names a script that does not exist`);
  }
  // Every remaining suite alias has to resolve to a file, or the release DAG schedules a ghost.
  for (const [alias, command] of Object.entries(scripts)) {
    if (!alias.startsWith('test:outcome-reconciler:')) continue;
    for (const token of command.split(/\s+/)) {
      if (!token.startsWith('scripts/')) continue;
      assert.ok(existsSync(path.join(ROOT, token)), `${alias} runs missing ${token}`);
    }
  }
});

test('(c) the release DAG no longer schedules the four removed suites', () => {
  const plan = JSON.parse(read('contracts/outcome-reconciler-release-dag.json')) as {
    nodes: Array<{ id: string; dependsOn: string[]; command: string[] }>;
    legacyEntrypoints: Array<{ nodeId: string }>;
    timeoutCalibration: { observedMaximumSeconds: Record<string, number> };
    postgresIsolation: { nodes: Record<string, unknown> };
  };
  const frontier = JSON.parse(read('contracts/outcome-reconciler-release-frontier.json')) as {
    namedSuites: Array<{ name: string; packageScript: string }>;
  };
  const ids = new Set(plan.nodes.map((node) => node.id));
  for (const removed of ['suite-watchdog-111k', 'suite-coordinator',
    'suite-watchdog-current-binding', 'suite-watchdog-current-binding-regression']) {
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
  assert.deepEqual(
    frontier.namedSuites.filter((suite) => /watchdog|coordinator/.test(suite.name)), []);
});

// (i) ---------------------------------------------------------------------------------------------
test('(i) this is subtraction: no new service, no new resident process', () => {
  const compose = read('docker-compose.yml');
  const services = [...compose.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]);
  assert.deepEqual(services.sort(),
    ['apiserver', 'gateway', 'pg-socket', 'pgbackup', 'postgres', 'web']);
  assert.equal(/restart:\s*unless-stopped/.test(REMOVAL_SQL), false);
  const apiserver = JSON.parse(read('src/apiserver/package.json')) as {
    scripts: Record<string, string>;
  };
  assert.deepEqual(
    Object.keys(apiserver.scripts).filter((name) => name.startsWith('start:')).sort(),
    ['start:dev'], 'the removal may not add a long-running entry point');
  // Nothing in the migration keeps running after it commits.
  assert.doesNotMatch(REMOVAL_SQL, /pg_cron|CREATE EXTENSION|LISTEN |NOTIFY /);
  // Its whole vocabulary is subtraction plus the three re-homed definitions section 1 and 2 name.
  const created = [...REMOVAL_SQL.matchAll(/^CREATE\s+(?:OR\s+REPLACE\s+)?(TABLE|TRIGGER|TYPE|INDEX)/gm)];
  assert.deepEqual(created, [], 'the removal migration installs no new relation, trigger or index');
});

/**
 * Every object 0221 took out, spelled the way a CREATE would have to spell it to put it back. The
 * two dropped columns are here too: re-adding a column is the same net addition as re-adding a
 * table. `outcome_watchdog` is the schema itself, which covers everything 0199 and 0214 named
 * inside it.
 */
const REMOVED_OBJECTS = [
  ...COORDINATOR_TABLES,
  ...COORDINATOR_FUNCTIONS,
  ...BINDING_TABLES,
  'executable_runtime_current_binding',
  'executable_runtime_register_current_binding',
  'executable_runtime_append_current_heartbeat',
  'outcome_watchdog',
  'runtime_binding_digest',
  'runtime_binding_logical_time',
];

/** Which of the removed objects this migration text puts back on the schema. */
function reinstalls(sql: string): string[] {
  return REMOVED_OBJECTS.filter((name) => new RegExp(
    '(?:CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:MATERIALIZED\\s+)?'
    + '(?:TABLE|VIEW|SCHEMA|FUNCTION|PROCEDURE|TRIGGER|INDEX)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?'
    + `|ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)${name}\\b`, 'i').test(sql));
}

test('(i) the removal deletes far more than it adds', () => {
  // This used to be `git diff --numstat main...HEAD`, which measured the work against wherever the
  // branch happened to be standing. That reads "8,666 deleted, 0 added" on the branch and "0 added,
  // 0 deleted" the moment it merges, so the assertion inverted on the tree it was written to
  // protect. The arithmetic below is read out of the tree itself and says the same thing before and
  // after the merge, on a clone with no `main` ref, and on an export with no history at all.

  // What it retired. The ledger is append-only and the test above pins these four in place, so this
  // is a fixed quantity that no later commit can dilute — which is exactly what a baseline SHA
  // could not promise: unrelated work landing on main would eventually out-add the 8,666 lines.
  const retired = INSTALLERS.reduce((total, dir) => total + migrationSql(dir).split('\n').length, 0);
  assert.ok(retired > 4_000,
    `expected the 4,160 lines the four migrations installed, saw ${retired}`);

  // What it spent. 0221, plus any later migration that goes back to the same vocabulary — a
  // compatibility shim for the machinery being removed is part of the removal's bill, while an
  // unrelated migration landing on top of it is not.
  const spending = ledger().filter((dir) => dir >= REMOVAL_DIR)
    .filter((dir) => DROPPED_NAMES.some((name) => migrationSql(dir).includes(name)));
  const spent = spending.reduce((total, dir) => total + migrationSql(dir).split('\n').length, 0);
  assert.ok(spent * 5 < retired,
    `the removal spent ${spent} lines (${spending.join(', ')}) to retire ${retired}`);

  // And it spent none of them putting any of it back. A removal that re-creates what it dropped is
  // a net addition however the line counts come out, so this half is absolute rather than a ratio.
  assert.deepEqual(spending.flatMap((dir) => reinstalls(migrationSql(dir)).map((n) => `${dir}: ${n}`)),
    [], 'nothing at or after the removal may re-create what it dropped');
});
