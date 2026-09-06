import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

/**
 * The frozen census list, held to the words it had before the coordinator-autonomy work began.
 *
 * WHY A SECOND FILE
 * =================
 * `projects/project-status-write-sites.spec.ts` answers "does production write `project.status`
 * anywhere other than the places on this list". That is the right question and it has one moving
 * part: THE LIST. A census whose baseline can be edited alongside the code it polices reports
 * nothing — an entry appears in the tree, the same commit appends it to the frozen array, and the
 * comparison goes on passing while the property it was written for has quietly gone.
 *
 * So this file makes the OTHER claim, and it has to be a different file to make it: the frozen
 * array is character-for-character what it was at `59f674e2`, the revision this project started
 * from. Between the two, "no write site was added by this work" is checkable by someone who was
 * not here — the sibling compares the tree against the list, this compares the list against
 * history, and neither can be satisfied by editing the other.
 *
 * WHY THE COMPARISON IS ON TEXT
 * =============================
 * The claim is about words, so the subject is the declaration exactly as it is written: its type
 * annotation, its quoting, its spacing. A comparison of PARSED entries would pass over a list
 * whose type had been widened or whose readonly-ness had been dropped, and both of those are edits
 * to how firmly the baseline is held. The parsed entries are asserted too, and only for the one
 * thing text cannot say: that the list is not empty, so the sibling's `deepEqual` is never a
 * comparison of nothing with nothing.
 *
 * WHAT THIS FILE DOES NOT CLAIM
 * =============================
 * Nothing about the tree. It never reads a production source and never decides what a write site
 * is: that is the sibling's reading, made once, and a second one here could disagree with it. What
 * it does instead — case (c) — is hold the sibling to still MAKING that reading, over every
 * production source, against this very array. A frozen baseline that nothing compares anything
 * against is a list of words.
 */

/** Resolved against the package root, not `__dirname`: this runs from `build/projects`. */
const SRC = path.resolve(__dirname, '../../src');

/** The census whose baseline this file freezes. */
const CENSUS = 'projects/project-status-write-sites.spec.ts';

/**
 * The declaration, byte for byte, as it stood at `59f674e2`.
 *
 * One entry, and it is the endpoint an owner calls. Reproduced here rather than referenced,
 * because a baseline that reads the current file to find out what the baseline is has no opinion
 * at all — the copy IS the evidence, and a reviewer checks it with `git show`.
 */
const BASELINE_DECLARATION =
  "const FROZEN_WRITE_SITES: readonly string[] = ['projects/projects.service.ts#update'];";

/** The revision the copy above was taken from, so the check a reviewer runs is written down. */
const BASELINE_REVISION = '59f674e2';

/**
 * The whole `FROZEN_WRITE_SITES` statement in a source, or `null` when it declares none.
 *
 * Anchored at the start of a line and stopping at the first line that ends the statement, so the
 * subject is one declaration rather than everything up to the next semicolon in the file.
 */
function frozenDeclaration(source: string): string | null {
  return /^const FROZEN_WRITE_SITES\b[^\n]*?;$/m.exec(source)?.[0] ?? null;
}

/** The entries a declaration names, for the one assertion text cannot make. */
function entriesOf(declaration: string): string[] {
  return [...declaration.matchAll(/'([^']*)'/g)].map((match) => match[1]!);
}

function censusSource(): string {
  return readFileSync(path.join(SRC, CENSUS), 'utf8');
}

// (a) ---------------------------------------------------------------------------------------------
test('(a) the frozen write-site list is what it was before this work started', () => {
  const declared = frozenDeclaration(censusSource());
  assert.ok(declared !== null, `${CENSUS} no longer declares a frozen write-site list at all`);
  assert.equal(
    declared,
    BASELINE_DECLARATION,
    `${CENSUS}'s frozen list differs from the one at ${BASELINE_REVISION}; a project that added a `
    + 'way to write project.status and appended it here would read exactly like this',
  );

  // The one thing the text comparison cannot say. An empty baseline agrees with an empty scan
  // result for ever, so the sibling's comparison is only worth something while this holds.
  const entries = entriesOf(declared);
  assert.ok(entries.length > 0, 'the frozen baseline is empty');
  assert.deepEqual(entries, ['projects/projects.service.ts#update']);
});

// (b) ---------------------------------------------------------------------------------------------
test('(b) the reader notices an edit to the list, and says so about the list alone', () => {
  // An entry appended — the exact shape a project that grew a status writer would leave behind.
  const grown =
    "const FROZEN_WRITE_SITES: readonly string[] = ["
    + "'projects/projects.service.ts#update', 'projects/project-wake.service.ts#settle'];";
  assert.notEqual(frozenDeclaration(grown), BASELINE_DECLARATION);
  assert.equal(entriesOf(grown).length, 2);

  // The same entry, held less firmly. A parsed comparison would call this unchanged.
  const widened = "const FROZEN_WRITE_SITES: string[] = ['projects/projects.service.ts#update'];";
  assert.notEqual(frozenDeclaration(widened), BASELINE_DECLARATION);
  assert.deepEqual(entriesOf(widened), entriesOf(BASELINE_DECLARATION));

  // And a file that declares none reads as none, rather than as some other statement in it.
  const absent = [
    '/** The frozen list used to live here. */',
    "const OTHER: readonly string[] = ['projects/projects.service.ts#update'];",
  ].join('\n');
  assert.equal(frozenDeclaration(absent), null);

  // The control that keeps the three above from being true of a reader that matches nothing.
  assert.equal(frozenDeclaration(BASELINE_DECLARATION), BASELINE_DECLARATION);
});

// (c) ---------------------------------------------------------------------------------------------
test('(c) the census still compares every production source against that list', () => {
  const census = censusSource();

  // The scan is over the tree, walked off the filesystem, and the comparison is with the frozen
  // array itself. A census that stopped scanning, or started comparing against something it had
  // just computed, would leave the baseline above frozen and meaningless.
  assert.match(census, /const found = writeSites\(sources\);/);
  assert.match(census, /const sources = productionSources\(\);/);
  assert.match(census, /assert\.deepEqual\(found, \[\.\.\.FROZEN_WRITE_SITES\]\);/);

  // Both non-emptiness guards, which is what stops the comparison degenerating.
  assert.match(census, /assert\.ok\(sources\.length > 0,/);
  assert.match(census, /assert\.ok\(found\.length > 0,/);

  // And the scan really does enumerate production sources rather than a list somebody maintains:
  // it walks directories and takes every `.ts` that is not a spec or a declaration file.
  assert.match(census, /readdirSync\(dir, \{ withFileTypes: true \}\)/);
  assert.match(census, /entry\.name\.endsWith\('\.spec\.ts'\)/);
});
