import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * What keeps the judgment machinery, and the EXECUTABLE decision, deleted.
 *
 * The account owner's decision on 2026-09-02, in the order it was given: delete everything to do
 * with judgement, delete the EXECUTABLE decision too, and — the sentence that fixed the shape —
 * delete only the DEPENDENCIES, not the executable DATA. So the machine goes and the declaration
 * stays, and this file reads the tree for both halves.
 *
 * It reads text rather than trusting `tsc`, for the reason every removal suite before it gives:
 * this codebase reaches PostgreSQL through `$queryRaw`, so a dropped relation compiles perfectly
 * and fails in production. `task-judgment-removal.pg.spec.ts` is the other half — what a migrated
 * server actually has.
 */

const API = path.resolve(__dirname, '../..');
const ROOT = path.resolve(API, '../..');
const MIGRATIONS = path.join(API, 'prisma/migrations');
const REMOVAL_DIR = '0228_task_judgment_removal';
const REMOVAL_SQL = readFileSync(path.join(MIGRATIONS, REMOVAL_DIR, 'migration.sql'), 'utf8');

/** The five tables the judgment machine kept its own running state in. */
export const DROPPED_JUDGMENT_TABLES = [
  'task_judgment_request',
  'task_executable_judgment_result',
  'task_judgment_inbox_item',
  'task_judgment_push_delivery',
  'task_judgment_backfill_batch',
] as const;

/** Their two read-only projections. */
export const DROPPED_JUDGMENT_VIEWS = [
  'task_judgment_signal',
  'project_judgment_blocker',
] as const;

/**
 * Every function whose body named one of those tables, plus the 0192 helper whose four EXISTS
 * clauses all started `FROM "task_judgment_request"` and the two guards that delegated to it.
 */
export const DROPPED_JUDGMENT_FUNCTIONS = [
  'task_judgment_request_transition_guard',
  'task_judgment_request_verifier_role_guard',
  'task_judgment_request_migration_metadata_guard',
  'task_judgment_delivery_file',
  'task_judgment_delivery_stop',
  'task_executable_judgment_result_request_guard',
  'task_judgment_verifier_delete_guard',
  'task_judgment_verifier_terminal_guard',
  'task_open_verification_request_guard',
  'task_open_verification_request_carrier_guard',
  'assert_verification_request_carrier_state',
] as const;

/** The three that sat on the CORE `task` table and therefore had to be detached by name. */
export const DROPPED_CORE_TASK_TRIGGERS = [
  'task_judgment_verifier_delete_guard',
  'task_judgment_verifier_terminal_guard',
  'task_open_verification_request_carrier_guard',
] as const;

/** Deleted outright: their whole subject was the machine. */
const DELETED_FILES = [
  'src/apiserver/src/tasks/task-judgment-review.service.ts',
  'src/apiserver/src/tasks/task-judgment-review.controller.ts',
  'src/apiserver/src/tasks/task-judgment-request.ts',
  'src/apiserver/src/tasks/task-judgment-request.controller.ts',
  'src/apiserver/src/tasks/task-judgment-repair.cli.ts',
  'src/apiserver/src/tasks/task-signoff-migration.cli.ts',
  'src/apiserver/src/push/judgment-delivery.service.ts',
  'src/apiserver/src/push/judgment-alert.ts',
  'src/web/src/lib/judgments.ts',
  'src/web/src/lib/judgmentEvidence.ts',
  'src/web/src/pages/JudgmentReviewPage.tsx',
  'src/web/src/components/JudgmentRequestSummary.tsx',
  'src/runner-go/task_judge_test.go',
];

/**
 * Files whose whole job is to say the removed things are gone, or to replay an immutable
 * historical migration against a synthetic schema of their own. Each is a named exception, not a
 * pattern: a scan that let any spec off would let the next accidental reader off with it.
 */
const EVIDENCE = new Set([
  'src/apiserver/src/tasks/task-judgment-removal.spec.ts',
  'src/apiserver/src/tasks/task-judgment-removal.pg.spec.ts',
  'src/apiserver/src/tasks/task-judgment-data-preserved.spec.ts',
  'src/apiserver/src/tasks/task-executable-acceptance.pg.spec.ts',
  'src/apiserver/src/tasks/executable-acceptance-runtime-removal.spec.ts',
  'src/apiserver/src/tasks/executable-acceptance-runtime-removal.pg.spec.ts',
  'src/apiserver/src/outcome-reconciler/watchdog-coordinator-removal.pg.spec.ts',
  'src/apiserver/src/tasks/task-verifier-role-migration.pg.spec.ts',
  'src/apiserver/src/tasks/task-done-writer-fence.pg.spec.ts',
  'src/apiserver/src/tasks/task-verification-sole-implementation.spec.ts',
  'src/apiserver/src/tasks/task-completion-evidence.spec.ts',
  'src/apiserver/src/tasks/auto-run-backoff.spec.ts',
  'src/apiserver/src/tasks/task-list-pagination.spec.ts',
  'src/apiserver/src/tasks/task-run-at.spec.ts',
  'src/apiserver/src/common/db-write-inventory-judgment-removal.spec.ts',
  'src/apiserver/src/common/judgment-removal-net-subtraction.spec.ts',
  'src/apiserver/src/common/completion-ack-removal-preserved.pg.spec.ts',
  'src/apiserver/src/push/judgment-delivery-removal.spec.ts',
  'src/apiserver/src/projects/evidence-judgment-removal.spec.ts',
  'src/apiserver/src/projects/project-acceptance-judgment-evidence-removal.spec.ts',
  'src/apiserver/src/runner-api/executable-derivation-removal.spec.ts',
  'src/apiserver/src/runner-api/task-judge-capability-removal.spec.ts',
  'test/outcome-reconciler-v2.ratification.test.mjs',
  'test/executable-acceptance-runtime.test.mjs',
  'contracts/outcome-reconciler-v2-source-audit.json',
]);

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8');
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

/**
 * Every file the worktree actually has, tracked or merely known about.
 *
 * `--others --exclude-standard` is load-bearing: plain `git ls-files` reports the INDEX, so a file
 * written but not yet staged is invisible and the scan goes green on a tree it never read.
 */
function scannableFiles(): string[] {
  const listed = execFileSync(
    'git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  ).split('\0').filter(Boolean);
  return listed.filter((file) => !file.startsWith('src/apiserver/prisma/migrations/')
    && !file.includes('/build/')
    && !file.includes('/dist/')
    && !file.startsWith('node_modules/'));
}

// (c) --------------------------------------------------------------------------------------------
test('(c) the EXECUTABLE and EVIDENCE_JUDGMENT satisfaction logic is gone from the evaluator', () => {
  const criterion = read('src/apiserver/src/tasks/task-completion-criterion.ts');
  const evaluator = criterion.slice(criterion.indexOf('export function evaluateTaskCompletion'));
  const body = evaluator.slice(0, evaluator.indexOf('\n}\n'));

  // The declaration is untouched: all three labels, and the pair the first of them carries.
  assert.match(criterion, /'EXECUTABLE',\n  'VERIFICATION',\n  'EVIDENCE_JUDGMENT',/u);
  assert.match(criterion, /acceptanceCommand\?: string \| null;/u);
  assert.match(criterion, /acceptanceExpectedExitCode\?: number \| null;/u);

  // The implementation is not. Nothing in the evaluator compares an exit code or reads a decision.
  for (const gone of [
    /executableExitCode/u,
    /executableTerminationKind/u,
    /executableLegacyTermination/u,
    /evidenceJudgment/u,
    /acceptanceExpectedExitCode/u,
  ]) {
    assert.doesNotMatch(body, gone, `the evaluator still reads ${gone}`);
  }
  // And both arms are explicit, so the exhaustiveness check keeps answering for them.
  assert.match(body, /case 'EXECUTABLE':\s*\n\s*state = 'UNSATISFIED';/u);
  assert.match(body, /case 'EVIDENCE_JUDGMENT':\s*\n\s*state = 'UNSATISFIED';/u);
  assert.doesNotMatch(body, /default:/u, 'no default arm may absorb a criterion');
});

test('(c) the runner callback no longer derives DONE, or FAILED, from an exit code', () => {
  const controller = read('src/apiserver/src/runner-api/runner-api.controller.ts');
  assert.doesNotMatch(controller, /deriveTaskCompletionStatus/u);
  assert.doesNotMatch(controller, /derivedStatus/u);
  assert.doesNotMatch(controller, /ensureLegacyExecutableJudgmentRequest/u);
  assert.doesNotMatch(controller, /acceptanceTaskCompleted/u);
  // Nor was it replaced by a second automatic route: the only `task.updateMany` writing a status
  // in the whole controller would be the removed one, so there is none.
  assert.doesNotMatch(controller, /data:\s*\{\s*status:\s*derived/u);
  assert.doesNotMatch(controller, /postExecutableAcceptanceComment/u,
    'the comment that announced a derived status has no derivation left to announce');

  // 0227 took 0200's typed attempt an hour before this change; between them the controller has
  // no criterion evaluation left at all.
  assert.doesNotMatch(controller, /taskExecutableAttempt/u);
  assert.doesNotMatch(controller, /acceptanceTaskChanged = true/u,
    'nothing can set the flag that said a criterion moved the task');
});

// (d) --------------------------------------------------------------------------------------------
test('(d) the deleted files are gone and their capability was not moved elsewhere', () => {
  for (const file of DELETED_FILES) {
    assert.equal(existsSync(path.join(ROOT, file)), false, `${file} must be deleted`);
  }
  // Nothing may import them, and no module may still provide them. The removal suites are the
  // exception by construction: naming a deleted symbol in order to assert its absence is the
  // record of the removal, and a scan that refused it would refuse its own evidence.
  const files = scannableFiles().filter((file) => !EVIDENCE.has(file));
  for (const file of files) {
    let source: string;
    try {
      source = read(file);
    } catch {
      continue;
    }
    for (const symbol of ['TaskJudgmentReviewService', 'JudgmentDeliveryService',
      'TaskJudgmentRequestController', 'TaskJudgmentReviewController', 'judgmentAlert',
      'routeTaskJudgment']) {
      assert.doesNotMatch(source, new RegExp(symbol),
        `${file} still names ${symbol}, which was deleted`);
    }
  }
});

// (l) --------------------------------------------------------------------------------------------
test('(l) task_judge is gone from every door; the declaration flags stay', () => {
  const mcp = read('src/runner-go/mcp.go');
  const cli = read('src/runner-go/task_cli.go');
  const transport = read('src/runner-go/transport.go');
  for (const [name, source] of [['mcp.go', mcp], ['task_cli.go', cli],
    ['transport.go', transport]] as const) {
    assert.doesNotMatch(source, /task_judge/u, `${name} still advertises task_judge`);
    assert.doesNotMatch(source, /judgeTask/u, `${name} still calls judgeTask`);
    assert.doesNotMatch(source, /tasks\/[^"]*\/judgment/u, `${name} still posts to the judgment route`);
  }
  assert.doesNotMatch(cli, /cliTaskJudge/u);

  // The two flags that write the DECLARATION are untouched, on both doors.
  assert.match(cli, /--acceptance-command/u);
  assert.match(cli, /--acceptance-expected-exit-code/u);
  assert.match(mcp, /acceptanceCommand/u);
  assert.match(mcp, /acceptanceExpectedExitCode/u);

  // And so is the server side of them.
  const dto = read('src/apiserver/src/tasks/dto.ts');
  assert.match(dto, /acceptanceCommand/u);
  assert.match(dto, /acceptanceExpectedExitCode/u);
  assert.doesNotMatch(dto, /JudgeTaskDto|DecideTaskJudgmentDto|TaskJudgmentRequestDto/u);
  const tasksController = read('src/apiserver/src/tasks/tasks.controller.ts');
  const runnerTasks = read('src/apiserver/src/runner-api/runner-tasks.controller.ts');
  assert.doesNotMatch(tasksController, /judgment/u);
  assert.doesNotMatch(runnerTasks, /judgment/u);
});

// (s) --------------------------------------------------------------------------------------------
test('(s) the project acceptance gate lost its judgment-result reader and gained no replacement', () => {
  const service = read('src/apiserver/src/projects/project-acceptance.service.ts');
  assert.doesNotMatch(service, /taskExecutableJudgmentResult\./u,
    'the gate must not read the removed result table');
  assert.doesNotMatch(service, /tx\.taskJudgment/u);
  // The EXECUTABLE branch this used to slice out is gone with the gate that held it: on
  // 2026-09-03 the account owner removed the project acceptance judgment entirely, so there is no
  // branch, no evidence source and no verdict for any criterion kind.
  for (const gone of ['TaskCompletionCriterion.EXECUTABLE', 'ProjectAcceptanceVerdict',
    'No matching recorded command result exists yet']) {
    assert.equal(service.includes(gone), false,
      `${gone} survives in a service that no longer concludes anything`);
  }

  // The DECLARATION and its data are outside BOTH changes, and this one names none of it.
  assert.match(service, /projectAcceptanceCriterionDefinition/u);
  assert.doesNotMatch(REMOVAL_SQL, /DROP\s+(?:TABLE|TRIGGER|FUNCTION)[^\n]*project_acceptance/u);
});

// (t) --------------------------------------------------------------------------------------------
test('(t) nothing in the tree still reads or writes the five tables, raw SQL included', () => {
  const names = [...DROPPED_JUDGMENT_TABLES, ...DROPPED_JUDGMENT_VIEWS];
  const camel = ['taskJudgmentRequest', 'taskExecutableJudgmentResult', 'taskJudgmentInboxItem',
    'taskJudgmentPushDelivery', 'taskJudgmentBackfillBatch'];
  const offenders: string[] = [];
  for (const file of scannableFiles()) {
    if (EVIDENCE.has(file)) continue;
    let source: string;
    try {
      source = read(file);
    } catch {
      continue;
    }
    for (const line of source.split('\n')) {
      // A comment saying what was removed is the record of the removal, not a reference to it.
      if (/^\s*(?:--|\/\/|\*|#)/.test(line)) continue;
      for (const name of [...names, ...camel]) {
        if (line.includes(name)) offenders.push(`${file}: ${line.trim().slice(0, 100)}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'live references to the removed relations remain');
});

// The removal is a subtraction of the machine only: no statement in it can reach a preserved row.
test('(t) the removal migration carries no DML at all', () => {
  const statements = REMOVAL_SQL.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n');
  for (const write of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+"?[a-z_]/i, /\bDELETE\s+FROM\b/i,
    /\bTRUNCATE\b/i]) {
    assert.equal(write.test(statements), false, `the removal carries a ${write} of its own`);
  }
  // Nothing later returns to the vocabulary to re-create what it dropped.
  const later = migrations().filter(({ dir }) => dir > REMOVAL_DIR);
  for (const { dir, sql } of later) {
    for (const name of [...DROPPED_JUDGMENT_TABLES, ...DROPPED_JUDGMENT_VIEWS]) {
      assert.doesNotMatch(sql, new RegExp(`CREATE\\s+(?:TABLE|VIEW)\\s+"?${name}"?`, 'i'),
        `${dir} re-creates ${name}`);
    }
  }
});
