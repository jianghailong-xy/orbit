import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

/**
 * 0220 removed the completion-ACK protocol. This is the static half of that removal: what the
 * migration text has to say, and what no line of live source may say any more.
 *
 * It is a string search rather than a compile check for the reason the 0218 removal suite gives:
 * this codebase reaches PostgreSQL through `$queryRaw`, so a dropped table survives `tsc` and
 * fails in production. `prisma/migrations` is excluded because it is the append-only record of how
 * the schema got here — 0201 must still be able to create what 0220 drops.
 */

const ROOT = path.resolve(__dirname, '../../../..');
const API = path.resolve(__dirname, '../..');
const MIGRATIONS = path.join(API, 'prisma/migrations');
const REMOVAL = path.join(MIGRATIONS, '0220_completion_ack_removal/migration.sql');

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

/**
 * Every file the worktree actually has — what git tracks AND what it merely knows about — minus
 * the migration ledger and the build output.
 *
 * `--others --exclude-standard` is load-bearing. Plain `git ls-files` reports the INDEX, so a file
 * that has been written but not staged is invisible to the scans below. That is not hypothetical:
 * while this suite was being written its six files were untracked, the scan could not see its own
 * siblings, and the run was green; the identical bytes went red on the next run, after the commit.
 * An assertion whose answer depends on whether someone has run `git add` yet binds its conclusion to
 * nothing, which is the one thing a removal proof has to do.
 * `scripts/outcome-reconciler-release-dag-lib.mjs` reaches for the same three flags for the same
 * reason. Parameterised by root so the enumeration itself can be tested against a throwaway
 * repository rather than asserted about this one.
 */
export function sourceFiles(root: string = ROOT): string[] {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);
  // `--cached` prints one row per index stage, so an unmerged path would arrive three times.
  return [...new Set(listed)]
    .filter((file) => !file.startsWith('src/apiserver/prisma/migrations/'))
    .filter((file) => existsSync(path.join(root, file)) && statSync(path.join(root, file)).isFile());
}

const REMOVAL_SQL = readFileSync(REMOVAL, 'utf8');

/** The twelve tables 0201-0204 created, exactly as the catalog named them. */
const DROPPED_TABLES = [
  'completion_ack_coordinator_delivery_adoption',
  'completion_ack_coordinator_delivery_plan',
  'completion_ack_coordinator_delivery_receipt',
  'completion_ack_delivery_progress_event',
  'completion_ack_delivery_reconcile_cursor',
  'completion_ack_fact',
  'completion_ack_obligation_event',
  'completion_ack_obligation_revision',
  'completion_ack_observation_register',
  'completion_ack_owner_decision_binding',
  'completion_ack_remediation_action',
  'completion_ack_rollout_epoch',
];

/** The four views. */
const DROPPED_VIEWS = [
  'completion_ack_active_obligation',
  'completion_ack_coordinator_source',
  'completion_ack_current_coordinator_delivery',
  'completion_ack_operational_obligation',
];

/**
 * The nine triggers 0201/0202 installed on tables that stay. The task named seven; PostgreSQL had
 * two more on `conversation_turn`, and they are removed on the same grounds as the rest.
 */
const CORE_TABLE_TRIGGERS: ReadonlyArray<[string, string]> = [
  ['task', 'task_completion_ack_remediation_action'],
  ['task', 'task_completion_ack_remediation_reactivation_guard'],
  ['task', 'zz_task_completion_ack_remediation_criterion_insert_guard'],
  ['task', 'zz_task_completion_ack_remediation_criterion_update_guard'],
  ['session', 'session_completion_ack_dispatch_insert_guard'],
  ['session', 'session_completion_ack_dispatch_revive_guard'],
  ['conversation_turn', 'conversation_turn_completion_ack_insert_guard'],
  ['conversation_turn', 'conversation_turn_completion_ack_lease_guard'],
  ['run_event', 'run_event_completion_ack_ingestion_guard'],
];

/** Load-bearing walls this removal may not touch, by the prefix each family is named with. */
const PROTECTED_PREFIXES = [
  'task_executable_',
  'failure_continuation_',
  'failure_successor_',
  'project_acceptance_',
  'executable_runtime_',
];

/** Every completion-ACK function 0220 drops, read back out of the removal's own DROP statements. */
const DROPPED_FUNCTIONS = [...REMOVAL_SQL.matchAll(/DROP FUNCTION ([a-z0-9_]+)\(/g)]
  .map((hit) => hit[1])
  .filter((name) => name.includes('completion_ack'));

/**
 * Everything no live line of source may still name. Deduplicated because a trigger and the function
 * it fires share a name in PostgreSQL — `run_event_completion_ack_ingestion_guard` is both — and one
 * line naming it once is one residual, not two.
 */
const DROPPED_NAMES = [...new Set([
  ...DROPPED_FUNCTIONS,
  ...DROPPED_TABLES,
  ...DROPPED_VIEWS,
  ...CORE_TABLE_TRIGGERS.map(([, trigger]) => trigger),
])];

/**
 * A line that carries no code at all: a `//` comment, a block-comment opener, or the ` * `
 * continuation inside one. A removal suite has to say what it removed, and a sentence about what a
 * dropped trigger used to do is not a call to it — the four hits that failed the 0220 acceptance run
 * were all sentences of that kind, in the sibling suites that drive the writes those triggers used
 * to fire on.
 *
 * Anchored at the start of the line on purpose: `await q(); // completion_ack_fact` is still a call
 * site, so only a line that is prose end to end is let through. The costs fall in the safe
 * direction — a wrapped expression whose continuation begins with `*` reads as prose, and a `#`
 * comment (shell, YAML) does not, so it would be reported rather than laundered.
 */
export function isProseLine(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*)/.test(line);
}

/** The same source with its prose blanked out and its line numbering intact. */
function withoutProse(source: string): string {
  return source
    .split('\n')
    .map((line) => (isProseLine(line) ? '' : line))
    .join('\n');
}

/**
 * Which of `needles` this one line still puts in front of PostgreSQL. Empty for prose; empty for a
 * line naming a migration DIRECTORY, because an inventory row saying a trigger has existed since
 * 0202_completion_ack_persistent_coordinator is history rather than a call site; otherwise every
 * name the line spells out, string literals included — a dropped table reached through `$queryRaw`
 * survives `tsc` and fails in production, which is why this suite reads text at all.
 */
export function namesDroppedObject(line: string, needles: readonly string[]): string[] {
  if (isProseLine(line)) return [];
  if (/\d{4}_completion_ack_/.test(line)) return [];
  return needles.filter((needle) => line.includes(needle));
}

// (a) --------------------------------------------------------------------------------------------
test('(a) 0220 drops every completion-ACK table, view and function by name', () => {
  for (const table of DROPPED_TABLES) {
    assert.match(REMOVAL_SQL, new RegExp(`DROP TABLE ${table};`),
      `${table} must be dropped by name`);
  }
  for (const view of DROPPED_VIEWS) {
    assert.match(REMOVAL_SQL, new RegExp(`DROP VIEW ${view};`), `${view} must be dropped by name`);
  }
  // Every function the four migrations created, read back out of their own CREATE statements, has
  // to be named by a DROP here. Derived rather than listed, so a function added to 0201-0204 in a
  // rebase cannot quietly survive the removal.
  const created = new Set<string>();
  for (const dir of readdirSync(MIGRATIONS).sort()) {
    if (!/^020[1-4]_completion_ack_/.test(dir)) continue;
    const sql = readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
    for (const hit of sql.matchAll(/CREATE (?:OR REPLACE )?FUNCTION\s+([a-z0-9_]*completion_ack[a-z0-9_]*)\s*\(/gi)) {
      created.add(hit[1]);
    }
  }
  assert.ok(created.size >= 50, `expected the whole protocol, saw ${created.size} functions`);
  const undropped = [...created]
    .filter((name) => !new RegExp(`DROP FUNCTION ${name}\\(`).test(REMOVAL_SQL))
    .sort();
  assert.deepEqual(undropped, [], 'every completion-ACK function must be dropped by name');
});

// (b) --------------------------------------------------------------------------------------------
test('(b) all nine core-table triggers are dropped, and only run_event keeps its behaviour', () => {
  for (const [table, trigger] of CORE_TABLE_TRIGGERS) {
    assert.match(REMOVAL_SQL, new RegExp(`DROP TRIGGER ${trigger} ON ${table};`),
      `${trigger} on ${table} must be dropped by name`);
  }
  // The one that is not a completion-ACK guard. Its name said it was; its body owns
  // `run_event.ingested_at` and the immutability of the ingestion provenance columns, which is an
  // ordinary run_event write path. It is re-created verbatim under a name that does not lie.
  assert.match(REMOVAL_SQL, /CREATE OR REPLACE FUNCTION run_event_ingestion_provenance_guard\(\)/);
  assert.match(REMOVAL_SQL, /CREATE TRIGGER run_event_ingestion_provenance_guard/);
  assert.match(REMOVAL_SQL, /NEW\.ingested_at := clock_timestamp\(\);/);
  assert.match(REMOVAL_SQL, /RUN_EVENT_INGESTED_AT_DB_OWNED/);
  assert.match(REMOVAL_SQL, /RUN_EVENT_INGESTION_PROVENANCE_IMMUTABLE/);
  // The other eight are pure denial or pure completion-ACK bookkeeping: nothing replaces them.
  for (const [, trigger] of CORE_TABLE_TRIGGERS.filter(([table]) => table !== 'run_event')) {
    assert.doesNotMatch(REMOVAL_SQL, new RegExp(`CREATE TRIGGER ${trigger.replace('completion_ack_', '')}`),
      `${trigger} must not be re-created under a new name`);
  }
});

test('(b) the trigger inventory agrees, and the renamed guard is attributed to 0220', () => {
  const inventory = read('src/apiserver/src/common/db-write-inventory.ts');
  for (const [, trigger] of CORE_TABLE_TRIGGERS) {
    assert.doesNotMatch(inventory, new RegExp(`"trigger":"${trigger}"`),
      `${trigger} must be gone from the trigger inventory`);
  }
  assert.match(
    inventory,
    /\{"table":"run_event","trigger":"run_event_ingestion_provenance_guard","event":"BEFORE INSERT OR UPDATE OF ingested_at, ingested_by_runner_id, ingested_under_lease_generation","kind":"ROW\/STATEMENT","since":"0220_completion_ack_removal"/,
    'the renamed run_event guard must be registered with its unchanged event list',
  );
});

// (c) --------------------------------------------------------------------------------------------
test('(c) no live source names a dropped table, view, function or trigger', () => {
  assert.ok(DROPPED_FUNCTIONS.length >= 50);
  const residual: string[] = [];
  for (const file of sourceFiles()) {
    // Only the two files that name the dropped objects in CODE are exempt: this suite holds the
    // lists above, and its pg half holds the catalog queries. Every other file — the four sibling
    // removal suites included — stays in the scan, and it is `namesDroppedObject` rather than a
    // path that decides whether one of their lines is a call site or a sentence about one.
    if (file === 'src/apiserver/src/common/completion-ack-removal.spec.ts') continue;
    if (file === 'src/apiserver/src/common/completion-ack-removal.pg.spec.ts') continue;
    const source = read(file);
    if (!source.includes('completion_ack')) continue;
    source.split('\n').forEach((line, index) => {
      // Reported with the line number: what failed the 0220 acceptance run was four entries that
      // had to be located by re-running this scan by hand before they could be read.
      for (const needle of namesDroppedObject(line, DROPPED_NAMES)) {
        residual.push(`${file}:${index + 1}: ${needle}`);
      }
    });
  }
  assert.deepEqual([...new Set(residual)].sort(), [],
    'no live source may still read a dropped relation or call a dropped function');
});

// (c) negative controls --------------------------------------------------------------------------
// The scan above is an assertion that something is absent, so it is worth nothing unless it would
// still report the thing if it were present. These three state that directly, against the exported
// pieces the scan is built from: what it must catch, what it must let through, and what it must be
// able to see at all.

test('(c) negative control: a forged $queryRaw call site is still residual', () => {
  const table = '  const [row] = await prisma.$queryRaw`SELECT id FROM completion_ack_fact`;';
  assert.deepEqual(namesDroppedObject(table, DROPPED_NAMES), ['completion_ack_fact'],
    'a live read of a dropped table must be reported, template literal or not');
  const trigger =
    "  await db.$executeRawUnsafe('ALTER TABLE run_event ENABLE TRIGGER run_event_completion_ack_ingestion_guard');";
  assert.deepEqual(namesDroppedObject(trigger, DROPPED_NAMES),
    ['run_event_completion_ack_ingestion_guard'],
    'a dropped trigger named from live code must be reported too');
  // Prose is a property of the whole line, so a trailing comment cannot launder the statement it is
  // attached to. This is what keeps the D1 fix from being a way to hide a call site.
  assert.deepEqual(namesDroppedObject('  await q(); // completion_ack_fact', DROPPED_NAMES),
    ['completion_ack_fact'], 'a comment tacked onto a live statement does not excuse it');
});

test('(c) negative control: the same name inside a comment is not residual', () => {
  // The two comment shapes the sibling removal suites actually use, carrying the two names that
  // failed the 0220 acceptance run. Both are explaining what a dropped guard used to do.
  assert.deepEqual(
    namesDroppedObject('  // `session_completion_ack_dispatch_insert_guard` fired on that INSERT.',
      DROPPED_NAMES),
    [], 'a sentence about a dropped trigger is not a call to it');
  assert.deepEqual(
    namesDroppedObject(' * `run_event_completion_ack_ingestion_guard` was not a completion-ACK guard',
      DROPPED_NAMES),
    [], 'and neither is a JSDoc line about one');
});

test('(c) negative control: a file that exists but is not in the index is still scanned', () => {
  // D2, stated as the difference it makes. `git ls-files` answers about the index, so the scan used
  // to be blind to a source file that had been written and not yet committed — which is exactly the
  // state a spec is in while you are writing it, and exactly how this suite passed a run that its
  // own committed content then failed. A throwaway repository holds both states at once.
  const root = mkdtempSync(path.join(tmpdir(), 'completion-ack-removal-scan-'));
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: root, stdio: 'ignore' });
    writeFileSync(path.join(root, 'staged.ts'), 'export const staged = 1;\n');
    execFileSync('git', ['add', 'staged.ts'], { cwd: root, stdio: 'ignore' });
    const callSite = 'const [row] = await prisma.$queryRaw`SELECT id FROM completion_ack_fact`;';
    writeFileSync(path.join(root, 'never-added.ts'), `${callSite}\n`);

    assert.deepEqual(
      execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean),
      ['staged.ts'],
      'the index-only enumeration this scan used to run cannot see the uncommitted file',
    );
    assert.deepEqual(sourceFiles(root).sort(), ['never-added.ts', 'staged.ts'],
      'the scan must enumerate a file that exists in the worktree but is not in the index');
    assert.deepEqual(namesDroppedObject(callSite, DROPPED_NAMES), ['completion_ack_fact'],
      'and the call site inside that file is read as residual');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('(c) the deleted modules are gone and nothing imports them', () => {
  const deleted = [
    'src/apiserver/src/common/completion-ack-obligation.ts',
    'src/apiserver/src/common/completion-ack-obligation.spec.ts',
    'src/apiserver/src/outcome-coordinator/completion-ack-coordinator.resolver.ts',
    'src/apiserver/src/outcome-coordinator/outcome-coordinator.runner.ts',
    'src/apiserver/src/outcome-coordinator/outcome-coordinator.worker.module.ts',
    'src/apiserver/src/outcome-coordinator/main.ts',
    'src/web/src/components/CompletionAckObligationBanner.tsx',
  ];
  for (const file of deleted) {
    assert.equal(existsSync(path.join(ROOT, file)), false, `${file} must be deleted`);
  }
  const specifiers = [
    'completion-ack-obligation',
    'completion-ack-coordinator.resolver',
    'outcome-coordinator/outcome-coordinator.runner',
    'outcome-coordinator/main',
    'CompletionAckObligationBanner',
  ];
  const importing: string[] = [];
  for (const file of sourceFiles()) {
    if (file === 'src/apiserver/src/common/completion-ack-removal.spec.ts') continue;
    // Same rule as the scan above: a commented-out import is a note, not an edge.
    const source = withoutProse(read(file));
    for (const [, specifier] of source.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      if (specifiers.some((needle) => specifier.includes(needle))) importing.push(`${file}: ${specifier}`);
    }
  }
  assert.deepEqual(importing, [], 'nothing may import a deleted module');
});

test('(c) the completion-ACK owner-decision doors are gone from every client surface', () => {
  for (const [file, needle] of [
    ['src/apiserver/src/projects/projects.controller.ts', 'completion-ack/owner-decisions'],
    ['src/apiserver/src/runner-api/runner-projects.controller.ts', 'completion-ack/owner-decisions'],
    ['src/runner-go/transport.go', 'completion-ack/owner-decisions'],
    ['src/runner-go/mcp.go', 'project_owner_decision_request'],
    ['src/runner-go/project_cli.go', 'owner-decision-request'],
  ] as const) {
    assert.equal(read(file).includes(needle), false, `${file} must not still name ${needle}`);
  }
});

// (j) --------------------------------------------------------------------------------------------
test('(j) 0220 drops nothing belonging to a protected family', () => {
  const dropped = [
    ...REMOVAL_SQL.matchAll(/DROP (?:TABLE|VIEW|FUNCTION|TRIGGER|INDEX)\s+([a-z0-9_]+)/g),
  ].map((hit) => hit[1]);
  assert.ok(dropped.length > 70, `expected the whole removal, saw ${dropped.length} drops`);
  for (const name of dropped) {
    for (const prefix of PROTECTED_PREFIXES) {
      assert.equal(name.startsWith(prefix), false,
        `${name} belongs to the protected ${prefix}* family and may not be dropped`);
    }
  }
  // The one column and index that do go, both created by the protocol for the protocol.
  assert.match(REMOVAL_SQL, /DROP COLUMN completion_delivery_receipt_id;/);
  assert.match(REMOVAL_SQL, /DROP INDEX conversation_turn_completion_ack_scan_idx;/);
});

test('(j) the executable-runtime helpers are re-created rather than left calling a dropped one', () => {
  // 0202 built the EXECUTABLE liveness wall beside the protocol and let it borrow two helpers.
  // Neutral copies are created first, and every borrower is re-created against them in the same
  // migration — a plpgsql body binds its callee by name at run time, so a rename alone would leave
  // five functions that compile and then fail on first call.
  assert.match(REMOVAL_SQL, /CREATE OR REPLACE FUNCTION outcome_uuid_from_digest\(p_digest text\)/);
  assert.match(REMOVAL_SQL, /CREATE OR REPLACE FUNCTION executable_runtime_sanitize_metadata\(p_metadata jsonb\)/);
  for (const borrower of [
    'executable_runtime_expectation_insert_guard',
    'executable_runtime_expectation_event_insert_guard',
    'executable_runtime_dead_man_expectation_guard',
    'executable_runtime_expect_generation',
    'executable_runtime_retire_expectation',
  ]) {
    assert.match(REMOVAL_SQL, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${borrower}\\(`),
      `${borrower} must be re-created against the neutral helpers`);
  }
  // Only the re-created bodies, not the DROP list that follows them.
  const bodies = REMOVAL_SQL.slice(
    REMOVAL_SQL.indexOf('CREATE OR REPLACE FUNCTION public.executable_runtime_expectation_insert_guard'),
    REMOVAL_SQL.indexOf('-- 6. Triggers on tables that stay'),
  );
  assert.ok(bodies.length > 5_000, 'the re-created bodies must be in the migration verbatim');
  assert.equal(bodies.includes('completion_ack_uuid_from_digest'), false);
  assert.equal(bodies.includes('completion_ack_sanitize_action_evidence'), false);
  assert.ok(bodies.includes('outcome_uuid_from_digest'));
  assert.ok(bodies.includes('executable_runtime_sanitize_metadata'));
});

test('(j) the 0202 coordinator wrappers are dropped and the 0198 implementations restored', () => {
  for (const entry of [
    'outcome_register_coordinator_obligation',
    'outcome_reconcile_active_obligations',
    'outcome_record_coordinator_result',
  ]) {
    assert.match(REMOVAL_SQL, new RegExp(`DROP FUNCTION ${entry}\\(`));
    assert.match(REMOVAL_SQL, new RegExp(`ALTER FUNCTION ${entry}_0198\\(`));
    assert.match(REMOVAL_SQL, new RegExp(`RENAME TO ${entry};`));
  }
});

// (l) --------------------------------------------------------------------------------------------
test('(l) this is subtraction: no new service, no new resident process, fewer lines', () => {
  const compose = read('docker-compose.yml');
  const services = [...(compose.match(/^services:\n([\s\S]*?)(?=^\S|\Z)/m)?.[1] ?? '')
    .matchAll(/^ {2}([a-z][a-z0-9_-]*):$/gm)].map((hit) => hit[1]).sort();
  assert.deepEqual(services, ['apiserver', 'gateway', 'pgbackup', 'postgres', 'web'],
    'the removal may not add a Compose service');
  // No new timer, poller or worker entry point: the removal deletes the only worker process the
  // protocol had and introduces none.
  assert.equal(existsSync(path.join(API, 'src/outcome-coordinator')), false);
  const apiScripts = JSON.parse(read('src/apiserver/package.json')).scripts as Record<string, string>;
  assert.deepEqual(
    Object.keys(apiScripts).filter((name) => name.startsWith('start:')).sort(),
    ['start:dev'],
    'the only launch alias left is the developer watch loop for the API itself',
  );

  // The SQL arithmetic, stated rather than implied: 0201-0204 are 7,146 lines of installed schema
  // and 0220 is what it costs to take them out. The four files stay on disk as history; what this
  // compares is how much schema is INSTALLED before and after.
  const installed = ['0201', '0202', '0203', '0204'].reduce((total, prefix) => {
    const dir = readdirSync(MIGRATIONS).find((name) => name.startsWith(`${prefix}_completion_ack_`))!;
    return total + readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8').split('\n').length;
  }, 0);
  assert.ok(installed > 7_000, `expected the protocol's 7,146 lines, saw ${installed}`);
  const removalLines = REMOVAL_SQL.split('\n').length;
  assert.ok(removalLines < installed / 5,
    `the removal (${removalLines} lines) must cost far less than the ${installed} it retires`);
});

test('(a) the Prisma schema declares none of the removed models or the receipt pointer', () => {
  const schema = read('src/apiserver/prisma/schema.prisma');
  for (const model of [
    'CompletionAckCoordinatorDeliveryPlan',
    'CompletionAckCoordinatorDeliveryReceipt',
    'CompletionAckCoordinatorDeliveryAdoption',
    'CompletionAckRemediationAction',
    'CompletionAckDeliveryProgressEvent',
    'CompletionAckDeliveryReconcileCursor',
    'CompletionAckOwnerDecisionBinding',
  ]) {
    assert.doesNotMatch(schema, new RegExp(`model ${model} \\{`), `${model} must be gone`);
  }
  // The generated client is what `tsc` type-checks against, so a model left behind here would
  // compile happily and fail on first query against the real server.
  assert.equal(schema.includes('completion_ack'), false,
    'no @@map may still point at a dropped table');
  assert.equal(schema.includes('completionDeliveryReceiptId'), false,
    'the coordinator attempt result must not keep a field over a dropped column');
});

test('(c) the watchdog SLO contract no longer measures or indexes the removed protocol', () => {
  const contract = JSON.parse(read('contracts/outcome-reconciler-v2-watchdog-slo.json')) as {
    metrics: Record<string, unknown>;
    capacity: Record<string, unknown> & { runtimeSchemaIndexes: string[] };
  };
  assert.equal('completionAckStaleness' in contract.metrics, false,
    'the collector may not still promise an SLO for a protocol that cannot fire');
  assert.equal('maximumCompletionAckEvidenceBytes' in contract.capacity, false);
  assert.equal('maximumCompletionAckActiveActions' in contract.capacity, false);
  assert.deepEqual(
    contract.capacity.runtimeSchemaIndexes.filter((name) => name.startsWith('completion_ack_')),
    [],
    'the runtime index census may not require an index on a dropped table',
  );
  // What it does still require has to be real, or the census is decorative.
  assert.ok(contract.capacity.runtimeSchemaIndexes.length >= 4);
  assert.equal(
    contract.capacity.runtimeSchemaIndexes.every((name) => name.startsWith('executable_')),
    true,
    'what is left is the EXECUTABLE liveness wall, which stays',
  );
});

test('(l) 0220 is the frontier, and the four migrations it retires stay as history', () => {
  const names = readdirSync(MIGRATIONS).filter((name) => /^\d{4}_/.test(name)).sort();
  assert.equal(names[names.length - 1], '0220_completion_ack_removal',
    'the removal must be the newest migration, so nothing replays after it');
  // The append-only ledger is not edited: 0201-0204 are still on disk, because a database that has
  // already applied them has to be able to replay the same history and then remove it.
  for (const prefix of ['0201', '0202', '0203', '0204']) {
    assert.ok(
      names.some((name) => name.startsWith(`${prefix}_completion_ack_`)),
      `${prefix} must remain in the migration ledger`,
    );
  }
});

test('(b) the removal installs exactly one new core-table trigger, and it is the renamed one', () => {
  const created = [...REMOVAL_SQL.matchAll(/CREATE TRIGGER ([a-z0-9_]+)/g)].map((hit) => hit[1]);
  assert.deepEqual(created, ['run_event_ingestion_provenance_guard'],
    'the only trigger 0220 creates is the run_event guard it renamed rather than removed');
  // And it re-creates exactly the functions it had to: the two neutral helpers, the five
  // executable-runtime borrowers, the read surfaces and the gate. Nothing new is invented.
  const functions = [...REMOVAL_SQL.matchAll(/CREATE OR REPLACE FUNCTION (?:public\.)?([a-z_.]+)\(/g)]
    .map((hit) => hit[1]);
  assert.deepEqual([...new Set(functions)].sort(), [
    'executable_runtime_dead_man_expectation_guard',
    'executable_runtime_expect_generation',
    'executable_runtime_expectation_event_insert_guard',
    'executable_runtime_expectation_insert_guard',
    'executable_runtime_retire_expectation',
    'executable_runtime_sanitize_metadata',
    'outcome_operational_read_surface',
    'outcome_projection.read_surface',
    'outcome_uuid_from_digest',
    'project_canonical_done_gate',
    'run_event_ingestion_provenance_guard',
  ]);
});
