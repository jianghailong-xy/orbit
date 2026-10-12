import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { WikiDocMaterialRecord, WikiRepoFileRead } from '@orbit/shared';

import { WikiDocsSnapshotRepo } from './wiki-docs-build-job';
import {
  wikiDocApplyMerge,
  wikiDocBodyOf,
  wikiDocDispositions,
  wikiDocEndOnlyNote,
  wikiDocEndOnlyParagraphs,
  wikiDocFactTokens,
  wikiDocFilter,
  wikiDocFingerprint,
  wikiDocFootnotes,
  wikiDocFootnoteWire,
  wikiDocHanded,
  wikiDocLocate,
  wikiDocMergePrompt,
  wikiDocOverviewFingerprint,
  wikiDocOverviewFootnotes,
  wikiDocOverviewMaterial,
  wikiDocOverviewPrompt,
  wikiDocParseQuotes,
  wikiDocParseWritten,
  wikiDocPiece,
  wikiDocQuoteRepairPrompt,
  wikiDocRepoPieces,
  wikiDocSelect,
  wikiDocSentences,
  wikiDocStripHeading,
  wikiDocUnfoundCitations,
  wikiDocWritePrompt,
  type WikiDocPiece,
  type WikiDocsPlanDoc,
  type WikiDocWrittenSection,
} from './wiki-docs-writer';

/**
 * One input, one deterministic answer on both paths (project criterion: "the deterministic results agree on the
 * old path and the new"): `src/shared/src/wiki-docs-build.fixture.json` holds what the runner's Go code
 * (src/runner-go/wiki_docs_build.go) makes of a confirmed document's sections on a checkout of the fixture's files —
 * the material, the filter and the cap, the fingerprint, the prompts, a scripted merge and draft as read, the
 * footnotes with their quotes found in the files, the quote repair and the rewrite asked for, the ledger and the
 * overview — and of a quote's lines, a line's sentences and a sentence's fact tokens. This holds the server's port
 * to the same bytes, step for step in the order the build takes them. The Go side holds itself to the same file
 * (wiki_docs_build_fixture_test.go), and writes it.
 *
 * The fingerprint matters most: a section whose stored fingerprint is the one its material gives is not written
 * again, so a space moved from the runner's build to the server's keeps every section the runner wrote.
 */

// From build/wiki-worker back to src/shared.
const FIXTURE = JSON.parse(readFileSync(path.resolve(__dirname, '../../../shared/src/wiki-docs-build.fixture.json'), 'utf8')) as {
  sha: string;
  files: Record<string, string>;
  doc: Record<string, unknown>;
  records: Record<string, Array<{ kind: string; ref: string; weight: string; ownerWords: boolean; text: string; via: { entryId: string; title: string; kind: string } | null }>>;
  answers: { merge: Record<string, string>; write: Record<string, string[]>; repair: Record<string, string>; overview: string };
  sections: Array<{
    key: string;
    pieces: unknown[];
    missing: string[];
    selected: unknown[];
    fingerprint: string;
    mergePrompt: string;
    state: string[];
    merged: unknown[];
    writePrompt: string;
    lonely: string[];
    againPrompt: string;
    body: string;
    quotes: Record<string, string[]>;
    unfound: string[];
    repairPrompt: string;
    markdown: string;
    footnotes: unknown[];
    counts: Record<string, number>;
    dispositions: unknown[];
  }>;
  overview: { key: string; fingerprint: string; sections: string[]; notes: Array<{ id: string; footnote: unknown }>; prompt: string; markdown: string; footnotes: unknown[] };
  locate: Array<{ path: string; quote: string; within: { start: number; end: number } | null; found: { start: number; end: number } | null }>;
  sentences: Array<{ line: string; sentences: string[] }>;
  factTokens: Array<{ sentence: string; tokens: string[] }>;
};

/**
 * The fixture's files at its commit, as the build's reader shows them (`WikiDocsSnapshotRepo`): their sizes from the
 * snapshot, their text from a read, and a path that is no file of the commit as `git show <sha>:<path>` shows it.
 */
const sizes = new Map(Object.entries(FIXTURE.files).map(([file, text]) => [file, Buffer.byteLength(text, 'utf8')]));
const repo = new WikiDocsSnapshotRepo(
  FIXTURE.sha,
  sizes,
  [...sizes.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
  async (wanted) => new Map(wanted.map((file): [string, WikiRepoFileRead] => [file, { path: file, state: 'found', text: FIXTURE.files[file], sizeBytes: sizes.get(file) ?? 0 }])),
);

/** The document as the runner decodes the plan read (`wikiDocsPlanDoc`). */
const doc = FIXTURE.doc as unknown as WikiDocsPlanDoc;

/** A record as the material read hands it out, with only what the fixture names set. */
function recordOf(item: (typeof FIXTURE.records)[string][number]): WikiDocMaterialRecord {
  const length = Array.from(item.text).length;
  return {
    kind: item.kind, ref: item.ref, found: 'search', via: item.via, weight: item.weight, ownerWords: item.ownerWords, label: null, at: null,
    sessionId: null, sessionTitle: null, taskId: null, taskTitle: null, projectId: null, projectTitle: null, notePath: null,
    text: item.text, chars: { start: 0, end: length }, length,
  } as unknown as WikiDocMaterialRecord;
}

/** A piece in the fixture's shape (`wikiDocsBuildFixturePiece`). */
function shaped(pieces: readonly WikiDocPiece[]): unknown[] {
  return pieces.map((p) => ({
    id: p.id, kind: p.kind, path: p.path, lines: p.lines, section: p.section, symbol: p.symbol, ref: p.ref, chars: p.chars,
    text: p.text, action: p.action, into: p.into, reason: p.reason, handed: p.handed,
  }));
}

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

test('each section comes out of the server\'s writer exactly as it comes out of the runner\'s, step for step', async () => {
  await repo.prepare(Object.keys(FIXTURE.files));
  const written: Array<WikiDocWrittenSection | null> = doc.sections.map(() => null);
  const fingerprints: string[] = doc.sections.map(() => '');
  let at = 0;
  doc.sections.forEach((planSection, i) => {
    if (planSection.kind === 'overview') return;
    const want = FIXTURE.sections[at];
    at += 1;
    const label = `section ${planSection.key}`;
    assert.equal(want.key, planSection.key);
    const { pieces, missing } = wikiDocRepoPieces(repo, planSection);
    (FIXTURE.records[planSection.key] ?? []).forEach((item, n) => {
      const record = recordOf(item);
      pieces.push(wikiDocPiece({ id: `S${n + 1}`, kind: item.kind, ref: item.ref, chars: { ...record.chars }, text: item.text, record }));
    });
    assert.deepEqual(plain(shaped(pieces)), want.pieces, `${label}: the material gathered`);
    assert.deepEqual(missing, want.missing, `${label}: what the commit does not have`);
    wikiDocFilter(pieces);
    wikiDocSelect(planSection.kind, pieces);
    assert.deepEqual(plain(shaped(pieces)), want.selected, `${label}: the filter and the cap`);
    const fingerprint = wikiDocFingerprint(planSection, pieces);
    assert.equal(fingerprint, want.fingerprint, `${label}: the fingerprint`);
    const handed = wikiDocHanded(pieces);
    let state: string[] = [];
    if (handed.length > 0) {
      assert.equal(wikiDocMergePrompt(doc, i, handed), want.mergePrompt, `${label}: the merge prompt`);
      state = wikiDocApplyMerge(FIXTURE.answers.merge[planSection.key] ?? '', pieces);
    } else {
      assert.equal(want.mergePrompt, '', `${label}: no merge`);
    }
    assert.deepEqual(state, want.state, `${label}: the state the merge wrote`);
    assert.deepEqual(plain(shaped(pieces)), want.merged, `${label}: what became of each piece`);
    const used = pieces.filter((piece) => piece.action === 'adopt' || piece.action === 'merge');
    const writePrompt = wikiDocWritePrompt(doc, i, state, used);
    assert.equal(writePrompt, want.writePrompt, `${label}: the write prompt`);
    const answers = FIXTURE.answers.write[planSection.key];
    let draft = wikiDocParseWritten(answers[0]);
    const lonely = wikiDocEndOnlyParagraphs(draft.body);
    assert.deepEqual(lonely, want.lonely, `${label}: the paragraphs marked only at their end`);
    if (lonely.length > 0) {
      assert.equal(writePrompt + wikiDocEndOnlyNote(lonely), want.againPrompt, `${label}: the rewrite asked for`);
      const retry = wikiDocParseWritten(answers[1] ?? '');
      if (retry.body !== '' && wikiDocEndOnlyParagraphs(retry.body).length < lonely.length) draft = retry;
    } else {
      assert.equal(want.againPrompt, '');
    }
    let footnoted = wikiDocFootnotes(repo, draft, used);
    const unfound = wikiDocUnfoundCitations(draft, footnoted.section, used);
    assert.deepEqual(unfound, want.unfound, `${label}: the citations with no quote that holds`);
    if (unfound.length > 0) {
      assert.equal(wikiDocQuoteRepairPrompt(draft, unfound, used), want.repairPrompt, `${label}: the quote repair`);
      for (const [id, quotes] of wikiDocParseQuotes(FIXTURE.answers.repair[planSection.key] ?? '')) draft.quotes.set(id, [...quotes, ...(draft.quotes.get(id) ?? [])]);
      footnoted = wikiDocFootnotes(repo, draft, used);
    } else {
      assert.equal(want.repairPrompt, '');
    }
    assert.equal(draft.body, want.body, `${label}: the draft's body`);
    assert.deepEqual(Object.fromEntries(draft.quotes), want.quotes, `${label}: the draft's quotes`);
    assert.equal(footnoted.section.markdown, want.markdown, `${label}: the section's markdown`);
    assert.deepEqual(plain(footnoted.section.footnotes.map((footnote) => wikiDocFootnoteWire(footnote))), want.footnotes, `${label}: its footnotes`);
    assert.deepEqual(footnoted.counts, want.counts, `${label}: the footnotes found`);
    assert.deepEqual(plain(wikiDocDispositions(pieces)), plain(want.dispositions), `${label}: the ledger`);
    written[i] = footnoted.section;
    fingerprints[i] = fingerprint;
  });
  assert.equal(at, FIXTURE.sections.length);

  // The overview, last, from the sections as written.
  const overview = FIXTURE.overview;
  assert.equal(doc.sections[0].key, overview.key);
  assert.equal(wikiDocOverviewFingerprint(doc.sections[0], doc, 0, fingerprints), overview.fingerprint, 'the overview\'s fingerprint');
  const material = wikiDocOverviewMaterial(doc, 0, written, null);
  assert.deepEqual(material.sections, overview.sections);
  assert.deepEqual(plain(material.notes.map((note) => ({ id: note.id, footnote: wikiDocFootnoteWire(note.footnote) }))), overview.notes);
  assert.equal(wikiDocOverviewPrompt(doc, 0, material.sections, material.notes), overview.prompt, 'the overview prompt');
  const done = wikiDocOverviewFootnotes(repo, wikiDocStripHeading(wikiDocBodyOf(FIXTURE.answers.overview)), material.notes);
  assert.equal(done.markdown, overview.markdown);
  assert.deepEqual(plain(done.footnotes.map((footnote) => wikiDocFootnoteWire(footnote))), overview.footnotes);
});

test('a quote\'s lines, a line\'s sentences and a sentence\'s fact tokens are the runner\'s', () => {
  for (const c of FIXTURE.locate) {
    assert.deepEqual(wikiDocLocate(FIXTURE.files[c.path], c.quote, c.within), c.found, `${c.path}: ${c.quote}`);
  }
  for (const c of FIXTURE.sentences) assert.deepEqual(wikiDocSentences(c.line), c.sentences, c.line);
  for (const c of FIXTURE.factTokens) assert.deepEqual(wikiDocFactTokens(c.sentence), c.tokens, c.sentence);
});
