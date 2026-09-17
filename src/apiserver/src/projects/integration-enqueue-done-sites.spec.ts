import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * Every place production code can set `task.status = DONE` calls `enqueueForDoneTask` in the same
 * declaration (`docs/project-integration-line-contract.md` §2.3 J-T1a).
 *
 * WHY THIS IS A CENSUS AND NOT A TEST OF ONE DOOR
 * ==============================================
 * The platform's promise is "a code task that finishes is integrated", with no qualifier about
 * which door finished it. There are four, they were written years apart, and nothing about the
 * shape of a fourth would remind whoever adds it that a fifth has an obligation. A task completed
 * through a door that forgot to queue is not a visible failure: it is a task that reads DONE, a
 * branch that never lands, and a dependent that waits on J9 forever — exactly the silent stall
 * this whole project exists to remove. So the obligation is checked over the tree, not over the
 * doors somebody remembered.
 *
 * The scan is syntactic, over the same text a reviewer reads. It pairs a DONE-capable write of the
 * `task` model with the enqueue call inside the SAME declaration, because the value written is
 * routinely computed thirty lines above the call that sends it and a scan of the call's own
 * arguments would see a variable name. That direction errs safe: a declaration counted that never
 * actually writes DONE costs one call to a function that answers NOT_A_CODE_TASK and returns.
 *
 * Bounded to `src/apiserver/src`. Migration 0193's `task_done_canonical_writer_fence` is the
 * database's own guard on the same column and is not in scope here.
 */

// Resolved against the package root: this runs from `build/projects`, and the subject is the
// TypeScript a reviewer reads.
const SRC = path.resolve(__dirname, '../../src');

/** The Prisma writes of the `task` model whose input can carry a status. Reads are absent. */
const PRISMA_TASK_WRITE =
  /\.task\.(?:create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert)\s*\(/;
/** A raw statement that assigns the column. */
const SQL_UPDATE_TASK_STATUS =
  /\bUPDATE\s+(?:"task"|task\b)(?:(?!\bUPDATE\b|`|;)[\s\S])*?\bSET\b(?:(?!\bWHERE\b|\bRETURNING\b|`|;)[\s\S])*?(?:"status"|\bstatus\b)\s*=/gi;

/**
 * A value that can BE done. `TaskStatus.DONE` and the bare string both appear; a variable holding
 * one is reached through the declaration-level pairing rather than by following it.
 */
const DONE_VALUE = /TaskStatus\.DONE|'DONE'|"DONE"|`DONE`/;
/** `status` in key position — a Prisma input field, not the word in prose. */
const STATUS_KEY = /\bstatus\s*:/;
const ENQUEUE_CALL = /\benqueueForDoneTask\s*\(/;

const METHOD =
  /^ {2}(?:private |protected |public |static |readonly |abstract )*(?:async )?(?:\*)?([A-Za-z0-9_$]+)\s*[(<]/;
const FUNCTION =
  /^export (?:async )?function ([A-Za-z0-9_$]+)|^(?:async )?function ([A-Za-z0-9_$]+)|^export const ([A-Za-z0-9_$]+)\s*[=:]/;
const NOT_A_METHOD = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'constructor', 'do', 'else', 'try',
]);

interface ScannedSource {
  /** Relative to `src/apiserver/src`, forward slashes — how a site is spelled below. */
  readonly path: string;
  readonly content: string;
}

/**
 * Declarations the census reaches that do not in fact complete a task, each with the reason.
 *
 * Neither is a door: one REFUSES the fact, the other is a fixture. The one entry a reader expects
 * and does not find is the parent rollup — `applyTaskAggregations` calls the enqueue like every
 * other writer, and the PREDICATE is what excludes a parent, because a parent has no work session
 * and therefore no branch, so `enqueueForDoneTask` answers NOT_A_CODE_TASK. Excluding it by name
 * here instead would put the decision in a list that stops tracking what makes it true; leaving the
 * call in place means a parent that one day does have a branch is integrated rather than skipped.
 *
 * An entry added here has to say which fact makes queueing wrong there, not that it was
 * inconvenient.
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    'tasks/tasks.service.ts#update',
    'It REFUSES DONE rather than writing it: `dto.status === TaskStatus.DONE` throws '
    + 'DIRECT_TASK_DONE_REFUSED before any write, for every actor. The census pairs per '
    + 'declaration rather than per statement, so a method that writes the task and mentions DONE '
    + 'anywhere is counted; here the mention is the refusal. Queueing from the door that refuses '
    + 'the fact would be queueing an integration for a completion that did not happen.',
  ],
  [
    'tasks/task-completion-test-helper.ts#completeHumanTaskForPgTest',
    'A pg-spec fixture, not a door: it drives a task to DONE through the VERIFICATION lane so a '
    + 'suite has a genuinely finished task to work with. It is reachable from no request, and a '
    + 'fixture that queued real integration jobs would give every suite that uses it a repository '
    + 'to fetch from.',
  ],
]);

/** Blank out comments without moving a line: these files describe their own writes in prose. */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => (/^\s*(\/\/|\*)/.test(line) ? '' : line.replace(/\/\/.*$/, '')))
    .join('\n');
}

/** The declaration each line belongs to — what a site anchors to instead of a line number. */
function unitsByLine(code: string): string[] {
  let unit = '(module)';
  return code.split('\n').map((line) => {
    const asMethod = METHOD.exec(line);
    if (asMethod && !NOT_A_METHOD.has(asMethod[1])) {
      unit = asMethod[1];
    } else {
      const asFunction = FUNCTION.exec(line);
      if (asFunction) unit = asFunction[1] ?? asFunction[2] ?? asFunction[3];
    }
    return unit;
  });
}

/** Every `path#declaration` in these sources that can set `task.status` to DONE. */
export function doneWriteSites(sources: readonly ScannedSource[]): string[] {
  const sites = new Set<string>();
  for (const source of sources) {
    const code = withoutComments(source.content);
    const units = unitsByLine(code);
    const writes = new Set<string>();
    const statuses = new Set<string>();
    const dones = new Set<string>();
    code.split('\n').forEach((line, index) => {
      if (PRISMA_TASK_WRITE.test(line)) writes.add(units[index]);
      if (STATUS_KEY.test(line)) statuses.add(units[index]);
      if (DONE_VALUE.test(line)) dones.add(units[index]);
    });
    for (const unit of writes) {
      if (statuses.has(unit) && dones.has(unit)) sites.add(`${source.path}#${unit}`);
    }
    for (const match of code.matchAll(SQL_UPDATE_TASK_STATUS)) {
      const unit = units[code.slice(0, match.index).split('\n').length - 1];
      if (dones.has(unit)) sites.add(`${source.path}#${unit}`);
    }
  }
  return [...sites].sort();
}

/** The declarations that call the enqueue. */
export function enqueueSites(sources: readonly ScannedSource[]): string[] {
  const sites = new Set<string>();
  for (const source of sources) {
    const code = withoutComments(source.content);
    const units = unitsByLine(code);
    code.split('\n').forEach((line, index) => {
      if (ENQUEUE_CALL.test(line)) sites.add(`${source.path}#${units[index]}`);
    });
  }
  return [...sites].sort();
}

/**
 * Walked off the filesystem rather than asked of `git ls-files`: an uncommitted file is exactly the
 * state a new door is in while it is being added, and a census over the index is green for the
 * author and red for whoever commits next.
 */
function productionSources(dir: string, prefix = ''): ScannedSource[] {
  const found: ScannedSource[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const here = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...productionSources(path.join(dir, entry.name), here));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (/\.(spec|pg\.spec|http\.spec|test)\.ts$/.test(entry.name)) continue;
    found.push({ path: here, content: readFileSync(path.join(dir, entry.name), 'utf8') });
  }
  return found;
}

test('every declaration that writes task.status = DONE queues the integration in the same place', () => {
  const sources = productionSources(SRC);
  const writers = doneWriteSites(sources);
  const enqueuers = new Set(enqueueSites(sources));
  assert.ok(
    writers.length >= 4,
    `the census found only ${writers.length} DONE writer(s); it has stopped seeing the doors it exists to cover`,
  );
  const missing = writers.filter((site) => !enqueuers.has(site) && !EXEMPT.has(site));
  assert.deepEqual(
    missing,
    [],
    'these declarations complete a task without queueing its integration (contract §2.3 J-T1a). '
      + 'Call enqueueForDoneTask in the same transaction, or add the site to EXEMPT with the fact '
      + `that makes queueing wrong there:\n  ${missing.join('\n  ')}`,
  );
});

test('the census notices a door that completes a task and queues nothing', () => {
  // A file that does not exist, so the check is shown to fail on something rather than only to pass
  // on the tree whose answer is already written down.
  const forgetful: ScannedSource[] = [{
    path: 'tasks/new-door.service.ts',
    content: [
      'export async function settle(tx: Prisma.TransactionClient, taskId: string) {',
      '  await tx.task.updateMany({',
      '    where: { id: taskId },',
      '    data: { status: TaskStatus.DONE },',
      '  });',
      '}',
    ].join('\n'),
  }];
  assert.deepEqual(doneWriteSites(forgetful), ['tasks/new-door.service.ts#settle']);
  assert.deepEqual(enqueueSites(forgetful), []);

  const corrected: ScannedSource[] = [{
    path: forgetful[0].path,
    content: forgetful[0].content.replace(
      '  });\n}',
      '  });\n  await enqueueForDoneTask(tx, ownerId, taskId);\n}',
    ),
  }];
  assert.deepEqual(enqueueSites(corrected), ['tasks/new-door.service.ts#settle']);
});

test('prose about DONE is not a write of it', () => {
  const prose: ScannedSource[] = [{
    path: 'tasks/reader.ts',
    content: [
      '// A task that is DONE is not rewritten here: this only reads status.',
      'export async function readDone(db: PrismaService) {',
      "  return db.task.findMany({ where: { status: 'DONE' } });",
      '}',
    ].join('\n'),
  }];
  assert.deepEqual(doneWriteSites(prose), []);
});
