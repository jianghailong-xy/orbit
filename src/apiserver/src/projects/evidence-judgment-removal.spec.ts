/**
 * N26 without a database: the human step is gone from the tree itself.
 *
 * Its sibling `evidence-judgment-removal.pg.spec.ts` proves the same removal against real
 * PostgreSQL rows. These are the halves that are decided by reading what ships — the criterion a
 * caller may declare, the absence of the dropped table at every door, the advice table that no
 * longer routes anybody to a person, the web app's inability to restate the ruler, and the shape
 * of the change itself — so they run wherever the suite runs, with or without a server.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { TASK_CRITERION_SHAPE_RULES } from '../tasks/task-criterion-shape-advice';
import { TASK_COMPLETION_CRITERIA } from '../tasks/task-completion-criterion';

/** build/projects -> build -> apiserver -> src -> repository root. */
function repoRoot(): string {
  return path.resolve(__dirname, '../../../..');
}

function read(relative: string): string {
  return readFileSync(path.join(repoRoot(), relative), 'utf8');
}

const REMOVAL_MIGRATION =
  'src/apiserver/prisma/migrations/0224_evidence_judgment_removal_of_human_signoff/migration.sql';

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoRoot(), encoding: 'utf8' }).trim();
}

// ── (a) HUMAN_SIGNOFF is not a criterion any caller can declare ────────────────────────────────

test('(a) HUMAN_SIGNOFF is not a completionCriterion value at any door', () => {
  assert.deepEqual([...TASK_COMPLETION_CRITERIA],
    ['EXECUTABLE', 'VERIFICATION', 'EVIDENCE_JUDGMENT']);
  assert.ok(!TASK_COMPLETION_CRITERIA.includes('HUMAN_SIGNOFF' as never));

  // The wire contract is the same list at all three doors, so a declaration this list rejects is
  // rejected identically from REST, the runner API and MCP rather than at one of them.
  const schema = read('src/apiserver/prisma/schema.prisma');
  assert.match(schema,
    /enum TaskCompletionCriterion \{\s*\n\s*EXECUTABLE\s*\n\s*VERIFICATION\s*\n\s*EVIDENCE_JUDGMENT\s*\n/);
  const dto = read('src/apiserver/src/tasks/dto.ts');
  assert.doesNotMatch(dto, /HUMAN_SIGNOFF/);
  const runnerController = read('src/apiserver/src/runner-api/runner-tasks.controller.ts');
  assert.doesNotMatch(runnerController, /HUMAN_SIGNOFF/);
  for (const file of ['src/runner-go/task_cli.go', 'src/runner-go/mcp.go',
    'src/runner-go/task_create_completion.go']) {
    assert.doesNotMatch(read(file), /HUMAN_SIGNOFF/, `${file} still offers the removed criterion`);
  }
  // The CLI/MCP enumerations that a caller picks from name the three peers and not the removed one.
  const completion = read('src/runner-go/task_create_completion.go');
  assert.match(completion, /EVIDENCE_JUDGMENT/);
});

// ── (c) the signoff table and its code face are gone ───────────────────────────────────────────

test('(c) nothing in the tree still names task_human_signoff, raw SQL included', () => {
  // git ls-files rather than a directory walk: the claim is about what ships, and a scan that
  // silently missed a directory would pass by not looking.
  const tracked = git('ls-files').split('\n').filter(Boolean);
  assert.ok(tracked.length > 500, 'the residual scan must actually have read the repository');
  const offenders: string[] = [];
  for (const file of tracked) {
    // Migrations are append-only history: 0180 must still be able to CREATE what 0224 drops.
    if (file.startsWith('src/apiserver/prisma/migrations/')) continue;
    // These two specs are where the name is asserted absent, so they necessarily contain it.
    if (file.includes('evidence-judgment-removal')) continue;
    if (!/\.(ts|tsx|js|mjs|cjs|go|sql|json|ya?ml|sh|md|swift)$/.test(file)) continue;
    let source: string;
    try {
      source = readFileSync(path.join(repoRoot(), file), 'utf8');
    } catch {
      continue;
    }
    // A fixture that REPLAYS an append-only migration has to reconstruct the schema that migration
    // was written against, exactly like the migrations directory skipped above.
    const replaysAMigration = source.includes('prisma/migrations/')
      || /'prisma',\s*'migrations'/.test(source);
    for (const [index, line] of source.split('\n').entries()) {
      if (replaysAMigration && /CREATE TABLE/i.test(line)) continue;
      // A USE, not a mention: the table name where SQL would read or write it, or the Prisma
      // delegate/model that stands for it. `$queryRaw` and `$executeRaw` are plain template
      // strings the compiler cannot check, which is exactly why this scan is textual.
      const uses = /(FROM|INTO|JOIN|UPDATE|TABLE|EXISTS|REFERENCES|ON)\s+"?task_human_signoff/i
        .test(line)
        || /\btaskHumanSignoff\b|\bTaskHumanSignoff\b/.test(line);
      if (!uses) continue;
      // A line that records what 0224 removed is history, not a reference: the specs and the
      // write-inventory entry that say "this is gone" have to be able to say the name.
      if (/0224|removal|removed|migration|deleted/i.test(line)) continue;
      offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('(c) the removal migration drops the table, its trigger and its function', () => {
  const removal = read(REMOVAL_MIGRATION);
  assert.match(removal, /DROP TABLE "task_human_signoff";/);
  assert.match(removal, /DROP TRIGGER IF EXISTS "task_human_signoff_current_request_guard"/);
  assert.match(removal, /DROP FUNCTION IF EXISTS "task_human_signoff_current_request_guard"\(\)/);
});

test('(c) the signoff backfill runs with the transition guard lifted, and puts it back', () => {
  // Every row the backfill touches is DECIDED, and `task_judgment_request_transition_guard` is a
  // BEFORE UPDATE trigger that raises TASK_JUDGMENT_REQUEST_TERMINAL_IMMUTABLE on any update to a
  // row that is not OPEN. Nothing else can catch this: the acceptance database applies migrations
  // to an EMPTY schema, where the backfill matches zero rows and the trigger never fires. It would
  // have failed on the first database that actually had a signoff in it.
  const removal = read(REMOVAL_MIGRATION);
  const disable = removal.indexOf(
    'DISABLE TRIGGER "task_judgment_request_transition_guard"');
  const update = removal.search(/UPDATE "task_judgment_request" r\s*\n\s*SET "decision_note"/);
  const enable = removal.indexOf(
    'ENABLE TRIGGER "task_judgment_request_transition_guard"');
  assert.ok(disable > 0, 'the backfill must lift the transition guard');
  assert.ok(update > disable, 'the guard must be lifted before the backfill, not after it');
  assert.ok(enable > update, 'the guard must be restored after the backfill');
  // And restoring it is asserted by the migration itself rather than assumed here.
  assert.match(removal, /EVIDENCE_JUDGMENT_MIGRATION_GUARD_LEFT_DISABLED/);
  assert.match(removal, /SELECT t\.tgenabled INTO enabled/);
  assert.match(removal, /enabled IS DISTINCT FROM 'O'/);
  // The suppression is scoped to that one trigger: a session-wide switch would also have silenced
  // every foreign key and every other trigger on the table. (Scanned over statements, since the
  // comment above the backfill says in prose why that switch was not used.)
  assert.doesNotMatch(removal.replace(/^--.*$/gm, ''), /session_replication_role/);
});

// ── (d) the shape advice no longer routes anybody to a human ───────────────────────────────────

test('(d) TASK_CRITERION_SHAPE_ADVICE cannot suggest the removed criterion', () => {
  assert.deepEqual(TASK_CRITERION_SHAPE_RULES.map((rule) => rule.criterion),
    ['EXECUTABLE', 'VERIFICATION']);
  const source = read('src/apiserver/src/tasks/task-criterion-shape-advice.ts');
  assert.doesNotMatch(source, /HUMAN_SIGNOFF/);
  for (const keyword of ['取舍', '值不值', '授权', '不可逆', '发布', '删除']) {
    assert.ok(!TASK_CRITERION_SHAPE_RULES.some((rule) => rule.keywords.includes(keyword)),
      `${keyword} still routes a caller towards a criterion nobody is waiting at`);
  }
});

// ── (l)–(o) the ruler's write protection, one assertion each ───────────────────────────────────

test('(l) theWebAppCannotAuthorACriterion: no screen may restate a project\'s criteria',
  () => {
    // The proposal channel this used to assert against was deleted by 0223, which restored the
    // direct runner write. The claim this test is named for is the web one below, and it stands
    // on its own: no screen in the app may author a criterion.

    const webSources: Array<{ path: string; source: string }> = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
        webSources.push({
          path: path.relative(repoRoot(), full),
          source: readFileSync(full, 'utf8'),
        });
      }
    };
    walk(path.join(repoRoot(), 'src/web/src'));
    assert.ok(webSources.length > 50, 'the web scan must actually have read the app');
    for (const file of webSources) {
      for (const line of file.source.split('\n')) {
        if (!line.includes('acceptanceCriteriaItems')) continue;
        assert.match(line, /acceptanceCriteriaItems\?:/,
          `${file.path} may only READ acceptanceCriteriaItems, never author it`);
      }
      assert.doesNotMatch(file.source, /method:\s*'(POST|PATCH|PUT)'[\s\S]{0,400}?acceptanceCriteria[^I]/,
        `${file.path} must not send acceptance criteria in a write`);
    }
  });

// ── (q) this change is a subtraction ───────────────────────────────────────────────────────────

test('(q) no compose service, no resident process, and the human step is gone from the tree', () => {
  const compose = read('docker-compose.yml');
  const services = [...compose.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]);
  assert.deepEqual(services, [
    'postgres', 'pgbackup', 'apiserver', 'web', 'gateway', 'pg-socket',
  ], 'the removal must not have added a service');

  const apiPackage = JSON.parse(read('src/apiserver/package.json')) as {
    scripts: Record<string, string>;
  };
  assert.deepEqual(Object.keys(apiPackage.scripts).filter((name) => name.startsWith('start:')),
    ['start:dev'],
    'the removal must not have added a long-running entrypoint');

  const removal = read(REMOVAL_MIGRATION);
  assert.doesNotMatch(removal, /CREATE EXTENSION|pg_cron|\bLISTEN\b|\bNOTIFY\b/,
    'the migration must not install a scheduler or a listener');

  // What "subtraction" means concretely: each of these was part of the human step and none of them
  // exists any more, at any door.
  const gone: Array<[string, RegExp]> = [
    ['src/apiserver/prisma/schema.prisma', /model TaskHumanSignoff/],
    ['src/apiserver/src/tasks/tasks.service.ts', /async signoff\(/],
    ['src/apiserver/src/tasks/tasks.controller.ts', /:id\/signoff/],
    ['src/apiserver/src/runner-api/runner-tasks.controller.ts', /tasks\/:id\/signoff/],
    ['src/runner-go/task_cli.go', /task_signoff/],
    ['src/web/src/lib/judgments.ts', /signoff/],
    ['src/apiserver/src/tasks/task-criterion-shape-advice.ts', /取舍/],
    ['src/apiserver/src/projects/coordinator-authority.ts', /VERDICT_PASS_HUMAN_ONLY/],
  ];
  for (const [file, pattern] of gone) {
    assert.doesNotMatch(read(file), pattern, `${file} still carries the removed human step`);
  }

  // A removal migration that adds schema is not a removal. 0224 drops a table and swaps three
  // CHECK definitions; it creates no table, no column, no type and no enum value.
  assert.match(removal, /DROP TABLE "task_human_signoff";/);
  const statements = removal.replace(/^--.*$/gm, '');
  assert.doesNotMatch(statements, /CREATE TABLE/i);
  assert.doesNotMatch(statements, /ADD COLUMN/i);
  assert.doesNotMatch(statements, /CREATE TYPE/i);
  assert.doesNotMatch(statements, /ALTER TYPE[^;]*ADD VALUE/i);

  // And the line tally, over the files the human gate actually lived in. Naming them is the point:
  // a whole-diff count would be dominated by renaming one enum label across 117 files, which is
  // churn rather than evidence either way, and by the migration and the two specs that exist to
  // prove this removal. Every file below either shrank or stayed flat, and the set as a whole is
  // net negative — which is what "this is a subtraction" means where it can be checked.
  // The whole-diff numbers are reported on the task rather than asserted here.
  const GATE_FILES = [
    'src/apiserver/prisma/schema.prisma',
    'src/apiserver/src/common/db-write-inventory.ts',
    'src/apiserver/src/projects/coordinator-authority.ts',
    'src/apiserver/src/projects/project-acceptance.service.ts',
    'src/apiserver/src/runner-api/runner-tasks.controller.ts',
    'src/apiserver/src/tasks/task-criterion-shape-advice.ts',
    'src/apiserver/src/tasks/task-judgment-review.service.ts',
    'src/apiserver/src/tasks/tasks.controller.ts',
    'src/apiserver/src/tasks/tasks.service.ts',
    'src/web/src/lib/judgments.ts',
    'src/web/src/pages/JudgmentReviewPage.tsx',
  ];
  let numstat: string;
  const commits = git('log', '--format=%H', '--', REMOVAL_MIGRATION).split('\n').filter(Boolean);
  if (commits.length > 0) {
    // Reading the change from the commit that carries it, rather than from a diff against a
    // branch, keeps this true after the change lands instead of inverting once merge-base catches
    // up with it.
    numstat = commits.map((sha) => git('show', '--numstat', '--format=', sha)).join('\n');
  } else {
    numstat = git('diff', '--numstat', 'HEAD');
  }
  let added = 0;
  let deleted = 0;
  const measured = new Set<string>();
  for (const line of numstat.split('\n')) {
    const match = line.match(/^(\d+)\t(\d+)\t(.*)$/);
    if (!match) continue;
    const file = GATE_FILES.find((candidate) => match[3].includes(candidate));
    if (!file) continue;
    measured.add(file);
    added += Number(match[1]);
    deleted += Number(match[2]);
  }
  assert.deepEqual([...measured].sort(), [...GATE_FILES].sort(),
    'every file the human gate lived in must appear in the change being measured');
  assert.ok(deleted > added,
    `the files the human step lived in must shrink: +${added} / -${deleted}`);
});
