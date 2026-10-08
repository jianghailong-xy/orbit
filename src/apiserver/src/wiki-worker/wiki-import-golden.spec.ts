import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  buildWikiImportOps,
  parseWikiImportAnswer,
  wikiImportNoteGives,
  wikiImportNoteLanguage,
  wikiImportPrompt,
  wikiImportQuote,
  wikiImportRetrySuffix,
  WikiImportRepo,
  type WikiImportNote,
} from './wiki-import-extract';

/**
 * One input, one deterministic answer on both paths (project criterion: "the deterministic results — parsing,
 * gate checks — agree on the old path and the new"): `src/shared/src/wiki-import.fixture.json` holds what the
 * runner's Go code (src/runner-go/wiki_import.go) makes of a set of notes and answers — the prompt, a note's
 * language, the reading of an answer, the quote, the verify command, the ops an answer becomes, the retry
 * that names what did not hold up, a path anchor — and this holds the server's port to the same bytes. The Go
 * side holds itself to the same file (wiki_import_fixture_test.go), and writes it.
 */

// From build/wiki-worker back to src/shared.
const FIXTURE = JSON.parse(readFileSync(path.resolve(__dirname, '../../../shared/src/wiki-import.fixture.json'), 'utf8')) as {
  notes: Array<{ id: string; path: string; date: string; text: string }>;
  prompts: Array<{ note: number; prompt: string }>;
  languages: Array<{ text: string; lang: string }>;
  answers: Array<{ answer: string; entries: unknown }>;
  quotes: Array<{ note: string; quote: string; cited: string | null }>;
  commands: Array<{ note: string; command: string; gives: boolean }>;
  builds: Array<{ note: number; answer: string; built: unknown; suffix: string }>;
  paths: { root: string; name: string; files: string[]; cases: Array<{ path: string; anchor: string | null }> };
};

function noteOf(index: number): WikiImportNote {
  const note = FIXTURE.notes[index];
  return { ...note, lang: wikiImportNoteLanguage(note.text) };
}

test('the prompt is the runner\'s, byte for byte, for every note', () => {
  assert.ok(FIXTURE.prompts.length >= 5);
  for (const c of FIXTURE.prompts) assert.equal(wikiImportPrompt(noteOf(c.note)), c.prompt, FIXTURE.notes[c.note].path);
});

test("a note's language is the runner's reading of it", () => {
  for (const c of FIXTURE.languages) assert.equal(wikiImportNoteLanguage(c.text), c.lang, JSON.stringify(c.text));
});

test('an answer reads as the runner reads it, entries and all, or not at all', () => {
  for (const c of FIXTURE.answers) assert.deepEqual(parseWikiImportAnswer(c.answer), c.entries, JSON.stringify(c.answer));
});

test('a quote is cited as the runner cites it', () => {
  for (const c of FIXTURE.quotes) assert.equal(wikiImportQuote(c.note, c.quote), c.cited, JSON.stringify(c.quote));
});

test('a verify command is the note\'s exactly when the runner says it is', () => {
  for (const c of FIXTURE.commands) assert.equal(wikiImportNoteGives(c.note, c.command), c.gives, JSON.stringify(c.command));
});

test('an answer becomes the ops, problems and counts the runner makes of it, and the same retry', () => {
  for (const c of FIXTURE.builds) {
    const note = noteOf(c.note);
    const entries = parseWikiImportAnswer(c.answer);
    const built = buildWikiImportOps(entries ?? [], note, null);
    const got = {
      parsed: entries !== null,
      ops: built.ops.map((op) => op.body),
      problems: built.problems,
      principles: built.principles,
      dropped: built.dropped,
    };
    assert.deepEqual(JSON.parse(JSON.stringify(got)), c.built, c.answer.slice(0, 80));
    const suffix = entries === null || built.problems.length > 0 ? wikiImportRetrySuffix(c.answer, entries !== null, built) : '';
    assert.equal(suffix, c.suffix, `retry of ${c.answer.slice(0, 80)}`);
  }
});

test('a path anchor reads as the runner reads it, against the same tree', () => {
  const repo = new WikiImportRepo({ files: FIXTURE.paths.files, commits: [] }, FIXTURE.paths.root, FIXTURE.paths.name);
  for (const c of FIXTURE.paths.cases) assert.equal(repo.path(c.path), c.anchor, JSON.stringify(c.path));
});
