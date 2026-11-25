import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { stripComments } from '../test-support/strip-comments';
import {
  ALLOW_LIST_SECTIONS,
  NO_RELEASED_VALUE,
  SESSION_TERMINAL_STATUS_READERS,
} from './session-terminal-status-readers.allowed';

/**
 * Plan step 0.5 of docs/session-three-state-plan.md: while every reader moves off the session's
 * terminal status values, no NEW reader of the old vocabulary may appear. The readers of today are
 * inventoried in docs/session-three-state-read-sites.md; the files among them that this scan sees
 * are listed, with how many hits each has, in session-terminal-status-readers.allowed.ts. A listed
 * file may fall below its number but never rise above it, and a file that is not listed must have
 * none — so a later phase shrinks the list by lowering numbers and deleting rows. The same shape as
 * src/web/src/copyLanguage.test.ts.
 *
 * Read: every .ts and .tsx file under src/apiserver/src, src/shared/src and src/web/src, except
 * tests (.spec / .test), fixtures, test-support and __tests__. Migrations live outside those roots.
 * Comments are stripped first, so a comment naming a status is not a reader.
 *
 * One hit is either of:
 *
 * (a) A terminal member of a session status enum, named through the enum: `RunStatus.SUCCEEDED`,
 *     `.FAILED`, `.CANCELLED`, `.INTERRUPTED` (also through `$Enums.` / `Prisma.` and through an
 *     import alias such as `RunStatus as SharedRunStatus`); `SessionRunState.SUCCEEDED`, `.FAILED`,
 *     `.ENDED`; `SessionState.COMPLETED`, `.FAILED`, `.CANCELLED`, `.DORMANT`, `.ENDED`, `.DELETED`.
 *     `SessionRunState.INTERRUPTED` is not counted: that enum documents it as not terminal.
 * (b) A hand-written status set: a `[...]` list (array, Prisma `in:`, SQL `ARRAY[...]`) or an SQL
 *     `IN (...)` list of two or more items, every item a quoted status word or an enum member as in
 *     (a), that is recognisably a SESSION set: it names `RunStatus.` / `SessionRunState.` /
 *     `SessionState.` members, or casts to `run_status`, or its bare words are all session words
 *     (PENDING RUNNING SUCCEEDED FAILED CANCELLED AWAITING_INPUT INTERRUPTED QUEUED ENDED DORMANT
 *     COMPLETED DELETED) and include one only a session has (AWAITING_INPUT, INTERRUPTED, DORMANT)
 *     or both SUCCEEDED and CANCELLED. A list counts once, on top of any (a) hits inside it.
 *
 * What it does NOT catch, because the spelling cannot be told from another enum's:
 * - a bare comparison such as `status === 'SUCCEEDED'` or a `case 'FAILED':` label;
 * - a set of bare words a Task, a job or a schedule run could also mean, such as
 *   `['FAILED', 'CANCELLED']` or `['SUCCEEDED', 'FAILED']`, and a string union type;
 * - a set built by spreading another (`[...LIVE, 'X']`), or one with an interpolated item;
 * - Swift, Kotlin, Go and SQL files: the Apple, Android and runner clients and the migrations.
 *
 * Plan step 4.8 split the allow-list into sections (its header says which and why) and added a second reading of each
 * file: whether it names a RELEASED value, a hit of (a) whose member is released (`RunStatus.SUCCEEDED`, `.FAILED`,
 * `.CANCELLED`; `SessionRunState.SUCCEEDED`, `.FAILED`, `.ENDED`; `SessionState.COMPLETED`, `.FAILED`, `.CANCELLED`,
 * `.DORMANT`, `.ENDED`, `.DELETED`) or a set of (b) with a released member (those, or the bare words SUCCEEDED,
 * FAILED, CANCELLED, ENDED, COMPLETED, DORMANT, DELETED). Exactly the files of the sections that may decide from a
 * terminal value name one. It does not see a spread of an exported set either (`[...RELEASED_SESSION_STATUSES]`).
 */

const REPO = path.resolve(__dirname, '../../../..');

const ROOTS = ['src/apiserver/src', 'src/shared/src', 'src/web/src'];
const SKIP_DIRS = new Set(['node_modules', 'build', 'dist', 'test-support', '__tests__', '__fixtures__']);
const SOURCE = /\.tsx?$/;
const NOT_PRODUCT = /(\.(test|spec)\.tsx?|\.fixtures?\.tsx?)$/;

const TERMINAL_MEMBERS: Record<string, readonly string[]> = {
  RunStatus: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED'],
  SessionRunState: ['SUCCEEDED', 'FAILED', 'ENDED'],
  SessionState: ['COMPLETED', 'FAILED', 'CANCELLED', 'DORMANT', 'ENDED', 'DELETED'],
};
const SESSION_WORDS = new Set([
  'PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'AWAITING_INPUT', 'INTERRUPTED',
  'QUEUED', 'ENDED', 'DORMANT', 'COMPLETED', 'DELETED',
]);
const SESSION_ONLY = new Set(['AWAITING_INPUT', 'INTERRUPTED', 'DORMANT']);
const RELEASED_MEMBERS: Record<string, readonly string[]> = {
  RunStatus: ['SUCCEEDED', 'FAILED', 'CANCELLED'],
  SessionRunState: ['SUCCEEDED', 'FAILED', 'ENDED'],
  SessionState: ['COMPLETED', 'FAILED', 'CANCELLED', 'DORMANT', 'ENDED', 'DELETED'],
};
const RELEASED_WORDS = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'ENDED', 'COMPLETED', 'DORMANT', 'DELETED']);

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) sources(relative, found);
    } else if (entry.isFile() && SOURCE.test(entry.name) && !NOT_PRODUCT.test(entry.name)) {
      found.push(relative);
    }
  }
  return found;
}

/** Names this file gives a session status enum: the enum's own name and any import alias of it. */
function enumNames(code: string): Map<string, string> {
  const names = new Map<string, string>(Object.keys(TERMINAL_MEMBERS).map((name) => [name, name]));
  for (const m of code.matchAll(/\b(RunStatus|SessionRunState|SessionState)\s+as\s+([A-Za-z_$][\w$]*)/g)) {
    names.set(m[2], m[1]);
  }
  return names;
}

const ITEM_ENUM = /^(?:(?:\$Enums|Prisma)\s*\.\s*)?([A-Za-z_$][\w$]*)\s*\.\s*([A-Z_]+)$/;
const ITEM_WORD = /^(['"])([A-Z_]+)\1(\s*::\s*"?(\w+)"?)?$/;

function setItems(body: string): string[] {
  const items = body.split(',').map((item) => item.trim());
  if (items[items.length - 1] === '') items.pop();
  return items;
}

/** Whether a session set (isSessionSet) has a released member, through an enum or as a bare word. */
function hasReleasedMember(body: string, names: Map<string, string>): boolean {
  return setItems(body).some((item) => {
    const member = ITEM_ENUM.exec(item);
    const real = member ? names.get(member[1]) : undefined;
    if (member && real) return RELEASED_MEMBERS[real].includes(member[2]);
    const word = ITEM_WORD.exec(item);
    return word !== null && RELEASED_WORDS.has(word[2]);
  });
}

function isSessionSet(body: string, names: Map<string, string>): boolean {
  const items = body.split(',').map((item) => item.trim());
  if (items[items.length - 1] === '') items.pop();
  if (items.length < 2) return false;
  let viaEnum = false;
  let cast = false;
  const words: string[] = [];
  for (const item of items) {
    const member = ITEM_ENUM.exec(item);
    if (member && names.has(member[1])) {
      viaEnum = true;
      continue;
    }
    const word = ITEM_WORD.exec(item);
    if (!word || !SESSION_WORDS.has(word[2])) return false;
    if (word[4] === 'run_status') cast = true;
    words.push(word[2]);
  }
  if (viaEnum || cast) return true;
  return words.some((w) => SESSION_ONLY.has(w)) || (words.includes('SUCCEEDED') && words.includes('CANCELLED'));
}

/** The hits of (a) and (b) above the file holds, and how many of them name a released value. */
function readHits(text: string): { count: number; released: number } {
  const code = stripComments(text);
  const names = enumNames(code);
  let count = 0;
  let released = 0;
  for (const m of code.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)\s*\.\s*([A-Z_]+)\b/g)) {
    const real = names.get(m[1]);
    if (real && TERMINAL_MEMBERS[real].includes(m[2])) {
      count += 1;
      if (RELEASED_MEMBERS[real].includes(m[2])) released += 1;
    }
  }
  const sets = [...code.matchAll(/\[([^[\]]*)\]/g), ...code.matchAll(/\bIN\s*\(([^()]*)\)/gi)];
  for (const m of sets) {
    if (!isSessionSet(m[1], names)) continue;
    count += 1;
    if (hasReleasedMember(m[1], names)) released += 1;
  }
  return { count, released };
}

/** How many hits of (a) and (b) above the file holds. */
export function countReaders(text: string): number {
  return readHits(text).count;
}

/** How many of those hits name a released value: a released enum member, or a session set with a released member. */
export function countReleasedValues(text: string): number {
  return readHits(text).released;
}

test('the lexer and the counter read what the header says they read', () => {
  assert.equal(countReaders('if (s.status === RunStatus.SUCCEEDED) {}'), 1);
  assert.equal(countReaders('// RunStatus.SUCCEEDED\n/* RunStatus.FAILED */ const x = 1;'), 0);
  assert.equal(countReaders('x === $Enums.RunStatus.CANCELLED'), 1);
  assert.equal(countReaders("import { RunStatus as R } from 'x'; R.INTERRUPTED"), 1);
  assert.equal(countReaders('RunStatus.RUNNING; RunStatus.PENDING; SessionRunState.INTERRUPTED'), 0);
  assert.equal(countReaders('SubagentRunStatus.FAILED; TaskStatus.FAILED'), 0);
  assert.equal(countReaders("const LIVE = ['PENDING', 'RUNNING', 'AWAITING_INPUT', 'INTERRUPTED'];"), 1);
  assert.equal(countReaders('const LIVE = [RunStatus.PENDING, RunStatus.RUNNING];'), 1);
  assert.equal(countReaders("sql`WHERE s.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED')`"), 1);
  assert.equal(countReaders("sql`WHERE s.status IN ('PENDING'::run_status, 'RUNNING'::run_status)`"), 1);
  assert.equal(countReaders("['DONE', 'CANCELLED', 'FAILED']; ['SUCCEEDED', 'FAILED']; ['FAILED', 'CANCELLED']"), 0);
  assert.equal(countReaders("const r = /['`]/; const s = 'it\\'s'; RunStatus.FAILED"), 1);
  assert.equal(countReaders('const t = `a ${`b ${RunStatus.FAILED}`} c // not a comment`; RunStatus.FAILED'), 2);
});

test('a released value is told from a hit that names none', () => {
  assert.equal(countReleasedValues('if (s.status === RunStatus.SUCCEEDED) {}'), 1);
  assert.equal(countReleasedValues('x === RunStatus.INTERRUPTED; [RunStatus.PENDING, RunStatus.RUNNING]'), 0);
  assert.equal(countReleasedValues("const IDLE = ['AWAITING_INPUT', 'INTERRUPTED'];"), 0);
  assert.equal(countReleasedValues("sql`WHERE s.status IN ('PENDING'::run_status, 'CANCELLED'::run_status)`"), 1);
  assert.equal(countReleasedValues('[SessionRunState.QUEUED, SessionRunState.ENDED]; SessionState.DORMANT'), 3);
  assert.equal(countReleasedValues("['DONE', 'CANCELLED', 'FAILED']"), 0);
});

test('no new reader of a terminal session status outside the allow-list', () => {
  const files = ROOTS.flatMap((root) => sources(root));
  assert.ok(files.length > 500, `the scan found only ${files.length} files: is REPO (${REPO}) the repository root?`);

  const problems: string[] = [];
  for (const file of files) {
    const has = countReaders(readFileSync(path.join(REPO, file), 'utf8'));
    const had = SESSION_TERMINAL_STATUS_READERS[file] ?? 0;
    if (has > had) {
      problems.push(
        `${file}: allowed ${had}, has ${has} — a terminal session status named through its enum, or a hand-written ` +
          'session status set. Read docs/session-three-state-plan.md and use the one definition it points to ' +
          'instead; do not raise the number in session-terminal-status-readers.allowed.ts.',
      );
    }
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}\n`);
});

test('a released value is named only by the release writers, the projector, the old protocol and the client decoder', () => {
  // Plan step 4.8: the sections of the allow-list that may decide from a terminal value are exactly the files that
  // name a released one. A file only in NO_RELEASED_VALUE names none, so a released value slipping into one fails
  // here even when its count does not rise; a file in another section names one, or it belongs in NO_RELEASED_VALUE.
  const files = ROOTS.flatMap((root) => sources(root));
  const mayName = new Set(
    Object.entries(ALLOW_LIST_SECTIONS)
      .filter(([name]) => name !== 'NO_RELEASED_VALUE')
      .flatMap(([, section]) => Object.keys(section)),
  );
  const problems: string[] = [];
  for (const file of Object.keys(SESSION_TERMINAL_STATUS_READERS)) {
    if (!files.includes(file)) problems.push(`${file}: listed, but not a product file the scan reads`);
  }
  for (const file of files) {
    const names = countReleasedValues(readFileSync(path.join(REPO, file), 'utf8')) > 0;
    if (names && !mayName.has(file)) {
      problems.push(
        `${file}: names a released session status value (SUCCEEDED, FAILED, CANCELLED, ENDED, COMPLETED, DORMANT, ` +
          'DELETED) but is no release writer, the projector, the old protocol or the client decoder. Ask the release module by its questions instead (common/session-release.ts: isReleased, ' +
          'releaseWasFailure, releaseFinishedTheWork).',
      );
    } else if (!names && mayName.has(file)) {
      problems.push(
        `${file}: listed as a section that names a released value, but names none: lower its row` +
          (file in NO_RELEASED_VALUE ? '' : ', or move it to NO_RELEASED_VALUE'),
      );
    }
  }
  assert.deepEqual(problems, [], `\n${problems.join('\n')}\n`);
});
