import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { WIKI_REPO_OPS } from '@orbit/shared';

import {
  wikiDocCleanPath,
  wikiDocFilter,
  wikiDocFingerprint,
  wikiDocLocate,
  wikiDocRepoPieces,
  wikiDocSelect,
  type WikiDocPiece,
  type WikiDocRepo,
  type WikiDocsPlanSection,
} from './wiki-docs-writer';

/**
 * The whole-file half of the documents build's golden fixture (owner 2026-10-08): one section and one footnote
 * quote taken from PAST the 22,000-character window of this repository's own docs/wiki-contract.md, held to
 * what src/runner-go/wiki_docs_build.go makes of the same whole file
 * (src/runner-go/wiki_docs_wholefile_fixture_test.go writes src/shared/src/wiki-docs-wholefile.fixture.json).
 *
 * WHY THIS IS A CASE OF ITS OWN. A read that answers only the first 22,000 characters finds neither the section
 * nor the quote: the server's docs build would report the section missing and the footnote unlocatable while the
 * runner's own path, which has the whole file, writes it — the two paths the project requires to agree. So both
 * sides read the real document (144,000 characters) and this holds the server's section text, its lines, what
 * survives the filter and the cap, the section's fingerprint and the two places the quote is found to the bytes
 * the Go side recorded.
 */

const ROOT = path.resolve(__dirname, '../../../..');

interface Fixture {
  source: string;
  plan: { key: string; title: string; kind: string; covers: string; length: number };
  section: string;
  sectionOffset: number;
  quoteOffset: number;
  quote: string;
  missing: string[];
  piece: Shaped;
  selected: Shaped[];
  fingerprint: string;
  located: { start: number; end: number };
  locatedWithin: { start: number; end: number };
}

interface Shaped {
  id: string;
  kind: string;
  path: string;
  lines: { start: number; end: number };
  section: string;
  symbol: string;
  ref: string;
  chars: { start: number; end: number };
  text: string;
  action: string;
  into: string;
  reason: string;
  handed: boolean;
}

const FIXTURE = JSON.parse(readFileSync(path.join(ROOT, 'src/shared/src/wiki-docs-wholefile.fixture.json'), 'utf8')) as Fixture;

/** A piece in the fixture's shape (`wikiDocsBuildFixturePiece`). */
function shaped(pieces: readonly WikiDocPiece[]): Shaped[] {
  return pieces.map((p) => ({
    id: p.id, kind: p.kind, path: p.path, lines: p.lines, section: p.section, symbol: p.symbol, ref: p.ref, chars: p.chars,
    text: p.text, action: p.action, into: p.into, reason: p.reason, handed: p.handed,
  }));
}

/** The rune offset of a 1-based line, as wikiDocLocate numbers its lines. */
function lineOffset(content: string, line: number): number {
  const lines = content.split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (i + 1 === line) return offset;
    offset += [...lines[i]].length + 1;
  }
  return offset;
}

test('a section and a footnote past the old 22,000-character window come out of the whole file as the runner makes them', () => {
  const content = readFileSync(path.join(ROOT, FIXTURE.source), 'utf8');
  const repo: WikiDocRepo = {
    sha: 'f'.repeat(40),
    show: (raw) => (wikiDocCleanPath(raw) === FIXTURE.source ? { text: content, cut: false } : null),
    under: () => [],
  };
  const plan = FIXTURE.plan;
  const section: WikiDocsPlanSection = {
    key: plan.key,
    title: plan.title,
    kind: plan.kind,
    covers: plan.covers,
    length: plan.length,
    // The code, contract and session sources are Go's nil slices (`null`), which the fingerprint's definition
    // carries as they are: an empty array is a different section definition.
    sources: { docs: [{ path: FIXTURE.source, section: FIXTURE.section }], code: null, contracts: null, sessions: null },
  };

  // The point of the fixture: a read of the first 22,000 characters of this document has neither the section
  // nor the quote in it, so a server that only ever holds that much cannot answer what the runner answers.
  assert.ok(FIXTURE.sectionOffset > WIKI_REPO_OPS.boundedChars, `the section stands at ${FIXTURE.sectionOffset}`);
  assert.ok(FIXTURE.quoteOffset > WIKI_REPO_OPS.boundedChars, `the quote stands at ${FIXTURE.quoteOffset}`);
  assert.equal(content.slice(0, FIXTURE.sectionOffset).includes(FIXTURE.section), false, 'the section is not in the old window');
  assert.equal(content.slice(0, FIXTURE.quoteOffset).includes(FIXTURE.quote), false, 'the quote is not in the old window');
  assert.ok([...content].length > WIKI_REPO_OPS.boundedChars, `${FIXTURE.source} is only ${[...content].length} characters`);

  // The material: the section cut out of the whole file, with the lines and text the Go side cut.
  const { pieces, missing } = wikiDocRepoPieces(repo, section);
  assert.deepEqual(shaped(pieces), [FIXTURE.piece], 'the section as the server cuts it out of the whole file');
  assert.deepEqual(missing, FIXTURE.missing, 'nothing of the commit is missing');
  assert.equal(pieces.length, 1);
  // The section really does come from past the window: its first line is the heading the fixture names.
  assert.equal(lineOffset(content, pieces[0].lines.start), FIXTURE.sectionOffset, 'the section starts where the fixture says');
  assert.ok(pieces[0].text.includes(FIXTURE.section), 'the piece carries the heading of its own section');

  // The cap and the filter, then the fingerprint that decides whether the section is written again — the
  // number a space moved from the runner's build to the server's keeps every section the runner wrote by.
  wikiDocFilter(pieces);
  wikiDocSelect(section.kind, pieces);
  assert.deepEqual(shaped(pieces), FIXTURE.selected, 'what survives the filter and the cap');
  assert.equal(wikiDocFingerprint(section, pieces), FIXTURE.fingerprint, 'the section\'s fingerprint');

  // The footnote's quote, found anywhere in the whole file and within the section's own lines.
  assert.deepEqual(wikiDocLocate(content, FIXTURE.quote, null), FIXTURE.located, 'the quote anywhere in the file');
  assert.deepEqual(wikiDocLocate(content, FIXTURE.quote, FIXTURE.piece.lines), FIXTURE.locatedWithin, 'the quote within the section\'s lines');
  assert.equal(lineOffset(content, FIXTURE.located.start), FIXTURE.quoteOffset, 'the quote is found where the fixture says');
});
