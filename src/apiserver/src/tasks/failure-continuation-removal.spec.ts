import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { TRIGGER_WRITE_SOURCES } from '../common/db-write-inventory';

/**
 * What keeps failure continuation and successor handoff deleted.
 *
 * Four migrations built a machine that decided, by itself, what should happen after a typed
 * EXECUTABLE attempt failed: 0210 wrote an immutable receipt per failure plus an obligation and a
 * delivery outbox, 0211 reduced that receipt to a deterministic route, 0212 committed an atomic
 * successor handoff that rewrote task lineage and moved downstream dependency edges, and 0213 gave
 * the fingerprint a failure-site input so two consecutive failures could be told apart. 0226
 * removes all four.
 *
 * This file reads the tree: the migration ledger for what was installed and dropped, and the same
 * text a reviewer reads for what may still name it. Text rather than `tsc`, for the reason every
 * removal suite here gives — this codebase reaches PostgreSQL through `$queryRaw`, so a dropped
 * relation compiles perfectly and fails in production.
 * `failure-continuation-removal.pg.spec.ts` is the other half: what a migrated server actually has,
 * and whether ordinary supersession still works on it.
 */

const API = path.resolve(__dirname, '../..');
const ROOT = path.resolve(API, '../..');
const MIGRATIONS = path.join(API, 'prisma/migrations');
const REMOVAL_DIR = '0226_failure_continuation_successor_removal';
const REMOVAL_SQL = readFileSync(path.join(MIGRATIONS, REMOVAL_DIR, 'migration.sql'), 'utf8');

/** The four migrations this removal reverses, oldest first. */
const REVERSED_DIRS = [
  '0210_failure_continuation_trigger',
  '0211_failure_continuation_routing',
  '0212_failure_successor_handoff',
  '0213_failure_site_fingerprint',
];

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

const DROPPED_TABLES = [
  'failure_continuation_attempt_receipt',
  'failure_continuation_obligation',
  'failure_continuation_route_decision',
  'failure_continuation_wakeup_outbox',
  'failure_successor_current_binding',
  'failure_successor_dependency_rebind',
  'failure_successor_handoff',
];

const DROPPED_VIEWS = [
  'failure_continuation_owner_decision_inbox',
  'failure_continuation_project_attention',
  'failure_successor_current',
];

const DROPPED_FUNCTIONS = [
  'executable_failure_fingerprint',
  'executable_failure_site_digest',
  'executable_failure_site_identity',
  'executable_failure_site_source',
  'failure_continuation_ack_wakeup',
  'failure_continuation_attempt_receipt_trigger',
  'failure_continuation_cancel_wakeup',
  'failure_continuation_claim_wakeups',
  'failure_continuation_continuation_trigger',
  'failure_continuation_idempotency_key',
  'failure_continuation_materialize',
  'failure_continuation_record_attempt',
  'failure_continuation_retry_wakeup',
  'failure_continuation_route_claim',
  'failure_continuation_route_read',
  'failure_continuation_sweep',
  'failure_successor_current_binding_guard',
  'failure_successor_handoff_commit',
  'failure_successor_handoff_read',
  'failure_successor_task_binding_guard',
];

/**
 * (b) The three triggers this project hung on tables it did not own, which is why they are named
 * separately from the six that stood on its own tables and went with them.
 */
const CORE_TABLE_TRIGGERS: ReadonlyArray<readonly [string, string]> = [
  ['task', 'failure_successor_task_binding_immutable'],
  ['task_executable_attempt', 'task_executable_attempt_failure_continuation_receipt'],
  ['task_executable_continuation', 'task_executable_continuation_failure_wakeup'],
];

/** 0213's two columns on `task_executable_attempt`, and the enum one of them was typed with. */
const DROPPED_COLUMNS = ['failure_site_source', 'failure_site_digest'];
const DROPPED_TYPE = 'executable_failure_site_source';

/**
 * The 0200 functions 0212 and 0213 rewrote in place. An object belongs to the migration that
 * CREATED it, so these are restored rather than dropped — and restored to 0200's text, not to a
 * third variant nobody reviewed.
 */
const RESTORED_FUNCTIONS = [
  'executable_acceptance_mark_stale_attempts',
  'task_dependency_tail_id',
  'task_executable_attempt_termination_guard',
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
  ...DROPPED_VIEWS,
  ...DROPPED_FUNCTIONS,
  ...CORE_TABLE_TRIGGERS.map(([, trigger]) => trigger),
  DROPPED_TYPE,
  'failure_site_digest',
  'failure_site_source',
  'FailureContinuationControllerService',
  'FailureContinuationService',
  'FailureCoordinationCard',
  'FailureCoordinationOverview',
  'FailureSuccessorHandoffDto',
  'executableFailureSiteIdentity',
  'failureContinuationIdempotencyKey',
  'failureContinuationWakeFact',
  'failureCoordinationByProject',
  'failureCoordinationByTask',
  'failureSuccessorHandoff',
  'isFailureCoordinationRead',
  'parseFailureSurface',
  'projectFailureCoordination',
  'readFailureCoordination',
  'readFailureProjectSurface',
  'summarizeFailureCoordination',
];

/** Source modules that existed only to serve this machinery. */
const DELETED_FILES = [
  'src/apiserver/src/common/failure-coordination-read.ts',
  'src/apiserver/src/common/failure-coordination-read.spec.ts',
  'src/apiserver/src/projects/failure-continuation.ts',
  'src/apiserver/src/projects/failure-continuation.service.ts',
  'src/apiserver/src/projects/failure-continuation-controller.ts',
  'src/apiserver/src/projects/failure-continuation-controller.service.ts',
  'src/web/src/components/FailureCoordinationCard.tsx',
  'src/web/src/components/FailureCoordinationUi.test.tsx',
  'src/web/src/lib/failureCoordination.ts',
  'src/runner-go/failure_successor_handoff_test.go',
  'test/outcome-reconciler-failure-continuation-trigger.test.mjs',
  'test/outcome-reconciler-failure-coordination-e2e.test.mjs',
  'test/outcome-reconciler-failure-routing.test.mjs',
  'test/outcome-reconciler-failure-successor-handoff.test.mjs',
  'scripts/outcome-reconciler-failure-continuation-trigger.sh',
  'scripts/outcome-reconciler-failure-continuation-trigger-manifest.mjs',
  'scripts/outcome-reconciler-failure-coordination-e2e.sh',
  'scripts/outcome-reconciler-failure-coordination-e2e-manifest.mjs',
  'scripts/outcome-reconciler-failure-routing.sh',
  'scripts/outcome-reconciler-failure-routing-manifest.mjs',
  'scripts/outcome-reconciler-failure-successor-handoff.sh',
  'scripts/outcome-reconciler-failure-successor-handoff-manifest.mjs',
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

/**
 * Every object, carrying the two patterns that say who put it on the schema and who took it off.
 * One list rather than two spellings of the same set: `(a)` proves each object's standing verdict
 * from it, and `(a)` also reads the same `created` patterns to work out which migrations installed
 * what is being retired, so the two cannot drift into disagreeing about what is being removed.
 */
const DROPPED_OBJECTS: ReadonlyArray<{
  name: string; kind: 'TABLE' | 'VIEW' | 'FUNCTION'; created: RegExp; dropped: RegExp;
}> = [
  ...DROPPED_TABLES.map((name) => ({
    name,
    kind: 'TABLE' as const,
    created: new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${name}"?[\\s(]`, 'i'),
    dropped: new RegExp(
      `DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?"?${name}"?\\s*(?:CASCADE|RESTRICT)?\\s*[;,]`, 'i'),
  })),
  ...DROPPED_VIEWS.map((name) => ({
    name,
    kind: 'VIEW' as const,
    created: new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?VIEW\\s+"?${name}"?`, 'i'),
    dropped: new RegExp(`DROP\\s+VIEW\\s+(?:IF\\s+EXISTS\\s+)?"?${name}"?\\s*[;,]`, 'i'),
  })),
  ...DROPPED_FUNCTIONS.map((name) => ({
    name,
    kind: 'FUNCTION' as const,
    created: new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+"?${name}"?\\s*\\(`, 'i'),
    dropped: new RegExp(`DROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?"?${name}"?\\s*\\(`, 'i'),
  })),
];

/**
 * Every file the worktree actually has, tracked or merely known about, minus the migration ledger
 * and build output. `--others --exclude-standard` is load-bearing: plain `git ls-files` reports the
 * INDEX, so a file written but not yet staged is invisible and the scan goes green on a tree it
 * never read.
 */
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
 * are let through. The same rule the 0221 and 0222 removal suites state, reused rather than
 * re-invented weaker.
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
  return /-removal(\.pg|\.http)?\.spec\.ts$/.test(file);
}

// (a) ---------------------------------------------------------------------------------------------
test('(a) every table, view and function 0210-0213 installed is dropped by 0226', () => {
  for (const { name, kind, created, dropped } of DROPPED_OBJECTS) {
    const standing = lastVerdict(created, dropped);
    assert.ok(standing, `${name} is named by no migration at all`);
    assert.equal(standing.verdict, 'DROPPED', `${name} is still installed by ${standing.dir}`);
    if (kind !== 'FUNCTION') {
      assert.equal(standing.dir, REMOVAL_DIR,
        `${name} was dropped by ${standing.dir}, not by this removal`);
    }
  }
  // And every one of them was installed by one of the four migrations this removal reverses —
  // derived from the same `created` patterns, so the claim "this is what 0210-0213 built" cannot
  // be satisfied by editing a hand-written list.
  const earlier = migrations().filter(({ dir }) => dir < REMOVAL_DIR);
  const installers = new Set<string>();
  for (const { name, created } of DROPPED_OBJECTS) {
    const first = earlier.find(({ sql }) => created.test(sql));
    assert.ok(first, `${name} is created by no migration before the removal`);
    installers.add(first.dir);
  }
  assert.deepEqual([...installers].sort(), REVERSED_DIRS);
});

test('(a) 0213\'s two attempt columns and its enum go, and no index survives them', () => {
  for (const column of DROPPED_COLUMNS) {
    assert.match(REMOVAL_SQL, new RegExp(`DROP COLUMN "${column}"`),
      `${column} must be dropped from task_executable_attempt`);
  }
  assert.match(REMOVAL_SQL,
    /DROP CONSTRAINT "task_executable_attempt_failure_site_digest_check"/);
  assert.match(REMOVAL_SQL, new RegExp(`DROP TYPE ${DROPPED_TYPE};`));
  const standing = lastVerdict(
    new RegExp(`CREATE TYPE ${DROPPED_TYPE}\\b`),
    new RegExp(`DROP TYPE ${DROPPED_TYPE}\\b`),
  );
  assert.deepEqual(standing, { dir: REMOVAL_DIR, verdict: 'DROPPED' });
});

// (b) ---------------------------------------------------------------------------------------------
test('(b) the three triggers on tables this project did not own are dropped by name', () => {
  for (const [table, trigger] of CORE_TABLE_TRIGGERS) {
    assert.match(
      REMOVAL_SQL,
      new RegExp(`DROP TRIGGER "?${trigger}"? ON "?${table}"?;`),
      `${trigger} must be dropped from ${table} explicitly, not left to a cascade`,
    );
    assert.equal(
      TRIGGER_WRITE_SOURCES.some((entry) => entry.trigger === trigger),
      false,
      `${trigger} is still registered in the DB write inventory`,
    );
  }
  // The `task` one is the reason ordinary supersession is this removal's most load-bearing
  // positive case: it fired on every status / superseded_by_task_id / superseded_at /
  // terminal_reason UPDATE in the database, not only on a routed one.
  const before = readFileSync(
    path.join(MIGRATIONS, '0212_failure_successor_handoff/migration.sql'), 'utf8');
  assert.match(before,
    /BEFORE UPDATE OF status, superseded_by_task_id, superseded_at, terminal_reason ON task/);
});

// (c) ---------------------------------------------------------------------------------------------
test('(c) no live line of source still names a dropped relation, function, trigger or module', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    if (isRemovalSuite(file)) continue;
    if (!/\.(ts|tsx|mts|mjs|js|json|sql|sh|go|md|prisma|yml|yaml)$/.test(file)) continue;
    read(file).split('\n').forEach((line, index) => {
      for (const name of livesOn(line)) offenders.push(`${file}:${index + 1}: ${name}`);
    });
  }
  assert.deepEqual(offenders, [], `live references survive the removal:\n${offenders.join('\n')}`);
});

test('(c) every module that existed only to serve the failure router is gone', () => {
  for (const file of DELETED_FILES) {
    assert.equal(existsSync(path.join(ROOT, file)), false, `${file} must be deleted`);
  }
  // Including the wiring: a package script pointing at a deleted shell script is a door that
  // reports "no such file" instead of "this suite is gone".
  const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
  const wired = Object.keys(scripts).filter((name) => name.includes('failure'));
  assert.deepEqual(wired, [], 'package.json still wires a failure-continuation suite');
});

test('(c) the schema declares none of the removed models, columns or enums', () => {
  const schema = read('src/apiserver/prisma/schema.prisma');
  for (const model of [
    'FailureContinuationAttemptReceipt', 'FailureContinuationObligation',
    'FailureContinuationWakeupOutbox', 'FailureContinuationRouteDecision',
    'FailureSuccessorHandoff', 'FailureSuccessorCurrentBinding',
    'FailureSuccessorDependencyRebind', 'ExecutableFailureSiteSource',
  ]) {
    assert.equal(schema.includes(model), false, `schema.prisma still declares ${model}`);
  }
  // And the wall it stands next to is untouched. Read inside the model rather than anywhere in the
  // file: `failureFingerprint` is 0200's column, three other models declare one of their own, and
  // a whole-file `includes` would have gone green on a TaskExecutableAttempt that had lost it.
  const model = schema.slice(schema.indexOf('model TaskExecutableAttempt {'));
  const attempt = model.slice(0, model.indexOf('\n}\n'));
  assert.ok(attempt.length > 0 && attempt.length < 4_000, 'the attempt model was not located');
  for (const kept of ['failureFingerprint', 'terminationKind', 'actualExitCode', 'rawOutput']) {
    assert.ok(attempt.includes(kept), `TaskExecutableAttempt lost ${kept}`);
  }
  for (const gone of ['failureSiteSource', 'failureSiteDigest']) {
    assert.equal(attempt.includes(gone), false, `TaskExecutableAttempt still declares ${gone}`);
  }
});

// (i) ---------------------------------------------------------------------------------------------
test('(i) the EXECUTABLE wall is not named by the removal beyond 0213\'s own two columns', () => {
  const statements = REMOVAL_SQL
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  // Every mention of a `task_executable_*` relation in a statement, and what it is doing there.
  // The list is exhaustive on purpose: the alternative is a prefix ban that this removal cannot
  // satisfy, because dropping 0213's columns and restoring 0200's functions both have to name it.
  const mentions = [...statements.matchAll(/task_executable_[a-z_]+/g)].map((hit) => hit[0]);
  assert.deepEqual([...new Set(mentions)].sort(), [
    // The three relations, read inside 0200's restored bodies and never dropped.
    'task_executable_admission',
    'task_executable_attempt',
    // The two 0210 triggers this removal takes off that wall, by name.
    'task_executable_attempt_failure_continuation_receipt',
    // 0213's column CHECK, dropped with the column it constrained.
    'task_executable_attempt_failure_site_digest_check',
    // And 0200's own termination guard, restored to 0200's body.
    'task_executable_attempt_termination_guard',
    'task_executable_continuation',
    'task_executable_continuation_failure_wakeup',
  ]);
  assert.equal(/DROP\s+TABLE\s+"?task_executable_/i.test(statements), false,
    'no task_executable_* table may be dropped by this removal');
  assert.equal(/CREATE\s+TABLE/i.test(statements), false,
    'this removal creates no table, archive or otherwise');
});

test('(i) 0200\'s three replaced functions are restored to 0200\'s own text', () => {
  const zero200 = readFileSync(
    path.join(MIGRATIONS, '0200_executable_acceptance_runtime_contract/migration.sql'), 'utf8');
  for (const name of RESTORED_FUNCTIONS) {
    // What 0226 did is frozen in its own text: it re-creates each one and drops none of them.
    // (Two of the three were later dropped outright by 0227 with the acceptance runtime, which is
    // that migration's decision to defend, not this one's — so this reads 0226, not the frontier.)
    assert.match(REMOVAL_SQL,
      new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+${name}\\s*\\(`, 'i'),
      `${name} must be re-created by the removal`);
    assert.doesNotMatch(REMOVAL_SQL,
      new RegExp(`DROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?${name}\\s*\\(`, 'i'),
      `${name} must never be dropped by the removal`);
    // Byte-for-byte against 0200's body, whitespace-insensitively: an object belongs to the
    // migration that created it, and "restore" has to mean the text that was there.
    const body = (source: string) => {
      const at = source.indexOf(`FUNCTION ${name}(`);
      assert.ok(at > 0, `${name} is not defined in this migration`);
      const start = source.indexOf('$$', at);
      const end = source.indexOf('$$', start + 2);
      return source.slice(start + 2, end).replace(/\s+/g, ' ').trim();
    };
    assert.equal(body(REMOVAL_SQL), body(zero200),
      `${name}'s restored body is not 0200's — a third variant is not a restoration`);
  }
  // The site input left the fingerprint with it, on both sides of the same value. The
  // TypeScript side of that pair was `tasks/executable-acceptance-runtime.ts`, which 0227
  // removed outright; there is no module left to carry either spelling.
  assert.equal(
    existsSync(path.join(API, 'src/tasks/executable-acceptance-runtime.ts')),
    false,
    'the acceptance runtime module is gone, so neither fingerprint spelling can survive in it',
  );
});

// (j) ---------------------------------------------------------------------------------------------
test('(j) 0226 does not so much as name project_acceptance_* or the other protected walls', () => {
  for (const prefix of [
    'project_acceptance_', 'executable_runtime_', 'task_judgment_', 'task_completion_evidence',
  ]) {
    assert.equal(REMOVAL_SQL.includes(prefix), false,
      `${prefix}* is a load-bearing wall and this removal may not name it`);
  }
});

// (k) ---------------------------------------------------------------------------------------------
test('(k) the migration is subtraction: drops far outnumber the three restorations', () => {
  const statements = REMOVAL_SQL
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  const drops = [...statements.matchAll(/^\s*DROP\s+(TABLE|VIEW|FUNCTION|TRIGGER|TYPE)\b/gm)].length
    + [...statements.matchAll(/DROP (?:COLUMN|CONSTRAINT)\b/g)].length;
  const creates = [...statements.matchAll(/^\s*CREATE\s+/gm)].length;
  assert.equal(creates, RESTORED_FUNCTIONS.length,
    'the only CREATE here is the restoration of a 0200 function');
  assert.ok(drops > creates * 10, `expected a removal, saw ${drops} drops and ${creates} creates`);
  for (const forbidden of [/CREATE\s+TRIGGER/i, /CREATE\s+VIEW/i, /CREATE\s+TABLE/i,
    /CREATE\s+TYPE/i, /CREATE\s+INDEX/i, /CREATE\s+EXTENSION/i, /pg_cron/i, /LISTEN\s/i,
    /NOTIFY\s/i]) {
    assert.doesNotMatch(statements, forbidden,
      'nothing is created to stand in for what is being removed');
  }
});

test('(k) what this removes is an order of magnitude more than what it adds', () => {
  const lines = (relative: string) => read(relative).split('\n').length;
  const removed = REVERSED_DIRS
    .map((dir) => lines(`src/apiserver/prisma/migrations/${dir}/migration.sql`))
    .reduce((total, count) => total + count, 0);
  const added = [
    `src/apiserver/prisma/migrations/${REMOVAL_DIR}/migration.sql`,
    'src/apiserver/src/tasks/failure-continuation-removal.spec.ts',
    'src/apiserver/src/tasks/failure-continuation-removal.pg.spec.ts',
  ].map(lines).reduce((total, count) => total + count, 0);
  // Content, not a revision range: `git diff main..HEAD` reads 0/0 the moment this lands, and a
  // pinned SHA only dilutes more slowly. These four files are what is being undone and these three
  // are what does the undoing, whatever branch they are read from.
  assert.ok(removed > 2_400, `the four migrations should be ~2,490 lines, saw ${removed}`);
  assert.ok(removed > added,
    `expected subtraction, saw ${removed} lines retired against ${added} added`);
  // Two of those three added files are this suite and its server half — evidence, not machinery.
  // The machinery side of the ledger is one migration that only issues DROPs.
  assert.ok(lines(`src/apiserver/prisma/migrations/${REMOVAL_DIR}/migration.sql`) < 300,
    'the removal itself must stay a small, readable migration');
});

test('(k) no compose service, daemon or replacement failure router is introduced', () => {
  const compose = read('docker-compose.yml');
  for (const word of ['failure', 'continuation', 'successor']) {
    assert.equal(compose.toLowerCase().includes(word), false,
      `docker-compose.yml names ${word}: this removal adds no service`);
  }
  // The exit that was missing is a person, not another table: no source may declare a new route
  // vocabulary, owner-decision option or delivery outbox to replace what went.
  for (const invented of ['APPROVE_BOUND_REQUEST', 'REVISE_OR_DENY', 'AUTOMATIC_REPAIR',
    'AUTOMATIC_REVALIDATION', 'FAILURE_CONTINUATION_OWNER_DECISION']) {
    const offenders = sourceFiles()
      .filter((file) => !isRemovalSuite(file))
      .filter((file) => /\.(ts|tsx|go|mjs|js)$/.test(file))
      .filter((file) => read(file).split('\n').some(
        (line) => !isProseLine(line) && line.includes(invented),
      ));
    assert.deepEqual(offenders, [], `${invented} came back in ${offenders.join(', ')}`);
  }
});
