import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * What keeps the obligation algebra, the canonical DONE gate and delivery attestation deleted.
 *
 * Seven migrations (0194, 0195-evaluator, 0196 x2, 0197, 0198-delivery, 0199-actor-surfaces) built
 * a canonical fact ingress, an evaluator that reduced facts to obligations, a shadow projection
 * reconciler in its own schema, a binding-invalidation ledger, a DONE gate driven by that
 * projection, and a delivery attestation store that fed the gate. 0222 removes all of it.
 *
 * This file reads the tree: the migration ledger for what was installed and dropped, and the same
 * text a reviewer reads for what may still name it. It reads text rather than trusting `tsc` for
 * the reason every removal suite before it gives — this codebase reaches PostgreSQL through
 * `$queryRaw`, so a dropped relation compiles perfectly and fails in production.
 * `canonical-done-gate-removal.pg.spec.ts` is the other half: what a migrated server actually has.
 */

const API = path.resolve(__dirname, '../..');
const ROOT = path.resolve(API, '../..');
const MIGRATIONS = path.join(API, 'prisma/migrations');
const REMOVAL_DIR = '0222_canonical_done_gate_removal';
const REMOVAL_SQL = readFileSync(path.join(MIGRATIONS, REMOVAL_DIR, 'migration.sql'), 'utf8');

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

/** The relations the seven migrations installed and 0222 takes away. */
const DROPPED_TABLES = [
  'outcome_active_obligation',
  'outcome_binding_transition',
  'outcome_canonical_fact',
  'outcome_delivery_attestation',
  'outcome_delivery_binding',
  'outcome_delivery_verification',
  'outcome_evaluation_cut',
  'outcome_evaluation_cut_fact',
  'outcome_evaluation_projection',
  'outcome_evaluator_result',
  'outcome_fact_authority_grant',
  'outcome_fact_authority_matrix',
  'outcome_fact_authority_revocation',
  'outcome_fact_binding',
  'outcome_fact_stream',
  'outcome_obligation_event',
  'outcome_obligation_reduction',
  'outcome_obligation_revision',
  'outcome_obligation_successor',
  'outcome_obsolete_obligation',
  'outcome_proof_obsolescence',
  'outcome_proof_successor',
  'outcome_reconcile_request',
];

const DROPPED_VIEWS = [
  'outcome_current_evaluation_projection',
  'outcome_current_evaluator_result',
  'outcome_current_reconcile_request',
  'outcome_obligation_successor_set',
];

const DROPPED_FUNCTIONS = [
  'outcome_authority_revocation_invalidates_reduction',
  'outcome_binding_changed_fields',
  'outcome_binding_invalidators',
  'outcome_binding_transition_record',
  'outcome_commit_evaluation',
  'outcome_commit_evaluation_v1',
  'outcome_enqueue_reconcile_request',
  'outcome_ingest_canonical_fact',
  'outcome_jsonb_exact_keys',
  'outcome_matching_fact_invalidates_reduction',
  'outcome_obsolete_current_reduction',
  'outcome_operational_read_surface',
  'outcome_publish_evaluation_projection',
  'outcome_read_delivery_evidence',
  'outcome_read_evaluation_cut',
  'outcome_record_delivery_attestation',
  'outcome_record_delivery_verification',
  'outcome_register_authority_grant',
  'outcome_register_delivery_binding',
  'outcome_register_fact_binding',
  'outcome_replay_fact_set_digest',
  'outcome_revoke_authority_grant',
  'outcome_seal_evaluation_cut',
  'project_canonical_done_gate',
  'project_canonical_done_gate_projection_integrity_body',
];

/** The shadow reconciler lived in a schema of its own, so the schema is the unit. */
const DROPPED_SCHEMA = 'outcome_projection';

/**
 * The five 0194 helpers that stay, and what would break if they went. Each is generic, holds no
 * business rule, and is the only definition of that helper in the schema; subsystems this task is
 * forbidden to touch adopted them after 0194 shipped. Re-homing them under new names would rewrite
 * twelve triggers and seven CHECK constraints on protected tables to gain nothing.
 */
const RETAINED_HELPERS: ReadonlyArray<readonly [string, string]> = [
  // Both dependents named here originally — `task_executable_attempt` and
  // `project_acceptance_run_derive_conclusion` — were removed by 0227 with the EXECUTABLE
  // acceptance runtime. Each helper still has other dependents, which is what this checks.
  ['outcome_append_only_guard', 'executable_runtime_heartbeat'],
  ['outcome_sha256_json', 'project_completion_contract_snapshot'],
  ['outcome_canonical_json', 'outcome_sha256_json'],
  ['outcome_canonical_number', 'outcome_canonical_json'],
  ['outcome_valid_digest', 'executable_runtime_expectation'],
];

/** Every name that must not be handed to PostgreSQL any more. */
const DROPPED_NAMES = [
  ...DROPPED_TABLES, ...DROPPED_VIEWS, ...DROPPED_FUNCTIONS, `${DROPPED_SCHEMA}.`,
  'project_acceptance_done_insert_gate', 'CANONICAL_DONE_GATE_BLOCKED',
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
function lastVerdict(created: RegExp, dropped: RegExp): { dir: string; verdict: 'CREATED' | 'DROPPED' } | null {
  let standing: { dir: string; verdict: 'CREATED' | 'DROPPED' } | null = null;
  for (const { dir, sql } of migrations()) {
    if (created.test(sql)) standing = { dir, verdict: 'CREATED' };
    if (dropped.test(sql)) standing = { dir, verdict: 'DROPPED' };
  }
  return standing;
}

/**
 * Every object the seven migrations installed and 0222 takes away, each carrying the two patterns
 * that say who put it on the schema and who took it off. One list rather than two spellings of the
 * same set: `(a)` proves each object's standing verdict from it, and the subtraction arithmetic in
 * `(s)` reads the same patterns to work out which migrations installed what is being retired, so
 * the two cannot drift apart into disagreeing about what this removal is removing.
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
    dropped: new RegExp(`DROP\\s+VIEW\\s+(?:IF\\s+EXISTS\\s+)?"?${name}"?`, 'i'),
  })),
  ...DROPPED_FUNCTIONS.map((name) => ({
    name,
    kind: 'FUNCTION' as const,
    created: new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+"?${name}"?\\s*\\(`, 'i'),
    dropped: new RegExp(`DROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?"?${name}"?\\s*\\(`, 'i'),
  })),
];

/**
 * The migrations that installed what 0222 takes away: for each dropped object, the first migration
 * in the ledger that creates it. Derived from the same `created` patterns `(a)` proves the drops
 * with, so there is no second, hand-written spelling of the list to fall out of date — and if one
 * of those patterns ever stopped matching, `(a)` fails before this does. Every one of them is older
 * than the removal and the ledger is append-only, so the set is fixed for good.
 */
function installers(): string[] {
  const earlier = migrations().filter(({ dir }) => dir < REMOVAL_DIR);
  const dirs = new Set<string>();
  for (const { created } of DROPPED_OBJECTS) {
    const first = earlier.find(({ sql }) => created.test(sql));
    if (first) dirs.add(first.dir);
  }
  return [...dirs].sort();
}

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

/** A line that is prose end to end: a removal suite has to be able to say what it removed. */
function isProseLine(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*|--|\|\s*~~)/.test(line);
}

/**
 * A live reference is a line that would hand one of these names to PostgreSQL. An absence check —
 * `to_regclass(...) IS NULL`, `proname = '...'`, `relname LIKE '...'` — names the thing precisely
 * in order to prove it is gone, which is the opposite of using it, so those lines are let through.
 * The same rule the 0221 removal suite states, reused rather than re-invented weaker.
 */
function livesOn(line: string): string[] {
  if (isProseLine(line)) return [];
  if (/to_regclass|pg_proc|pg_class|pg_namespace|proname|relname|nspname|indexname|migration_name|DROP\s|doesNotMatch/i
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
test('(a) every relation, view and function the seven migrations installed is dropped by 0222', () => {
  for (const { name, kind, created, dropped } of DROPPED_OBJECTS) {
    const standing = lastVerdict(created, dropped);
    assert.ok(standing, `${name} is named by no migration at all`);
    assert.equal(standing.verdict, 'DROPPED', `${name} is still installed by ${standing.dir}`);
    if (kind === 'TABLE') {
      assert.equal(standing.dir, REMOVAL_DIR, `${name} was dropped by ${standing.dir}, not this removal`);
    }
  }
  assert.match(REMOVAL_SQL, new RegExp(`DROP SCHEMA ${DROPPED_SCHEMA} CASCADE;`),
    'the shadow projection schema is the unit its seven tables and two triggers go with');
  assert.match(REMOVAL_SQL, /DROP TRIGGER "project_acceptance_done_insert_gate" ON "project";/,
    "0197's second gate trigger goes with the gate it called");
});

test('(a) the five shared 0194 helpers are kept on purpose, and the migration says why', () => {
  for (const [helper, dependent] of RETAINED_HELPERS) {
    const standing = lastVerdict(
      new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+"?${helper}"?\\s*\\(`, 'i'),
      new RegExp(`DROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?"?${helper}"?\\s*\\(`, 'i'),
    );
    assert.ok(standing, `${helper} is named by no migration`);
    assert.equal(standing.verdict, 'CREATED',
      `${helper} was dropped by ${standing.dir}, and ${dependent} depends on it`);
    assert.ok(REMOVAL_SQL.includes(helper),
      `${helper} is kept silently — the removal must name it and say what depends on it`);
  }
});

// (b) ---------------------------------------------------------------------------------------------
test('(b) no live source names a dropped relation, view, function or schema', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    if (isRemovalSuite(file)) continue;
    if (!/\.(ts|tsx|mts|mjs|js|json|sql|sh|go|md|prisma)$/.test(file)) continue;
    read(file).split('\n').forEach((line, index) => {
      for (const name of livesOn(line)) offenders.push(`${file}:${index + 1}: ${name}`);
    });
  }
  assert.deepEqual(offenders, [],
    'a relation this migration dropped is still named outside the migration history — raw SQL in ' +
      '`$queryRaw` is not type-checked, so this scan is the only thing that would catch it');
});

test('(b) the Prisma schema no longer models a relation that does not exist', () => {
  const schema = read('src/apiserver/prisma/schema.prisma');
  for (const table of DROPPED_TABLES) {
    assert.equal(schema.includes(`@@map("${table}")`), false, `${table} still has a Prisma model`);
  }
  for (const column of ['outcome_binding_digest', 'outcome_binding_epoch',
    'outcome_watermark_logical_time']) {
    assert.equal(schema.includes(column), false,
      `${column} was 0196's addition to project_ratified_action_intent and is dropped with it`);
  }
});

// (c) ---------------------------------------------------------------------------------------------
test('(c) each of the eight canonical-gate readers is handled, and none holds raw SQL for a dropped relation', () => {
  // Four files went with the machinery, four were cut back to the half that survives. Stated as a
  // table so a reader can check the disposition of every one of the eight against the tree.
  const deleted = [
    'src/apiserver/src/outcome-reconciler/outcome-projection.service.ts',
    'src/apiserver/src/outcome-reconciler/outcome-surfaces.ts',
  ];
  for (const file of deleted) {
    assert.equal(existsSync(path.join(ROOT, file)), false, `${file} must be gone with the layer`);
  }
  const trimmed: Record<string, RegExp[]> = {
    // The canonical obligation surface read is gone. The Failure Continuation surface stood beside
    // it and stayed, until migration 0226 removed the router it projected; what is left of this
    // file is the owner inbox, which is what it was cut back TO rather than what it was cut back
    // FROM, and is therefore still the property worth pinning here.
    'src/apiserver/src/outcome-reconciler/outcome-surface.service.ts': [/humanInbox/],
    // 0150's acceptance gate is restored here; the 0197 canonical gate reader is gone.
    'src/apiserver/src/projects/project-acceptance.ts': [/ACCEPTANCE_MISSING/, /ACCEPTANCE_BLOCKED/],
    'src/apiserver/src/projects/project-acceptance.service.ts': [
      /async assertDoneAllowed\(/, /assertDoneAllowedForDigest/, /async evaluateGate\(/,
    ],
    'src/apiserver/src/projects/projects.controller.ts': [/@Get\(':id\/acceptance'\)/],
    'src/apiserver/src/projects/coordinator-judgment-opening.ts': [/./],
    'src/apiserver/src/common/db-write-inventory.ts': [/TRIGGER_WRITE_SOURCES/],
  };
  for (const [file, expectations] of Object.entries(trimmed)) {
    assert.ok(existsSync(path.join(ROOT, file)), `${file} must still exist`);
    const text = read(file);
    for (const expectation of expectations) {
      assert.match(text, expectation, `${file} lost something it was supposed to keep`);
    }
    for (const name of DROPPED_NAMES) {
      assert.equal(text.includes(name), false, `${file} still names ${name}`);
    }
  }
});

test('(c) project-acceptance.service.ts keeps the 0150 layer and holds none of the 0197 one', () => {
  const service = read('src/apiserver/src/projects/project-acceptance.service.ts');
  // 0150's half: the acceptance evidence version, its criterion projection and the two refusals.
  assert.match(service, /projectAcceptanceRun\.findFirst/);
  assert.match(service, /ACCEPTANCE_BLOCKED,/);
  assert.match(service, /unmetCriteria/);
  // 0197's half: the structured canonical view, its reader and its refusal code.
  for (const gone of ['CanonicalDoneGateView', 'canonicalGate', 'failedCanonicalGate',
    'canonicalIdentity', 'blockingObligations']) {
    assert.equal(service.includes(gone), false, `${gone} belongs to the removed canonical gate`);
  }
});

// (s) ---------------------------------------------------------------------------------------------
test('(s) the removal is subtraction: no new relation, no replacement completion gate', () => {
  for (const forbidden of [/CREATE\s+TABLE/i, /CREATE\s+(?:CONSTRAINT\s+)?TRIGGER/i,
    /CREATE\s+(?:UNIQUE\s+)?INDEX/i, /CREATE\s+VIEW/i, /CREATE\s+TYPE/i, /CREATE\s+SCHEMA/i]) {
    assert.equal(forbidden.test(REMOVAL_SQL), false,
      `the removal migration installs ${forbidden} — it must only take machinery away`);
  }
  // The four bodies it does rewrite all existed before it and are replaced, never created.
  const replaced = [...REMOVAL_SQL.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+([a-z_0-9]+)/gi)]
    .map((match) => match[1]).sort();
  assert.deepEqual(replaced, [
    'project_acceptance_done_gate',
    'project_acceptance_run_derive_conclusion',
    'project_action_intent_bind_full_revision',
    'project_commit_ratified_action',
    'project_submit_ratified_action',
  ]);
  const earlier = migrations().filter(({ dir }) => dir < REMOVAL_DIR);
  for (const fn of replaced) {
    assert.ok(earlier.some(({ sql }) => new RegExp(`FUNCTION\\s+"?${fn}"?\\s*\\(`).test(sql)),
      `${fn} is new, not replaced`);
  }
});

/**
 * Every name 0222 took off the schema, spelled the way a CREATE would have to spell it to put the
 * thing back. The three columns 0196 added to `project_ratified_action_intent` are here too —
 * re-adding a column is the same net addition as re-adding a table — and `outcome_projection` is
 * the shadow schema itself, which stands for the seven tables and two triggers that lived in it.
 */
const REMOVED_OBJECTS = [
  ...DROPPED_TABLES, ...DROPPED_VIEWS, ...DROPPED_FUNCTIONS, DROPPED_SCHEMA,
  'project_acceptance_done_insert_gate',
  'outcome_binding_digest', 'outcome_binding_epoch', 'outcome_watermark_logical_time',
];

/**
 * Which of the removed objects this migration text puts back on the schema. `RENAME TO` is one of
 * the ways in, not a flourish: 0196 is how `outcome_commit_evaluation_v1` came to exist, and it
 * never held a `CREATE` of that name — without this alternative that one entry could never match,
 * which is an unfalsifiable line rather than a check.
 */
function reinstalls(sql: string): string[] {
  return REMOVED_OBJECTS.filter((name) => new RegExp(
    '(?:CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:MATERIALIZED\\s+)?'
    + '(?:TABLE|VIEW|SCHEMA|FUNCTION|PROCEDURE|TRIGGER|INDEX)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?'
    + '|ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?'
    + `|RENAME\\s+TO\\s+)"?${name}"?\\b`, 'i').test(sql));
}

test('(s) no compose service or resident process is added, and the removal deletes more than it writes', () => {
  const compose = read('docker-compose.yml');
  assert.equal(/outcome[-_]?(projection|evaluator|delivery|obligation)/i.test(compose), false,
    'the removal must add no compose service');

  // The subtraction used to be proved with `git diff --numstat main...HEAD`, which measured where
  // the branch was standing rather than whether the change was a subtraction: 15,905 deleted
  // against 1,809 added while the work sat on a branch, and 0 against 0 the instant it merged. The
  // assertion therefore inverted on the one tree it exists to protect. Pinning a baseline SHA would
  // only have moved the problem — unrelated work landing on main keeps accumulating on the `added`
  // side until it out-adds the deletion, and it would fail for a reason that has nothing to do with
  // this removal — so the baseline here is content rather than a revision. Everything below is read
  // out of the worktree and says the same thing before a merge, after a merge, on a clone with no
  // `main` ref, and on an export with no history at all.
  const ledger = migrations();

  // What it retired: the migrations that installed the objects 0222 drops. The ledger is
  // append-only and all of them are older than the removal, so no later commit can dilute it.
  const installed = installers();
  const retired = ledger.filter(({ dir }) => installed.includes(dir))
    .reduce((total, { sql }) => total + sql.split('\n').length, 0);
  assert.ok(retired > 7_000,
    `expected the ~7,900 lines that installed this machinery, saw ${retired} in ${installed.join(', ')}`);

  // What it spent: 0222, plus any later migration that returns to the same vocabulary. A
  // compatibility shim for the machinery being removed goes on the removal's bill; an unrelated
  // migration that merely lands on top of it does not.
  const spending = ledger.filter(({ dir }) => dir >= REMOVAL_DIR)
    .filter(({ sql }) => DROPPED_NAMES.some((name) => sql.includes(name)));
  const spent = spending.reduce((total, { sql }) => total + sql.split('\n').length, 0);
  assert.ok(spent * 5 < retired, `the removal spent ${spent} lines `
    + `(${spending.map(({ dir }) => dir).join(', ')}) to retire ${retired}`);

  // And none of it went back. A removal that re-creates what it dropped is a net addition however
  // the line counts come out, so this half is absolute rather than a ratio.
  assert.deepEqual(
    spending.flatMap(({ dir, sql }) => reinstalls(sql).map((name) => `${dir}: ${name}`)), [],
    'nothing at or after the removal may re-create what it dropped');
});

test('(l)(m) the removal writes no row: the stated criteria and their conclusions are untouched', () => {
  // 306 criterion definitions across 43 projects, 313 criteria and 152 conclusions are account-level
  // audit records, and the strongest thing that can be said about them is that this migration has
  // no statement that could reach one. Its only DML is the three columns 0196 added to the ratified
  // action intent; every `project_acceptance_*` it names is read inside a function body it rewrites.
  const statements = REMOVAL_SQL.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');
  for (const write of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+"?project/i, /\bDELETE\s+FROM\b/i,
    /\bTRUNCATE\b/i]) {
    assert.equal(write.test(statements), false, `the removal carries a ${write} of its own`);
  }
  const altered = [...statements.matchAll(/ALTER\s+TABLE\s+"?([a-z_0-9]+)"?/gi)].map((m) => m[1]);
  assert.deepEqual([...new Set(altered)], ['project_ratified_action_intent']);
  for (const relation of ['project_acceptance_criterion_definition', 'project_acceptance_criterion',
    'project_acceptance_conclusion', 'project_acceptance_run', 'project_acceptance_audit']) {
    const drop = new RegExp(`DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?"?${relation}"?`, 'i');
    assert.equal(drop.test(statements), false, `${relation} is not this removal's to drop`);
  }
});

test('(s) the acceptance DONE gate is not replaced by a second completion mechanism', () => {
  // Exactly one BEFORE trigger on `project` decides DONE, it is 0150's, and 0222 re-creates its
  // body rather than installing a new gate beside it.
  const created = [...REMOVAL_SQL.matchAll(/CREATE\s+TRIGGER\s+"?([a-z_0-9]+)"?/gi)].map((m) => m[1]);
  assert.deepEqual(created, [], 'the removal installs no trigger at all');
  assert.match(REMOVAL_SQL,
    /CREATE OR REPLACE FUNCTION project_acceptance_done_gate\(\) RETURNS TRIGGER/,
    "the 0150 gate's body is restored, not a new one invented");
  // The header explains what was removed, so the vocabulary check reads only what executes.
  const statements = REMOVAL_SQL.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');
  for (const invented of ['DELIVERY_ATTESTATION_MISSING', 'CANONICAL_DONE_GATE_BLOCKED',
    'OBLIGATION_OPEN', 'PROJECT_DONE_GATE_V3']) {
    assert.equal(statements.includes(invented), false, `${invented} is a new gate vocabulary`);
  }
});
