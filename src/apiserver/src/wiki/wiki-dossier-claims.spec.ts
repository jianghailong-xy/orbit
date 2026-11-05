import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { wikiEstimateTokens, WIKI_MAINTENANCE_JOB } from '@orbit/shared';

import { parseWikiImportAnswer } from '../wiki-worker/wiki-import-extract';
import {
  buildWikiMaintainOps,
  wikiMaintainCheckClaims,
  wikiMaintainCiteShownBy,
  wikiMaintainClaimsPrompt,
  wikiMaintainLines,
  wikiMaintainNoteAnswers,
  wikiMaintainPrompt,
  type WikiMaintainRepoGate,
} from '../wiki-worker/wiki-maintain';
import {
  buildDossier,
  dossierHash,
  wikiClaimsHeldOut,
  WIKI_DOSSIER_CLAIMS,
  type DossierEventRow,
  type DossierImportedNote,
  type DossierMemoryWrite,
  type DossierReader,
  type DossierRecords,
} from './wiki-dossier';

/**
 * The pass that only checks the agent's notes (docs/wiki-memory-claims-design.md §3.1, §6.2), from records held in
 * memory: what counts as a write, what is skipped, the caps, the budget, the evidence, that nothing can cite a note,
 * and what the pass keeps of an answer. The reads of real rows are `wiki-dossier.pg.spec.ts`'s.
 *
 * Off is the promise everything else stands on, so the bytes are pinned: the digests below were read from the code
 * as it was before the switch existed, on these same records (commit 47ae19fbb).
 */

const GOLDEN_OFF = {
  textSha256: 'd3b5e8c5e62c99ca531a13861c079ea6390fc2a1ddb1627986da66fe3bc74259',
  hash: '9faf849c416400af26ee4b36c1d66855f6cae9fff34f04209970d3669a1237d5',
  promptSha256: 'fe990d5ef312e5648e3f50bb43096b3538509279cde8081598e219f28e0a0ed5',
};

const LIBRARY = '/root/.claude/projects/-root-orbit/memory';
const moment = (minute: number, second = 0): Date => new Date(Date.UTC(2026, 9, 10, 9, minute, second));
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A session's records as `loadDossierRecords` hands them over, one append at a time. */
class Records {
  readonly events: DossierEventRow[] = [];
  readonly turns: DossierRecords['turns'] = [];
  readonly calls: Array<{ id: string; toolUseId: string; name: string; input: unknown; output: unknown }> = [];
  readonly wikiNotes: NonNullable<DossierRecords['wikiNotes']> = [];
  private next = 1;

  constructor(readonly sessionId = '00000000-0000-4000-8000-000000000001') {}

  private id(): string {
    const n = this.next;
    this.next += 1;
    return `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
  }

  private row(type: string, at: Date, over: Partial<DossierEventRow>): DossierEventRow {
    return {
      id: this.id(), seq: this.next, type, createdAt: at, text: null, parentToolUseId: null, toolUseId: null, toolName: null, command: null,
      filePath: null, filePathKey: null, pattern: null, background: null, input: null, resultOf: null, isError: null, resultHead: null,
      resultTail: null, bgCommand: null, bgStatus: null, bgExit: null, bgSummary: null, errorMessage: null, subtype: null, ...over,
    };
  }

  owner(content: string, at: Date): this {
    this.turns.push({ id: this.id(), seq: this.turns.length + 1, kind: 'message', clientTurnId: `00000000-0000-4000-A000-${String(this.next).padStart(12, '0')}`, sendIntent: 'NEXT_TURN', content, createdAt: at });
    return this;
  }

  text(type: 'assistant' | 'thinking', text: string, at: Date): this {
    this.events.push(this.row(type, at, { text }));
    return this;
  }

  /** A tool call as the SQL reads it: its input's columns, its result's first 1,200 and last 600 characters, and its row. */
  tool(name: string, input: Record<string, unknown>, output: string, at: Date, over: { isError?: boolean } = {}): string {
    const toolUseId = `toolu_${this.next}`;
    const path = (input.file_path ?? input.path) as string | undefined;
    const use = this.row('tool_use', at, {
      toolUseId, toolName: name,
      command: (input.command as string | undefined) ?? null,
      filePath: path ?? null,
      filePathKey: path ? 'file_path' : null,
      input: ['Bash', 'Read', 'Edit', 'Write', 'MultiEdit'].includes(name) ? null : JSON.stringify(input),
      memoryWrite: this.memoryWriteOf(name, input),
    });
    this.events.push(use);
    this.events.push(this.row('tool_result', at, {
      resultOf: toolUseId, isError: over.isError ? 'true' : 'false',
      resultHead: output.slice(0, 1200),
      resultTail: output.length > 1200 ? output.slice(-600) : null,
    }));
    this.calls.push({ id: this.id(), toolUseId, name, input, output });
    return use.id;
  }

  private memoryWriteOf(name: string, input: Record<string, unknown>): DossierMemoryWrite | null {
    if (!['Write', 'Edit', 'MultiEdit'].includes(name) || !/\/projects\/[^/]+\/memory\/[^/]+\.md$/u.test(String(input.file_path))) return null;
    const cut = (value: unknown) => (typeof value === 'string' ? value.slice(0, WIKI_DOSSIER_CLAIMS.bodyMaxChars) : null);
    return { content: cut(input.content), oldString: cut(input.old_string), newString: cut(input.new_string), edits: input.edits ?? null };
  }

  write(file: string, content: string, at: Date, over: { isError?: boolean } = {}): string {
    return this.tool('Write', { file_path: `${LIBRARY}/${file}`, content }, 'File created', at, over);
  }

  edit(file: string, before: string, after: string, at: Date): string {
    return this.tool('Edit', { file_path: `${LIBRARY}/${file}`, old_string: before, new_string: after }, 'File updated', at);
  }

  /** A `wiki_note` as its row reads: what the session filed, apart from any call that filed it. */
  note(text: string, at: Date): string {
    const id = this.id();
    this.wikiNotes.push({ id, text, createdAt: at });
    return id;
  }

  records(): DossierRecords {
    return {
      session: { id: this.sessionId, title: 'a session', provider: 'claude', model: 'claude-opus-5', status: 'SUCCEEDED', createdAt: moment(0), taskId: null, parentSessionId: null, dispatchOrigin: 'USER' },
      turns: this.turns, approvals: [], events: this.events,
      toolCallIds: new Map(this.calls.map((call) => [call.toolUseId, call.id])),
      task: null, comments: [], receipts: [], blockers: [], tainted: false,
      ...(this.wikiNotes.length > 0 ? { wikiNotes: this.wikiNotes } : {}),
    };
  }

  /** The reads `buildDossier` makes through its reader, answered from the rows above as the SQL answers them. */
  reader(): DossierReader {
    const { calls } = this;
    const queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
      const sql = strings.join('?');
      if (sql.includes('"tool_use_id" AS "toolUseId", c."output"')) {
        const words = values.find((value) => Array.isArray(value) && !value.includes('Write')) as string[];
        return calls
          .filter((call) => !['Write', 'Edit', 'MultiEdit'].includes(call.name) && words.some((word) => JSON.stringify(call.output).includes(word)))
          .sort((a, b) => (a.id < b.id ? 1 : -1))
          .map((call) => ({ toolUseId: call.toolUseId, output: call.output }));
      }
      if (sql.includes('FROM "tool_call" c')) {
        const ids = values.find(Array.isArray) as string[];
        return calls.filter((call) => ids.includes(call.id));
      }
      return [];
    };
    return { $queryRaw: queryRaw } as unknown as DossierReader;
  }
}

const LITERALS = ['workspace-env-value-1234'];

function build(records: Records, options: { claims?: boolean; maxTokens?: number; notes?: readonly DossierImportedNote[] } = {}) {
  return buildDossier(records.reader(), records.records(), { literals: LITERALS, ...options });
}

/** An imported note as `wiki_note` keeps it: the whole file, its frontmatter included. */
function imported(id: string, path: string, body: string, type = 'project'): DossierImportedNote {
  return { id, path, text: `---\noriginSessionId: abc\ntype: ${type}\n---\n\n${body}\n` };
}

/** The session the golden digests are of: a memory read and writes among the lines a dossier always made, long enough to be cut. */
function goldenSession(): Records {
  const s = new Records();
  s.owner('Never hard-code the port in a fixture.', moment(1));
  s.text('assistant', 'I will read the fixture first.', moment(2));
  s.tool('Read', { file_path: 'src/api/test/storage-fixture.ts' }, 'export function fixture() {}', moment(3));
  s.tool('Read', { file_path: `${LIBRARY}/old-note.md` }, 'an old note', moment(4));
  s.text('thinking', 'Planning. It turns out STORAGE_PORT is read at import, before the fixture sets it. Moving on.', moment(5));
  s.tool('Bash', { command: 'npm test -w api -- upload.spec.ts' }, 'Exit code 1\nError: connect ECONNREFUSED 127.0.0.1:9000', moment(6), { isError: true });
  s.tool('Edit', { file_path: 'src/api/test/storage-fixture.ts', old_string: 'a', new_string: 'b' }, 'File updated', moment(7));
  s.tool('Bash', { command: 'npm test -w api -- upload.spec.ts' }, `# pass 14\n${'ok line\n'.repeat(400)}# fail 0`, moment(8));
  s.write('storage-port.md', '---\nname: storage-port\nmetadata:\n  type: feedback\n---\n\nSTORAGE_PORT is read at import in `storage-fixture.ts`.\n', moment(9));
  s.edit('storage-port.md', 'old words', 'old words\nThe fixture has to return the url instead of a port number.', moment(10));
  s.tool('Write', { file_path: `${LIBRARY}/MEMORY.md`, content: '- [Storage port](storage-port.md) — read at import' }, 'File updated', moment(11));
  for (let n = 0; n < 40; n += 1) {
    s.text('assistant', `Reply ${n}: actually the reason is subtle. ${'consectetur adipiscing elit '.repeat(40)}`, moment(12, n));
    s.owner(`Owner message ${n}: always keep it short. ${'lorem ipsum dolor sit amet '.repeat(30)}`, moment(13, n));
  }
  s.text('assistant', 'Done: the fixture returns the url.', moment(20));
  return s;
}

const CONTEXT = { title: 'orbit', repo: { urlNorm: 'github.com/acme/app' }, topics: [{ slug: 'testing', title: 'Testing', description: 'Tests.' }] };

const ANCHORS: WikiMaintainRepoGate = { anchors: () => [] };

/** An entry the checks take, naming `sources`. */
function entry(title: string, sources: Array<{ ref: string; quote: string }>, note?: string): Record<string, unknown> {
  return {
    kind: 'pitfall', title, summary: 'A summary a future agent can act on.', topic: 'testing',
    trigger: { paths: [], commands: ['npm test'], errorSignature: '' }, symptom: 'It fails.', cause: 'The import.', fix: 'Return the url.',
    sources, ...(note === undefined ? {} : { note }),
  };
}

// ── Off ─────────────────────────────────────────────────────────────────────────────────────────

test('off, the dossier and the prompt are the bytes they were before the switch existed', async () => {
  const off = await build(goldenSession());
  assert.equal(sha256(off.text), GOLDEN_OFF.textSha256);
  assert.equal(off.hash, GOLDEN_OFF.hash);
  assert.equal(off.truncated, true, 'the golden session is long enough to be cut');
  assert.ok(!('claims' in off), 'and says nothing of notes');
  assert.doesNotMatch(off.text, /claim:/u);
  assert.doesNotMatch(off.text, /storage-port/u, 'a memory write is left out as it always was');

  assert.equal(sha256(wikiMaintainPrompt(CONTEXT, 'A small service.', off.text)), GOLDEN_OFF.promptSha256);
});

test('the pass on leaves the case file and its prompt the same bytes: the notes\' file is another file, from the same records', async () => {
  const s = goldenSession();
  const records = s.records();
  const file = await buildDossier(s.reader(), records, { literals: LITERALS, claims: true });
  assert.notEqual(file.text, (await build(s)).text);
  const after = await buildDossier(s.reader(), records, { literals: LITERALS });
  assert.equal(sha256(after.text), GOLDEN_OFF.textSha256);
  assert.equal(after.hash, GOLDEN_OFF.hash);
  assert.equal(sha256(wikiMaintainPrompt(CONTEXT, 'A small service.', after.text)), GOLDEN_OFF.promptSha256);
  assert.ok(!('claims' in after));
});

test('on, a session with no note to carry is the same bytes as off', async () => {
  const none = new Records();
  none.owner('Fix the port.', moment(1));
  none.tool('Bash', { command: 'npm test' }, '# pass 1', moment(2));
  const quiet = await build(none, { claims: true });
  const off = await build(none);
  assert.equal(quiet.text, off.text);
  assert.equal(quiet.hash, off.hash);
  assert.deepEqual(quiet.sources, off.sources);
  assert.deepEqual(quiet.claims, { seen: 0, notes: 0, skipped: 0, overCap: 0, heldOut: 0, lines: [] });

  const skippedOnly = new Records();
  skippedOnly.owner('Fix the port.', moment(1));
  skippedOnly.write('me.md', '---\ntype: user\n---\n\nThe owner likes short answers and works in the evening.', moment(2));
  const allSkipped = await build(skippedOnly, { claims: true });
  assert.equal(allSkipped.text, (await build(skippedOnly)).text, 'nor does a write that is skipped change a byte');
  assert.deepEqual(allSkipped.claims, { seen: 1, notes: 0, skipped: 1, overCap: 0, heldOut: 0, lines: [] });
});

// ── What counts as a write (§3.1) ───────────────────────────────────────────────────────────────

test('a write is a Write, an Edit or a MultiEdit of a memory file that did not fail, and says only what it added', async () => {
  const s = new Records();
  s.owner('Remember the port.', moment(1));
  const whole = s.write('storage-port.md', '---\nname: storage-port\ndescription: not the note\nmetadata:\n  node_type: memory\n  type: project\n---\n\nSTORAGE_PORT is read at import, before the fixture sets it.\n', moment(2));
  s.owner('And what else?', moment(3));
  const edited = s.edit('storage-port.md', 'First line stays.\nSecond line goes.', 'First line stays.\nSecond line says what really happened.', moment(4));
  const multi = s.tool('MultiEdit', {
    file_path: `${LIBRARY}/other.md`,
    edits: [{ old_string: 'keep', new_string: 'keep\nThe first edit adds this whole sentence.' }, { old_string: 'x', new_string: 'The second edit replaces x with this sentence.' }],
  }, 'ok', moment(5));
  // None of these is a note.
  s.write('failed.md', 'A write the tool refused wrote nothing at all.', moment(6), { isError: true });
  s.tool('Write', { file_path: `${LIBRARY}/MEMORY.md`, content: 'The index is not a note, whatever it says at length.' }, 'ok', moment(7));
  s.tool('Write', { file_path: 'docs/memory/notes.md', content: 'A file of a repository that happens to sit under memory/.' }, 'ok', moment(8));
  s.tool('Bash', { command: `echo 'A note by shell is not read, as design 3.1 says.' >> ${LIBRARY}/shell.md` }, 'ok', moment(9));
  s.tool('Read', { file_path: `${LIBRARY}/storage-port.md` }, 'STORAGE_PORT notes read back from the library', moment(10));

  const dossier = await build(s, { claims: true });
  const lines = dossier.text.split('\n');
  assert.deepEqual(dossier.claims?.lines, [
    { ref: 'C1', eventId: whole, file: 'storage-port.md' },
    { ref: 'C2', eventId: edited, file: 'storage-port.md' },
    { ref: 'C3', eventId: multi, file: 'other.md' },
  ]);
  assert.equal(dossier.claims?.seen, 3, 'the failed write, the index, the repository file and the shell are no writes');
  assert.ok(lines.includes('C1 claim: STORAGE_PORT is read at import, before the fixture sets it.'), 'the body, with no frontmatter');
  assert.ok(lines.includes('C2 claim: Second line says what really happened.'), 'an edit, only the lines it added');
  assert.ok(lines.includes('C3 claim: The first edit adds this whole sentence.'), 'a MultiEdit, the lines of each edit');
  assert.ok(lines.includes('    The second edit replaces x with this sentence.'), 'a note of two lines continues as any line does');
  assert.doesNotMatch(dossier.text, /not the note|whatever it says|sit under memory|by shell|A write the tool refused|read back from the library/u);
  // At its moment, between the lines around it, and numbered on its own.
  const at = (start: string) => lines.findIndex((line) => line.startsWith(start));
  assert.ok(at('L1 owner:') < at('C1 claim:') && at('C1 claim:') < at('L2 owner:') && at('L2 owner:') < at('C2 claim:'), dossier.text);
});

// ── What is skipped (§3.1) ──────────────────────────────────────────────────────────────────────

test('skipped, and counted: a user note, a hub, a write of under 20 new characters, and an edit of a user note', async () => {
  const s = new Records();
  s.owner('Go on.', moment(1));
  s.write('me.md', '---\nname: me\nmetadata:\n  type: user\n---\n\nThe owner works late and likes numbers first.', moment(2));
  s.write('flat.md', '---\nname: me\ntype: user\n---\n\nThe owner reads Chinese and writes tasks in it.', moment(3));
  s.edit('me.md', 'likes numbers first', 'likes numbers first, and then a recommendation in one line.', moment(4));
  s.write('hub.md', 'These notes moved here.\n- [One](one.md) — the first\n- [Two](two.md) — the second\n- [[three]] — the third', moment(5));
  s.edit('hub.md', '- [[three]] — the third', '- [[three]] — the third\n- [Four](four.md) — a pointer added to a hub, with a hook', moment(6));
  s.write('short.md', 'Too short to say.', moment(7));
  s.edit('typo.md', 'A long sentence about how the fixture recieves its port.', 'A long sentence about how the fixture receives its port.', moment(8));
  const kept = s.write('kept.md', 'A short note that passes, with [one link](x.md) at its end.\nRelated: [[other]]\nAnd a third line of prose.', moment(9));

  const dossier = await build(s, { claims: true });
  assert.deepEqual(dossier.claims, { seen: 8, notes: 0, skipped: 7, overCap: 0, heldOut: 0, lines: [{ ref: 'C1', eventId: kept, file: 'kept.md' }] });
  assert.doesNotMatch(dossier.text, /works late|reads Chinese|recommendation in one line|moved here|pointer added|Too short|receives/u);
  assert.match(dossier.text, /C1 claim: A short note that passes/u, 'a link in a note of prose does not make it a hub');
});

// ── The caps (§3.1) ─────────────────────────────────────────────────────────────────────────────

test('at most 6 notes of 600 characters: the feedback first, then the newest, and the rest counted', async () => {
  const s = new Records();
  s.owner('Go on.', moment(1));
  s.write('feedback-0.md', '---\ntype: feedback\n---\n\nFeedback note number zero says enough words.', moment(2));
  s.write('feedback-1.md', '---\nmetadata:\n  type: feedback\n---\n\nFeedback note number one says enough words.', moment(3));
  for (let n = 2; n < 9; n += 1) s.write(`note-${n}.md`, `An ordinary note number ${n} says enough words.`, moment(n + 2));
  s.write('long.md', `A long note: ${'word '.repeat(400)}`, moment(12));

  const dossier = await build(s, { claims: true });
  assert.equal(dossier.claims?.seen, 10);
  assert.equal(dossier.claims?.overCap, 4);
  assert.deepEqual(dossier.claims?.lines.map((line) => line.file), ['feedback-0.md', 'feedback-1.md', 'note-6.md', 'note-7.md', 'note-8.md', 'long.md'],
    'carried in time order: both feedback notes, though oldest, and the four newest of the rest');
  const long = dossier.text.split('\n').find((line) => line.startsWith('C6 claim: '))!.slice('C6 claim: '.length);
  assert.ok(long.startsWith('A long note: word word'));
  assert.match(long, /…\[\+\d+ chars\]$/u, 'a note past the cap says so');
  assert.equal(Array.from(long.replace(/…\[\+\d+ chars\]$/u, '')).length, WIKI_DOSSIER_CLAIMS.lineMaxChars);
});

// ── The notes a backfill names (design §5) ──────────────────────────────────────────────────────

test('a note a backfill names is what the session claimed: its body, under the rules of a write, and the session\'s writes are not read beside it', async () => {
  const s = new Records();
  s.owner('Go on.', moment(1));
  s.tool('Bash', { command: 'npm test' }, 'connect ECONNREFUSED 127.0.0.1:9000', moment(2));
  s.write('port.md', 'An earlier version of this file, which said something else entirely.', moment(3));
  s.write('other.md', 'A file of this session no note was imported from, and nobody names.', moment(4));
  const body = 'STORAGE_PORT is read at import, so the fixture has to return the url it listens on.';

  const dossier = await build(s, { claims: true, notes: [imported('note-1', 'sub/dir/port.md', body)] });
  assert.ok(dossier.text.includes(`C1 claim: ${body}`), dossier.text);
  assert.ok(!dossier.text.includes('originSessionId'), 'the frontmatter is no part of what it says');
  assert.ok(!dossier.text.includes('earlier version') && !dossier.text.includes('nobody names'), 'its writes are not read');
  assert.deepEqual(dossier.claims?.lines, [{ ref: 'C1', noteId: 'note-1', file: 'port.md' }], 'traced by the note, and known by its file\'s name');
  assert.deepEqual([dossier.claims?.seen, dossier.claims?.skipped, dossier.claims?.overCap, dossier.claims?.heldOut], [1, 0, 0, 0], 'the report counts what it read: the note');
  assert.ok(dossier.sources.every((source) => source.kind !== 'note' && !source.ref.startsWith('C')), 'nothing can cite it');

  const plain = await build(s);
  assert.deepEqual(await build(s, { notes: [imported('note-1', 'sub/dir/port.md', body)] }), plain, 'only the notes\' file reads a note: the case file is the bytes it is');
});

test('a note stands where the session last wrote its file, or after everything, so what bears on it is what came before', async () => {
  const s = new Records();
  s.owner('Go on.', moment(1));
  s.tool('Bash', { command: 'npm test' }, 'first line of the first run', moment(2));
  s.write('port.md', 'The first version of the file, long enough to count as a note.', moment(3));
  s.tool('Bash', { command: 'npm run lint' }, 'first line of the second run', moment(4));
  s.write('port.md', 'The second version of the file, long enough to count as a note.', moment(5));
  s.tool('Bash', { command: 'npm run build' }, 'first line of the last run', moment(6));
  s.write('port.md', 'A last attempt that failed and wrote nothing at all, in the end.', moment(7), { isError: true });

  const notes = [imported('at-the-write', 'port.md', 'What became of the port file, in its last version.'), imported('no-write', 'never-written.md', 'A note of a file the session has no write of.')];
  const lines = (await build(s, { claims: true, notes })).text.split('\n');
  const at = (words: string) => lines.findIndex((line) => line.includes(words));
  assert.ok(at('npm run lint') < at('What became of the port file'), 'after the write that stood');
  assert.ok(at('What became of the port file') < at('npm run build'), 'and before what came after it: a failed write is no write');
  assert.ok(at('npm run build') < at('A note of a file the session has no write of'), 'one with no write stands after everything');
  assert.deepEqual(lines.filter((line) => /^C\d+ claim:/u.test(line)).map((line) => line.slice(0, 2)), ['C1', 'C2'], 'numbered in the order they stand');
});

test('a note says too little by the rules a write does, at most 6 are carried, the feedback first and then the newest, and a held-out session carries none', async () => {
  const s = new Records();
  s.owner('Go on.', moment(1));
  const words = 'A note that says enough words to be a claim of its own, number';
  const said = await build(s, {
    claims: true,
    notes: [
      imported('user', 'user.md', 'The owner likes short answers, and says so at every turn they get.', 'user'),
      imported('short', 'short.md', 'Too short.'),
      imported('hub', 'hub.md', '- [One](one.md)\n- [Two](two.md)\n- [Three](three.md)'),
    ],
  });
  assert.deepEqual([said.claims?.seen, said.claims?.skipped, said.claims?.lines.length], [3, 3, 0]);

  const many = [...Array.from({ length: 7 }, (_, n) => imported(`note-${n}`, `note-${n}.md`, `${words} ${n}.`)), imported('feedback', 'feedback.md', `${words} feedback.`, 'feedback')];
  const capped = await build(s, { claims: true, notes: many });
  assert.equal(capped.claims?.seen, 8);
  assert.equal(capped.claims?.overCap, 2);
  assert.deepEqual(capped.claims?.lines.map((line) => ('noteId' in line ? line.noteId : '')).sort(), ['feedback', 'note-2', 'note-3', 'note-4', 'note-5', 'note-6'].sort(),
    'the feedback, though it is last in no order of time, and of notes of one moment the later named');

  const out = new Records(Array.from({ length: 64 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`).find((id) => wikiClaimsHeldOut(id))!);
  out.owner('Go on.', moment(1));
  const held = await build(out, { claims: true, notes: [imported('held', 'held.md', `${words} held.`)] });
  assert.deepEqual([held.claims?.seen, held.claims?.heldOut, held.claims?.lines.length], [1, 1, 0]);
  assert.ok(!held.text.includes('claim:'), 'its file says nothing of it');
});

// ── The budget (§3.2) ───────────────────────────────────────────────────────────────────────────

test('the file is the notes, the owner\'s words within their share, and what bears on each note, within the budget', async () => {
  const s = new Records();
  // Far more evidence than the budget holds, and more of the owner than their share.
  for (let n = 0; n < 200; n += 1) {
    s.tool('Bash', { command: `npm run check ${n}` }, `SHARED_MARKER ${'x'.repeat(300)}`, moment(1, n / 4));
    if (n % 10 === 0) s.owner(`From now on always run the check on module ${n}. ${'And keep it short. '.repeat(60)}`, moment(1, n / 4));
  }
  const chinese = (n: number) => `第${n}条记录说明 SHARED_MARKER 在模块里的行为，${'这是一段很长的说明文字用来测试预算上限，'.repeat(40)}`;
  for (let n = 0; n < 6; n += 1) s.write(`note-${n}.md`, chinese(n), moment(5, n));

  const dossier = await build(s, { claims: true });
  const lines = dossier.text.split('\n');
  const costOf = (line: string) => wikiEstimateTokens(line.slice(line.indexOf(': ') + 2)) + 6;
  const spentOn = (pattern: RegExp) => lines.filter((line) => pattern.test(line)).reduce((sum, line) => sum + costOf(line), 0);
  assert.equal(lines.filter((line) => /^C\d+ claim: /u.test(line)).length, 6, 'six long Chinese notes all stay');
  assert.equal(dossier.claims?.overCap, 0);
  assert.ok(lines.some((line) => /^L\d+ owner: /u.test(line)), 'the owner\'s words are there');
  assert.ok(spentOn(/^L\d+ owner: /u) <= WIKI_DOSSIER_CLAIMS.ownerShare * 8000 + 50, `the owner's words cost ${spentOn(/^L\d+ owner: /u)}`);
  assert.ok(lines.filter((line) => /^L\d+ tool: /u.test(line)).length > 0, 'and what the rest holds goes to the evidence');
  assert.ok(wikiEstimateTokens(dossier.text) <= 8000, 'the whole stays within the budget');
});

test('a smaller budget holds too, and a note that does not fit is left out and counted', async () => {
  const s = new Records();
  for (let n = 0; n < 40; n += 1) s.tool('Bash', { command: `npm run check -- module-${n}` }, `SHARED_MARKER ${n} ${'x'.repeat(200)}`, moment(1, n));
  for (let n = 0; n < 6; n += 1) s.write(`note-${n}.md`, `SHARED_MARKER note ${n}: ${'words about it '.repeat(30)}`, moment(5, n));
  const dossier = await build(s, { claims: true, maxTokens: 500 });
  assert.ok(wikiEstimateTokens(dossier.text) <= 500);
  assert.ok((dossier.claims?.overCap ?? 0) > 0);
  assert.equal((dossier.claims?.lines.length ?? 0) + (dossier.claims?.overCap ?? 0), 6);
});

test('nothing else is carried: a surprise, a failure or a long reply far from the notes stays out of their file', async () => {
  const s = new Records();
  s.text('assistant', `It turns out the far away cache is the real cause of something else. ${'more words '.repeat(40)}`, moment(1));
  s.tool('Bash', { command: 'make far-away' }, 'Exit code 1\nfar away failure', moment(1, 1), { isError: true });
  s.tool('Bash', { command: 'make far-away' }, 'far away success', moment(1, 2));
  for (let n = 0; n < 12; n += 1) s.tool('Bash', { command: `npm run step-${n}` }, `step ${n}`, moment(2, n));
  s.write('port.md', 'STORAGE_PORT is read at import, before the fixture sets it.', moment(3));
  s.text('assistant', 'Noted, and that is the end of the work.', moment(4));
  s.text('assistant', 'A second closing word.', moment(4, 1));
  s.text('assistant', 'A third closing word.', moment(4, 2));
  s.text('assistant', 'A fourth closing word stays out.', moment(4, 3));
  const off = await build(s);
  assert.match(off.text, /far away cache/u, 'the case file carries it');
  const file = await build(s, { claims: true });
  assert.doesNotMatch(file.text, /far away|far-away/u);
  assert.doesNotMatch(file.text, /A fourth closing word/u, 'three lines after a note, and no more');
  assert.match(file.text, /A third closing word/u);
  assert.doesNotMatch(file.text, /step-3 /u, 'eight lines before a note, and no more');
  assert.match(file.text, /step-4 /u);
});

// ── The evidence (§3.2) ─────────────────────────────────────────────────────────────────────────

test('what bears on a note is carried: the tool line that names its words, and the result line that names them', async () => {
  const s = new Records();
  s.owner('Find out why the release tagged.', moment(1));
  for (let n = 0; n < 30; n += 1) s.tool('Bash', { command: `git log -${n} --stat` }, `commit ${n}\n${'noise '.repeat(60)}`, moment(2, n));
  const middle = `${'line one of a long result\n'.repeat(80)}tagging v0.1.2-beta.104 ... pushed by \`release.sh next\`\n${'line after\n'.repeat(120)}the end`;
  const release = s.tool('Bash', { command: 'bash .claude/skills/release/release.sh next' }, middle, moment(3));
  for (let n = 0; n < 30; n += 1) s.tool('Bash', { command: `git status --short -${n}` }, `status ${n}\n${'noise '.repeat(60)}`, moment(4, n));
  const before = s.tool('Bash', { command: 'npm run build' }, 'built', moment(5));
  const read = s.tool('Read', { file_path: 'scripts/lib/next.ts' }, `first\nexport const X = 1;\nrelease.sh next parses the version\nlast`, moment(6));
  const after = s.tool('Read', { file_path: 'scripts/lib/after.ts' }, 'more', moment(7));
  s.write('release.md', 'The script `release.sh next` tags at once; parseVersion is not a dry run.', moment(8));
  s.tool('Bash', { command: 'node --print parseVersion' }, 'a first line\nparseVersion is named in the middle\na last line', moment(9));

  const off = await build(s);
  assert.doesNotMatch(off.text, /tagging v0\.1\.2/u, 'off, the result line is nowhere');
  const dossier = await build(s, { claims: true });
  /** The dossier's line for the tool call whose tool_use event is `id`. */
  const line = (id: string) => {
    const use = s.events.find((event) => event.id === id)!;
    return dossier.sources.find((one) => one.id === s.records().toolCallIds.get(use.toolUseId!));
  };

  assert.match(dossier.text, /\$ bash \.claude\/skills\/release\/release\.sh next → ok: line one of a long result … tagging v0\.1\.2-beta\.104/u,
    'the first line of the result, then the line of its middle that names the words');
  assert.deepEqual(line(release)?.spans.map((span) => span.text).filter((text) => text.startsWith('tagging')), ['tagging v0.1.2-beta.104 ... pushed by `release.sh next`'],
    'and a quote of it is placed in the record');
  const output = s.calls.find((call) => call.name === 'Bash' && String((call.input as { command: string }).command).endsWith('release.sh next'))!;
  const placed = line(release)!.spans.find((span) => span.text.startsWith('tagging'))!;
  const whole = `Bash\ncommand: bash .claude/skills/release/release.sh next\n${String(output.output)}`;
  assert.equal(Array.from(whole).slice(placed.start, placed.end).join(''), placed.text, 'word for word at the place it names');

  assert.match(dossier.text, /read scripts\/lib\/next\.ts → ok: release\.sh next parses the version/u, 'a read shows the line that names the words, where a read shows nothing');
  assert.ok(line(read), 'and stands as a line of its own, not folded into its neighbours');
  assert.ok(line(before) && line(after), 'with its neighbours in the window');
  assert.match(dossier.text, /\$ node --print parseVersion → ok: a first line/u, 'a call right after the note is carried');
  assert.doesNotMatch(dossier.text, /parseVersion is named in the middle/u, 'with the line it always had: what comes after a note is no evidence for its words');
  assert.ok(!dossier.sources.some((source) => source.ref.startsWith('C')), 'and a note is no source');
});

test('a result line that points at the memory library stays out, and a note is redacted', async () => {
  const s = new Records();
  s.owner('Go on.', moment(1));
  s.tool('Bash', { command: 'grep -r budgetShare .' }, `first\n${LIBRARY}/note.md: budgetShare is a quarter\nlast`, moment(2));
  const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
  s.write('note.md', `The budgetShare note with a ${token} and the ${LITERALS[0]} in it.`, moment(3));
  const dossier = await build(s, { claims: true });
  assert.doesNotMatch(dossier.text, /is a quarter/u);
  assert.ok(!dossier.text.includes(token), 'a token is gone from a note');
  assert.ok(!dossier.text.includes(LITERALS[0]!), 'and so is a workspace value');
  assert.match(dossier.text, /C1 claim: The budgetShare note with a \[redacted\]/u);
});

// ── Nothing can cite a note (§3.2, §3.3) ────────────────────────────────────────────────────────

test('a note is no line of the case file: citing it drops the entry, and what the model says of it is read beside the entry', async () => {
  const s = new Records();
  s.owner('Why does the upload test fail?', moment(1));
  s.tool('Bash', { command: 'npm test' }, 'Error: connect ECONNREFUSED 127.0.0.1:9000', moment(2), { isError: true });
  s.write('port.md', 'STORAGE_PORT is read at import, before the fixture sets it.\nSo the test connects to the default port.', moment(3));
  s.text('assistant', 'I saw the error and noted it.', moment(4));
  const dossier = await build(s, { claims: true });

  const lines = wikiMaintainLines(dossier);
  assert.deepEqual([...lines.keys()], ['L1', 'L2', 'L3'], 'only L lines are read');
  assert.ok(!lines.get('L2')!.text.includes('STORAGE_PORT'), 'a note is not read as the line before it continuing');
  assert.equal(dossier.sources.length, 3);

  const built = buildWikiMaintainOps([
    entry('Cites the note alone', [{ ref: 'C1', quote: 'STORAGE_PORT is read at import' }]),
    entry('Cites a line and the note', [{ ref: 'L2', quote: 'connect ECONNREFUSED 127.0.0.1:9000' }, { ref: 'C1', quote: 'STORAGE_PORT is read at import' }]),
    entry('Puts the note in a line', [{ ref: 'L2', quote: 'STORAGE_PORT is read at import' }]),
    entry('Comes from the note', [{ ref: 'L2', quote: 'connect ECONNREFUSED 127.0.0.1:9000' }], 'C1'),
    entry('Names a note the case does not have', [{ ref: 'L1', quote: 'Why does the upload test fail?' }], 'C2'),
    entry('Names no note', [{ ref: 'L3', quote: 'I saw the error and noted it.' }]),
  ], dossier, lines, ANCHORS, CONTEXT.topics);

  assert.deepEqual(built.ops.map((op) => op.title), ['Comes from the note', 'Names a note the case does not have', 'Names no note']);
  assert.equal(built.dropped, 3);
  assert.ok(built.problems.some((problem) => problem.includes('source ref C1 is not a line of the case file')), built.problems.join('\n'));
  assert.ok(built.problems.some((problem) => problem.includes('quote for L2 is not copied exactly')));
  const [fromNote, wrongNote, noNote] = built.ops;
  assert.equal(fromNote!.note, 'C1', 'the note it came from is kept beside the op');
  assert.ok(!('note' in fromNote!.body), 'and is no part of what is proposed');
  assert.ok(!JSON.stringify(fromNote!.body).includes('C1'));
  assert.ok(!('note' in wrongNote!), 'a note the case does not carry is not taken');
  assert.ok(!('note' in noNote!));

  // The prompt says what a note is, and holds the file.
  const prompt = wikiMaintainClaimsPrompt(CONTEXT, 'A small service.', dossier.text);
  assert.match(prompt, /- claim: a note the agent wrote to its own memory\. It is what the agent believed, not evidence/u);
  assert.match(prompt, /A C line is never a source/u);
  assert.ok(prompt.endsWith(`==== CASE FILE ====\n${dossier.text}\n==== END OF CASE FILE ====\nOutput the JSON object now.`));

  // The answer the prompt asks for reads as entries, and its notes beside them.
  const answer = JSON.stringify({ notes: [{ note: 'C1', outcome: 'shown', shownBy: ['L2'] }], entries: [entry('Comes from the note', [{ ref: 'L2', quote: 'connect ECONNREFUSED 127.0.0.1:9000' }], 'C1')] });
  assert.equal(parseWikiImportAnswer(answer)?.length, 1);
  assert.deepEqual([...wikiMaintainNoteAnswers(answer, ['C1'])], [['C1', { outcome: 'shown', shownBy: ['L2'] }]]);
});

test('what became of each note is read wherever it is said, and what cannot be read is unanswered', () => {
  const refs = ['C1', 'C2', 'C3'];
  const read = (answer: string) => Object.fromEntries([...wikiMaintainNoteAnswers(answer, refs)].map(([ref, said]) => [ref, said.outcome]));
  assert.deepEqual(read('{"notes": [{"note": "C1", "outcome": "shown", "shownBy": ["L12", "L30"]}, {"note": "C2", "outcome": "not_durable"}, {"note": "C3", "outcome": "contradicted"}], "entries": []}'),
    { C1: 'shown', C2: 'not_durable', C3: 'contradicted' });
  assert.deepEqual(read('```json\n{"notes": [{"outcome": "narrowed", "note": "C2"}], "entries": []}\n```'), { C1: 'unanswered', C2: 'narrowed', C3: 'unanswered' }, 'fenced, in either order');
  assert.deepEqual(read('[{"kind": "pitfall", "note": "C1", "title": "An entry names its note, which says nothing of the outcome"}]'), { C1: 'unanswered', C2: 'unanswered', C3: 'unanswered' }, 'a bare array answers nothing');
  assert.deepEqual(read('{"entries": [{"kind": broken}], "notes": [{"note": "C1", "outcome": "absent"}]}'), { C1: 'absent', C2: 'unanswered', C3: 'unanswered' }, 'a broken entry costs the note nothing');
  assert.deepEqual(read('{"notes": [{"note": "C1", "outcome": "maybe"}, {"note": "C9", "outcome": "shown"}, {"note": "C2", "outcome": "shown"}, {"note": "C2", "outcome": "absent"}]}'),
    { C1: 'unanswered', C2: 'shown', C3: 'unanswered' }, 'an unknown outcome and an unknown note are not taken, and the first said of a note stands');
  assert.deepEqual(read('no JSON at all'), { C1: 'unanswered', C2: 'unanswered', C3: 'unanswered' });
});

test('an entry from a note also cites the first-hand lines the model said show it, and nothing else does', () => {
  const lines = new Map([
    ['L1', { text: 'Why does it fail?', kind: 'turn', id: 'turn-1', author: 'owner', spans: [{ start: 0, end: 17, text: 'Why does it fail?' }] }],
    ['L2', { text: '$ npm test → ERR: refused', kind: 'tool_call', id: 'call-2', author: 'tool', spans: [{ start: 4, end: 12, text: 'npm test' }] }],
    ['L3', { text: 'The port is read at import.', kind: 'event', id: 'event-3', author: 'agent', spans: [{ start: 0, end: 27, text: 'The port is read at import.' }] }],
    ['L4', { text: '$ npm run build → ok', kind: 'tool_call', id: 'call-4', author: 'tool', spans: [] }],
    ['L5', { text: '$ npm run lint → ok', kind: 'tool_call', id: 'call-5', author: 'tool', spans: [] }],
    ['L6', { text: 'Go on.', kind: 'task_comment', id: 'comment-6', author: 'comment', spans: [] }],
    ['L7', { text: 'edit src/app.ts → ok', kind: 'tool_call', id: 'call-7', author: 'tool', spans: [] }],
    ['L8', { text: 'write ×2: a.md, b.md', kind: 'tool_call', id: 'call-8', author: 'tool', spans: [] }],
    ['L10', { text: 'A note on the task.', kind: 'task_comment', id: 'comment-10', author: 'comment-owner', spans: [] }],
    ['L11', { text: 'Hello.', kind: 'turn', id: 'turn-11', author: 'user', spans: [] }],
  ]);
  const op = (note: string | undefined, sources: Array<Record<string, unknown>>) => ({ body: { op: 'add', entry: {}, sources }, topic: '', session: 's', title: 't', ...(note ? { note } : {}) });
  const fromNote = op('C1', [{ kind: 'event', ref: 'event-3', quote: 'The port is read at import.' }]);
  const already = op('C2', [{ kind: 'tool_call', ref: 'call-2' }]);
  const plain = op(undefined, [{ kind: 'event', ref: 'event-3' }]);
  const unnamed = op('C3', [{ kind: 'event', ref: 'event-3' }]);
  wikiMaintainCiteShownBy([fromNote, already, plain, unnamed], new Map([
    ['C1', { outcome: 'shown' as const, shownBy: ['L3', 'L9', 'L7', 'L8', 'L10', 'L11', 'L1', 'L6', 'L2', 'L4', 'L5'] }],
    ['C2', { outcome: 'narrowed' as const, shownBy: ['L2'] }],
    ['C3', { outcome: 'shown' as const, shownBy: [] }],
  ]), lines);
  assert.deepEqual(fromNote.body.sources, [
    { kind: 'event', ref: 'event-3', quote: 'The port is read at import.' },
    { kind: 'turn', ref: 'turn-1', quote: 'Why does it fail?', locator: { start: 0, end: 17 } },
    { kind: 'tool_call', ref: 'call-2' },
  ], 'the first two first-hand lines it names: an agent line, a file write, a comment, a user line and a line the case does not have are passed over, and only the owner\'s words are quoted');
  assert.deepEqual(already.body.sources, [{ kind: 'tool_call', ref: 'call-2' }], 'a record it already cites is not cited twice');
  assert.deepEqual(plain.body.sources, [{ kind: 'event', ref: 'event-3' }], 'an entry from no note is left as it is');
  assert.deepEqual(unnamed.body.sources, [{ kind: 'event', ref: 'event-3' }], 'and so is one whose note names no line');
});

test('a tool line that repeats a note is not added for it, an owner line that does is, and neither is held against another note', () => {
  const words = 'The upload test fails with ECONNREFUSED because the port is read at import, before the fixture sets it.';
  const line = (author: string, id: string, text: string) => ({ text, kind: 'event', id, author, spans: [] });
  const lines = new Map([
    ['L1', line('tool', 'stored', `read tool-results/1.txt → ok: ${words}`)],
    ['L2', line('tool', 'short', `$ npm test → ERR: ${words.slice(0, 59)}!`)],
    ['L3', line('owner', 'owner', words)],
  ]);
  const body = () => ({ body: { op: 'add', sources: [] as Array<Record<string, unknown>> }, topic: '', session: 's', title: 't' });
  const repeated = { ...body(), note: 'C1' };
  const other = { ...body(), note: 'C2' };
  wikiMaintainCiteShownBy([repeated, other], new Map([
    ['C1', { outcome: 'shown' as const, shownBy: ['L1', 'L2'] }],
    ['C2', { outcome: 'shown' as const, shownBy: ['L1'] }],
  ]), lines, new Map([['C1', words], ['C2', 'Another note altogether, which no line of this case repeats anywhere.']]));
  assert.deepEqual(repeated.body.sources, [{ kind: 'event', ref: 'short' }], 'the line with 60 characters in a row is passed over, the one with 59 is not');
  assert.deepEqual(other.body.sources, [{ kind: 'event', ref: 'stored' }]);
  const fromOwner = { ...body(), note: 'C1' };
  wikiMaintainCiteShownBy([fromOwner], new Map([['C1', { outcome: 'shown' as const, shownBy: ['L3'] }]]), lines, new Map([['C1', words]]));
  assert.deepEqual((fromOwner.body.sources as Array<{ ref: string }>).map((source) => source.ref), ['owner']);
});

// ── The pass (§6.2) ──────────────────────────────────────────────────────────────

/** A session with two notes, and the file made of it. */
async function twoNotes() {
  const s = new Records();
  s.owner('Why does the upload test fail?', moment(1));
  s.tool('Bash', { command: 'npm test' }, 'Error: connect ECONNREFUSED 127.0.0.1:9000', moment(2), { isError: true });
  s.tool('Edit', { file_path: 'src/api/fixture.ts', old_string: 'a', new_string: 'b' }, 'File updated', moment(3));
  s.text('assistant', 'The port is read at import.', moment(4));
  s.write('port.md', 'The upload test fails with ECONNREFUSED 127.0.0.1:9000 because the port is read at import.', moment(5));
  s.write('other.md', 'The upload service retries three times before it gives up.', moment(6));
  const dossier = await build(s, { claims: true });
  assert.deepEqual(dossier.claims?.lines.map((line) => line.ref), ['C1', 'C2']);
  const quoted = (ref: string) => [...wikiMaintainLines(dossier)].find(([, line]) => line.text.includes(ref))![0];
  return { dossier, refs: ['C1', 'C2'], failure: quoted('ECONNREFUSED'), reply: quoted('read at import'), edit: quoted('edit ') };
}

/** The pass over `answers`, one a call, keeping the prompts it asked with. */
async function run(file: Awaited<ReturnType<typeof twoNotes>>, answers: Array<string | null>) {
  const asked: Array<{ prompt: string; again: boolean }> = [];
  const result = await wikiMaintainCheckClaims({
    dossier: file.dossier,
    refs: file.refs,
    context: CONTEXT,
    about: 'A small service.',
    repo: ANCHORS,
    ask: async (prompt, again) => {
      asked.push({ prompt, again });
      return answers.shift() ?? null;
    },
  });
  return { ...result, asked };
}

test('the pass keeps one entry for each note answered shown or narrowed, and nothing else', async () => {
  const file = await twoNotes();
  const source = { ref: file.failure, quote: 'connect ECONNREFUSED 127.0.0.1:9000' };
  const answer = JSON.stringify({
    notes: [{ note: 'C1', outcome: 'shown', shownBy: [file.failure] }, { note: 'C2', outcome: 'absent', shownBy: [] }],
    entries: [
      entry('From a note it shows', [source], 'C1'),
      entry('A second from the same note', [source], 'C1'),
      entry('From a note it says is absent', [source], 'C2'),
      entry('From no note at all', [source]),
    ],
  });
  const result = await run(file, [answer]);
  assert.deepEqual(result.ops.map((op) => op.title), ['From a note it shows']);
  assert.deepEqual(result.leftOut, { noNote: 1, noteNotShown: 1, secondOfNote: 1 });
  assert.equal(result.retried, false, 'nothing to ask again');
  assert.equal(result.asked.length, 1);
  assert.equal(result.asked[0]!.prompt, wikiMaintainClaimsPrompt(CONTEXT, 'A small service.', file.dossier.text));
  assert.deepEqual([...result.notes.keys()], ['C1', 'C2']);
  assert.equal(result.notes.get('C1')?.outcome, 'shown');
  assert.equal(result.notes.get('C2')?.outcome, 'absent');
});

test('the pass adds the first-hand lines of shownBy to what the model cited, and says how many it cited itself', async () => {
  const file = await twoNotes();
  const answer = JSON.stringify({
    notes: [{ note: 'C1', outcome: 'narrowed', shownBy: [file.reply, file.edit, file.failure] }, { note: 'C2', outcome: 'not_durable', shownBy: [] }],
    entries: [entry('Cited from the agent', [{ ref: file.reply, quote: 'The port is read at import.' }], 'C1')],
  });
  const result = await run(file, [answer]);
  assert.deepEqual(result.citedByModel, [1]);
  const lines = wikiMaintainLines(file.dossier);
  const sources = result.ops[0]!.body.sources as Array<{ ref: string }>;
  assert.deepEqual(sources.map((one) => one.ref), [lines.get(file.reply)!.id, lines.get(file.failure)!.id], 'the failure is added, the file write is not');
  assert.ok(!JSON.stringify(result.ops[0]!.body).includes('"note"'), 'and the note is no part of what is proposed');
});

test('a note answered shown with no entry is asked for once more, and the first answer of a note stands', async () => {
  const file = await twoNotes();
  const source = { ref: file.failure, quote: 'connect ECONNREFUSED 127.0.0.1:9000' };
  const first = JSON.stringify({ notes: [{ note: 'C1', outcome: 'shown', shownBy: [file.failure] }], entries: [] });
  const second = JSON.stringify({
    notes: [{ note: 'C1', outcome: 'absent', shownBy: [] }, { note: 'C2', outcome: 'not_durable', shownBy: [] }],
    entries: [entry('Written when asked', [source], 'C1')],
  });
  const result = await run(file, [first, second]);
  assert.equal(result.retried, true);
  assert.equal(result.asked[1]!.again, true);
  assert.match(result.asked[1]!.prompt, /note C1 was answered shown or narrowed and has no entry/u);
  assert.ok(result.asked[1]!.prompt.startsWith(result.asked[0]!.prompt));
  assert.deepEqual(result.ops.map((op) => op.title), ['Written when asked']);
  assert.equal(result.notes.get('C1')?.outcome, 'shown', 'the first said of a note stands');
  assert.equal(result.notes.get('C2')?.outcome, 'not_durable', 'and a note the first left open takes the second');
});

test('an entry that cites a C line is dropped and asked for again; an answer that cannot be had leaves what there was', async () => {
  const file = await twoNotes();
  const answer = JSON.stringify({
    notes: [{ note: 'C1', outcome: 'shown', shownBy: ['C1'] }, { note: 'C2', outcome: 'absent', shownBy: [] }],
    entries: [entry('Cites its own note', [{ ref: 'C1', quote: 'The upload test fails with ECONNREFUSED' }], 'C1')],
  });
  const result = await run(file, [answer, null]);
  assert.deepEqual(result.ops, []);
  assert.equal(result.built?.dropped, 1);
  assert.match(result.asked[1]!.prompt, /source ref C1 is not a line of the case file/u);

  const broken = await run(file, ['not JSON at all', null]);
  assert.deepEqual(broken.ops, []);
  assert.equal(broken.retried, true);
  assert.equal(broken.notes.get('C1')?.outcome, 'unanswered', 'nobody asks a third time');
  assert.match(broken.asked[1]!.prompt, /not a valid JSON object of notes and flat entry objects/u);
});

test('a case about something else is said once and takes nothing', async () => {
  const result = await run(await twoNotes(), ['{"offTopic": true}']);
  assert.equal(result.offTopic, true);
  assert.deepEqual(result.ops, []);
  assert.equal(result.asked.length, 1);
  assert.equal(result.notes.get('C1')?.outcome, 'unanswered');
});

// ── Held out, and the same twice (§3.2) ─────────────────────────────────────────────────────────

test('one session in ten is held out, by a digest of its id: it carries no note, in the bytes it would have had', async () => {
  const ids = Array.from({ length: 5000 }, (_, n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`);
  const held = ids.filter(wikiClaimsHeldOut);
  assert.ok(held.length > 400 && held.length < 600, `about a tenth: ${held.length}`);
  const id = held[0]!;
  assert.equal(parseInt(sha256(id).slice(0, 8), 16) % 10, 0, 'the rule, spelled out: sha256 of the id, its first eight hex digits, mod 10');

  const s = new Records(id);
  s.owner('Fix the port.', moment(1));
  s.write('port.md', 'STORAGE_PORT is read at import, before the fixture sets it.', moment(2));
  const dossier = await build(s, { claims: true });
  assert.equal(dossier.text, (await build(s)).text);
  assert.deepEqual(dossier.claims, { seen: 1, notes: 0, skipped: 0, overCap: 0, heldOut: 1, lines: [] });
});

test('the same records give the same dossier, notes and evidence included', async () => {
  const once = await build(goldenSession(), { claims: true });
  const twice = await build(goldenSession(), { claims: true });
  assert.equal(once.text, twice.text);
  assert.equal(once.hash, twice.hash);
  assert.deepEqual(once.sources, twice.sources);
  assert.deepEqual(once.claims, twice.claims);
  assert.match(once.text, /C1 claim: STORAGE_PORT is read at import in `storage-fixture\.ts`\./u);
  assert.ok(WIKI_MAINTENANCE_JOB.entriesPerSessionMax === 6, 'the entry cap is not moved by notes');
});

// ── A session's wiki_note (docs/wiki-memory-claims-design.md §4) ───────────────────────────────

/** A session with something to read, and no note of any kind. */
function workedOn(id?: string): Records {
  const s = new Records(id);
  s.owner('Fix the upload test.', moment(1));
  s.tool('Bash', { command: 'npm test -w api -- upload.spec.ts' }, 'Exit code 1\nError: connect ECONNREFUSED 127.0.0.1:9000', moment(2), { isError: true });
  s.tool('Bash', { command: 'npm test -w api -- upload.spec.ts' }, '# pass 14', moment(3));
  return s;
}

const heldOutSession = (): string => {
  for (let n = 0; ; n += 1) {
    const id = `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    if (wikiClaimsHeldOut(id)) return id;
  }
};

test('a wiki_note is a claim at its moment, named by its row: no source can cite it, and the extraction never hears of it', async () => {
  const s = workedOn();
  const noted = s.note('The upload test needs the url from the fixture.\nPaths: src/api/test/storage-fixture.ts', moment(4));
  const file = await build(s, { claims: true });
  assert.match(file.text, /C1 claim: The upload test needs the url from the fixture\.\n {4}Paths: src\/api\/test\/storage-fixture\.ts/u);
  assert.deepEqual(file.claims, { seen: 0, notes: 1, skipped: 0, overCap: 0, heldOut: 0, lines: [{ ref: 'C1', noteId: noted, file: 'wiki_note' }] });
  assert.ok(file.sources.length > 0 && file.sources.every((source) => source.kind !== 'note' && !source.ref.startsWith('C')));
  assert.match(file.text, /ECONNREFUSED/u, 'what bears on it is carried with it');

  const plain = await build(s);
  assert.ok(!plain.text.includes('needs the url from the fixture'), 'the extraction does not read it');
  assert.ok(!('claims' in plain));
});

test('filing a note leaves no line in a dossier, under any engine\'s name or through the CLI, and its record cannot be cited', async () => {
  const filed = workedOn();
  const said = 'The upload test needs the url from the fixture, which is what the fixture is for.';
  filed.tool('mcp__orbit__wiki_note', { text: said }, 'Noted as a-note.', moment(5));
  filed.tool('orbit__wiki_note', { text: said }, 'Noted as a-note.', moment(6));
  filed.tool('Bash', { command: `orbit wiki note "${said}" --path src/api/test/storage-fixture.ts` }, 'Noted as a-note.', moment(7));
  filed.tool('Bash', { command: "'/usr/local/bin/orbit' wiki note --text-file - < note.txt" }, 'Noted as a-note.', moment(8));
  const clean = workedOn();
  for (const options of [{}, { claims: true }]) {
    const [withCalls, without] = [await build(filed, options), await build(clean, options)];
    assert.equal(withCalls.text, without.text);
    assert.ok(!withCalls.text.includes(said));
    assert.deepEqual(withCalls.sources.map((source) => source.id), without.sources.map((source) => source.id));
  }
});

test('a note changes a dossier\'s hash and nothing else of it, and a session with none keeps the hash it had', async () => {
  const before = await build(workedOn());
  const s = workedOn();
  s.note('The upload test needs the url from the fixture.', moment(4));
  const after = await build(s);
  assert.equal(after.text, before.text);
  assert.deepEqual(after.sources, before.sources);
  assert.notEqual(after.hash, before.hash, 'a new note is something the run has not read');
  assert.equal(before.hash, dossierHash(before.text, before.sources));
  s.note('A second one, which is something new again.', moment(5));
  assert.notEqual((await build(s)).hash, after.hash);
  assert.equal((await build(goldenSession())).hash, GOLDEN_OFF.hash, 'the bytes of a session with no note do not move');
});

test('a session held out keeps its writes out and its wiki_notes in: the hold-out measures its memory', async () => {
  const s = workedOn(heldOutSession());
  s.write('port.md', 'STORAGE_PORT is read at import, before the fixture sets it, which the memory says.', moment(4));
  assert.deepEqual((await build(s, { claims: true })).claims, { seen: 1, notes: 0, skipped: 0, overCap: 0, heldOut: 1, lines: [] });
  const noted = s.note('The upload test needs the url from the fixture.', moment(5));
  const file = await build(s, { claims: true });
  assert.deepEqual(file.claims, { seen: 1, notes: 1, skipped: 0, overCap: 0, heldOut: 1, lines: [{ ref: 'C1', noteId: noted, file: 'wiki_note' }] });
  assert.match(file.text, /C1 claim: The upload test needs the url/u);
  assert.ok(!file.text.includes('STORAGE_PORT is read at import'), 'what it wrote to memory stays out');
});

test('notes and writes share the cap, in the order they were written: a wiki_note ranks with the feedback, and the rest are counted', async () => {
  const s = workedOn();
  const plain = s.write('plain.md', 'A project fact written first, which nothing says is the owner\'s word.', moment(4));
  const feedback = s.write('owner.md', '---\ntype: feedback\n---\nThe owner said to keep the port out of the fixture.', moment(5));
  const notes = Array.from({ length: 6 }, (_, n) => s.note(`A note numbered ${n} about the upload test and its fixture.`, moment(6 + n)));
  const late = s.write('late.md', 'A project fact written last, newer than every note and no feedback.', moment(20));
  const file = await build(s, { claims: true });
  assert.equal(file.claims?.seen, 3);
  assert.equal(file.claims?.notes, 6);
  assert.equal(file.claims?.overCap, 3);
  const carried = file.claims!.lines;
  assert.deepEqual(carried.map((line) => ('noteId' in line ? line.noteId : line.eventId)), notes, 'the six newest of those that rank first, and in time order');
  assert.ok(!carried.some((line) => 'eventId' in line && [plain, feedback, late].includes(line.eventId)));

  const two = workedOn();
  two.write('first.md', 'A fact written to memory before the note, with enough words.', moment(4));
  two.note('The note, between the two writes to memory, with enough words.', moment(5));
  two.write('second.md', 'A fact written to memory after the note, with enough words.', moment(6));
  const mixed = await build(two, { claims: true });
  assert.deepEqual(mixed.claims?.lines.map((line) => line.ref), ['C1', 'C2', 'C3']);
  assert.match(mixed.text, /C1 claim: A fact written to memory before[\s\S]*C2 claim: The note, between[\s\S]*C3 claim: A fact written to memory after/u);
});

test('a wiki_note says what it says: no type to skip it, no minimum, and it is cut as any note is', async () => {
  const s = workedOn();
  s.note('Short.', moment(4));
  s.note(`A long one. ${'word '.repeat(300)}`, moment(5));
  const file = await build(s, { claims: true });
  assert.equal(file.claims?.skipped, 0);
  assert.match(file.text, /C1 claim: Short\./u);
  const cut = /C2 claim: (.*)/u.exec(file.text)![1]!;
  assert.match(cut, /…\[\+\d+ chars\]$/u, cut.slice(-40));
  assert.ok(Array.from(cut.replace(/…\[.*$/u, '')).length <= WIKI_DOSSIER_CLAIMS.lineMaxChars);
});
