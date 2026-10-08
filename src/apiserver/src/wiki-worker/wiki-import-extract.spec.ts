import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WIKI_IMPORT_JOB } from '@orbit/shared';

import {
  buildWikiImportOps,
  collapseWhitespace,
  mergeWikiImportRetry,
  parseWikiImportAnswer,
  wikiImportNoteGives,
  wikiImportNoteLanguage,
  wikiImportOpFrom,
  wikiImportPrompt,
  wikiImportQuote,
  wikiImportRetrySuffix,
  WikiImportRepo,
  type WikiImportNote,
} from './wiki-import-extract';
import { wikiImportIdempotencyKey, wikiImportRationale, wikiImportRepoName, wikiImportSnapshotOpId } from './wiki-import-job';

/**
 * What the server's import makes of a note (wiki-import-extract.ts), case for case the unit cases of
 * `src/runner-go/wiki_import_test.go`: the answer read however it comes, the quote cited in the note's own
 * words, each entry held to its kind's fields, a verify command only as the note writes it, a note's language
 * read from its prose — and, where the server differs from the runner, the anchors held to the space's snapshot
 * instead of a checkout. The end-to-end cases (the job against PostgreSQL and a fake System model) are
 * wiki-import-job.pg.spec.ts; what both implementations must answer byte for byte is wiki-import-golden.spec.ts.
 */

const note = (over: Partial<WikiImportNote> = {}): WikiImportNote => ({
  id: 'note-9', path: 'memory/x.md', date: '2026-09-20', text: "the note's text: run `make`", lang: '', ...over,
});

const entryOf = (op: { body: Record<string, unknown> } | null): Record<string, unknown> =>
  (op?.body.entry ?? {}) as Record<string, unknown>;

// ── TestWikiImportReadsTheModelsAnswerTheWayItComes ─────────────────────────────────────────────────────────

test('the answer is read the way it comes: bare, in a fence, after reasoning, wrapped, with a trailing comma or a bare quote', () => {
  const entry = '{"kind":"concept","title":"A","summary":"B","definition":"C","boundaries":"D","quote":"E"}';
  const answers: Record<string, string> = {
    bare: `[${entry}]`,
    'in a fence': `\`\`\`json\n[${entry}]\n\`\`\``,
    'after some reasoning': `Let me think about the note [first] step.\n[${entry}]`,
    wrapped: `{"entries":[${entry}]}`,
    'with a trailing comma': `[${entry},]`,
    'with a bare quote': '[{"kind":"concept","title":"A","summary":"B","definition":"C","boundaries":"D","quote":"he said "stop" twice"}]',
  };
  for (const [name, answer] of Object.entries(answers)) {
    const entries = parseWikiImportAnswer(answer);
    assert.ok(entries && entries.length === 1 && entries[0]?.title === 'A', `${name}: parsed ${JSON.stringify(entries)}`);
  }
  assert.equal(parseWikiImportAnswer('with a bare quote'), null);
  const bare = parseWikiImportAnswer(answers['with a bare quote']);
  assert.equal(bare?.[0]?.quote, 'he said "stop" twice', 'the repaired quote keeps its words');
  assert.deepEqual(parseWikiImportAnswer('Nothing here is worth keeping.\n[]'), [], '[] is an answer of no entries');
  for (const answer of ['I cannot tell.', '{"verdict":"supported"}', '[1, 2, 3]']) {
    assert.equal(parseWikiImportAnswer(answer), null, `${answer} read as entries`);
  }
});

test("the answer is read as Go's encoding/json reads it: a lone surrogate is U+FFFD, a number past float64 is no parse", () => {
  // P10's boundary probes (zz_p10_parity_test.go), where JSON.parse alone answers differently from the
  // runner's decoder: it keeps a lone surrogate and turns 1e999 into Infinity, Go writes U+FFFD and fails.
  const lone = parseWikiImportAnswer('[{"kind":"concept","title":"half \\ud83d of a pair","summary":"B","definition":"C","boundaries":"D","quote":"E"}]');
  assert.ok(lone && lone.length === 1, `the lone-surrogate answer parses: ${JSON.stringify(lone)}`);
  assert.equal(lone?.[0]?.title, 'half \ufffd of a pair', 'a lone surrogate is U+FFFD, as Go decodes it');
  const pair = parseWikiImportAnswer('[{"kind":"concept","title":"a \\ud83d\\ude00 pair","summary":"B","definition":"C","boundaries":"D","quote":"E"}]');
  assert.equal(pair?.[0]?.title, 'a \ud83d\ude00 pair', 'a whole pair stays');
  assert.equal(
    parseWikiImportAnswer('[{"kind":"recipe","title":"t","summary":"s","steps":["a"],"verify":{"command":"make","expectedExit":1e999}}]'),
    null,
    'a number past float64 fails the whole parse, as Go decodes into one',
  );
});

// ── TestWikiImportCitesTheNotesOwnWords ─────────────────────────────────────────────────────────────────────

test("a quote is the note's own words: as written, or the note's span when the model dropped its marks", () => {
  const text = 'Run `scripts/run-pg-spec.sh`   before you\ntrust a green **pg spec**: “a skip is red”.';
  const cases: Record<string, string> = {
    'Run `scripts/run-pg-spec.sh` before you trust': 'Run `scripts/run-pg-spec.sh` before you trust',
    'Run scripts/run-pg-spec.sh before you trust': 'Run `scripts/run-pg-spec.sh`   before you\ntrust',
    'trust a green pg spec': 'trust a green **pg spec**',
    'Run scripts/run-pg-spec.sh': 'Run `scripts/run-pg-spec.sh`',
    '"a skip is red"': '“a skip is red”',
  };
  for (const [quote, want] of Object.entries(cases)) {
    const got = wikiImportQuote(text, quote);
    assert.equal(got, want, `quote ${JSON.stringify(quote)}`);
    // Whatever is cited, the note holds it — the check the server makes.
    assert.ok(collapseWhitespace(text).includes(collapseWhitespace(got as string)), `${got} is not the note's own words`);
  }
  for (const quote of ['', 'a paraphrase the note never says']) {
    assert.equal(wikiImportQuote(text, quote), null, `quote ${JSON.stringify(quote)}: a quote the note does not hold is left out`);
  }
});

// ── TestWikiImportHoldsEachEntryToItsKindsFields ───────────────────────────────────────────────────────────

test("each entry is held to its kind's fields: cut, defaulted, flat or nested, and refused when it lacks one", () => {
  const decision = {
    kind: 'decision', title: 't'.repeat(150), summary: 's', context: 'c', decision: 'd',
    alternatives: { option: 'o', whyRejected: 'w' }, consequences: 'q', decidedAt: '2026-13-45',
  };
  const made = wikiImportOpFrom(decision, 'decision', note(), null);
  assert.deepEqual(made.problems, []);
  const draft = entryOf(made.op);
  const fields = draft.fields as Record<string, unknown>;
  assert.equal([...(draft.title as string)].length, 120, 'a title cut to 120');
  assert.equal(fields.decidedAt, '2026-09-20', "a date that is not one read as the note's");
  assert.deepEqual(fields.alternatives, [{ option: 'o', whyRejected: 'w' }], 'one alternative a list of one');

  const recipe = {
    kind: 'recipe', title: 't', summary: 's',
    fields: { steps: ['a', ' ', 'b'], verify: { command: 'make', expectedExit: '2' } },
  };
  const madeRecipe = wikiImportOpFrom(recipe, 'recipe', note(), null);
  assert.deepEqual(madeRecipe.problems, []);
  assert.deepEqual(entryOf(madeRecipe.op).fields, { steps: ['a', 'b'], verify: { command: 'make', expectedExit: 2 } },
    'fields nested or flat, blanks left out, an exit code written as text');

  const lacking: Record<string, Record<string, unknown>> = {
    pitfall: { title: 't', summary: 's', trigger: { paths: [] }, symptom: 'a', cause: 'b', fix: 'c' },
    convention: { title: 't', summary: 's', rule: 'r' },
    concept: { title: '', summary: 's', definition: 'd', boundaries: 'b' },
    assumption: { title: 't', summary: 's' },
  };
  for (const [kind, entry] of Object.entries(lacking)) {
    assert.ok(wikiImportOpFrom(entry, kind, note(), null).problems.length > 0, `a ${kind} missing what it needs was let through`);
  }
});

test('an op is an add citing its note, with the quote it holds, and the anchors only when the repository has them', () => {
  const made = wikiImportOpFrom(
    { kind: 'convention', title: 'Reply in Chinese', summary: 'Answer in Chinese.', rule: 'Reply in Chinese', scope: 'every reply', exceptions: '',
      quote: 'run `make`', anchors: { paths: ['src/app/main.go'], commits: [] } },
    'convention', note(), null,
  );
  assert.deepEqual(made.op?.body, {
    op: 'add',
    entry: { kind: 'convention', title: 'Reply in Chinese', summary: 'Answer in Chinese.', fields: { rule: 'Reply in Chinese', scope: ['every reply'] } },
    sources: [{ kind: 'note', ref: 'note-9', quote: 'run `make`' }],
  }, 'a lone scope is a list of one, a blank exception is left out, and with no snapshot there are no anchors at all');
});

// ── TestWikiImportReadsANotesLanguageFromItsProse ──────────────────────────────────────────────────────────

test("a note's language is read from its prose: frontmatter, code and links left out", () => {
  const cases: Record<string, string> = {
    '发版前先核对 `origin/main`，再跑 `.claude/skills/release/release.sh next`。': 'Chinese',
    '---\nname: x\ndescription: 中文的描述\n---\nThe body is English prose about the release script, with one word in Chinese: 发版.\n': '',
    '```\n中文 inside a code block only\n```\nThe rest is English prose about the release script.': '',
    'Run it twice.': '',
    '': '',
  };
  for (const [text, want] of Object.entries(cases)) assert.equal(wikiImportNoteLanguage(text), want, JSON.stringify(text));
});

// ── TestWikiImportTakesAVerifyCommandOnlyAsTheNoteWritesIt ─────────────────────────────────────────────────

test('a verify command is taken only as the note writes it, in its code', () => {
  const withCode = note({
    id: 'note-7',
    text: '开工先在 main 上取 full-api 基线，见 [[full-api-red-on-main]]：\n```bash\n$ npm run test:full-api   -- --main\n```\n再跑 `git status --short`。\n',
  });
  const recipe = (command: string) => ({ kind: 'recipe', title: '取基线', summary: 's', steps: ['a'], verify: { command, expectedExit: 0 } });
  for (const command of ['npm run test:full-api -- --main', '$ npm run test:full-api -- --main', 'git status --short']) {
    assert.deepEqual(wikiImportOpFrom(recipe(command), 'recipe', withCode, null).problems, [], `the note's own command ${command} was refused`);
  }
  // A description, a command the note never writes, and two spans of its prose that are no command.
  for (const command of ['full-api on main', 'npm run test:full-api -- --branch', '见 [[full-api-red-on-main]]', 'full-api-red-on-main']) {
    const { problems } = wikiImportOpFrom(recipe(command), 'recipe', withCode, null);
    assert.equal(problems.length, 1, command);
    assert.match(problems[0], /is not a command the note gives/u);
  }
  assert.equal(wikiImportNoteGives('no code here', 'make'), false);
});

// ── TestWikiImportAsksOnceMoreWithWhatWasWrong, the parts that are no model's ──────────────────────────────

test('what does not hold up is named for the one retry, and a correction joins the entries that held', () => {
  const first = buildWikiImportOps([
    { kind: 'convention', title: 'Keep it', summary: 's', rule: 'Keep it' },
    { kind: 'concept', title: 'Also', summary: 's', definition: 'd', boundaries: 'b' },
    { kind: 'principle', title: 'Secrets are never stored', summary: 'x' },
    { kind: 'concept', title: 'also', summary: 's', definition: 'd', boundaries: 'b' },
  ], note(), null);
  assert.equal(first.ops.length, 1);
  assert.equal(first.principles, 1, 'a principle is counted, never proposed');
  assert.equal(first.dropped, 2, 'the entry that did not hold up, and a second of one title');
  assert.deepEqual(first.problems, ['entry "Keep it": scope is missing']);
  const suffix = wikiImportRetrySuffix('[...]', true, first);
  assert.match(suffix, /SOME ENTRIES IN YOUR ANSWER WERE REJECTED:\n\[\{"kind":"convention","rule":"Keep it","summary":"s","title":"Keep it"\}\]/u);
  assert.match(suffix, /PROBLEMS:\n- entry "Keep it": scope is missing\n/u);
  assert.match(wikiImportRetrySuffix('I would rather not.', false, first), /YOUR ANSWER WAS NOT A JSON ARRAY OF FLAT ENTRY OBJECTS:\nI would rather not\./u);

  mergeWikiImportRetry(first, buildWikiImportOps([{ kind: 'convention', title: 'Keep it', summary: 's', rule: 'Keep it', scope: ['here'] }], note(), null));
  assert.deepEqual(first.ops.map((op) => entryOf(op).title), ['Also', 'Keep it'], 'the corrected entry joins the one that held up');
  assert.equal(first.dropped, 1, 'the correction is no longer dropped');
});

// ── TestWikiImportTitlesAChineseNotesEntriesInChinese, the parts that are no model's ───────────────────────

test("a Chinese note's prompt says so last, and an English title for it is sent back", () => {
  const zh = note({ path: 'memory/feedback-zh.md', text: '发版前先核对 `origin/main`：别直接给会话分支打 tag，否则客户端会倒退。\n' });
  zh.lang = wikiImportNoteLanguage(zh.text);
  const en = note({ path: 'memory/feedback-en.md', text: 'Check `origin/main` before tagging a release.\n' });
  const line = 'This note is written in Chinese: write every title, summary and text field in Chinese';
  assert.ok(wikiImportPrompt(zh).includes(line));
  assert.ok(wikiImportPrompt(zh).endsWith('keep code, paths and commands verbatim.\nOutput the JSON array now.'));
  assert.ok(!wikiImportPrompt(en).includes(line));
  assert.ok(wikiImportPrompt(en).includes('==== NOTE (memory/feedback-en.md, 2026-09-20) ====\nCheck `origin/main` before tagging a release.\n\n==== END OF NOTE ===='));
  const built = buildWikiImportOps([
    { kind: 'convention', title: 'Check origin/main before a release', summary: '别给会话分支打 tag。', rule: '先核对 origin/main 再打 tag', scope: ['发版'] },
  ], zh, null);
  assert.deepEqual(built.problems, ['entry "Check origin/main before a release": title is not in the note\'s language: the note is written in Chinese, so write the title in Chinese']);
});

// ── The anchors: the runner's checks, held to the space's snapshot ─────────────────────────────────────────

const HEAD = '1f3e5a7c9b2d4f6e8a0c1e3f5a7b9d1c3e5f7a9b';
const OTHER = '1f3e5a7d00000000000000000000000000000000';
const repo = new WikiImportRepo(
  { files: ['src/app/main.go', 'docs/guide.md'], commits: [HEAD, OTHER, 'abcdef0123456789abcdef0123456789abcdef01'] },
  '/home/me/checkouts/orbit-fork',
  'orbit',
);

test("a path anchor is the snapshot tree's: relative, read inside the checkout, a worktree or the repository's directory", () => {
  const cases: Record<string, string | null> = {
    'src/app/main.go': 'src/app/main.go',
    '/root/orbit/docs/guide.md': 'docs/guide.md',
    '/root/.orbit/worktrees/0e2c/src/app/main.go': 'src/app/main.go',
    '/home/me/checkouts/orbit-fork/docs/guide.md': 'docs/guide.md',
    '~/code/orbit/src/app': 'src/app',
    '`src/app/main.go:12-20`': 'src/app/main.go',
    './docs/': 'docs',
    'src/does/not/exist.go': null,
    '/etc/passwd': null,
    '': null,
  };
  for (const [raw, want] of Object.entries(cases)) assert.equal(repo.path(raw), want, JSON.stringify(raw));
});

test("a commit anchor is one origin/main reaches, named in full: a prefix names exactly one of them", () => {
  assert.equal(repo.commit(HEAD), HEAD);
  assert.equal(repo.commit(HEAD.slice(0, 9).toUpperCase()), HEAD, 'a short sha, any case, is the commit it names');
  assert.equal(repo.commit('1f3e5a7'), null, 'a prefix two reachable commits share names neither');
  assert.equal(repo.commit('0000000'), null, 'a sha that names no reachable commit');
  assert.equal(repo.commit('abc12'), null, 'fewer than seven characters is no sha');
  assert.equal(repo.commit('not-a-sha'), null);
  assert.deepEqual(
    repo.anchors({ paths: ['src/app/main.go', '/root/orbit/docs/guide.md', 'src/does/not/exist.go', 'src/app/main.go'], commits: [HEAD.slice(0, 9), '0000000'] }),
    [
      { type: 'path', path: 'src/app/main.go' },
      { type: 'path', path: 'docs/guide.md' },
      { type: 'commit', sha: HEAD },
    ],
    'only the anchors the snapshot has: the paths it holds, made relative, and its commit in full; the made-up path and a sha that names no commit are gone',
  );
  assert.deepEqual(repo.anchors('nothing'), []);
});

test("the repository's name for a note's absolute paths is the space's repository's, else the checkout's", () => {
  assert.equal(wikiImportRepoName('github.com/wikova/orbit', '/x/y'), 'orbit');
  assert.equal(wikiImportRepoName('github.com/wikova/orbit.git', ''), 'orbit');
  assert.equal(wikiImportRepoName(null, '/home/me/checkouts/orbit-fork'), 'orbit-fork');
  assert.equal(wikiImportRepoName(null, ''), '');
});

// ── The proposal's own words ───────────────────────────────────────────────────────────────────────────────

test('a batch is proposed under a key made of the space and the ops, and says what read it', () => {
  const ops = [{ op: 'add', entry: { title: 'A', kind: 'concept' }, sources: [{ kind: 'note', ref: 'n1' }] }];
  const key = wikiImportIdempotencyKey('space-1', ops);
  assert.match(key, /^wiki-import:[0-9a-f]{40}$/u);
  assert.equal(wikiImportIdempotencyKey('space-1', [{ sources: [{ ref: 'n1', kind: 'note' }], entry: { kind: 'concept', title: 'A' }, op: 'add' }]), key,
    'the same ops are the same key however their keys were ordered');
  assert.notEqual(wikiImportIdempotencyKey('space-2', ops), key);
  assert.equal(wikiImportRationale('qwen3', ['memory/a.md', 'memory/b.md'], 3), 'orbit wiki import: 3 entries the System model (qwen3) read in 2 notes: memory/a.md, memory/b.md');
  assert.equal(wikiImportRationale('qwen3', ['1', '2', '3', '4', '5', '6', '7'], 1), 'orbit wiki import: 1 entry the System model (qwen3) read in 7 notes: 1, 2, 3, 4, 5, and 2 more');
  assert.match(wikiImportSnapshotOpId('0b8f5e2c-1111-4222-8333-444455556666'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(wikiImportSnapshotOpId('a'), wikiImportSnapshotOpId('a'), "one job's snapshot operation is always the same row");
  assert.equal(WIKI_IMPORT_JOB.systemPrompt.startsWith('You compile durable engineering knowledge'), true);
});
