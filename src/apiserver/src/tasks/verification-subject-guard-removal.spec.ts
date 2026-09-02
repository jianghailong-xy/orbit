import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { TRIGGER_WRITE_SOURCES } from '../common/db-write-inventory';

/**
 * 0224 removed the verification-subject dispatch guard 0207 installed. This is the static half of
 * that removal: what the migration text says, what the trigger inventory says, and what no line of
 * live source may say any more.
 *
 * It is a string search rather than a compile check for the reason the sibling removal suites give:
 * this codebase reaches PostgreSQL through `$queryRaw`, so a dropped trigger survives `tsc` and
 * fails at run time. `prisma/migrations` is excluded from the scan because it is the append-only
 * record of how the schema got here — 0207 must still be able to create what 0224 drops.
 */

const ROOT = path.resolve(__dirname, '../../../..');
const API = path.resolve(__dirname, '../..');
const MIGRATIONS = path.join(API, 'prisma/migrations');
const INSTALL = path.join(MIGRATIONS, '0207_verification_subject_dispatch_guard/migration.sql');
const REMOVAL_DIR = '0224_verification_subject_dispatch_guard_removal';
const REMOVAL = path.join(MIGRATIONS, REMOVAL_DIR, 'migration.sql');
const INSTALL_SQL = readFileSync(INSTALL, 'utf8');
const REMOVAL_SQL = readFileSync(REMOVAL, 'utf8');

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

/** The three triggers 0207 installed on core tables, exactly as the catalog named them. */
const DROPPED_TRIGGERS: ReadonlyArray<[string, string]> = [
  ['session', 'session_verification_subject_guard_insert'],
  ['session', 'session_verification_subject_guard_update'],
  ['task', 'task_verification_subject_live_session_guard'],
];

/** The two trigger functions behind them. */
const DROPPED_FUNCTIONS = [
  'session_verification_subject_guard',
  'task_verification_subject_live_session_guard',
];

/**
 * Everything no live line of source may still name.
 *
 * The two `session` trigger names are omitted deliberately: each contains the function name, so a
 * line naming one is already reported once. `TASK_VERIFICATION_SUBJECT:` carries its colon because
 * `TASK_VERIFICATION_SUBJECT_BUSY` and `TASK_VERIFICATION_SUBJECT_SUPERSEDED` are 0130's, they are
 * still raised, and the service still has to translate them.
 */
const DROPPED_NAMES = [
  'session_verification_subject_guard',
  'task_verification_subject_live_session_guard',
  'TASK_VERIFICATION_SUBJECT_LIVE_SESSION',
  'TASK_VERIFICATION_SUBJECT:',
];

/**
 * Every file the worktree actually has — what git tracks AND what it merely knows about — minus
 * the migration ledger and the build output.
 *
 * `--others --exclude-standard` is load-bearing: plain `git ls-files` reports the INDEX, so a file
 * that has been written and not staged would be invisible to the scan below, which is exactly the
 * state a spec is in while it is being written.
 */
function sourceFiles(root: string = ROOT): string[] {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);
  return [...new Set(listed)]
    .filter((file) => !file.startsWith('src/apiserver/prisma/migrations/'))
    .filter((file) => existsSync(path.join(root, file)) && statSync(path.join(root, file)).isFile());
}

/** A line that carries no code at all: a `//` comment, a block opener, or its ` * ` continuation. */
export function isProseLine(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*)/.test(line);
}

/**
 * Which of `needles` this one line still puts in front of PostgreSQL. Empty for prose; otherwise
 * every name the line spells out, string literals included — a dropped trigger reached through
 * `$executeRaw` survives `tsc` and fails on the server.
 */
export function namesDroppedObject(line: string, needles: readonly string[]): string[] {
  if (isProseLine(line)) return [];
  return needles.filter((needle) => line.includes(needle));
}

// (a) --------------------------------------------------------------------------------------------
test('(a) 0224 drops all three 0207 triggers and both of their functions by name', () => {
  for (const [table, trigger] of DROPPED_TRIGGERS) {
    assert.match(INSTALL_SQL, new RegExp(`CREATE TRIGGER "${trigger}"`),
      `${trigger} must be one 0207 actually installed`);
    assert.match(REMOVAL_SQL, new RegExp(`DROP TRIGGER ${trigger} ON ${table};`),
      `${trigger} on ${table} must be dropped by name`);
  }
  for (const fn of DROPPED_FUNCTIONS) {
    assert.match(REMOVAL_SQL, new RegExp(`DROP FUNCTION ${fn}\\(\\);`),
      `${fn}() must be dropped, not left behind as an unreachable body`);
  }
  // Nothing replaces them: the rule they duplicated lives in the service door.
  assert.doesNotMatch(REMOVAL_SQL, /CREATE\s+(?:CONSTRAINT\s+)?TRIGGER/);
  assert.doesNotMatch(REMOVAL_SQL, /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/);
});

test('(a) the similarly named 0130 guard is not collateral', () => {
  // `task_verification_subject_guard` polices where a `verifies_task_id` may point. Different job,
  // different migration, and it stays — a `DROP` whose prefix matched would take it out silently.
  // Read out of the DROP statements rather than the whole file, because the migration's own header
  // names it: saying which neighbour is deliberately spared is not sparing it.
  const dropped = [...REMOVAL_SQL.matchAll(/DROP (?:TRIGGER|FUNCTION) ([a-z0-9_]+)/g)]
    .map((hit) => hit[1]);
  assert.equal(dropped.includes('task_verification_subject_guard'), false,
    '0130\'s task_verification_subject_guard must not be dropped');
  assert.ok(
    TRIGGER_WRITE_SOURCES.some((entry) =>
      entry.trigger === 'task_verification_subject_guard'
      && entry.since === '0130_task_supersession_dispatch_guard'),
    '0130\'s guard must still be registered as installed',
  );
});

// (a) the rule the triggers duplicated is still enforced -------------------------------------------
test('(a) the service door still owns the rule, under the lock the triggers relied on', () => {
  // 0207's own header says the triggers preserved a rule "service gates and readiness use". This
  // is that rule, and the lock it is read under: without them the removal would not be a removal.
  const aggregation = read('src/apiserver/src/projects/task-aggregation.ts');
  assert.match(aggregation,
    /fact\.completionCriterion === 'VERIFICATION' && fact\.verifiesTaskId == null\) return true/);
  const sessions = read('src/apiserver/src/sessions/sessions.service.ts');
  assert.match(sessions, /if \(startsTaskWork && taskStartOwnedByCompletion\(\{/);
  assert.match(sessions, /FOR SHARE OF t/);
  const runnable = read('src/apiserver/src/tasks/manual-runnable-task-sql.ts');
  assert.match(runnable, /completion_criterion = 'VERIFICATION'::task_completion_criterion/);
  assert.match(runnable, /verifies_task_id IS NULL/);
});

// (b) --------------------------------------------------------------------------------------------
test('(b) the 0208 coordinator-context columns are kept, and the protocol reading them is intact', () => {
  // The retention decision, stated as a checked fact rather than only as a sentence in a comment.
  // These three columns are read on the session delivery path and written on turn completion and
  // event ingestion, and the runner binary advertises the capability that switches the path on.
  // Deleting them would not remove dead machinery, it would delete a live one-attach-per-engine-
  // context protocol and put the full coordinator instruction block back on every user message.
  const schema = read('src/apiserver/prisma/schema.prisma');
  for (const declaration of [
    'coordinatorContextEpoch Int @default(0) @map("coordinator_context_epoch")',
    'coordinatorContextAckKey String? @map("coordinator_context_ack_key")',
    'coordinatorContextKey String? @map("coordinator_context_key")',
  ]) {
    assert.ok(schema.includes(declaration), `${declaration} must still be declared`);
  }
  const controller = read('src/apiserver/src/runner-api/runner-api.controller.ts');
  assert.match(controller, /'session-claude-coordinator-context-v1'/);
  assert.match(controller, /'session-codex-coordinator-context-v1'/);
  assert.match(controller, /"coordinator_context_key" AS "coordinatorContextKey"/);
  // Both ends of the wire, so a future removal cannot take one side and leave the other.
  const transport = read('src/runner-go/transport.go');
  assert.match(transport, /sessionClaudeCoordinatorContextV1\s+=\s+"session-claude-coordinator-context-v1"/);
  assert.match(transport, /sessionCodexCoordinatorContextV1\s+=\s+"session-codex-coordinator-context-v1"/);
  // And the correctness-first fallback every runtime without that capability still takes.
  assert.match(read('src/apiserver/src/projects/coordinator-opening.ts'),
    /export function appendCoordinatorDeliveryContext\(/);
});

// (c) --------------------------------------------------------------------------------------------
test('(c) no live source names a dropped trigger, function or retired error string', () => {
  const residual: string[] = [];
  for (const file of sourceFiles()) {
    // Only this suite and its pg half are exempt: they hold the lists above and the catalog
    // queries. Every other file stays in the scan, and it is `namesDroppedObject` rather than a
    // path that decides whether one of its lines is a call site or a sentence about one.
    if (file === 'src/apiserver/src/tasks/verification-subject-guard-removal.spec.ts') continue;
    if (file === 'src/apiserver/src/tasks/verification-subject-guard-removal.pg.spec.ts') continue;
    const source = read(file);
    if (!source.includes('verification_subject') && !source.includes('VERIFICATION_SUBJECT')) continue;
    source.split('\n').forEach((line, index) => {
      for (const needle of namesDroppedObject(line, DROPPED_NAMES)) {
        residual.push(`${file}:${index + 1}: ${needle}`);
      }
    });
  }
  assert.deepEqual([...new Set(residual)].sort(), [],
    'no live source may still name a dropped trigger, call a dropped function, or match an error '
      + 'string nothing can raise any more');
});

test('(c) negative control: the scan would still report a forged call site, and lets prose through', () => {
  const forged =
    "  await db.$executeRawUnsafe('ALTER TABLE task DISABLE TRIGGER task_verification_subject_live_session_guard');";
  assert.deepEqual(namesDroppedObject(forged, DROPPED_NAMES),
    ['task_verification_subject_live_session_guard'],
    'a dropped trigger named from live code must be reported');
  assert.deepEqual(
    namesDroppedObject('  if (/TASK_VERIFICATION_SUBJECT: /.test(message)) return null;', DROPPED_NAMES),
    ['TASK_VERIFICATION_SUBJECT:'],
    'and so must a translation of an error nothing raises any more');
  assert.deepEqual(
    namesDroppedObject(' * `session_verification_subject_guard` used to refuse that INSERT.',
      DROPPED_NAMES),
    [], 'a sentence about a dropped trigger is not a call to it');
  // Prose is a property of the whole line, so a trailing comment cannot launder the statement it
  // is attached to.
  assert.deepEqual(
    namesDroppedObject('  await q(); // task_verification_subject_live_session_guard', DROPPED_NAMES),
    ['task_verification_subject_live_session_guard'],
    'a comment tacked onto a live statement does not excuse it');
  // And the two 0130 markers the service still translates must not be swept up by the prefix.
  assert.deepEqual(
    namesDroppedObject('  if (/TASK_VERIFICATION_SUBJECT_BUSY/.test(message)) return retry;',
      DROPPED_NAMES),
    [], '0130\'s BUSY marker is still raised and must stay translated');
  assert.deepEqual(
    namesDroppedObject('  if (/TASK_VERIFICATION_SUBJECT_SUPERSEDED/.test(message)) return gone;',
      DROPPED_NAMES),
    [], 'and so is its SUPERSEDED marker');
});

// (g) --------------------------------------------------------------------------------------------
/**
 * The core tables this removal touches, and their neighbours, after 0224.
 *
 * Written out rather than counted: "40 triggers" is satisfied by removing three and adding three,
 * and the thing criterion (g) is about is that nothing ELSE moved. `db-write-inventory.spec.ts`
 * ties this list to a replay of every migration, and the pg half of this suite ties it to the
 * server, so an entry here that no database installs is caught from both sides.
 *
 * `project` is deliberately outside the census. It is a core table, but it is not one 0207 or 0224
 * touches, and a sibling removal landing on it would fail this suite for something that is not this
 * removal — which is the same mistake as measuring subtraction against `main...HEAD`.
 */
const CENSUS_TABLES = ['conversation_turn', 'run_event', 'session', 'task'];

const CORE_TRIGGERS_AFTER: Readonly<Record<string, readonly string[]>> = {
  conversation_turn: [],
  run_event: ['run_event_ingestion_provenance_guard'],
  session: [
    'session_admission_lock_order_insert_delete',
    'session_admission_lock_order_update',
    'session_completed_at_compat',
    'session_dispatch_dependency_check',
    'session_merge_projection_checkpoint_authority_trg',
    'session_opencode_runner_claim_guard',
    'session_project_capacity_serialize_insert_delete',
    'session_project_capacity_serialize_update',
    'session_superseded_task_guard',
    'session_superseded_task_revive_guard',
  ],
};

test('(g) exactly the three 0207 triggers left, and nothing installed before them moved', () => {
  const byTable = new Map<string, string[]>();
  for (const entry of TRIGGER_WRITE_SOURCES) {
    byTable.set(entry.table, [...(byTable.get(entry.table) ?? []), entry.trigger].sort());
  }
  for (const [table, expected] of Object.entries(CORE_TRIGGERS_AFTER)) {
    assert.deepEqual(byTable.get(table) ?? [], expected, `${table}'s trigger set changed`);
  }
  // `task` carries 29; naming all of them here would restate the inventory rather than check it.
  // What matters for it is the same two properties, stated directly.
  const core = TRIGGER_WRITE_SOURCES.filter((entry) => CENSUS_TABLES.includes(entry.table));
  assert.equal(core.length, 39,
    'these four tables carried 43 triggers before 0224, 40 after it, and 39 once 0226 removed '
    + '`failure_successor_task_binding_immutable` from `task`');
  assert.deepEqual(core.filter((entry) => entry.since.startsWith('0207_')), [],
    'no trigger attributed to 0207 may still be registered');
  // Every one of them installed BEFORE 0207 is still here. Derived from the inventory's own
  // `since`, so it cannot be satisfied by editing a number.
  const olderThan0207 = core.filter((entry) => Number(entry.since.slice(0, 4)) < 207);
  assert.equal(olderThan0207.length, 38,
    'the 38 triggers on these tables that predate 0207 must all survive it');
  assert.deepEqual(
    core.filter((entry) => Number(entry.since.slice(0, 4)) >= 207).map((entry) => entry.trigger).sort(),
    ['run_event_ingestion_provenance_guard'],
    'the only trigger here newer than 0207 is the one a later migration installed and kept — '
    + '0212\'s `failure_successor_task_binding_immutable` was the other, and 0226 removed it',
  );
  assert.ok(
    TRIGGER_WRITE_SOURCES.some((entry) => entry.trigger === 'task_verification_subject_guard'),
    '0130\'s guard, whose name this removal came closest to matching, must still be registered',
  );
});

// (h) --------------------------------------------------------------------------------------------
test('(h) 0224 names nothing in the project_acceptance family, or any other protected wall', () => {
  for (const prefix of [
    'project_acceptance_',
    'task_executable_',
    'failure_continuation_',
    'failure_successor_',
    'executable_runtime_',
  ]) {
    assert.equal(REMOVAL_SQL.includes(prefix), false,
      `${prefix}* is a load-bearing wall and 0224 may not so much as name it`);
  }
  // Stated positively as well: the whole migration is five DROPs and nothing else.
  const statements = REMOVAL_SQL
    .split('\n')
    .filter((line) => !line.startsWith('--') && line.trim().length > 0)
    .map((line) => line.trim());
  assert.deepEqual(statements, [
    'BEGIN;',
    'DROP TRIGGER session_verification_subject_guard_insert ON session;',
    'DROP TRIGGER session_verification_subject_guard_update ON session;',
    'DROP TRIGGER task_verification_subject_live_session_guard ON task;',
    'DROP FUNCTION session_verification_subject_guard();',
    'DROP FUNCTION task_verification_subject_live_session_guard();',
    'COMMIT;',
  ]);
});

// (i) --------------------------------------------------------------------------------------------
test('(i) this is subtraction: no new service, no new resident process, less installed schema', () => {
  const compose = read('docker-compose.yml');
  const services = [...(compose.match(/^services:\n([\s\S]*?)(?=^\S|\Z)/m)?.[1] ?? '')
    .matchAll(/^ {2}([a-z][a-z0-9_-]*):$/gm)].map((hit) => hit[1]).sort();
  assert.deepEqual(services, ['apiserver', 'gateway', 'pgbackup', 'postgres', 'web'],
    'the removal may not add a Compose service');
  const apiScripts = JSON.parse(read('src/apiserver/package.json')).scripts as Record<string, string>;
  assert.deepEqual(Object.keys(apiScripts).filter((name) => name.startsWith('start:')).sort(),
    ['start:dev'], 'the removal may not add a resident process');

  // The SQL arithmetic, stated rather than implied. 0207 stays on disk as history; what this
  // compares is how much schema is INSTALLED before and after.
  const installed = INSTALL_SQL.split('\n').length;
  const removal = REMOVAL_SQL.split('\n').length;
  assert.ok(installed >= 100, `expected 0207's 100 lines, saw ${installed}`);
  assert.ok(removal < installed / 3, `the removal (${removal} lines) must cost far less than ${installed}`);
  // And the same in production TypeScript: the removal deletes translation branches and inventory
  // rows and adds no non-test source file of its own.
  const added = sourceFiles().filter((file) =>
    file.includes('verification-subject-guard-removal') && !file.endsWith('.spec.ts'));
  assert.deepEqual(added, [], 'a removal that needs new production code is not a removal');
});

test('(i) the removal is in the ledger, 0207 stays as history, and nothing puts it back', () => {
  const names = readdirSync(MIGRATIONS).filter((name) => /^\d{4}_/.test(name)).sort();
  assert.ok(names.includes(REMOVAL_DIR), 'the removal must stay in the ledger, so a database that '
    + 'applied it can replay it');
  assert.ok(names.includes('0207_verification_subject_dispatch_guard'),
    '0207 must remain, because a database that applied it has to replay it before the removal');
  // Deliberately NOT "the removal is the newest migration". That reads as a stronger claim and is
  // actually a different one: it says the schema may never move again, so the next unrelated
  // migration to land fails it whatever it does. What has to hold is that nothing at or after the
  // removal re-creates what it dropped — `CREATE OR REPLACE` in a later file is exactly how a
  // removal silently un-happens.
  for (const later of names.filter((name) => name >= REMOVAL_DIR)) {
    const sql = readFileSync(path.join(MIGRATIONS, later, 'migration.sql'), 'utf8');
    for (const [table, trigger] of DROPPED_TRIGGERS) {
      assert.doesNotMatch(sql, new RegExp(`CREATE\\s+TRIGGER\\s+"?${trigger}"?`),
        `${later} puts ${trigger} back on ${table}`);
    }
    for (const fn of DROPPED_FUNCTIONS) {
      assert.doesNotMatch(sql, new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+"?${fn}"?`),
        `${later} re-creates ${fn}()`);
    }
  }
});
