import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { wikiEstimateTokens, WIKI_MAINTENANCE_JOB } from '@orbit/shared';

import { parseWikiImportAnswer } from '../wiki-worker/wiki-import-extract';
import {
  buildWikiMaintainOps,
  wikiMaintainCiteShownBy,
  wikiMaintainLines,
  wikiMaintainNoteAnswers,
  wikiMaintainPrompt,
  type WikiMaintainRepoGate,
} from '../wiki-worker/wiki-maintain';
import {
  buildDossier,
  wikiClaimsHeldOut,
  WIKI_DOSSIER_CLAIMS,
  type DossierEventRow,
  type DossierMemoryWrite,
  type DossierReader,
  type DossierRecords,
} from './wiki-dossier';

/**
 * The agent's notes in a dossier (docs/wiki-memory-claims-design.md §3.1 to §3.3), from records held in memory: what
 * counts as a write, what is skipped, the caps, the budget, the evidence, and that nothing can cite a note. The
 * reads of real rows are `wiki-dossier.pg.spec.ts`'s.
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

  records(): DossierRecords {
    return {
      session: { id: this.sessionId, title: 'a session', provider: 'claude', model: 'claude-opus-5', status: 'SUCCEEDED', createdAt: moment(0), taskId: null, parentSessionId: null, dispatchOrigin: 'USER' },
      turns: this.turns, approvals: [], events: this.events,
      toolCallIds: new Map(this.calls.map((call) => [call.toolUseId, call.id])),
      task: null, comments: [], receipts: [], blockers: [], tainted: false,
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

function build(records: Records, options: { claims?: boolean; maxTokens?: number } = {}) {
  return buildDossier(records.reader(), records.records(), { literals: LITERALS, ...options });
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
  assert.equal(wikiMaintainPrompt(CONTEXT, 'A small service.', off.text, { claims: false }), wikiMaintainPrompt(CONTEXT, 'A small service.', off.text));
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
  assert.deepEqual(quiet.claims, { seen: 0, skipped: 0, overCap: 0, heldOut: 0, lines: [] });

  const skippedOnly = new Records();
  skippedOnly.owner('Fix the port.', moment(1));
  skippedOnly.write('me.md', '---\ntype: user\n---\n\nThe owner likes short answers and works in the evening.', moment(2));
  const allSkipped = await build(skippedOnly, { claims: true });
  assert.equal(allSkipped.text, (await build(skippedOnly)).text, 'nor does a write that is skipped change a byte');
  assert.deepEqual(allSkipped.claims, { seen: 1, skipped: 1, overCap: 0, heldOut: 0, lines: [] });
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
  assert.deepEqual(dossier.claims, { seen: 8, skipped: 7, overCap: 0, heldOut: 0, lines: [{ ref: 'C1', eventId: kept, file: 'kept.md' }] });
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

// ── The budget (§3.2) ───────────────────────────────────────────────────────────────────────────

test('the notes and their evidence take at most 25% of the budget, from the windows, and never the owner\'s words', async () => {
  const s = new Records();
  // Far more evidence than a quarter of the budget holds, and owner lines that have to stay.
  for (let n = 0; n < 200; n += 1) {
    s.tool('Bash', { command: `npm run check ${n}` }, 'SHARED_MARKER', moment(1, n / 4));
    if (n % 50 === 0) s.owner(`From now on always run the check on module ${n}.`, moment(1, n / 4));
  }
  const chinese = (n: number) => `第${n}条记录说明 SHARED_MARKER 在模块里的行为，${'这是一段很长的说明文字用来测试预算上限，'.repeat(40)}`;
  for (let n = 0; n < 6; n += 1) s.write(`note-${n}.md`, chinese(n), moment(5, n));

  const dossier = await build(s, { claims: true });
  const off = await build(s);
  const quarter = WIKI_DOSSIER_CLAIMS.budgetShare * 8000;
  const lines = dossier.text.split('\n');
  const costOf = (line: string) => wikiEstimateTokens(line.slice(line.indexOf(': ') + 2)) + 6;
  const claimLines = lines.filter((line) => /^C\d+ claim: /u.test(line));
  const toolLines = lines.filter((line) => /^L\d+ tool: /u.test(line));
  const spent = [...claimLines, ...toolLines].reduce((sum, line) => sum + costOf(line), 0);
  assert.equal(claimLines.length, 4, 'four long Chinese notes fill most of the quarter');
  assert.equal(dossier.claims?.overCap, 2, 'and the two that do not fit are counted');
  assert.deepEqual(dossier.claims?.lines.map((line) => line.file), ['note-2.md', 'note-3.md', 'note-4.md', 'note-5.md'], 'the newest are the ones kept');
  assert.ok(spent <= quarter, `the notes and the evidence cost ${spent} of ${quarter}`);
  assert.ok(toolLines.length > 0, 'and what the notes left of it goes to the evidence');
  assert.ok(wikiEstimateTokens(dossier.text) <= 8000, 'the whole stays within the budget');
  for (const owner of off.text.split('\n').filter((line) => /^L\d+ owner: /u.test(line))) {
    assert.ok(lines.some((line) => line.endsWith(owner.slice(owner.indexOf(': ') + 2))), `the owner's words stay: ${owner}`);
  }

  // With notes short enough to leave room, the evidence comes up to the share and no further.
  const short = new Records();
  for (let n = 0; n < 200; n += 1) {
    short.tool('Bash', { command: `npm run check -- src/app/module-${n}.ts` }, `Checked SHARED_MARKER in ${'x'.repeat(300)}`, moment(1, n / 4));
  }
  short.write('note.md', 'SHARED_MARKER is what every module check prints first.', moment(5));
  const roomy = await build(short, { claims: true });
  const roomyLines = roomy.text.split('\n').filter((line) => /^(?:L\d+ tool|C\d+ claim): /u.test(line));
  const roomySpent = roomyLines.reduce((sum, line) => sum + costOf(line), 0);
  assert.ok(roomySpent <= quarter && roomySpent > quarter * 0.9, `the share is spent and not passed: ${roomySpent} of ${quarter}`);
  assert.ok(wikiEstimateTokens(roomy.text) < wikiEstimateTokens(off.text) + 8000);
});

test('a smaller budget holds its share too', async () => {
  const s = new Records();
  for (let n = 0; n < 40; n += 1) s.tool('Bash', { command: `npm run check -- module-${n}` }, `SHARED_MARKER ${n} ${'x'.repeat(200)}`, moment(1, n));
  for (let n = 0; n < 6; n += 1) s.write(`note-${n}.md`, `SHARED_MARKER note ${n}: ${'words about it '.repeat(30)}`, moment(5, n));
  const dossier = await build(s, { claims: true, maxTokens: 1_000 });
  const spent = dossier.text.split('\n').filter((line) => /^(?:L\d+ tool|C\d+ claim): /u.test(line))
    .reduce((sum, line) => sum + wikiEstimateTokens(line.slice(line.indexOf(': ') + 2)) + 6, 0);
  assert.ok(spent <= 250, `${spent} of 250`);
  assert.ok(wikiEstimateTokens(dossier.text) <= 1_000);
  assert.ok((dossier.claims?.overCap ?? 0) > 0);
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
  s.tool('Bash', { command: 'node --print parseVersion' }, 'a later call that names the same word', moment(9));

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
  assert.doesNotMatch(dossier.text, /node --print/u, 'a call after the note is no evidence for it');
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

  // The prompt: everything it always said, and then the notes.
  const plain = wikiMaintainPrompt(CONTEXT, 'A small service.', dossier.text);
  const withNotes = wikiMaintainPrompt(CONTEXT, 'A small service.', dossier.text, { claims: true });
  const end = '==== END OF CASE FILE ====\n';
  assert.equal(withNotes.slice(0, withNotes.indexOf(end)), plain.slice(0, plain.indexOf(end)), 'not a byte of the rest changes');
  assert.ok(plain.endsWith(`${end}Output the JSON array now.`));
  assert.match(withNotes, /THE AGENT'S NOTES: C lines are notes/u);
  assert.match(withNotes, /Never cite a C line\./u);
  assert.ok(withNotes.endsWith('{"notes": [{"note": "C1", "outcome": "shown", "shownBy": ["L12"]}], "entries": [{"note": "C1", "kind": ...}, {"kind": ...}]}.\nOutput the JSON object now.'));

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
  ]);
  const op = (note: string | undefined, sources: Array<Record<string, unknown>>) => ({ body: { op: 'add', entry: {}, sources }, topic: '', session: 's', title: 't', ...(note ? { note } : {}) });
  const fromNote = op('C1', [{ kind: 'event', ref: 'event-3', quote: 'The port is read at import.' }]);
  const already = op('C2', [{ kind: 'tool_call', ref: 'call-2' }]);
  const plain = op(undefined, [{ kind: 'event', ref: 'event-3' }]);
  const unnamed = op('C3', [{ kind: 'event', ref: 'event-3' }]);
  wikiMaintainCiteShownBy([fromNote, already, plain, unnamed], new Map([
    ['C1', { outcome: 'shown' as const, shownBy: ['L3', 'L9', 'L1', 'L6', 'L2', 'L4', 'L5'] }],
    ['C2', { outcome: 'narrowed' as const, shownBy: ['L2'] }],
    ['C3', { outcome: 'shown' as const, shownBy: [] }],
  ]), lines);
  assert.deepEqual(fromNote.body.sources, [
    { kind: 'event', ref: 'event-3', quote: 'The port is read at import.' },
    { kind: 'turn', ref: 'turn-1', quote: 'Why does it fail?', locator: { start: 0, end: 17 } },
    { kind: 'tool_call', ref: 'call-2' },
  ], 'the first two first-hand lines it names: an agent line, a comment and a line the case does not have are passed over, and only the owner\'s words are quoted');
  assert.deepEqual(already.body.sources, [{ kind: 'tool_call', ref: 'call-2' }], 'a record it already cites is not cited twice');
  assert.deepEqual(plain.body.sources, [{ kind: 'event', ref: 'event-3' }], 'an entry from no note is left as it is');
  assert.deepEqual(unnamed.body.sources, [{ kind: 'event', ref: 'event-3' }], 'and so is one whose note names no line');
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
  assert.deepEqual(dossier.claims, { seen: 1, skipped: 0, overCap: 0, heldOut: 1, lines: [] });
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
