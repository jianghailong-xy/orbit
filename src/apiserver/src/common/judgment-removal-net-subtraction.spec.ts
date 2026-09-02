import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * "This change deletes more than it adds", measured from CONTENT rather than from a branch diff.
 *
 * `git diff --numstat main...HEAD` measures where the branch is standing, not whether the change
 * is a subtraction: it reads thousands deleted on the branch and 0/0 forever after the merge, so
 * the assertion inverts on exactly the tree it exists to protect. That defect has landed twice in
 * this repository. Both numbers below are read out of the worktree, so they say the same thing
 * before a merge, after a merge, on a clone with no `main` ref, and on an export with no history.
 *
 * `docs/verification-tiering.md` states the rule; `common/verification-tiering.spec.ts` (k) keeps
 * it stated.
 */

const API = path.resolve(__dirname, '../..');
const ROOT = path.resolve(API, '../..');
const MIGRATIONS = path.join(API, 'prisma/migrations');
const REMOVAL_DIR = '0227_task_judgment_removal';

/** The vocabulary this removal owns. A later migration that returns to it is charged here. */
const VOCABULARY = [
  'task_judgment_request',
  'task_executable_judgment_result',
  'task_judgment_inbox_item',
  'task_judgment_push_delivery',
  'task_judgment_backfill_batch',
  'task_judgment_signal',
  'project_judgment_blocker',
];

/** The migrations that installed the machinery. Immutable, so no later commit can dilute them. */
const INSTALLERS = [
  '0181_task_judgment_request',
  '0182_task_judgment_delivery',
  '0184_task_signoff_backfill',
];

/**
 * Executable lines: the statements, not the prose around them.
 *
 * Applied to BOTH sides, so the ratio compares like with like. A removal migration is mostly
 * commentary by design — it has to record a decision that the deleted code can no longer state —
 * and charging its explanation against an installer's statements would make writing the reason
 * down the thing that fails the assertion.
 */
function executableLines(sql: string): number {
  return sql.split('\n').filter((line) => line.trim() && !line.trim().startsWith('--')).length;
}

function migrations(): Array<{ dir: string; sql: string }> {
  return readdirSync(MIGRATIONS)
    .filter((dir) => /^\d{4}_/.test(dir))
    .sort()
    .flatMap((dir) => {
      try {
        return [{ dir, sql: readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8') }];
      } catch {
        return [];
      }
    });
}

test('(y) the removal spends far fewer lines than the machinery it retires', () => {
  const ledger = migrations();

  const retired = ledger.filter(({ dir }) => INSTALLERS.includes(dir))
    .reduce((total, { sql }) => total + executableLines(sql), 0);
  assert.ok(retired > 700,
    `expected the ~800 statement lines that installed the judgment machinery, saw ${retired}`);

  // What it spent: 0227, plus any later migration that returns to the same vocabulary. Filtered by
  // vocabulary rather than by date, so a compatibility shim for the removed machinery goes on this
  // bill and an unrelated migration landing on top does not.
  const spending = ledger.filter(({ dir }) => dir >= REMOVAL_DIR)
    .filter(({ sql }) => VOCABULARY.some((name) => sql.includes(name)));
  const spent = spending.reduce((total, { sql }) => total + executableLines(sql), 0);
  assert.ok(spent > 0, 'the removal migration itself must be among the spending');
  assert.ok(spent * 5 < retired, `the removal spent ${spent} lines `
    + `(${spending.map(({ dir }) => dir).join(', ')}) to retire ${retired}`);
});

test('(y) nothing at or after the removal re-creates what it dropped', () => {
  // Absolute rather than a ratio: a removal that re-creates what it dropped is a net addition
  // however the line counts come out.
  const reinstalled = migrations()
    .filter(({ dir }) => dir >= REMOVAL_DIR)
    .flatMap(({ dir, sql }) => VOCABULARY
      .filter((name) => new RegExp(
        'CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:MATERIALIZED\\s+)?(?:TABLE|VIEW)'
        + `\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"?${name}"?\\b`, 'i').test(sql))
      .map((name) => `${dir}: ${name}`));
  assert.deepEqual(reinstalled, []);

  // And the vocabulary pattern is not simply dead: run it over the installers, each of which must
  // match. A regex that never matches would make the assertion above a permanent false negative.
  for (const installer of INSTALLERS) {
    const sql = readFileSync(path.join(MIGRATIONS, installer, 'migration.sql'), 'utf8');
    assert.ok(VOCABULARY.some((name) => new RegExp(
      `CREATE\\s+TABLE\\s+"?${name}"?\\b`, 'i').test(sql)),
      `${installer} matches no CREATE in the vocabulary; the pattern is dead`);
  }
});

test('(z) no compose service or resident process is added', () => {
  const compose = readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
  // `services:` is the first line and `volumes:` is the only other top-level key, so the service
  // block is everything between them. Counting the whole file would count the named volume too.
  const services = compose.slice(0, compose.indexOf('\nvolumes:'));
  const names = [...services.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gmu)].map((match) => match[1]);
  assert.deepEqual(names, ['postgres', 'pgbackup', 'apiserver', 'web', 'gateway'],
    `compose declares ${names.length} services: ${names.join(', ')}`);
  assert.equal(/judgment|judgement/i.test(compose), false,
    'the removal must add no judgment compose service');

  // Nor a timer, worker or bootstrap hook in place of the delivery worker it deleted.
  for (const file of [
    'src/apiserver/src/push/push.module.ts',
    'src/apiserver/src/push/push.service.ts',
    'src/apiserver/src/tasks/tasks.module.ts',
  ]) {
    const source = readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(source, /TaskJudgment|JudgmentDelivery|JudgmentReview|JudgmentRequest/u,
      `${file} still wires a judgment provider`);
  }
  assert.doesNotMatch(
    readFileSync(path.join(ROOT, 'src/apiserver/src/push/push.module.ts'), 'utf8'),
    /OnModuleInit|OnApplicationBootstrap|setInterval/u,
    'the push module must not have gained a resident process where the worker was',
  );
});
