import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WIKI_REPO_OPS } from '@orbit/shared';

import { WikiPlanRepo, type WikiPlanSnapshotIndex } from './wiki-plan-repo';

/**
 * The plan's symbol fallback on the whole file (owner 2026-10-08, design §7). The snapshot index names a file's
 * declarations as far as a regex reads them; a symbol it does not name is looked for as a word of the file's text,
 * and the server reads that text through `read`, which now answers with the WHOLE file. This is the case that
 * separates the two: a symbol the file spells only past the old 22,000-character window, which the bounded read
 * would never have put in front of the gate — and which the runner's own path, which always had the whole file,
 * would have found. The pg spec holds the other half: the server asks the runner with no window at all.
 */

const SHA = 'a'.repeat(40);

/** The file: a symbol near its top, then more than the old window of text, then the symbol the index misses. */
const EARLY = 'export function earlyOne() {}\n';
const PADDING = `${'// a line of the file, long enough to be read past the old window.\n'.repeat(400)}`;
const LATE = 'export function lateSymbolPastTheWindow() {}\n';
const TEXT = `// src/late.ts\n${EARLY}${PADDING}${LATE}`;

function index(): WikiPlanSnapshotIndex {
  return {
    sha: SHA,
    date: '2026-10-08',
    files: [{ path: 'src/late.ts', size: Buffer.byteLength(TEXT, 'utf8') }],
    docs: [],
    // The index names what its regex read: the early declaration, and not the one past the window.
    symbols: { 'src/late.ts': ['earlyOne'] },
    contracts: [],
  };
}

test('a symbol past the old window is found in the whole file, and a read bounded to the window would miss it', () => {
  const whole = new WikiPlanRepo(index()).withTexts({ 'src/late.ts': TEXT });
  const bounded = new WikiPlanRepo(index()).withTexts({ 'src/late.ts': [...TEXT].slice(0, WIKI_REPO_OPS.boundedChars).join('') });

  // The index does not name it, so the gate has to read the file's text: that is what the job reads at the sha.
  // What the job reads at the sha before it gates: the file whose index does not name the symbol, and whose
  // text it does not hold yet.
  assert.deepEqual(new WikiPlanRepo(index()).textsWantedFor('src/late.ts', 'lateSymbolPastTheWindow'), ['src/late.ts']);
  assert.equal(new WikiPlanRepo(index()).hasSymbol('src/late.ts', 'lateSymbolPastTheWindow'), false, 'the index alone does not name it');

  assert.equal(bounded.hasSymbol('src/late.ts', 'lateSymbolPastTheWindow'), false,
    'the old window stops before the declaration, so a bounded read reports it missing');
  assert.equal(whole.hasSymbol('src/late.ts', 'lateSymbolPastTheWindow'), true,
    'the whole file has it, and that is what the server reads now');
  // The other half of the fallback is unchanged: an indexed symbol is a hit without any text.
  assert.equal(new WikiPlanRepo(index()).hasSymbol('src/late.ts', 'earlyOne'), true);
  const at = [...TEXT.slice(0, TEXT.indexOf('lateSymbolPastTheWindow'))].length;
  assert.ok(at > WIKI_REPO_OPS.boundedChars,
    `the case is only about the window if the symbol really stands past it (it stands at ${at})`);
});
