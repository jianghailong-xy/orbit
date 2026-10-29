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
 *
 * THE DELIVERED IDENTITY (revision 29, §10.5 O-L4, §10.9 item 8)
 * ==============================================================
 * Every DONE writer also freezes the commit the task's work is named by, and the obligation is
 * checked the same way, for the same reason: a door that forgot it leaves a task the observation
 * never looks for (§10.6), and in an AGENT_PUSH project a dependent that waits on J9 with nobody
 * holding the wait. Three halves:
 *
 *   * the DONE writer states the identity in the statement that writes DONE
 *     (`deliveredIdentityAtDone`) — or is listed in FREEZES_AT_FINISH with the fact that its work
 *     cannot have settled when it writes;
 *   * `enqueueForDoneTask`, which every DONE writer calls, settles it (`settleDeliveredIdentity`):
 *     it announces what the DONE froze and opens what an unknown identity owes;
 *   * every write of a session's `finished_at` settles it (`settleDeliveredIdentityAfterFinish`),
 *     because the DONE of work still moving freezes when that work finishes (O-L4 3).
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
/** The identity a DONE write states in its own statement (O-L4). */
const IDENTITY_IN_DONE_WRITE = /\bdeliveredIdentityAtDone\s*\(/;
/** The settlement `enqueueForDoneTask` makes after the route is queued. */
const SETTLE_AFTER_DONE = /\bsettleDeliveredIdentity\s*\(/;
/** The settlement a finish of a work session makes (O-L4 3). */
const SETTLE_AFTER_FINISH = /\bsettleDeliveredIdentityAfterFinish\s*\(/;
/** A Prisma write of the `session` model, whose data can carry `finishedAt`. */
const PRISMA_SESSION_WRITE = /\.session\.(?:update|updateMany|upsert)\s*\(/g;
/** `finishedAt` in key position with a value written — not a select (`true`), a filter (`{`) or a
 *  revive clearing it (`null`). */
const FINISHED_AT_WRITTEN = /\bfinishedAt\s*:(?!\s*(?:true\b|null\b|undefined\b|\{))/;

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
    'projects/project-integration-job.ts#settleDeliveredIdentity',
    'It writes no status: the `status: TaskStatus.DONE` it names is the predicate of the freeze\'s '
    + 'compare-and-set, which writes the five delivered_* columns of a task that is already DONE and '
    + 'nothing else (§10.5 O-L4). It runs inside the enqueue a DONE door already called, and after the '
    + 'finish of work a DONE was waiting for; queueing here would queue a second time for one DONE.',
  ],
  [
    'tasks/task-completion-test-helper.ts#completeHumanTaskForPgTest',
    'A pg-spec fixture, not a door: it drives a task to DONE through the VERIFICATION lane so a '
    + 'suite has a genuinely finished task to work with. It is reachable from no request, and a '
    + 'fixture that queued real integration jobs would give every suite that uses it a repository '
    + 'to fetch from.',
  ],
]);

/**
 * DONE writers whose statement does not state the delivered identity, each with the fact that makes
 * its work unsettled at the moment it writes DONE — so there is nothing yet to state, and the finish
 * of that work freezes it (O-L4 3). `enqueueForDoneTask` freezes it as well if the work ever had
 * settled, so an entry here costs a second write of the task's row, never a missing identity.
 */
const FREEZES_AT_FINISH: ReadonlyMap<string, string> = new Map([
  [
    'runner-api/runner-api.controller.ts#turnComplete',
    'The acceptance command runs in the task\'s own work session, which is live while this turn '
    + 'completes — a live session\'s finished_at is null until its finalize writes it — so the work '
    + 'has not settled when the comparison derives DONE, and that finalize freezes the identity. The '
    + 'comparison is also held to writing `data: { status: derivedStatus }` and nothing else '
    + '(runner-api/executable-exit-code-judgment.spec.ts).',
  ],
]);

/**
 * Writes of a session's finish whose transaction settles the identity in the declaration that owns
 * the transaction, after writes of its own that have to come first: the finish site, the declaration
 * that settles it, and why it is not the site itself.
 */
const SETTLED_BY_CALLER: ReadonlyMap<string, { by: string; why: string }> = new Map([
  [
    'projects/session-source.ts#freezeSessionSourcePin',
    {
      by: 'runner-api/runner-api.controller.ts#pinSessionSource',
      why: 'The refusal this freeze closes the run on is recorded by its caller in the same '
        + 'transaction, the project blocker (rank 40) first and the task (rank 50) second; a settle '
        + 'inside the freeze could write the task before the project is taken, the cycle that order '
        + 'exists to prevent.',
    },
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
  return declarationsCalling(sources, ENQUEUE_CALL);
}

/** The declarations whose code calls what `call` matches. */
export function declarationsCalling(sources: readonly ScannedSource[], call: RegExp): string[] {
  const sites = new Set<string>();
  for (const source of sources) {
    const code = withoutComments(source.content);
    const units = unitsByLine(code);
    code.split('\n').forEach((line, index) => {
      if (call.test(line)) sites.add(`${source.path}#${units[index]}`);
    });
  }
  return [...sites].sort();
}

/**
 * Every `path#declaration` that writes a session's `finished_at`: a write of the `session` model whose
 * arguments, read up to the parenthesis that closes the call, give `finishedAt` a value.
 */
export function finishWriteSites(sources: readonly ScannedSource[]): string[] {
  const sites = new Set<string>();
  for (const source of sources) {
    const code = withoutComments(source.content);
    const units = unitsByLine(code);
    for (const match of code.matchAll(PRISMA_SESSION_WRITE)) {
      const at = match.index ?? 0;
      const open = at + match[0].length - 1;
      let depth = 0;
      let close = open;
      for (; close < code.length; close += 1) {
        if (code[close] === '(') depth += 1;
        else if (code[close] === ')' && --depth === 0) break;
      }
      if (FINISHED_AT_WRITTEN.test(code.slice(open, close))) {
        sites.add(`${source.path}#${units[code.slice(0, at).split('\n').length - 1]}`);
      }
    }
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

test('every declaration that writes task.status = DONE states the delivered identity in that write (§10.5 O-L4)', () => {
  const sources = productionSources(SRC);
  const writers = doneWriteSites(sources).filter((site) => !EXEMPT.has(site));
  const stating = new Set(declarationsCalling(sources, IDENTITY_IN_DONE_WRITE));
  const missing = writers.filter((site) => !stating.has(site) && !FREEZES_AT_FINISH.has(site));
  assert.deepEqual(
    missing,
    [],
    'these declarations write DONE without freezing the delivered identity in the same statement '
      + '(contract §10.5 O-L4). Spread deliveredIdentityAtDone into the DONE write, or add the site to '
      + `FREEZES_AT_FINISH with the fact that its work cannot have settled:\n  ${missing.join('\n  ')}`,
  );
  // An entry for a door that states the identity after all, or that no longer writes DONE, is a
  // reason nobody needs any more.
  const stale = [...FREEZES_AT_FINISH.keys()].filter((site) => !writers.includes(site) || stating.has(site));
  assert.deepEqual(stale, [], 'FREEZES_AT_FINISH names a site that does not need it');
});

test('enqueueForDoneTask settles the identity, and so does every write of a work session\'s finish (O-L4 3)', () => {
  const sources = productionSources(SRC);
  assert.ok(
    declarationsCalling(sources, SETTLE_AFTER_DONE).includes('projects/project-integration-job.ts#enqueueForDoneTask'),
    'enqueueForDoneTask no longer settles the delivered identity, so no DONE door does (§10.5 O-L4)',
  );
  const finishes = finishWriteSites(sources);
  assert.ok(
    finishes.length >= 4,
    `the census found only ${finishes.length} write(s) of a session's finish; it has stopped seeing them`,
  );
  const settling = new Set(declarationsCalling(sources, SETTLE_AFTER_FINISH));
  const missing = finishes.filter((site) => {
    if (settling.has(site)) return false;
    const caller = SETTLED_BY_CALLER.get(site);
    return !caller || !settling.has(caller.by);
  });
  assert.deepEqual(
    missing,
    [],
    'these declarations write a session\'s finished_at without settling the delivered identity of '
      + 'the task whose work it ends (contract §10.5 O-L4 3): a DONE that waited for this finish '
      + `would never freeze. Call settleDeliveredIdentityAfterFinish in the same transaction:\n  ${missing.join('\n  ')}`,
  );
  const stale = [...SETTLED_BY_CALLER.keys()].filter((site) => !finishes.includes(site) || settling.has(site));
  assert.deepEqual(stale, [], 'SETTLED_BY_CALLER names a site that does not need it');
});

test('the census notices a DONE that states no identity, and a finish that settles nothing', () => {
  const forgetful: ScannedSource[] = [{
    path: 'tasks/new-door.service.ts',
    content: [
      'export async function settle(tx: Prisma.TransactionClient, taskId: string) {',
      '  await tx.task.updateMany({ where: { id: taskId }, data: { status: TaskStatus.DONE } });',
      '  await enqueueForDoneTask(tx, ownerId, taskId);',
      '}',
      'export async function end(tx: Prisma.TransactionClient, sessionId: string) {',
      '  await tx.session.updateMany({',
      '    where: { id: sessionId, finishedAt: null },',
      '    data: { status: RunStatus.CANCELLED, finishedAt: new Date() },',
      '  });',
      '}',
      'export async function read(tx: Prisma.TransactionClient, sessionId: string) {',
      '  await tx.session.update({ where: { id: sessionId }, data: { finishedAt: null } });',
      '  return tx.session.findMany({ where: { finishedAt: { not: null } }, select: { finishedAt: true } });',
      '}',
    ].join('\n'),
  }];
  assert.deepEqual(doneWriteSites(forgetful), ['tasks/new-door.service.ts#settle']);
  assert.deepEqual(declarationsCalling(forgetful, IDENTITY_IN_DONE_WRITE), []);
  assert.deepEqual(finishWriteSites(forgetful), ['tasks/new-door.service.ts#end']);
  assert.deepEqual(declarationsCalling(forgetful, SETTLE_AFTER_FINISH), []);

  const corrected: ScannedSource[] = [{
    path: forgetful[0].path,
    content: forgetful[0].content
      .replace(
        'data: { status: TaskStatus.DONE } }',
        'data: { status: TaskStatus.DONE, ...(await deliveredIdentityAtDone(tx, ownerId, taskId)) } }',
      )
      .replace('  });\n}\nexport async function read', '  });\n  await settleDeliveredIdentityAfterFinish(tx, sessionId);\n}\nexport async function read'),
  }];
  assert.deepEqual(declarationsCalling(corrected, IDENTITY_IN_DONE_WRITE), ['tasks/new-door.service.ts#settle']);
  assert.deepEqual(declarationsCalling(corrected, SETTLE_AFTER_FINISH), ['tasks/new-door.service.ts#end']);
});
