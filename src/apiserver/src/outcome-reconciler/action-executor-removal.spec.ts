import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * What keeps the constrained Action Executor deleted.
 *
 * 0196_outcome_constrained_action_executor built a queue, budget ledger, lease/attempt trace,
 * receipt store, fairness cursor and an executor-owned obligation set. Nothing ever enqueued an
 * action; every relation held zero rows. This file is the regression that stops the machinery
 * from reappearing, and — just as important — the negative assertions that say the load-bearing
 * acceptance and canonical-obligation relations were NOT taken down with it.
 *
 * Everything is derived from the tree: relations are replayed out of `prisma/migrations` and the
 * reference scan reads the same text a reviewer reads.
 */
const API = path.resolve(__dirname, '../..');
const REPO = path.resolve(API, '../..');
const MIGRATIONS = path.join(API, 'prisma/migrations');

/** The thirteen relations 0196 created. Ten carry the `outcome_action_` prefix. */
const EXECUTOR_TABLES = [
  'outcome_action_attempt',
  'outcome_action_budget_account',
  'outcome_action_diagnostic',
  'outcome_action_event',
  'outcome_action_failure_fingerprint',
  'outcome_action_intent',
  'outcome_action_precondition',
  'outcome_action_project_fairness',
  'outcome_action_receipt',
  'outcome_action_scheduler',
  'outcome_executor_active_obligation',
  'outcome_executor_obligation_event',
  'outcome_executor_obligation_revision',
];

const EXECUTOR_FUNCTIONS = [
  'outcome_action_committing_guard',
  'outcome_activate_executor_obligation',
  'outcome_append_action_event',
  'outcome_assert_action_commit_fence',
  'outcome_begin_action_commit',
  'outcome_claim_next_action',
  'outcome_enqueue_action',
  'outcome_fail_claimed_action_diagnosis',
  'outcome_finish_action_commit',
  'outcome_record_action_diagnostic',
  'outcome_register_action_budget',
  'outcome_register_action_precondition',
  'outcome_resolve_executor_obligation',
  'outcome_sweep_action_queue',
];

const EXECUTOR_VIEW = 'outcome_canonical_active_obligation';

const CREATED_BY = '0196_outcome_constrained_action_executor';

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

test('every Action Executor relation is created by 0196 and dropped by a later migration', () => {
  for (const table of EXECUTOR_TABLES) {
    const create = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${table}"?[\\s(]`, 'i');
    const drop = new RegExp(`DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?"?${table}"?\\s*(?:CASCADE|RESTRICT)?\\s*[;,]`, 'i');
    const standing = lastVerdict(create, drop);
    assert.ok(standing, `${table} is named by no migration at all`);
    assert.equal(standing.verdict, 'DROPPED', `${table} is still installed by ${standing.dir}`);
    assert.ok(standing.dir > CREATED_BY, `${table} must be dropped after ${CREATED_BY}, not by ${standing.dir}`);
  }
});

test('every Action Executor stored function and its canonical view are dropped', () => {
  for (const fn of EXECUTOR_FUNCTIONS) {
    const create = new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+"?${fn}"?\\s*\\(`, 'i');
    const drop = new RegExp(`DROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?"?${fn}"?\\s*\\(`, 'i');
    const standing = lastVerdict(create, drop);
    assert.ok(standing, `${fn} is named by no migration at all`);
    assert.equal(standing.verdict, 'DROPPED', `${fn} is still installed by ${standing.dir}`);
  }
  const view = lastVerdict(
    new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?VIEW\\s+"?${EXECUTOR_VIEW}"?`, 'i'),
    new RegExp(`DROP\\s+VIEW\\s+(?:IF\\s+EXISTS\\s+)?"?${EXECUTOR_VIEW}"?`, 'i'),
  );
  assert.ok(view);
  assert.equal(view.verdict, 'DROPPED', `${EXECUTOR_VIEW} is still installed by ${view.dir}`);
});

/** Every tracked file a reviewer would read, minus the immutable migration history. */
function liveSources(): Array<{ rel: string; text: string }> {
  const roots = ['src/apiserver/src', 'src/apiserver/prisma/schema.prisma', 'src/shared/src',
    'src/web/src', 'scripts', 'test', 'contracts', 'package.json'];
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
    if (!/\.(ts|tsx|mts|mjs|js|json|sql|sh)$/.test(abs)) return;
    const rel = path.relative(REPO, abs);
    if (rel.endsWith('action-executor-removal.spec.ts')) return;
    out.push({ rel, text: readFileSync(abs, 'utf8') });
  };
  for (const root of roots) walk(path.join(REPO, root));
  return out;
}

test('no live source names an Action Executor relation, function or view', () => {
  const names = [...EXECUTOR_TABLES, ...EXECUTOR_FUNCTIONS, EXECUTOR_VIEW];
  const offenders: string[] = [];
  for (const { rel, text } of liveSources()) {
    text.split('\n').forEach((line, index) => {
      // Naming the migration that created something, on the same line, is a citation of the
      // history rather than a use of it: `prisma/migrations` is append-only, so an evidence
      // record may still point into 0196 after the objects it describes are gone.
      if (line.includes('prisma/migrations/')) return;
      for (const name of names) {
        if (line.includes(name)) offenders.push(`${rel}:${index + 1}: ${name}`);
      }
    });
  }
  assert.deepEqual(offenders, [],
    'a relation this migration dropped is still named outside the migration history — raw SQL in ' +
      '`$queryRaw` is not type-checked, so this scan is the only thing that would catch it');
});

test('the executor removal is subtraction: it installs no new relation', () => {
  const removals = migrations().filter(({ sql }) => /DROP TABLE outcome_action_intent/.test(sql));
  assert.equal(removals.length, 1, 'exactly one migration removes the executor');
  const [{ sql }] = removals;
  for (const forbidden of [/CREATE\s+TABLE/i, /CREATE\s+(?:CONSTRAINT\s+)?TRIGGER/i,
    /CREATE\s+(?:UNIQUE\s+)?INDEX/i, /CREATE\s+VIEW/i, /CREATE\s+TYPE/i]) {
    assert.equal(forbidden.test(sql), false,
      `the removal migration installs ${forbidden} — it must only take machinery away`);
  }
  // The two coordinator bodies it does rewrite existed before it and are replaced, never created.
  const replaced = [...sql.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+([a-z_0-9]+)/gi)]
    .map((match) => match[1]).sort();
  assert.deepEqual(replaced,
    ['outcome_reconcile_active_obligations_0198', 'outcome_record_coordinator_result_0198']);
  const earlier = migrations().filter(({ dir }) => dir < '0219');
  for (const fn of replaced) {
    assert.ok(earlier.some(({ sql: text }) => text.includes(fn)), `${fn} is new, not replaced`);
  }
});

test('the load-bearing acceptance and canonical relations were not taken down with it', () => {
  const standing = [
    'task_executable_attempt',
    'task_executable_admission',
    'outcome_canonical_fact',
    'outcome_obligation_revision',
    'outcome_obligation_event',
    'outcome_obligation_reduction',
    'outcome_obligation_successor',
    'outcome_active_obligation',
    'project_acceptance_run',
    'project_acceptance_criterion',
    'project_acceptance_criterion_definition',
    'project_acceptance_conclusion',
    'project_acceptance_audit',
    'project_acceptance_criteria_confirmation',
  ];
  for (const table of standing) {
    const create = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${table}"?[\\s(]`, 'i');
    const drop = new RegExp(`DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?"?${table}"?\\s*(?:CASCADE|RESTRICT)?\\s*[;,]`, 'i');
    const verdict = lastVerdict(create, drop);
    assert.ok(verdict, `${table} is named by no migration`);
    assert.equal(verdict.verdict, 'CREATED', `${table} was dropped by ${verdict.dir}`);
  }
  // The DONE gate is a trigger function, and it must still be the last word on project completion.
  const gate = lastVerdict(
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+"?project_acceptance_done_gate"?\s*\(/i,
    /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?"?project_acceptance_done_gate"?/i,
  );
  assert.ok(gate);
  assert.equal(gate.verdict, 'CREATED', `the DONE gate was dropped by ${gate.dir}`);
});
