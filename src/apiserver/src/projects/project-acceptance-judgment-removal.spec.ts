import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * What keeps the project acceptance JUDGMENT deleted, and the project acceptance CRITERIA kept.
 *
 * The account owner's decision on 2026-09-03, converged over several turns: "delete the project
 * acceptance judgment too"; then "`acceptance_criteria` should be deleted, it is supposed to have
 * been split into the per-item table"; then, correcting a coordinator session that had drawn the
 * line in the wrong place twice, "why would this project's acceptance criteria be deleted, isn't
 * `project_acceptance_criterion_definition` being kept". And, between two shapes for the DONE
 * guard, the one with no guard at all.
 *
 * So this file has two halves that have to hold at once:
 *
 *   * The MACHINE is gone — four tables, sixteen functions, four triggers on the core `project`
 *     table, six `project` columns, one enum, the review pages, and the application-layer refusal
 *     that made `status: DONE` a 409 for every principal.
 *   * The DECLARATION is not — `project_acceptance_criterion_definition`, all 274 rows across 41
 *     projects on the deployment this was written against, its normalize trigger and the six
 *     functions that serve it.
 *
 * The two are one word apart in the schema. Every assertion below states which side it is on.
 *
 * The catalogue half, against an actually-migrated PostgreSQL, is
 * `project-acceptance-judgment-removal.pg.spec.ts`; the HTTP half — an ordinary actor writing DONE
 * and it going through — is `project-done-unguarded.http.spec.ts`.
 */
const API = path.resolve(__dirname, '../..');
const REPO = path.resolve(API, '../..');
const MIGRATIONS = path.join(API, 'prisma/migrations');

const REMOVED_BY = '0229_project_acceptance_judgment_removal';
const REMOVAL_SQL = readFileSync(path.join(MIGRATIONS, REMOVED_BY, 'migration.sql'), 'utf8');

/** The four tables, the enum, the six `project` columns and the refusal code, as names. Anything
 *  in this list appearing in a live source line is a reference to something that is not there. */
const REMOVED_NAMES = [
  'project_acceptance_run',
  'project_acceptance_criterion_immutable',
  'project_acceptance_conclusion',
  'project_acceptance_audit',
  'project_acceptance_verdict',
  'project_acceptance_done_gate',
  'project_acceptance_advance_epoch',
  'project_acceptance_epoch_audit',
  'project_acceptance_criteria_fact',
  'project_acceptance_standing',
  'project_acceptance_is_pass',
  'project_acceptance_reopen',
  'project_acceptance_parse_legacy',
  'project_acceptance_sync_legacy_definitions',
  'ProjectAcceptanceRun',
  'ProjectAcceptanceConclusion',
  'ProjectAcceptanceAudit',
  'ProjectAcceptanceVerdict',
  'projectAcceptanceRun',
  'projectAcceptanceConclusion',
  'projectAcceptanceAudit',
  'accepted_run_id',
  'acceptedRunId',
  'acceptance_epoch',
  'acceptanceEpoch',
  'projectAcceptanceEpoch',
  'legacy_accepted_at',
  'legacyAcceptedAt',
  'acceptance_criteria_digest',
  'acceptanceCriteriaDigest',
  'acceptance_criteria_format',
  'acceptanceCriteriaFormat',
  'PROJECT_DONE_AUTOMATIC_ONLY',
  'refuseDirectDone',
];

function isProseLine(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*|--|\|\s*~~)/.test(line);
}

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
    .filter((file) => !file.startsWith('docs/evidence/'))
    .filter((file) => existsSync(path.join(REPO, file)) && statSync(path.join(REPO, file)).isFile());
}

/**
 * A live reference is a line that would hand one of these names to PostgreSQL, to Prisma or to a
 * client. An absence check — `to_regclass(...) IS NULL`, `proname = '...'`, a `doesNotMatch`, an
 * `includes(...) === false` — names the thing precisely in order to prove it is gone, which is the
 * opposite of using it, so those lines are let through. The same rule the 0221, 0222 and 0226
 * removal suites state, reused rather than re-invented weaker.
 */
function livesOn(line: string): string[] {
  if (isProseLine(line)) return [];
  // A catalogue probe, an absence assertion, or a markdown row already struck through as removed.
  if (/to_regclass|pg_proc|pg_class|pg_trigger|pg_namespace|proname|relname|tgname|nspname|indexname|migration_name|column_name|DROP\s|doesNotMatch|not\.toContain|toBe\(false\)|REMOVED_NAMES|REMOVED_TABLES|REMOVED_FUNCTIONS|REMOVED_HANDLERS|ACCEPTANCE_TABLES|DISPATCH_TABLES|includes\(|assert\.equal\(|assert\.deepEqual\(|survives|was dropped by|gone|~~|已删除/i
    .test(line)) {
    return [];
  }
  // A migration DIRECTORY name is history, not a live reference: `0127_project_acceptance_run` and
  // `0150_task_provenance_project_acceptance_epoch` keep those words forever, and the ledger is
  // append-only. Strip them before looking for the names themselves.
  const withoutLedgerNames = line.replace(/\b\d{4}_[a-z0-9_]+/g, '');
  return REMOVED_NAMES.filter((name) => withoutLedgerNames.includes(name));
}

/**
 * Files whose whole job is to name these things in order to prove they are gone: removal suites,
 * migration replays that apply a shipped file verbatim, and the one page that documents the
 * removal. Excluded from the live-reference scan for the same reason `livesOn` lets an absence
 * assertion through — quoting a name to say it is absent is the opposite of using it.
 */
function statesTheAbsence(file: string): boolean {
  return /-removal(\.pg|\.http)?\.spec\.ts$/.test(file)
    || /-preserved(\.pg)?\.spec\.ts$/.test(file)
    || /-migration\.pg\.spec\.ts$/.test(file)
    || /project-provenance-epoch(\.pg)?\.spec\.ts$/.test(file)
    || [
      'docs/project-done-gate.md',
      'src/apiserver/src/projects/project-acceptance.spec.ts',
      'src/apiserver/src/projects/project-acceptance.service.spec.ts',
      'src/apiserver/src/projects/project-done-gate.pg.spec.ts',
      'src/apiserver/src/projects/project-done-unguarded.http.spec.ts',
      'test/outcome-reconciler-v2.ratification.test.mjs',
      'src/runner-go/project_cli_test.go',
      'src/runner-go/mcp_project_test.go',
    ].includes(file);
}

// (a) the removal, in the ledger -------------------------------------------------------------
test('(a) 0229 drops the four judgment tables and installs nothing', () => {
  const statements = REMOVAL_SQL.split('\n').filter((line) => !isProseLine(line)).join('\n');

  const dropped = [...statements.matchAll(/DROP TABLE "([a-z_0-9]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(dropped, [
    'project_acceptance_audit',
    'project_acceptance_conclusion',
    'project_acceptance_criterion',
    'project_acceptance_run',
  ]);

  // Subtraction only. A removal that installs a replacement gate is not the decision that was made.
  for (const forbidden of [/CREATE\s+TABLE/i, /CREATE\s+(?:CONSTRAINT\s+)?TRIGGER/i,
    /CREATE\s+(?:UNIQUE\s+)?INDEX/i, /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW/i, /CREATE\s+TYPE/i,
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION/i, /CREATE\s+SCHEMA/i]) {
    assert.equal(forbidden.test(statements), false,
      `the removal installs ${forbidden} — it must only take machinery away`);
  }
  assert.doesNotMatch(statements, /pg_cron|CREATE EXTENSION|LISTEN |NOTIFY /,
    'the migration starts nothing that keeps running after it commits');

  // And it reads and rewrites no row of any preserved table: the whole file is DDL.
  assert.doesNotMatch(statements, /\b(INSERT INTO|UPDATE\s+"|DELETE FROM)\b/i,
    'the removal touches rows; it must be pure DDL');
});

test('(a) the declaration table is named by no statement of the removal', () => {
  for (const line of REMOVAL_SQL.split('\n')) {
    if (isProseLine(line)) continue;
    assert.equal(line.includes('project_acceptance_criterion_definition'), false,
      `the removal names the declaration table in a statement: ${line.trim()}`);
    assert.equal(/project_acceptance_definition_/.test(line), false,
      `the removal names a declaration function in a statement: ${line.trim()}`);
  }
});

test('(a) the four project triggers and the six project columns are dropped by name', () => {
  for (const trigger of ['project_acceptance_advance_epoch', 'project_acceptance_criteria_fact',
    'project_acceptance_done_gate', 'project_acceptance_epoch_audit']) {
    assert.match(REMOVAL_SQL, new RegExp(`DROP TRIGGER "${trigger}" ON "project";`));
  }
  for (const column of ['accepted_run_id', 'acceptance_epoch', 'legacy_accepted_at',
    'acceptance_criteria', 'acceptance_criteria_digest', 'acceptance_criteria_format']) {
    assert.match(REMOVAL_SQL, new RegExp(`ALTER TABLE "project" DROP COLUMN "${column}";`));
  }
  // `accepted_run_id` before the table it points at: that is what breaks the
  // project -> run -> project foreign-key cycle by hand rather than by cascade.
  assert.ok(REMOVAL_SQL.indexOf('DROP COLUMN "accepted_run_id"')
    < REMOVAL_SQL.indexOf('DROP TABLE "project_acceptance_run"'));
});

// (b) nothing live still names any of it ------------------------------------------------------
test('(b) no live source names a dropped relation, column, function or refusal code', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    if (statesTheAbsence(file)) continue;
    if (!/\.(ts|tsx|mts|mjs|js|json|sql|sh|go|md|prisma|swift|kt)$/.test(file)) continue;
    readFileSync(path.join(REPO, file), 'utf8').split('\n').forEach((line, index) => {
      for (const name of livesOn(line)) offenders.push(`${file}:${index + 1}: ${name}`);
    });
  }
  assert.deepEqual(offenders, [],
    'something this migration removed is still named outside the migration history — raw SQL in '
      + '`$queryRaw` is not type-checked, so this scan is the only thing that would catch it');
});

test('(b) the Prisma schema models no relation that does not exist', () => {
  const schema = readFileSync(path.join(API, 'prisma/schema.prisma'), 'utf8');
  for (const table of ['project_acceptance_run', 'project_acceptance_criterion',
    'project_acceptance_conclusion', 'project_acceptance_audit']) {
    assert.equal(schema.includes(`@@map("${table}")`), false, `${table} still has a Prisma model`);
  }
  assert.equal(schema.includes('enum ProjectAcceptanceVerdict'), false);
  // And the declaration model is still there, mapped to the table that keeps its rows.
  assert.match(schema, /@@map\("project_acceptance_criterion_definition"\)/);
});

// (c) the DONE refusal ------------------------------------------------------------------------
test('(c) nothing in the tree refuses a direct DONE any more', () => {
  const service = readFileSync(path.join(API, 'src/projects/projects.service.ts'), 'utf8');
  assert.equal(service.includes('refuseDirectDone'), false);
  assert.equal(service.includes('PROJECT_DONE_AUTOMATIC_ONLY'), false);
  // The DTO admits all three statuses, and says why rather than leaving DONE looking like an
  // oversight that a later reader would 'fix'.
  const dto = readFileSync(path.join(API, 'src/projects/dto.ts'), 'utf8');
  assert.match(dto, /All three values are ordinary request values/);

  // The refusal code appears nowhere outside the immutable migration history. That is what makes
  // the negative control in `project-done-unguarded.http.spec.ts` mean something: a guard cannot
  // come back under the old name without failing here too.
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    if (statesTheAbsence(file)) continue;
    if (!/\.(ts|tsx|mts|mjs|js|go|swift|kt)$/.test(file)) continue;
    readFileSync(path.join(REPO, file), 'utf8').split('\n').forEach((line, index) => {
      if (isProseLine(line)) return;
      if (line.includes('PROJECT_DONE_AUTOMATIC_ONLY')) offenders.push(`${file}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});

// (d) what was kept ---------------------------------------------------------------------------
test('(d) the criteria are still authored, read and validated', () => {
  const service = readFileSync(path.join(API, 'src/projects/projects.service.ts'), 'utf8');
  assert.match(service, /replaceAcceptanceDefinitions/, 'the criteria ingress is gone');
  assert.match(service, /acceptanceCriteriaItems/, 'the authoring field is gone');
  const dto = readFileSync(path.join(API, 'src/projects/dto.ts'), 'utf8');
  assert.match(dto, /acceptanceCriteriaItems\?: (Create|Update)ProjectAcceptanceCriterionDto\[\]/);
  const pure = readFileSync(path.join(API, 'src/projects/project-acceptance.ts'), 'utf8');
  assert.match(pure, /export function criteriaFromDefinitions/);
});

// (e) subtraction, measured from the worktree --------------------------------------------------
test('(e) the removal deletes far more than it writes, measured from the tree', () => {
  // Deliberately NOT `git diff --numstat main...HEAD`. That measures where a branch is standing
  // rather than whether the change is a subtraction: it reads thousands-against-zero on a branch
  // and 0-against-0 the instant it merges, so the assertion inverts on the one tree it protects.
  // Pinning a baseline SHA only moves the problem. Everything below is read out of the worktree
  // and says the same thing before a merge, after one, and on an export with no history at all.
  //
  // Both numbers are executable SQL: comment lines are excluded from BOTH sides, so a removal
  // whose file is mostly the explanation of why it is safe is still a subtraction.
  const executable = (sql: string) => sql.split('\n')
    .filter((line) => !isProseLine(line) && line.trim().length > 0).length;
  const ledger = migrations();

  // What it retires: the statements that PUT this machinery on the schema. Scoped by the names
  // being removed, and to migrations BEFORE the removal — the append-only ledger makes those a
  // constant no later commit can dilute.
  const installers = ledger
    .filter(({ dir }) => dir < REMOVED_BY)
    .filter(({ sql }) => /CREATE TABLE "?project_acceptance_(run|criterion|conclusion|audit)"?[\s(]/.test(sql)
      || /CREATE (?:OR REPLACE )?FUNCTION "?project_acceptance_(done_gate|advance_epoch|epoch_audit|criteria_fact|standing|is_pass|reopen|parse_legacy|sync_legacy_definitions)"?/.test(sql));
  assert.ok(installers.length >= 3,
    `the installer scan matched ${installers.length} migrations; a dead regex is not a true negative`);
  const retired = installers.reduce((total, { sql }) => total + executable(sql), 0);
  assert.ok(retired > 500, `expected the thousands of lines that installed this, saw ${retired}`);

  // What it spent: 0229, plus any later migration that returns to the same vocabulary. A
  // compatibility shim for the machinery being removed goes on the removal's bill; an unrelated
  // migration that merely lands on top of it does not.
  const spending = ledger
    .filter(({ dir }) => dir >= REMOVED_BY)
    .filter(({ sql }) => REMOVED_NAMES.some((name) => /^[a-z_]+$/.test(name) && sql.includes(name)));
  const spent = spending.reduce((total, { sql }) => total + executable(sql), 0);
  assert.ok(spent * 5 < retired,
    `the removal spent ${spent} executable lines (${spending.map((s) => s.dir).join(', ')}) `
    + `to retire ${retired}`);

  // And none of it went back. A removal that re-creates what it dropped is a net addition however
  // the line counts come out, so this half is absolute rather than a ratio.
  for (const { dir, sql } of spending) {
    for (const table of ['project_acceptance_run', 'project_acceptance_criterion',
      'project_acceptance_conclusion', 'project_acceptance_audit']) {
      assert.equal(
        new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${table}"?[\\s(]`, 'i').test(sql),
        false, `${dir} re-creates ${table}`);
    }
    for (const fn of ['project_acceptance_done_gate', 'project_acceptance_standing',
      'project_acceptance_parse_legacy']) {
      assert.equal(
        new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+"?${fn}"?`, 'i').test(sql),
        false, `${dir} re-creates ${fn}`);
    }
  }
});

test('(e) the removal adds no compose service and no resident process', () => {
  // Only the `services:` section: the top-level `volumes:` keys sit at the same indentation, so a
  // flat scan counts `pg-socket` as a sixth service.
  const compose = readFileSync(path.join(REPO, 'docker-compose.yml'), 'utf8');
  const services = [...(compose.match(/^services:\n([\s\S]*?)(?=^\S|\Z)/m)?.[1] ?? '')
    .matchAll(/^ {2}([a-z][a-z0-9_-]*):$/gm)].map((match) => match[1]).sort();
  assert.deepEqual(services, ['apiserver', 'gateway', 'pgbackup', 'postgres', 'web']);

  const service = readFileSync(path.join(API, 'src/projects/project-acceptance.service.ts'), 'utf8');
  assert.doesNotMatch(service, /setInterval|setTimeout|@Interval|@Cron|OnModuleInit|OnApplicationBootstrap/);
});

// (f) the web surfaces -------------------------------------------------------------------------
test('(f) the judgment inbox, the review page and their routes are gone from the web app', () => {
  for (const gone of [
    'src/web/src/pages/JudgmentInboxPage.tsx',
    'src/web/src/pages/ProjectAcceptanceReviewPage.tsx',
    'src/web/src/pages/ProjectAcceptanceReviewPage.test.tsx',
    'src/web/src/lib/projectAcceptance.ts',
    'src/web/src/components/ProjectReopenControl.tsx',
  ]) {
    assert.equal(existsSync(path.join(REPO, gone)), false, `${gone} survives 0229`);
  }
  const app = readFileSync(path.join(REPO, 'src/web/src/App.tsx'), 'utf8');
  assert.equal(app.includes('judgments'), false, 'the /judgments routes survive');
  const panel = readFileSync(path.join(REPO, 'src/web/src/components/TasksSidePanel.tsx'), 'utf8');
  assert.equal(panel.includes('judgments'), false, 'the sidebar entry survives');
  assert.equal(panel.includes('openJudgmentCount'), false, 'the sidebar badge survives');
});

// (g) the MCP and CLI doors --------------------------------------------------------------------
test('(g) the three judgment capabilities are gone and the criteria ingress is not', () => {
  const mcp = readFileSync(path.join(REPO, 'src/runner-go/mcp.go'), 'utf8');
  const cli = readFileSync(path.join(REPO, 'src/runner-go/project_cli.go'), 'utf8');
  for (const source of [mcp, cli]) {
    for (const tool of ['project_acceptance_run', 'project_acceptance_verdict',
      'project_reopen_impact']) {
      assert.equal(source.includes(tool), false, `${tool} still has a door`);
    }
    // `project_acceptance` (the read) went with them: everything it reported beyond the criteria
    // is gone, and the criteria are already in `project_get`. A second tool returning a strict
    // subset of another one is the duplication this whole change is about.
    assert.equal(/"project_acceptance"/.test(source), false, 'project_acceptance still has a door');
    assert.ok(source.includes('acceptanceCriteriaItems'), 'the criteria ingress is gone');
  }
});
