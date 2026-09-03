import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * What keeps the acceptance standard-set CONFIRMATION deleted.
 *
 * 0189_project_criteria_automation created `project_acceptance_criteria_confirmation`: one
 * append-only row per (project, criteria digest) recording that the complete current standard set
 * expressed the project's goal. It had exactly one reader and one writer.
 *
 *   * The reader was 0189's own DONE gate, which refused a project whose current
 *     `acceptance_criteria_digest` had no matching row (CRITERIA_CONFIRMATION_REQUIRED).
 *     0222_canonical_done_gate_removal is the last migration to CREATE OR REPLACE
 *     `project_acceptance_done_gate()` and its body names no confirmation at all.
 *   * The writer was `ProjectAcceptanceService#confirmCriteria`, reached through
 *     `orbit project criteria-confirm` and the `project_criteria_confirm` tool. `da6b8f5a` deleted
 *     the method, the command, its help block and the tool with the owner-approval queue.
 *
 * What that commit left behind was a relation nothing could write and nothing read, its BEFORE
 * UPDATE immutability trigger, and one line of
 * `contracts/outcome-reconciler-v2-source-audit.json` still declaring the deleted method as the
 * ACCEPTANCE_REVISION writer — the assertion that failed the release DAG's `suite-contract` node.
 * 0226 removes the storage; this file is what keeps it removed.
 *
 * The account owner's 2026-09-02 decision was to delete the leftovers rather than name a
 * replacement writer, so `ACCEPTANCE_REVISION` is deliberately left with no
 * confirmation-authority writer at all. The two writers it keeps are the ones that were always
 * there and always did something else: `criteriaSemanticRevision` derives the revision, and
 * `replaceAcceptanceDefinitions` is the criteria ingress. Nothing here should be read as room for
 * a confirmation step to come back under another name.
 *
 * Everything is derived from the tree. The catalogue half, against the actually-migrated schema,
 * is `projects/criteria-confirmation-removal.pg.spec.ts`.
 */
const API = path.resolve(__dirname, '../..');
const REPO = path.resolve(API, '../..');
const MIGRATIONS = path.join(API, 'prisma/migrations');

const INSTALLED_BY = '0189_project_criteria_automation';
const REMOVED_BY = '0226_project_criteria_confirmation_removal';

const CONFIRMATION_TABLE = 'project_acceptance_criteria_confirmation';
/** The trigger and the function share this name; both go, and the function is not a cascade. */
const CONFIRMATION_GUARD = 'project_acceptance_confirmation_immutable';
/** The two 0189 declared by name. The primary key goes with the relation. */
const CONFIRMATION_INDEXES = [
  'project_acceptance_confirmation_digest_key',
  'project_acceptance_confirmation_project_idx',
];

/** Every name this removal takes off the schema, in the spelling a live reference would use. */
const REMOVED_NAMES = [CONFIRMATION_TABLE, CONFIRMATION_GUARD, ...CONFIRMATION_INDEXES];

/**
 * The account-level acceptance standard set itself: 306 criterion definitions, 313 criteria and
 * 152 conclusions across 43 projects, all of it older than this project. None of it is this
 * removal's to touch, and `_criteria_confirmation` is deliberately not in the list any more —
 * that is the one relation being removed.
 */
const ACCEPTANCE_TABLES = [
  'project_acceptance_audit',
  'project_acceptance_conclusion',
  'project_acceptance_criterion',
  'project_acceptance_criterion_definition',
  'project_acceptance_run',
];

/** 0150's three and 0172's one. Their alphabetical order is load-bearing; see the pg spec. */
const PROJECT_ACCEPTANCE_TRIGGERS = [
  'project_acceptance_advance_epoch',
  'project_acceptance_criteria_fact',
  'project_acceptance_done_gate',
  'project_acceptance_epoch_audit',
];

function migrations(): Array<{ dir: string; sql: string }> {
  return readdirSync(MIGRATIONS)
    .filter((entry) => statSync(path.join(MIGRATIONS, entry)).isDirectory())
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

/** The last migration that creates or drops an object, and which of the two it did. */
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

const REMOVAL_SQL = readFileSync(path.join(MIGRATIONS, REMOVED_BY, 'migration.sql'), 'utf8');

function read(relative: string): string {
  return readFileSync(path.join(REPO, relative), 'utf8');
}

function isProseLine(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*|--|\|\s*~~)/.test(line);
}

/**
 * Every file the worktree actually has, tracked or merely known about, minus the migration ledger
 * and build output. `--others --exclude-standard` is load-bearing: plain `git ls-files` reports
 * the INDEX, so a file written but not yet staged is invisible and the scan goes green on a tree
 * it never read.
 */
function sourceFiles(): string[] {
  const listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).split('\n').filter(Boolean);
  return [...new Set(listed)]
    .filter((file) => !file.startsWith('src/apiserver/prisma/migrations/'))
    .filter((file) => existsSync(path.join(REPO, file)) && statSync(path.join(REPO, file)).isFile());
}

/**
 * A live reference is a line that would hand one of these names to PostgreSQL or to Prisma. An
 * absence check — `to_regclass(...) IS NULL`, `proname = '...'`, a `doesNotMatch` — names the
 * thing precisely in order to prove it is gone, which is the opposite of using it, so those lines
 * are let through. The same rule the 0221 and 0222 removal suites state, reused rather than
 * re-invented weaker.
 */
function livesOn(line: string): string[] {
  if (isProseLine(line)) return [];
  if (/to_regclass|pg_proc|pg_class|pg_trigger|pg_namespace|proname|relname|tgname|nspname|indexname|migration_name|DROP\s|doesNotMatch|REMOVED_NAMES/i
    .test(line)) {
    return [];
  }
  return REMOVED_NAMES.filter((name) => line.includes(name));
}

/**
 * Removal suites quote migrations rather than calling them, and so does the 0189 replay: that spec
 * builds an isolated schema, applies the shipped 0189 file into it verbatim, and counts rows in
 * the table 0189 creates THERE. The ledger is append-only, so 0189 keeps creating it forever.
 */
function isLedgerReplay(file: string): boolean {
  return /-removal(\.pg|\.http)?\.spec\.ts$/.test(file)
    || file.endsWith('projects/project-criteria-automation-migration.pg.spec.ts');
}

// (a) ------------------------------------------------------------------------------------------
test('(a) the relation, its two indexes, its trigger and its function are installed by 0189 and dropped by 0226', () => {
  const table = lastVerdict(
    new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${CONFIRMATION_TABLE}"?[\\s(]`, 'i'),
    new RegExp(`DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?"?${CONFIRMATION_TABLE}"?\\s*(?:CASCADE|RESTRICT)?\\s*[;,]`, 'i'),
  );
  assert.ok(table, `${CONFIRMATION_TABLE} is named by no migration at all`);
  assert.equal(table.verdict, 'DROPPED', `${CONFIRMATION_TABLE} is still installed by ${table.dir}`);
  assert.equal(table.dir, REMOVED_BY);

  for (const index of CONFIRMATION_INDEXES) {
    const standing = lastVerdict(
      new RegExp(`CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${index}"?`, 'i'),
      new RegExp(`DROP\\s+INDEX\\s+(?:IF\\s+EXISTS\\s+)?"?${index}"?`, 'i'),
    );
    assert.ok(standing, `${index} is named by no migration`);
    assert.equal(standing.verdict, 'DROPPED', `${index} is still installed by ${standing.dir}`);
    assert.equal(standing.dir, REMOVED_BY);
  }

  // The trigger and the function are two objects with one name, and DROP TABLE takes only the
  // first of them. An orphan `RETURNS TRIGGER` function that can never fire again is exactly the
  // kind of leftover this task is about, so the removal names it.
  const trigger = lastVerdict(
    new RegExp(`CREATE\\s+TRIGGER\\s+"?${CONFIRMATION_GUARD}"?`, 'i'),
    new RegExp(`DROP\\s+TRIGGER\\s+(?:IF\\s+EXISTS\\s+)?"?${CONFIRMATION_GUARD}"?\\s+ON`, 'i'),
  );
  assert.ok(trigger);
  assert.equal(trigger.verdict, 'DROPPED');
  assert.equal(trigger.dir, REMOVED_BY);

  const fn = lastVerdict(
    new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+"?${CONFIRMATION_GUARD}"?\\s*\\(`, 'i'),
    new RegExp(`DROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?"?${CONFIRMATION_GUARD}"?\\s*\\(`, 'i'),
  );
  assert.ok(fn);
  assert.equal(fn.verdict, 'DROPPED');
  assert.equal(fn.dir, REMOVED_BY);

  const installed = migrations().find(({ dir }) => dir === INSTALLED_BY);
  assert.ok(installed && installed.sql.includes(`CREATE TABLE "${CONFIRMATION_TABLE}"`),
    `${INSTALLED_BY} must still be the migration that installed it`);
});

// (b) ------------------------------------------------------------------------------------------
test('(b) the removal reads and writes no row, so no BEFORE UPDATE guard can abort it', () => {
  // The relation carries `project_acceptance_confirmation_immutable`, a BEFORE UPDATE ROW trigger
  // that raises unconditionally. On an empty schema an `UPDATE` in this file would match zero rows
  // and pass; on the deployed database it holds four rows and would abort the whole migration.
  // The migration is therefore pure DDL, and that is asserted rather than left to a reading.
  const statements = REMOVAL_SQL.split('\n').filter((line) => !isProseLine(line)).join('\n');
  for (const write of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+"?[a-z_]/i, /\bDELETE\s+FROM\b/i,
    /\bTRUNCATE\b/i, /\bSELECT\b/i, /\bDO\s+\$\$/i]) {
    assert.equal(write.test(statements), false, `the removal carries a ${write}`);
  }
  const verbs = [...statements.matchAll(/^\s*(DROP\s+(?:TABLE|INDEX|TRIGGER|FUNCTION))/gim)]
    .map((match) => match[1].replace(/\s+/g, ' ').toUpperCase());
  assert.deepEqual(verbs,
    ['DROP TRIGGER', 'DROP FUNCTION', 'DROP INDEX', 'DROP INDEX', 'DROP TABLE'],
    'the removal is five drops in dependency order and nothing else');

  // 0225 learned this the hard way in the other direction: an explicit BEGIN/COMMIT reports
  // "transaction is aborted" instead of the real message, because Prisma already runs the file in
  // one transaction.
  assert.doesNotMatch(REMOVAL_SQL, /^\s*(BEGIN|COMMIT)\s*;/im,
    'Prisma already wraps the file; an explicit transaction only hides the real error');
  assert.doesNotMatch(REMOVAL_SQL, /pg_cron|CREATE EXTENSION|LISTEN |NOTIFY /,
    'the migration starts nothing that keeps running after it commits');
});

// (c) ------------------------------------------------------------------------------------------
test('(c) the standard set itself is not named by any statement of the removal', () => {
  for (const line of REMOVAL_SQL.split('\n')) {
    if (isProseLine(line)) continue;
    for (const table of ACCEPTANCE_TABLES) {
      assert.equal(line.includes(table), false,
        `the removal names ${table} in a statement: ${line.trim()}`);
    }
    for (const trigger of PROJECT_ACCEPTANCE_TRIGGERS) {
      assert.equal(line.includes(trigger), false,
        `the removal names ${trigger} in a statement: ${line.trim()}`);
    }
  }
  // Not one byte of a criterion's `text` or `verification_method` can move: the removal touches
  // no relation that holds one.
  assert.doesNotMatch(REMOVAL_SQL, /ALTER\s+TABLE/i, 'the removal alters nothing');
});

// (d) ------------------------------------------------------------------------------------------
test('(d) nothing outside the migration ledger still names the relation, its indexes or its guard', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    if (isLedgerReplay(file)) continue;
    read(file).split('\n').forEach((line, index) => {
      for (const name of livesOn(line)) offenders.push(`${file}:${index + 1}: ${name}`);
    });
  }
  assert.deepEqual(offenders, []);

  // The Prisma model and the `Project` relation field that reached it.
  const schema = read('src/apiserver/prisma/schema.prisma');
  assert.doesNotMatch(schema, /ProjectAcceptanceCriteriaConfirmation|acceptanceCriteriaConfirmations/,
    'the Prisma model or its relation field is still declared');

  // The generated trigger inventory. `scripts/sync-db-trigger-inventory.mjs` writes this list from
  // the ledger and understands the DROP TABLE cascade; an entry describing a trigger no database
  // has is exactly what `db-write-inventory.spec.ts` refuses.
  assert.doesNotMatch(read('src/apiserver/src/common/db-write-inventory.ts'),
    new RegExp(`"trigger":"${CONFIRMATION_GUARD}"`),
    'the write inventory still registers the dropped trigger');
});

// (e) ------------------------------------------------------------------------------------------
test('(e) the source audit resolves ACCEPTANCE_REVISION without inventing a confirmation writer', () => {
  const audit = JSON.parse(read('contracts/outcome-reconciler-v2-source-audit.json')) as {
    surfaces: Array<{
      id: string;
      sourceOfTruth: Array<{ storage: string; role: string }>;
      writers: Array<{ path: string; symbol: string; authority: string }>;
      readers: Array<{ path: string; symbol: string; purpose: string }>;
    }>;
  };
  const surface = audit.surfaces.find((entry) => entry.id === 'ACCEPTANCE_REVISION');
  assert.ok(surface, 'ACCEPTANCE_REVISION is a frozen surface and must still be declared');

  // The declaration that failed `suite-contract`: `confirmCriteria` was deleted by `da6b8f5a`.
  // Removed outright — NOT repointed at another symbol. The account owner's decision was that
  // there is no confirmation writer, and a contract that invents one to look complete is worse
  // than a contract that is honestly short of one.
  assert.deepEqual(
    surface.writers.filter((writer) => /confirm/i.test(writer.symbol)
      || /CONFIRMATION/i.test(writer.authority)),
    [], 'a confirmation writer has been re-declared for ACCEPTANCE_REVISION');
  assert.deepEqual(surface.writers.map((writer) => writer.symbol),
    ['criteriaSemanticRevision', 'replaceAcceptanceDefinitions'],
    'the two surviving writers are the revision derivation and the criteria ingress');
  // `criteriaSemanticRevision` moved out of the service and into the pure criteria module when
  // 0229 reduced the service to the criteria it reads; the surface names the module it is in.

  // `validateSourceAudit` requires each SURFACE to inventory at least one writer and one reader.
  // It has no per-authority rule, which is why removing this one entry leaves a valid contract.
  assert.ok(surface.writers.length > 0 && surface.readers.length > 0);
  const lib = read('scripts/lib/outcome-reconciler-v2.mjs');
  assert.match(lib, /surface\.writers\.length > 0 && surface\.readers\.length > 0/,
    'the contract rule this decision depends on is stated in the validator, not here');

  // The storage the surface is derived from. Migration 0229 dropped the legacy digest column and
  // the run binding with the acceptance judgment; the authored definitions and the completion
  // contract's two digests are what a revision is derived from now.
  assert.deepEqual(surface.sourceOfTruth.map((entry) => entry.storage), [
    'project_acceptance_criterion_definition.revision/content_hash',
    'project_completion_contract.contract_digest/evaluation_plan_digest',
  ]);

  // Every writer and reader must still resolve — the same check `validateSourceAudit` makes, made
  // here so a stale symbol is attributed to the surface it belongs to rather than to whichever
  // assertion happens to run first.
  for (const entry of [...surface.writers, ...surface.readers]) {
    assert.ok(read(entry.path).includes(entry.symbol),
      `${entry.path} no longer contains ${JSON.stringify(entry.symbol)}`);
  }
});

// (f) ------------------------------------------------------------------------------------------
test('(f) no surface promises a confirmation the API cannot return', () => {
  // `da6b8f5a` deleted the `criteria-confirm` command and the `project_criteria_confirm` tool but
  // left both `project_acceptance` descriptions saying the read returns "its confirmation". A
  // description of a field that is not in the payload is the same class of defect the criteria
  // proposal removal called lying copy: a model reads it and reports a fact nobody wrote.
  for (const relative of ['src/runner-go/mcp.go', 'src/runner-go/project_cli.go']) {
    const source = read(relative);
    assert.doesNotMatch(source, /project_criteria_confirm/,
      `${relative} declares a criteria confirmation capability`);
    assert.doesNotMatch(source, /digest and its (?:set-level )?confirmation/i,
      `${relative} still promises a confirmation with the acceptance read`);
  }
  // The read the audit names for the CLI. It used to be the acceptance overview's digest; 0229
  // removed that read with the judgment, and what the CLI reads now is the criteria themselves.
  assert.match(read('src/runner-go/project_cli.go'), /acceptanceCriteriaItems/,
    'the CLI still reads the stated criteria, and the audit names that read');
  assert.doesNotMatch(read('src/runner-go/project_cli.go'), /project_acceptance_run/,
    'the CLI still advertises a judgment capability 0229 removed');
});

// (g) ------------------------------------------------------------------------------------------
test('(g) the removal adds no compose service, and deletes more than it writes', () => {
  // Only the `services:` section: the top-level `volumes:` keys sit at the same indentation, so a
  // flat scan counts `pg-socket` as a sixth service.
  const compose = read('docker-compose.yml');
  const services = [...(compose.match(/^services:\n([\s\S]*?)(?=^\S|\Z)/m)?.[1] ?? '')
    .matchAll(/^ {2}([a-z][a-z0-9_-]*):$/gm)].map((match) => match[1]).sort();
  assert.deepEqual(services, ['apiserver', 'gateway', 'pgbackup', 'postgres', 'web'],
    'the removal must add no compose service');
  assert.equal(/criteria[-_]?confirm/i.test(compose), false);

  // The subtraction, measured from the worktree rather than with `git diff --numstat main...HEAD`
  // — which measures where a branch is standing, reads 0/0 the instant it merges, and therefore
  // inverts on the one tree it exists to protect.
  //
  // Both numbers are executable SQL: comment lines are excluded from BOTH sides. A removal whose
  // file is mostly the explanation of why it is safe is still a subtraction, and counting prose
  // would let a long comment turn a five-statement drop into a net addition.
  const ledger = migrations();
  const executable = (sql: string) => sql.split('\n')
    .filter((line) => !isProseLine(line) && line.trim().length > 0).length;

  // What it retires: the statements in the append-only ledger that PUT these objects on the
  // schema. Scoped to statements whose TARGET is one of the removed names, so 0189's other work —
  // the definition normalizer, `project_acceptance_standing`, the done-gate rewrite, all of which
  // survive — is not billed to this removal. That would be an overstatement dressed as a stronger
  // check.
  const installer = new RegExp(
    '^\\s*CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:UNIQUE\\s+)?'
    + `(?:TABLE|INDEX|TRIGGER|FUNCTION)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?(?:${REMOVED_NAMES.join('|')})"?\\b`,
    'i');
  let retired = 0;
  const installers = new Set<string>();
  for (const { dir, sql } of ledger.filter(({ dir }) => dir < REMOVED_BY)) {
    const lines = sql.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (!installer.test(lines[index])) continue;
      installers.add(dir);
      // From the CREATE to the end of its statement. `$$` bodies hold their own semicolons, so
      // the terminator is the one that closes the statement, not the first one seen.
      let dollars = 0;
      for (; index < lines.length; index += 1) {
        const line = lines[index];
        if (!isProseLine(line) && line.trim().length > 0) retired += 1;
        dollars += (line.match(/\$\$/g) ?? []).length;
        if (dollars % 2 === 0 && /;\s*$/.test(line)) break;
      }
    }
  }
  assert.deepEqual([...installers], [INSTALLED_BY]);
  assert.ok(retired >= 30,
    `expected the ~31 executable lines that installed this relation, saw ${retired}`);

  // What it spends: this migration, plus any later one that returns to the same vocabulary. A
  // compatibility shim for what is being removed goes on this removal's bill; an unrelated
  // migration that merely lands on top of it does not.
  const spending = ledger.filter(({ dir }) => dir >= REMOVED_BY)
    .filter(({ sql }) => REMOVED_NAMES.some((name) => sql.split('\n')
      .some((line) => !isProseLine(line) && line.includes(name))));
  const spent = spending.reduce((total, { sql }) => total + executable(sql), 0);
  assert.deepEqual(spending.map(({ dir }) => dir), [REMOVED_BY]);
  assert.ok(spent < retired,
    `the removal spent ${spent} executable lines to retire ${retired}`);

  // And none of it goes back. A removal that re-creates what it dropped is a net addition however
  // the line counts come out, so this half is absolute rather than a ratio.
  const reinstalled = spending.flatMap(({ dir, sql }) => REMOVED_NAMES
    .filter((name) => new RegExp(
      '(?:CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:UNIQUE\\s+)?'
      + '(?:TABLE|VIEW|SCHEMA|FUNCTION|PROCEDURE|TRIGGER|INDEX)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?'
      + `|ADD\\s+COLUMN\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?|RENAME\\s+TO\\s+)"?${name}"?\\b`, 'i')
      .test(sql))
    .map((name) => `${dir}: ${name}`));
  assert.deepEqual(reinstalled, [],
    'nothing at or after the removal may re-create what it dropped');
});
