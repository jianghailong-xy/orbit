import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { TRIGGER_WRITE_SOURCES } from '../common/db-write-inventory';
import {
  deriveTaskCompletionStatus,
  evaluateTaskCompletion,
} from './task-completion-criterion';

/**
 * What keeps the EXECUTABLE acceptance runtime deleted.
 *
 * 0200 put a negotiation and a typed termination in front of one exit-code comparison: an
 * admission decided before the process started, an append-only attempt whose termination said
 * EXITED / TIMED_OUT / CANCELLED / SIGNALED / START_FAILED / INFRASTRUCTURE_LOST, and a
 * continuation that read a non-EXITED termination and kept the goal actionable instead of failing
 * the task. 0209 bound that attempt into a project criterion as a collector, and 0215 gave the
 * acceptance run a closing move derived from it. 0227 removes all three, and takes 0187's FineWeb
 * backfill ledger — the rest of the `task_executable_*` family — with them.
 *
 * This file reads the tree: the migration ledger for what was installed and dropped, and the same
 * text a reviewer reads for what may still name it. Text rather than `tsc`, for the reason every
 * removal suite here gives — this codebase reaches PostgreSQL through `$queryRaw`, so a dropped
 * relation compiles perfectly and fails in production.
 * `executable-acceptance-runtime-removal.pg.spec.ts` is the other half: what a migrated server
 * actually has, and whether an EXECUTABLE task still reaches DONE on it.
 */

const API = path.resolve(__dirname, '../..');
const ROOT = path.resolve(API, '../..');
const MIGRATIONS = path.join(API, 'prisma/migrations');
const REMOVAL_DIR = '0227_executable_acceptance_runtime_removal';
const REMOVAL_SQL = readFileSync(path.join(MIGRATIONS, REMOVAL_DIR, 'migration.sql'), 'utf8');

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

/** A migration with its prose stripped: what the database is actually asked to do. */
function statementsOf(sql: string): string {
  return sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
}

/** The migrations this removal reverses, oldest first. */
const REVERSED_DIRS = [
  '0187_fineweb_executable_backfill',
  '0200_executable_acceptance_runtime_contract',
  '0209_project_acceptance_executable_attempt_collector',
  '0215_acceptance_run_closure',
];

const DROPPED_TABLES = [
  'task_executable_admission',
  'task_executable_attempt',
  'task_executable_backfill_batch',
  'task_executable_backfill_item',
  'task_executable_continuation',
  'task_executable_diagnosis',
];

const DROPPED_FUNCTIONS = [
  'executable_acceptance_import_bootstrap_legacy_timeout',
  'executable_acceptance_mark_stale_attempts',
  'executable_acceptance_plan_digest',
  'n19_fineweb_executable_backfill_step',
  'n19_fineweb_executable_classify',
  'n19_fineweb_executable_inventory',
  'n19_fineweb_executable_prepare',
  'n19_fineweb_executable_rollback_step',
  'project_acceptance_run_closure_guard',
  'project_acceptance_run_conclude',
  'project_acceptance_run_derive_conclusion',
  'project_acceptance_run_stalled_obligations',
  'project_acceptance_run_state_value',
  'project_acceptance_run_states',
  'task_executable_admission_immutable_guard',
  'task_executable_attempt_start_guard',
  'task_executable_attempt_termination_guard',
  'task_executable_plan_bind',
];

const DROPPED_TYPES = [
  'executable_acceptance_admission_decision',
  'executable_acceptance_continuation_kind',
  'executable_acceptance_legacy_termination',
  'executable_acceptance_termination_kind',
  'project_acceptance_run_conclusion_basis',
  'project_acceptance_run_obligation_kind',
  'project_acceptance_run_state',
];

/** Triggers this removal takes off tables it did not own, plus the ones that fell with a table. */
const DROPPED_TRIGGERS = [
  'project_acceptance_run_closure_guard',
  'task_executable_admission_immutable_guard',
  'task_executable_attempt_no_delete',
  'task_executable_attempt_start_guard',
  'task_executable_attempt_termination_guard',
  'task_executable_diagnosis_append_only',
  'task_executable_plan_bind',
];

/**
 * 0200's negotiation columns on `task`, and 0215's three on `project_acceptance_run`.
 *
 * `acceptance_timeout_seconds` is NOT here, and was until 0236. That migration takes the column
 * back -- one nullable integer, still no admission, no ceiling and no typed termination -- and
 * `(ab)` below is what holds it to exactly that. The rest of the negotiation stays listed, which
 * is the point of naming the exception rather than shortening the list: a budget being declarable
 * again says nothing about the machinery that used to decide whether a task deserved one.
 */
const DROPPED_COLUMNS = [
  'acceptance_owner_timeout_ceiling_seconds',
  'acceptance_policy_timeout_ceiling_seconds',
  'acceptance_schema_revision',
  'acceptance_capability_revision',
  'acceptance_command_digest',
  'acceptance_evaluation_plan_digest',
  'execution_attempt_count',
  'acceptance_runtime_schema_revision',
  'acceptance_runtime_capability_revision',
  'acceptance_runtime_hard_max_seconds',
  'acceptance_runtime_reported_at',
  'conclusion_basis',
  'conclusion_digest',
  'conclusion_window_seconds',
];

/**
 * Identifiers no live line of source may still hand to PostgreSQL or call in TypeScript/Go.
 *
 * The database names and the code that only existed to reach them, in one list: this removal's
 * whole point is that both halves go, and a scan that checked only the SQL names would pass over a
 * service still importing a deleted module.
 */
const DROPPED_NAMES = [
  ...DROPPED_TABLES,
  ...DROPPED_FUNCTIONS,
  ...DROPPED_TYPES,
  ...DROPPED_COLUMNS,
  'ExecutableAcceptanceCapability',
  'ExecutableAcceptanceDispatchPlan',
  'ExecutableAttemptStartResponse',
  'ExecutableAttemptTerminationKind',
  'acceptanceCapabilityMatrix',
  'acceptanceCapabilityRevision',
  'acceptanceCommandDigest',
  'acceptanceEvaluationPlanDigest',
  'acceptanceOwnerTimeoutCeilingSeconds',
  'acceptancePolicyTimeoutCeilingSeconds',
  'acceptanceRuntimeDeadline',
  'acceptanceSchemaRevision',
  // `acceptanceTimeoutSeconds` was here too, and came back with 0236's column -- see `(ab)`. Its
  // two ceilings above did not, so a caller can still say how long, and nothing can be said about
  // what happens to a task that wants longer than someone else would allow.
  'continuationAfterExecutableAttempt',
  'evaluateExecutableAttempt',
  'executableAcceptanceCapabilityV2',
  'executableEvaluationPlan',
  'executableFailureFingerprint',
  'executionAttemptCount',
  'negotiateExecutableAcceptance',
  'startExecutableAcceptanceAttempt',
  'taskExecutableAdmission',
  'taskExecutableAttempt',
  'taskExecutableContinuation',
  'taskExecutableDiagnosis',
  'timeoutContinuationTrace',
];

/** Source modules and harnesses that existed only to serve this machinery. */
const DELETED_FILES = [
  'src/apiserver/src/tasks/executable-acceptance-runtime.ts',
  'src/runner-go/executable_acceptance.go',
  'src/runner-go/executable_acceptance_test.go',
  'scripts/executable-acceptance-runtime.sh',
  'scripts/executable-acceptance-runtime-manifest.mjs',
  'scripts/executable-acceptance-rolling-upgrade.mjs',
  'test/executable-acceptance-runtime.test.mjs',
  'test/executable-acceptance-deadline.test.mjs',
];

/**
 * The three groups 0200 also installed that are NOT this runtime, and stay.
 *
 * An object belongs to the migration that created it — but "created it" is not the same as "is
 * what this removal is about". Each of these has its own callers and its own later owner, and the
 * removal migration has to say so in prose rather than leave a reader to wonder.
 */
const KEPT_0200_OBJECTS = [
  'task_dependency_tail_id',
  'task_dependency_tail_satisfied',
  'task_all_dependency_tails_satisfied',
  'session_dispatch_dependency_check',
  'executable_runtime_heartbeat',
  'executable_dead_man_event',
  'executable_runtime_liveness',
  'executable_runtime_overlay_read_surface',
];

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

function sourceFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).split('\n').filter(Boolean);
  return [...new Set(listed)]
    .filter((file) => !file.startsWith('src/apiserver/prisma/migrations/'))
    .filter((file) => existsSync(path.join(ROOT, file)) && statSync(path.join(ROOT, file)).isFile());
}

/** A line that is prose end to end: a removal has to be able to say what it removed. */
function isProseLine(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*|--|#|\|\s*~~)/.test(line);
}

/**
 * A live reference is a line that would hand one of these names to PostgreSQL or call it. An
 * absence check — `to_regclass(...) IS NULL`, `proname = '...'`, `relname LIKE '...'` — names the
 * thing precisely in order to prove it is gone, which is the opposite of using it, so those lines
 * are let through. The same rule the 0221, 0222 and 0226 removal suites state, reused rather than
 * restated, so one reading of "still referenced" covers every removal in this project.
 */
function livesOn(line: string): string[] {
  if (isProseLine(line)) return [];
  if (/to_regclass|pg_proc|pg_class|pg_namespace|pg_trigger|pg_type|proname|relname|nspname|typname|tgname|column_name|table_name|indexname|migration_name|DROP\s|doesNotMatch|doesNotInclude/i
    .test(line)) {
    return [];
  }
  return DROPPED_NAMES.filter((name) => line.includes(name));
}

/** Removal suites are exempt as files: every such line quotes a migration rather than calling it. */
function isRemovalSuite(file: string): boolean {
  return /-removal(\.pg|\.http)?\.spec\.ts$/.test(file)
    || /-removal-preserved\.pg\.spec\.ts$/.test(file);
}

// (a) ---------------------------------------------------------------------------------------------
test('(a) every relation, function, type and trigger this removal names ends DROPPED', () => {
  for (const name of DROPPED_TABLES) {
    const standing = lastVerdict(
      new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${name}"?[\\s(]`, 'i'),
      new RegExp(`DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?"?${name}"?`, 'i'),
    );
    assert.ok(standing, `${name} is named by no migration at all`);
    assert.deepEqual(standing, { dir: REMOVAL_DIR, verdict: 'DROPPED' },
      `${name} must be dropped by this removal, not by ${standing.dir}`);
  }
  for (const name of DROPPED_FUNCTIONS) {
    const standing = lastVerdict(
      new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+"?${name}"?\\s*\\(`, 'i'),
      new RegExp(`DROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?"?${name}"?\\s*\\(`, 'i'),
    );
    assert.ok(standing, `${name} is named by no migration at all`);
    assert.deepEqual(standing, { dir: REMOVAL_DIR, verdict: 'DROPPED' },
      `${name} is still installed by ${standing.dir}`);
  }
  for (const name of DROPPED_TYPES) {
    const standing = lastVerdict(
      new RegExp(`CREATE\\s+TYPE\\s+"?${name}"?\\b`, 'i'),
      new RegExp(`DROP\\s+TYPE\\s+(?:IF\\s+EXISTS\\s+)?"?${name}"?`, 'i'),
    );
    assert.ok(standing, `${name} is named by no migration at all`);
    assert.equal(standing.verdict, 'DROPPED', `${name} is still installed by ${standing.dir}`);
  }
  // Every one of them was installed by one of the migrations this removal reverses — derived from
  // the ledger rather than from a hand-written list, so "this is what 0187/0200/0209/0215 built"
  // cannot be satisfied by editing a constant in this file.
  const earlier = migrations().filter(({ dir }) => dir < REMOVAL_DIR);
  for (const name of [...DROPPED_TABLES, ...DROPPED_TYPES]) {
    const first = earlier.find(({ sql }) => new RegExp(
      `CREATE\\s+(?:TABLE|TYPE)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${name}"?[\\s(]`, 'i').test(sql));
    assert.ok(first, `${name} is created by no migration before the removal`);
    assert.ok(REVERSED_DIRS.includes(first.dir),
      `${name} came from ${first.dir}, which is not one of the migrations being reversed`);
  }
});

test('(a) the triggers it names are off the server for good', () => {
  for (const name of DROPPED_TRIGGERS) {
    const standing = lastVerdict(
      new RegExp(`CREATE\\s+(?:CONSTRAINT\\s+)?TRIGGER\\s+"?${name}"?\\b`, 'i'),
      new RegExp(`DROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?"?${name}"?\\b`, 'i'),
    );
    assert.ok(standing, `${name} is named by no migration at all`);
    // Two of these fell with their table rather than being named; the rest are dropped by name.
    if (standing.verdict === 'CREATED') {
      assert.ok(
        DROPPED_TABLES.some((table) => name.startsWith(table)),
        `${name} is still created by ${standing.dir} and no table drop takes it down`,
      );
    }
  }
  // And the generated trigger inventory agrees: none of them is registered any more.
  for (const name of DROPPED_TRIGGERS) {
    assert.equal(TRIGGER_WRITE_SOURCES.some((row) => row.trigger === name), false,
      `${name} is still registered in db-write-inventory.ts`);
  }
});

// (b) ---------------------------------------------------------------------------------------------
test('(b) no live source names a dropped relation, function, type or column', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    if (isRemovalSuite(file)) continue;
    // Frozen evidence reports record what was run at the time, for the same reason the migration
    // ledger is excluded above: they are history, not a live caller.
    if (file.startsWith('docs/evidence/')) continue;
    // A spec whose whole subject is a migration's frozen text quotes it rather than calling it.
    if (file === 'src/apiserver/src/tasks/task-fineweb-executable-backfill.spec.ts') continue;
    if (!/\.(ts|tsx|mts|mjs|js|json|sql|sh|go|md|prisma|yml|yaml)$/.test(file)) continue;
    read(file).split('\n').forEach((line, index) => {
      for (const name of livesOn(line)) offenders.push(`${file}:${index + 1}: ${name}`);
    });
  }
  assert.deepEqual(offenders, [], `live references survive the removal:\n${offenders.join('\n')}`);
});

test('(b) every module and harness that only served this runtime is gone', () => {
  for (const file of DELETED_FILES) {
    assert.equal(existsSync(path.join(ROOT, file)), false, `${file} must be deleted`);
  }
  // The suite that drove them is gone from the entry points that would run it, too.
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
  for (const script of ['test:outcome-reconciler:acceptance-runtime',
    'test:outcome-reconciler:acceptance-deadline']) {
    assert.equal(script in pkg.scripts, false, `${script} still exists in package.json`);
  }
  const frontier = JSON.parse(read('contracts/outcome-reconciler-release-frontier.json')) as {
    namedSuites: Array<{ name: string }>;
  };
  assert.equal(frontier.namedSuites.some(({ name }) => name === 'acceptance-runtime'), false);
  const plan = JSON.parse(read('contracts/outcome-reconciler-release-dag.json')) as {
    nodes: Array<{ id: string; dependsOn: string[] }>;
  };
  assert.equal(plan.nodes.some(({ id }) => id === 'suite-acceptance-runtime'), false);
  for (const node of plan.nodes) {
    assert.equal(node.dependsOn.includes('suite-acceptance-runtime'), false,
      `${node.id} still depends on the removed suite`);
  }
});

// (c) ---------------------------------------------------------------------------------------------
test('(c) the completionCriterion vocabulary is untouched by this removal', () => {
    // The enum is not this removal's to change, and it is still not changed: all three labels are
    // declared. What DID change, one migration later, is that 0228 removed the implementations
    // behind two of them at the account owner's direction — which is why this asserts the
    // vocabulary rather than that each value can be satisfied.
    // Statements only: the header prose says why the enum is out of scope.
    assert.doesNotMatch(statementsOf(REMOVAL_SQL), /task_completion_criterion/,
      'this removal must not issue a statement against the criterion enum');
    const schema = read('src/apiserver/prisma/schema.prisma');
    const declared = schema
      .slice(schema.indexOf('enum TaskCompletionCriterion {'))
      .split('\n}')[0]!
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[A-Z_]+$/.test(line));
    assert.deepEqual(declared, ['EXECUTABLE', 'VERIFICATION', 'EVIDENCE_JUDGMENT']);
    const criterion = read('src/apiserver/src/tasks/task-completion-criterion.ts');
    assert.match(criterion, /export function evaluateTaskCompletion\(/);
    assert.match(criterion, /export function deriveTaskCompletionStatus\(/);
  });

// The five-row table that stood here asked the pure evaluator for the four exit-code shapes plus
// the legacy -1 sentinel; 0228 then removed the comparison and it became "EXECUTABLE never
// satisfies". 2026-09-03 restored the comparison — without any of 0200's runtime, which is what
// THIS suite is answerable for. So the table is back, minus the sentinel row: the -1 case existed
// because 0200's typed termination could tell a kill from a disagreement, and with that gone -1 is
// just an integer. `task-completion-criterion.spec.ts` owns the full matrix; what is pinned here
// is that the restored answer comes from the exit code and from nothing this migration removed.
test('(c)(w) the pure evaluator answers EXECUTABLE from the exit code, with no runtime behind it',
  () => {
    assert.equal(deriveTaskCompletionStatus({
      completionCriterion: 'EXECUTABLE', acceptanceExpectedExitCode: 0, executableExitCode: 0,
    }), 'DONE');
    assert.equal(deriveTaskCompletionStatus({
      completionCriterion: 'EXECUTABLE', acceptanceExpectedExitCode: 0, executableExitCode: 1,
    }), null);
    // -1 was 0200's "not a real exit" sentinel. It is compared like anything else now, which is
    // the accepted consequence of removing the typed termination: a killed command and a
    // disagreeing one are the same fact.
    assert.equal(deriveTaskCompletionStatus({
      completionCriterion: 'EXECUTABLE', acceptanceExpectedExitCode: 0, executableExitCode: -1,
    }), null);
    // And no admission, attempt, continuation or termination kind is consulted to get there: the
    // fact type carries exactly two executable fields.
    const source = read('src/apiserver/src/tasks/task-completion-criterion.ts');
    const facts = source.slice(source.indexOf('export interface TaskCompletionFacts'));
    const body = facts.slice(0, facts.indexOf('\n}'));
    for (const gone of [/TerminationKind/u, /Admission/u, /attempt/iu, /Continuation/u]) {
      assert.doesNotMatch(body, gone, `TaskCompletionFacts carries ${gone} again`);
    }
    for (const facts2 of [
      { completionCriterion: 'EXECUTABLE' as const },
      { completionCriterion: 'EXECUTABLE' as const, verificationVerdict: 'PASS' as const },
      { completionCriterion: 'EXECUTABLE' as const, ownVerdict: 'PASS' as const },
      { completionCriterion: 'EXECUTABLE' as const, verifiesTaskId: 'not-a-verifier' },
    ]) {
      const evaluation = evaluateTaskCompletion(facts2);
      assert.equal(evaluation.criterion, 'EXECUTABLE');
      assert.equal(evaluation.satisfied, false,
        "no other criterion's fact can stand in for the comparison");
      assert.equal(deriveTaskCompletionStatus(facts2), null);
    }
    // EVIDENCE_JUDGMENT was not restored alongside it.
    assert.equal(deriveTaskCompletionStatus({ completionCriterion: 'EVIDENCE_JUDGMENT' }), null);
    // VERIFICATION is answered by the same function, and still concludes.
    assert.equal(deriveTaskCompletionStatus({
      completionCriterion: 'VERIFICATION', verificationVerdict: 'PASS',
    }), 'DONE');
    assert.equal(deriveTaskCompletionStatus({
      completionCriterion: 'VERIFICATION', verificationVerdict: 'FAIL',
    }), null);
  });

// (u)(v) -------------------------------------------------------------------------------------------
test('(u)(v) 0177 and 0181 are not named by this removal at all', () => {
  // No DDL against either, and no write. Reads are a different thing and were required here: the
  // DONE fence this removal restored still asked `task_judgment_request` whether a PASS was
  // decided. 0228 removed that lane and its table the same day, which is that migration's claim
  // to make, not this one's — what THIS one has to show is that it issued no statement itself.
  const statements = statementsOf(REMOVAL_SQL);
  for (const kept of ['acceptance_command', 'acceptance_expected_exit_code',
    'task_executable_acceptance_pair', 'task_judgment_request', 'task_executable_judgment_result']) {
    for (const ddl of ['DROP TABLE', 'ALTER TABLE', 'CREATE TABLE', 'TRUNCATE', 'DELETE FROM',
      'INSERT INTO', 'UPDATE', 'DROP COLUMN', 'DROP CONSTRAINT']) {
      assert.equal(new RegExp(`${ddl}\\s+(?:IF\\s+EXISTS\\s+)?"?${kept}"?\\b`, 'i').test(statements),
        false, `the removal issues ${ddl} against ${kept}: 0177 and 0181 are out of its scope`);
    }
  }
  assert.match(statements, /FROM "task_judgment_request" request/,
    'the DONE fence this removal restored still read the request, in this migration');
  // 0177's declaration still stands in the ledger: created, never dropped. That is the half the
  // account owner kept through both removals.
  //
  // Both patterns are anchored on `ALTER TABLE "task"`, and the DROP one has to be: migration 0233
  // drops a column of the same NAME from `project_acceptance_criterion_definition`, and a
  // table-blind `DROP COLUMN "acceptance_command"` would read that as 0177's pair going away.
  const declaration = lastVerdict(
    /ALTER TABLE "task"[\s\S]{0,200}ADD COLUMN "acceptance_command"/i,
    /ALTER TABLE "task"[\s\S]{0,200}DROP COLUMN "acceptance_command"/i,
  );
  assert.ok(declaration);
  assert.equal(declaration.verdict, 'CREATED', `dropped by ${declaration.dir}`);
  // 0181's two relations do NOT: 0228 dropped them. Asserted here, in the suite that used to
  // depend on them, so the dependency cannot quietly outlive the thing it depended on.
  for (const relation of ['task_judgment_request', 'task_executable_judgment_result']) {
    const standing = lastVerdict(
      new RegExp(`CREATE\\s+TABLE\\s+"?${relation}"?[\\s(]`, 'i'),
      new RegExp(`DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?"?${relation}"?`, 'i'),
    );
    assert.ok(standing);
    assert.equal(standing.verdict, 'DROPPED', `${relation} should have been dropped by 0228`);
    assert.equal(standing.dir, '0228_task_judgment_removal');
  }
});

// (aa) ---------------------------------------------------------------------------------------------
test('(aa) the ability to tell a timeout from a failure is gone, and nothing replaces it', () => {
  // The two functions that made a non-EXITED termination mean "keep going" rather than "failed".
  for (const symbol of ['evaluateExecutableAttempt', 'continuationAfterExecutableAttempt']) {
    const offenders = sourceFiles()
      .filter((file) => !isRemovalSuite(file))
      .filter((file) => /\.(ts|tsx|go|mjs|js)$/.test(file))
      .filter((file) => read(file).split('\n')
        .some((line) => !isProseLine(line) && line.includes(symbol)));
    assert.deepEqual(offenders, [], `${symbol} still has callers: ${offenders.join(', ')}`);
  }
  // And no new vocabulary stands in for the distinction they carried. These four spellings were
  // this runtime's alone -- the wire fields a runner used to report a typed termination, and the
  // type that named the six kinds. A source that spells one is proposing to reintroduce it.
  // (`TIMED_OUT` and `INFRASTRUCTURE_LOST` are deliberately NOT on this list: the release DAG's
  // own node terminal states use those words for something else entirely.)
  for (const invented of ['acceptanceTerminationKind', 'acceptanceAdmissionId',
    'acceptanceAttemptId', 'ExecutableAttemptTerminationKind']) {
    const offenders = sourceFiles()
      .filter((file) => !isRemovalSuite(file))
      .filter((file) => /\.(ts|tsx|go|mjs)$/.test(file))
      .filter((file) => read(file).split('\n')
        .some((line) => !isProseLine(line) && line.includes(invented)));
    assert.deepEqual(offenders, [],
      `${invented} is spelled by ${offenders.join(', ')}: this removal invents no replacement`);
  }
});

// (ab) -------------------------------------------------------------------------------------------
/**
 * The one thing this removal gave back, and how much of it.
 *
 * 0227 took out an admission, an append-only attempt with a typed termination, and a continuation
 * that read that termination and kept a failing task actionable. It also took out the number those
 * three were built around: how long the command may run. On 2026-09-03 the number came back, alone,
 * because without it EXECUTABLE could not be used by a repository whose test suite runs longer than
 * the runner's hard-coded two minutes -- this one, measured at 101-126s on the same tree, where the
 * same code derived DONE or FAILED depending on host load.
 *
 * A budget and a negotiation are not the same object, and this is where that claim is made
 * checkable rather than argued. 0236 may add the column and its CHECK. It may not create a table,
 * a type, a trigger or a function, and its STATEMENTS may not name anything else this removal
 * dropped -- its prose may, and does, in order to say what stays gone.
 */
const REINTRODUCED_DIR = '0236_executable_acceptance_budget';

test('(ab) 0236 takes the budget column back, and none of the runtime it was part of', () => {
  const sql = readFileSync(path.join(MIGRATIONS, REINTRODUCED_DIR, 'migration.sql'), 'utf8');
  const statements = statementsOf(sql);
  assert.match(statements, /ADD COLUMN "acceptance_timeout_seconds" integer/);
  // The column is the last word on itself: nothing after 0227 drops it again, and 0236 is what
  // creates it. Read from the ledger rather than from this file's constants.
  assert.deepEqual(
    lastVerdict(
      /ADD COLUMN "acceptance_timeout_seconds"/,
      /DROP COLUMN "acceptance_timeout_seconds"/,
    ),
    { dir: REINTRODUCED_DIR, verdict: 'CREATED' },
  );
  for (const structural of [/CREATE\s+TABLE/i, /CREATE\s+TYPE/i, /CREATE\s+(?:CONSTRAINT\s+)?TRIGGER/i,
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i, /CREATE\s+INDEX/i, /CREATE\s+VIEW/i, /DROP\s/i]) {
    assert.doesNotMatch(statements, structural,
      `0236 is one column and a CHECK; it must not also ${structural}`);
  }
  // Everything else this removal dropped is still dropped, in the statements 0236 actually runs.
  for (const name of DROPPED_NAMES) {
    assert.equal(statements.includes(name), false,
      `0236 returns to ${name}, which is the negotiation and not the budget`);
  }
  // And the accepted consequence is unchanged where it is written down: a budget buys wall-clock
  // and decides nothing, so a command killed at one is still reported and compared as -1.
  const doc = read('docs/task-completion-criteria.md');
  assert.match(doc, /Two consequences follow and are accepted/);
  assert.match(doc, /The runner reports `-1` for all of them/);
  // The budget is documented as an input with a default, not as a second chance.
  assert.match(doc, /acceptanceTimeoutSeconds/);
});

// (r)(s) -------------------------------------------------------------------------------------------
test('(r) the removal creates nothing: no table, view, trigger, type or index', () => {
  const statements = REMOVAL_SQL
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  for (const forbidden of [/CREATE\s+TABLE/i, /CREATE\s+VIEW/i, /CREATE\s+TRIGGER/i,
    /CREATE\s+TYPE/i, /CREATE\s+INDEX/i, /CREATE\s+SCHEMA/i, /CREATE\s+EXTENSION/i,
    /pg_cron/i, /LISTEN\s/i, /NOTIFY\s/i]) {
    assert.doesNotMatch(statements, forbidden,
      'nothing is created to stand in for what is being removed');
  }
  // The only CREATEs are two in-place function bodies that predate this removal, each restored
  // minus exactly the increment the removed layer added to it.
  const replaced = [...statements.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+"?([a-z_0-9]+)"?/gi)]
    .map((match) => match[1]).sort();
  assert.deepEqual(replaced, ['project_completion_contract_snapshot', 'task_done_canonical_writer_fence']);
  const earlier = migrations().filter(({ dir }) => dir < REMOVAL_DIR);
  for (const name of replaced) {
    assert.ok(earlier.some(({ sql }) => new RegExp(`FUNCTION\\s+"?${name}"?\\s*\\(`).test(sql)),
      `${name} is new, not replaced`);
  }
  // Neither restored body may reach for anything this removal drops.
  for (const name of [...DROPPED_TABLES, ...DROPPED_FUNCTIONS]) {
    const body = statements.slice(statements.indexOf('CREATE OR REPLACE FUNCTION'));
    assert.equal(new RegExp(`FROM\\s+"?${name}"?\\b`).test(body), false,
      `a restored body still reads ${name}`);
  }
});

test('(s) no compose service, daemon or replacement acceptance executor is introduced', () => {
  const compose = read('docker-compose.yml');
  // Only the block under `services:`; `volumes:` declares keys at the same indentation.
  const servicesBlock = compose.slice(compose.indexOf('\nservices:') + 1).split(/\n(?=\S)/)[0]!;
  const services = (servicesBlock.match(/^ {2}[a-z][a-z0-9-]*:$/gm) ?? [])
    .map((line) => line.trim().replace(':', ''));
  assert.deepEqual(services, ['postgres', 'pgbackup', 'apiserver', 'web', 'gateway']);
  for (const word of ['admission', 'acceptance', 'dead-man', 'watchdog', 'coordinator']) {
    assert.equal(compose.toLowerCase().includes(word), false,
      `docker-compose.yml names ${word}: this removal adds no service`);
  }
});

// (t) ---------------------------------------------------------------------------------------------
test('(t) what this retires is an order of magnitude more than what it spends', () => {
  const lines = (relative: string) => read(relative).split('\n').length;
  // Content, not a revision range. `git diff main..HEAD` reads 0/0 the moment this lands and a
  // pinned SHA only dilutes more slowly; these are the files being undone and the file doing the
  // undoing, and they read the same on any branch.
  const retired = REVERSED_DIRS
    .map((dir) => lines(`src/apiserver/prisma/migrations/${dir}/migration.sql`))
    .reduce((total, count) => total + count, 0);
  // Spent = the removal migration plus any later migration that returns to the same vocabulary.
  // Filtered by words rather than by date, so a compatibility shim written for what is being
  // removed lands on this removal's bill and unrelated later work does not.
  const VOCABULARY = new RegExp([
    // 0187's and 0200's relations, but NOT 0181's `task_executable_judgment_result` or 0177's
    // `task_executable_acceptance_pair`: both are out of this removal's scope by (u)(v) below, so
    // a later migration that names one is a different removal's bill, not a shim for this one.
    'task_executable_(?!judgment_result|acceptance_pair)',
    'executable_acceptance_(?!pair)',            // 0200's functions and enums, not 0177's CHECK
    'project_acceptance_run_conclu',             // 0215's closing move
    'project-acceptance-executable-attempt',     // 0209's collector version string
    'n19_fineweb',                               // 0187's operator functions
  ].join('|'));
  const spent = migrations()
    .filter(({ dir }) => dir >= REMOVAL_DIR)
    .filter(({ sql }) => VOCABULARY.test(sql))
    .map(({ dir }) => lines(`src/apiserver/prisma/migrations/${dir}/migration.sql`))
    .reduce((total, count) => total + count, 0);
  assert.ok(spent > 0, 'the removal migration itself must match the vocabulary filter');
  // The filter is a live predicate, not a permanently-empty one: it hits every installer this
  // removal reverses. An empty `spent` that came from a dead regex would read as a perfect score.
  for (const dir of REVERSED_DIRS) {
    assert.equal(VOCABULARY.test(read(`src/apiserver/prisma/migrations/${dir}/migration.sql`)),
      true, `${dir} does not match the vocabulary filter — it cannot be measuring anything`);
  }
  assert.ok(spent * 5 < retired,
    `expected subtraction: ${spent} spent against ${retired} retired`);
  // Absolute, so the ratio has no back door: nothing at or after the removal may re-create a
  // dropped object.
  for (const { dir, sql } of migrations().filter((m) => m.dir >= REMOVAL_DIR)) {
    for (const name of [...DROPPED_TABLES, ...DROPPED_TYPES]) {
      assert.equal(new RegExp(`CREATE\\s+(?:TABLE|TYPE)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${name}"?[\\s(]`, 'i').test(sql), false,
        `${dir} re-creates ${name}`);
    }
  }
});

test('(t) the removal migration stays a small, readable subtraction', () => {
  const statements = REMOVAL_SQL
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  const drops = [...statements.matchAll(/^\s*DROP\s+(TABLE|VIEW|FUNCTION|TRIGGER|TYPE)\b/gm)].length
    + [...statements.matchAll(/DROP (?:COLUMN|CONSTRAINT)\b/g)].length;
  assert.ok(drops >= 40, `expected a removal, saw only ${drops} drops`);
});

// The three groups 0200 installed that this removal deliberately keeps ------------------------------
test('the removal states, in its own text, what it keeps of 0200 and why', () => {
  for (const kept of KEPT_0200_OBJECTS) {
    assert.ok(REMOVAL_SQL.includes(kept),
      `${kept} is kept silently — the removal must name it and say who owns it`);
    // Read from the removal forward: a migration that re-creates an object it dropped in the same
    // file (0200 does exactly that with the dispatch trigger) is not evidence of anything here.
    const later = migrations().filter(({ dir }) => dir >= REMOVAL_DIR);
    for (const { dir, sql } of later) {
      assert.equal(
        new RegExp(`DROP\\s+(?:FUNCTION|VIEW|TABLE|TRIGGER)\\s+(?:IF\\s+EXISTS\\s+)?"?${kept}"?`, 'i')
          .test(sql),
        false, `${kept} is dropped by ${dir}`);
    }
  }
  // Each is named beside the reason it stays, not merely mentioned.
  assert.match(REMOVAL_SQL, /ordinary task\n--\s+dependency resolution/);
  assert.match(REMOVAL_SQL, /watchdog liveness channel, not the acceptance runtime/);
});
