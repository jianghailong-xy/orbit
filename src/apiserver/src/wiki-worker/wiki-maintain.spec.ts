import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WIKI_MAINTAIN_JOB } from '@orbit/shared';
import type { WikiDossier } from '@orbit/shared';
import {
  buildWikiMaintainOps,
  mergeWikiMaintainBuilt,
  wikiMaintainBatchSize,
  wikiMaintainBreakerHold,
  wikiMaintainLines,
  wikiMaintainOffTopic,
  wikiMaintainOutcomeAt,
  wikiMaintainPlace,
  wikiMaintainPlain,
  wikiMaintainPrompt,
  wikiMaintainRemaining,
  wikiMaintainRetrySuffix,
  wikiMaintainSources,
  wikiMaintainTopicOrder,
  wikiMaintainTopicsOf,
  WIKI_MAINTAIN_SYSTEM_PROMPT,
  type WikiMaintainBatch,
  type WikiMaintainBuilt,
  type WikiMaintainOp,
  type WikiMaintainRepoGate,
} from './wiki-maintain';

/**
 * What the model's part of a server-executed maintenance run makes of an answer (contracts/wiki.contract.json
 * `maintenance.job.server`, `maintenance.job.run.steps`; design §8, P8): the extraction prompt, the off-topic
 * answer, each entry held to its dossier's lines and spans and to the space's snapshot, the one retry with
 * the reasons the first answer was refused, the batches a run proposes in, and the circuit breaker's
 * hold-back over them.
 *
 * The runner does the same in Go (`src/runner-go/wiki_maintain_test.go`); these are its cases, ported.
 */

/** A dossier of three lines, the tool call of the port case with its two spans. */
function portDossier(over: Partial<WikiDossier> = {}): WikiDossier {
  const command = 'go test ./...';
  const output = 'connect ECONNREFUSED 127.0.0.1:9000';
  const text = 'SESSION: 修 fixture 的端口\nanthropic/claude-opus-5 · started 2026-09-20 · status SUCCEEDED\n\n'
    + 'L1 owner: 以后 fixture 里不要写死端口，一律从 fixture 的返回值里取。\n'
    + `L2 tool: $ ${command} → ERR: ${output}\n`
    + 'L3 agent: 根因：src/app.go 在导入时读取 PORT，fixture 之后才设置。\n';
  return {
    sessionId: 'session-1',
    taskId: null,
    title: '修 fixture 的端口',
    text,
    tokens: 200,
    truncated: false,
    tainted: false,
    sources: [
      { ref: 'L1', kind: 'turn', id: 'turn-1', spans: [{ start: 0, end: 27, text: '以后 fixture 里不要写死端口，一律从 fixture 的返回值里取。' }] },
      {
        ref: 'L2',
        kind: 'tool_call',
        id: 'call-2',
        spans: [
          { start: 14, end: 14 + command.length, text: command },
          { start: 28, end: 28 + output.length, text: output },
        ],
      },
      { ref: 'L3', kind: 'event', id: 'event-3', spans: [{ start: 0, end: 36, text: '根因：src/app.go 在导入时读取 PORT，fixture 之后才设置。' }] },
    ],
    hash: 'c'.repeat(64),
    unchanged: false,
    ...over,
  };
}

/** The snapshot's answer, as the anchors are held to it. */
function gate(paths: readonly string[], commits: readonly string[] = []): WikiMaintainRepoGate {
  return {
    anchors(raw: unknown) {
      const given = (raw ?? {}) as { paths?: unknown; commits?: unknown };
      const out: Array<Record<string, string>> = [];
      for (const path of Array.isArray(given.paths) ? given.paths : []) {
        if (typeof path === 'string' && paths.includes(path)) out.push({ type: 'path', path });
      }
      for (const sha of Array.isArray(given.commits) ? given.commits : []) {
        if (typeof sha === 'string' && commits.includes(sha)) out.push({ type: 'commit', sha });
      }
      return out;
    },
  };
}

const TOPICS = wikiMaintainTopicsOf([
  { slug: 'testing', title: '测试', description: 'Tests: fixtures, flakes.' },
  { slug: 'runner', title: 'Runner', description: null },
]);

/** A valid pitfall, as the model would write it. */
function pitfall(title: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'pitfall',
    title,
    summary: 'PORT 必须在导入前设好。',
    topic: 'testing',
    trigger: { paths: ['src/app.go'], commands: ['go test ./...'], errorSignature: 'connect ECONNREFUSED' },
    symptom: '测试报 ECONNREFUSED',
    cause: '导入时读取 PORT',
    fix: 'fixture 返回 url',
    anchors: { paths: ['src/app.go'], commits: [] },
    sources: [{ ref: 'L2', quote: 'connect ECONNREFUSED 127.0.0.1:9000' }],
    verified: true,
    ...over,
  };
}


// ── The ported table: each row is one case of `src/runner-go/wiki_maintain_test.go` ───────────────

/**
 * The runner's own cases, one row each, on one dossier: the same input, the same deterministic answer the Go
 * function gives it. Every row names the Go test it is the port of, so a reviewer can read the two side by side;
 * the checks, the quota (the batch size by mode) and the breaker are the same arithmetic in both.
 */
test('the ported table: each row answers what the Go case it ports answers', () => {
  const dossier = portDossier();
  const lines = wikiMaintainLines(dossier);
  const gateOf = (paths: readonly string[]) => gate(paths);
  const rows: Array<{
    go: string;
    what: string;
    answer: Array<Record<string, unknown>>;
    /** The model's answer as text, for the one row that is not an array of entries. */
    answerText?: string;
    repo: WikiMaintainRepoGate;
    expect: { ops?: number; dropped?: number; foreign?: number; principles?: number; firstSource?: Record<string, unknown> | null };
  }> = [
    {
      go: 'TestWikiMaintainTakesNothingFromASessionAboutSomethingElse',
      what: 'the model says the case is about something else',
      answer: [],
      answerText: '{"offTopic": true}',
      repo: gateOf(['src/app.go']),
      expect: { ops: 0 },
    },
    {
      go: 'TestWikiMaintainQuotesTheRecordsOwnWordsWhereTheLineSaysTheyAre',
      what: 'a quote one of the line\'s spans holds',
      answer: [pitfall('PORT 在导入时读取')],
      repo: gateOf(['src/app.go']),
      expect: {
        ops: 1,
        firstSource: { kind: 'tool_call', ref: 'call-2', quote: 'connect ECONNREFUSED 127.0.0.1:9000', locator: { start: 28, end: 63 } },
      },
    },
    {
      go: 'TestWikiMaintainCitesTheRecordWithoutTheQuoteTheServerDoesNotFind',
      what: 'a quote no span of the line holds: the record is cited, the quote left out',
      answer: [pitfall('PORT 在导入时读取', { sources: [{ ref: 'L2', quote: 'go test ./...' }] })],
      repo: gateOf(['src/app.go']),
      expect: { ops: 1, firstSource: { kind: 'tool_call', ref: 'call-2', quote: 'go test ./...', locator: { start: 14, end: 27 } } },
    },
    {
      go: 'TestWikiMaintainRunsThePipelineAndAdvancesTheCursor (the foreign anchor)',
      what: 'every code anchor points outside the repository',
      answer: [pitfall('游戏面板渲染慢', { anchors: { paths: ['src/components/GameBoard.tsx'], commits: [] } })],
      repo: gateOf(['src/app.go']),
      expect: { ops: 0, foreign: 1, dropped: 0 },
    },
    {
      go: 'TestWikiMaintainRunsThePipelineAndAdvancesTheCursor (the principle)',
      what: 'a principle: the owner\'s alone, counted and never an op',
      answer: [{ kind: 'principle', title: '一切从简', summary: '越简单越好。', statement: '从简', rationale: '少出错' }],
      repo: gateOf(['src/app.go']),
      expect: { ops: 0, principles: 1, dropped: 0 },
    },
    {
      go: 'TestWikiMaintainRunsThePipelineAndAdvancesTheCursor (the rejected entries)',
      what: 'an unknown kind and an unquoted source are dropped, and handed back for the retry',
      answer: [pitfall('bad kind', { kind: 'fact' }), pitfall('bad quote', { sources: [{ ref: 'L2', quote: 'connection refused' }] })],
      repo: gateOf(['src/app.go']),
      expect: { ops: 0, dropped: 2 },
    },
    {
      go: 'TestWikiMaintainExtractsAtMostSixEntriesFromOneSession',
      what: 'two entries of one title are one op',
      answer: [pitfall('PORT 在导入时读取'), pitfall('port 在导入时读取')],
      repo: gateOf(['src/app.go']),
      expect: { ops: 1, dropped: 1 },
    },
  ];
  for (const row of rows) {
    if (row.answerText !== undefined) {
      // The one answer that is not an array: the model saying the case is about something else, which the run
      // reads before any entry is checked (`wikiMaintainOffTopic`).
      assert.equal(wikiMaintainOffTopic(row.answerText), true, row.go);
      continue;
    }
    const built = buildWikiMaintainOps(row.answer, dossier, lines, row.repo, TOPICS, new Date('2026-09-20T00:00:00Z'));
    assert.equal(built.ops.length, row.expect.ops ?? 0, `${row.go}: ops — ${row.what}: ${JSON.stringify(built.problems)}`);
    if (row.expect.dropped !== undefined) assert.equal(built.dropped, row.expect.dropped, `${row.go}: dropped`);
    if (row.expect.foreign !== undefined) assert.equal(built.foreign, row.expect.foreign, `${row.go}: foreign`);
    if (row.expect.principles !== undefined) assert.equal(built.principles, row.expect.principles, `${row.go}: principles`);
    if (row.expect.firstSource !== undefined) {
      assert.deepEqual((built.ops[0].body.sources as unknown[])[0], row.expect.firstSource, `${row.go}: the source`);
    }
  }
  // The quota: the batch size by mode is the contract's `limits.opsPerChangeset` / `opsPerTurn`, as the Go
  // `wikiMaintainBatchSize` reads them.
  assert.equal(wikiMaintainBatchSize('automatic'), 30);
  assert.equal(wikiMaintainBatchSize('tiered'), 30);
  assert.equal(wikiMaintainBatchSize('manual'), 5);
  // The breaker: the same page arithmetic the Go `breaker` makes, and the same arithmetic the pg spec drives
  // end to end (a hundred live entries, the second page held back, the cursor stopped where it starts).
  const batch = (session: string): WikiMaintainBatch => ({ topic: 'testing', ops: [{ body: {}, topic: 'testing', session, title: session }], changes: [true] });
  assert.deepEqual(
    wikiMaintainBreakerHold([batch('s1'), batch('s2')], new Map([['s1', 0], ['s2', 1]]), 2, 1),
    { batches: [batch('s1')], heldBack: 1, stop: 1 },
    'one entry of room: the first page fits, the second is held back and the cursor stops where it starts',
  );
});

// ── The prompt and the off-topic answer ─────────────────────────────────────────────────────────

test('the prompt names the repository, what it is, the topics and the dossier, and asks for the flat array', () => {
  const prompt = wikiMaintainPrompt(
    { title: 'app', repo: { urlNorm: 'github.com/acme/app' }, topics: TOPICS },
    'App is the spec\'s small service that reads a PORT.',
    'L1 owner: hello',
  );
  assert.ok(prompt.startsWith('Below is a CASE FILE: a compressed timeline of one piece of work in the "app" repository'));
  assert.match(prompt, /THE REPOSITORY: "app" \(github\.com\/acme\/app\) — App is the spec's small service/);
  assert.match(prompt, /- testing: Tests: fixtures, flakes\./u);
  assert.match(prompt, /- runner: Runner\n/u, 'a topic with no description falls back to its title');
  assert.match(prompt, /at most 6 objects/u, 'the entry cap is the contract\'s');
  assert.match(prompt, /==== CASE FILE ====\nL1 owner: hello\n==== END OF CASE FILE ====/u);
  assert.equal(WIKI_MAINTAIN_SYSTEM_PROMPT, 'You compile durable engineering knowledge from a coding-agent work record into wiki '
    + 'entries. You output only a JSON array.');
});

test('the off-topic answer is read bare and fenced, and nothing else is', () => {
  assert.equal(wikiMaintainOffTopic('{"offTopic": true}'), true);
  assert.equal(wikiMaintainOffTopic('```json\n{"offTopic": true}\n```'), true);
  assert.equal(wikiMaintainOffTopic('{"offTopic": false}'), false);
  assert.equal(wikiMaintainOffTopic('[]'), false);
  assert.equal(wikiMaintainOffTopic('{"offTopic": true'), false);
});

// ── The dossier's lines ─────────────────────────────────────────────────────────────────────────

test('a line continues over the indented lines under it, and an omission marker ends it', () => {
  const lines = wikiMaintainLines(portDossier({
    text: 'L1 owner: first\n    second\n    third\n   … (2 lines omitted)\nL2 tool: alone\n',
    sources: [
      { ref: 'L1', kind: 'turn', id: 'turn-1', spans: [] },
      { ref: 'L2', kind: 'tool_call', id: 'call-2', spans: [] },
      { ref: 'L9', kind: 'turn', id: 'turn-9', spans: [] },
    ],
  }));
  assert.equal(lines.get('L1')!.text, 'first\nsecond\nthird');
  assert.equal(lines.get('L2')!.text, 'alone');
  assert.equal(lines.get('L9'), undefined, 'a line with no record is no line');
  assert.equal(lines.get('L1')!.kind, 'turn');
  assert.equal(lines.get('L1')!.id, 'turn-1');
});

// ── The plain comparison and the quote's place ──────────────────────────────────────────────────

test('a quote is compared with marks, curly quotes and whitespace read as the demo read them', () => {
  assert.equal(wikiMaintainPlain('a `b` *c*  d'), 'a b c d');
  assert.equal(wikiMaintainPlain('“quoted”  ‘single’'), '"quoted" \'single\'');
});

test('a quote one span holds is placed as the record\'s own words, at the offsets the spans name', () => {
  const spans = [
    { start: 14, end: 26, text: 'go test ./...' },
    { start: 28, end: 66, text: 'connect ECONNREFUSED 127.0.0.1:9000' },
  ];
  const placed = wikiMaintainPlace(spans, 'connect ECONNREFUSED');
  assert.deepEqual(placed, { words: 'connect ECONNREFUSED', start: 28, end: 48 });
  assert.equal(wikiMaintainPlace(spans, 'a quote from nowhere'), null);
  assert.deepEqual(wikiMaintainPlace(spans, '`go test ./...`'), { words: 'go test ./...', start: 14, end: 27 },
    'the marks around the words are not part of the comparison');
  assert.equal(wikiMaintainPlace(spans, 'go test ./....'), null, 'words the span does not hold are not placed');
});

test('a quote whose words the redactor took out is not placed, and one no span holds is not placed', () => {
  assert.equal(wikiMaintainPlace([{ start: 0, end: 21, text: 'the key is [redacted]' }], 'the key is [redacted]'), null);
  assert.equal(wikiMaintainPlace([], 'anything at all'), null);
});

// ── The sources of an entry ─────────────────────────────────────────────────────────────────────

test('a source is a line of the dossier, with its quote copied from it and placed where its spans put it', () => {
  const lines = wikiMaintainLines(portDossier());
  const made = wikiMaintainSources([{ ref: 'L2', quote: 'connect ECONNREFUSED 127.0.0.1:9000' }], lines);
  assert.deepEqual(made.problems, []);
  assert.deepEqual(made.sources, [{
    kind: 'tool_call',
    ref: 'call-2',
    quote: 'connect ECONNREFUSED 127.0.0.1:9000',
    locator: { start: 28, end: 63 },
  }]);
});

test('a quote not copied from the line is a problem, and a line a server says nothing about cites without one', () => {
  const lines = wikiMaintainLines(portDossier());
  assert.deepEqual(
    wikiMaintainSources([{ ref: 'L2', quote: 'connection refused' }], lines).problems,
    ['quote for L2 is not copied exactly from that line'],
  );
  assert.deepEqual(wikiMaintainSources([{ ref: 'L7', quote: 'anything' }], lines).problems, ['source ref L7 is not a line of the case file']);
  assert.deepEqual(wikiMaintainSources([{ ref: 'L2', quote: 'ab' }], lines).problems, ['source L2 has no quote']);

  // A line whose server said nothing of its spans: the line's own words are cited, held to the record by the
  // dry run.
  const older = wikiMaintainLines(portDossier({
    sources: [
      { ref: 'L1', kind: 'turn', id: 'turn-1', spans: [] },
      { ref: 'L2', kind: 'tool_call', id: 'call-2', spans: [] },
      { ref: 'L3', kind: 'event', id: 'event-3', spans: [] },
    ],
  }));
  assert.deepEqual(wikiMaintainSources([{ ref: 'L2', quote: 'go test ./... → ERR: connect ECONNREFUSED 127.0.0.1:9000' }], older).sources,
    [{ kind: 'tool_call', ref: 'call-2', quote: 'go test ./... → ERR: connect ECONNREFUSED 127.0.0.1:9000' }]);
});

test('two sources of one record are one, and the first quote is the one kept', () => {
  const lines = wikiMaintainLines(portDossier());
  const made = wikiMaintainSources([
    { ref: 'L2', quote: 'connect ECONNREFUSED 127.0.0.1:9000' },
    { ref: 'L2', quote: 'go test ./...' },
  ], lines);
  assert.equal(made.sources.length, 1);
  assert.equal(made.sources[0].quote, 'connect ECONNREFUSED 127.0.0.1:9000');
});

// ── The entry checks ────────────────────────────────────────────────────────────────────────────

test('an entry of a known kind with its fields, its quote and a path the snapshot has is kept', () => {
  const built = buildWikiMaintainOps([pitfall('PORT 在导入时读取')], portDossier(), wikiMaintainLines(portDossier()), gate(['src/app.go']), TOPICS,
    new Date('2026-09-20T00:00:00Z'));
  assert.deepEqual(built.problems, []);
  assert.equal(built.ops.length, 1);
  const op = built.ops[0];
  assert.equal(op.body.op, 'add');
  assert.equal(op.topic, 'testing');
  assert.equal(op.session, 'session-1');
  const entry = op.body.entry as Record<string, unknown>;
  assert.equal(entry.kind, 'pitfall');
  assert.deepEqual(entry.topics, ['testing']);
  assert.deepEqual(entry.anchors, [{ type: 'path', path: 'src/app.go' }]);
  assert.deepEqual(built.ops[0].body.sources, [{
    kind: 'tool_call',
    ref: 'call-2',
    quote: 'connect ECONNREFUSED 127.0.0.1:9000',
    locator: { start: 28, end: 63 },
  }]);
  assert.equal(built.extracted, 1);
  assert.equal(built.dropped, 0);
});

test('a principle is the owner\'s: counted and set aside, never an op', () => {
  const built = buildWikiMaintainOps([{ kind: 'principle', title: '一切从简', summary: '越简单越好。', statement: '从简', rationale: '少出错' }],
    portDossier(), wikiMaintainLines(portDossier()), gate([]), TOPICS);
  assert.equal(built.principles, 1);
  assert.equal(built.ops.length, 0);
});

test('an entry whose every code anchor is outside the repository is another repository\'s knowledge', () => {
  const built = buildWikiMaintainOps([pitfall('游戏面板渲染慢', { anchors: { paths: ['src/components/GameBoard.tsx'], commits: [] } })],
    portDossier(), wikiMaintainLines(portDossier()), gate(['src/app.go']), TOPICS);
  assert.equal(built.foreign, 1);
  assert.equal(built.ops.length, 0);
  assert.deepEqual(built.problems, [], 'an entry left out for being foreign is not a problem to retry');
});

test('an unknown kind, a missing field and an unquoted source are problems, and the entry becomes no op', () => {
  const built = buildWikiMaintainOps([
    pitfall('bad kind', { kind: 'fact' }),
    pitfall('no summary', { summary: '' }),
    pitfall('bad quote', { sources: [{ ref: 'L2', quote: 'connection refused' }] }),
  ], portDossier(), wikiMaintainLines(portDossier()), gate(['src/app.go']), TOPICS);
  assert.equal(built.ops.length, 0);
  assert.equal(built.extracted, 3);
  assert.equal(built.dropped, 3);
  assert.ok(built.problems.some((problem) => problem.includes('is not one of convention, decision, pitfall, recipe, concept')));
  assert.ok(built.problems.some((problem) => problem.includes('summary is missing')));
  assert.ok(built.problems.some((problem) => problem.includes('quote for L2 is not copied exactly from that line')));
  assert.equal(built.rejected.length, 3, 'every rejected entry is handed back for the retry');
});

test('two entries of one title are one op, and the second is dropped', () => {
  const built = buildWikiMaintainOps([pitfall('PORT 在导入时读取'), pitfall('port 在导入时读取')],
    portDossier(), wikiMaintainLines(portDossier()), gate(['src/app.go']), TOPICS);
  assert.equal(built.ops.length, 1);
  assert.equal(built.dropped, 1);
});

test('a topic the space does not have leaves the entry with none', () => {
  const built = buildWikiMaintainOps([pitfall('PORT 在导入时读取', { topic: 'werewolf' })],
    portDossier(), wikiMaintainLines(portDossier()), gate(['src/app.go']), TOPICS);
  assert.equal(built.ops.length, 1);
  assert.equal(built.ops[0].topic, '');
  assert.equal((built.ops[0].body.entry as Record<string, unknown>).topics, undefined);
});

test('the required fields are filled from the entry or its nested `fields`, and the dossier\'s date is the default', () => {
  const built = buildWikiMaintainOps([pitfall('A decision', {
    kind: 'decision',
    context: 'the context',
    decision: 'the decision',
    alternatives: [{ option: 'a', whyRejected: 'because' }],
    consequences: 'none',
    decidedAt: '',
  })], portDossier(), wikiMaintainLines(portDossier()), gate(['src/app.go']), TOPICS);
  assert.deepEqual(built.problems, []);
  const fields = (built.ops[0].body.entry as Record<string, unknown>).fields as Record<string, unknown>;
  assert.equal(fields.decidedAt, '2026-09-20', 'the dossier\'s own date');
});

test('the retry suffix names the problems and the rejected entries, and asks for the array alone', () => {
  const built: WikiMaintainBuilt = { ops: [], rejected: [{ kind: 'fact' }], problems: ['entry "x": kind "fact" is not one'], extracted: 1, dropped: 1, foreign: 0, principles: 0, titles: new Set() };
  const suffix = wikiMaintainRetrySuffix('the answer', true, built);
  assert.match(suffix, /SOME ENTRIES IN YOUR ANSWER WERE REJECTED/);
  assert.match(suffix, /\[\{"kind":"fact"\}\]/u);
  assert.match(suffix, /entry "x": kind "fact" is not one/u);
  const unparsed = wikiMaintainRetrySuffix('not json at all', false, built);
  assert.match(unparsed, /the output was not a valid JSON array of flat entry objects/);
  assert.match(unparsed, /not json at all/);
});

test('a retry\'s corrected entries take the place of the ones they corrected', () => {
  const first = buildWikiMaintainOps([pitfall('bad quote', { sources: [{ ref: 'L2', quote: 'connection refused' }] })],
    portDossier(), wikiMaintainLines(portDossier()), gate(['src/app.go']), TOPICS);
  assert.equal(first.dropped, 1);
  const retry = buildWikiMaintainOps([pitfall('bad quote')], portDossier(), wikiMaintainLines(portDossier()), gate(['src/app.go']), TOPICS);
  mergeWikiMaintainBuilt(first, retry);
  assert.equal(first.ops.length, 1);
  assert.equal(first.dropped, 0, 'the correction is not also a drop');
});

// ── Batches and the breaker ─────────────────────────────────────────────────────────────────────

test('the batch size is the contract\'s by mode, and the topics are taken in their own order', () => {
  assert.equal(wikiMaintainBatchSize('automatic'), WIKI_MAINTAIN_JOB.opsPerChangeset);
  assert.equal(wikiMaintainBatchSize('tiered'), WIKI_MAINTAIN_JOB.opsPerChangeset);
  assert.equal(wikiMaintainBatchSize('manual'), WIKI_MAINTAIN_JOB.opsPerTurn);
  const op = (topic: string, session: string): WikiMaintainOp => ({ body: {}, topic, session, title: topic });
  assert.deepEqual(wikiMaintainTopicOrder([op('runner', 's'), op('testing', 's'), op('runner', 's')]), ['runner', 'testing']);
});

test('what the run may still change is the dry run\'s reading, else the share of the active entries', () => {
  assert.deepEqual(wikiMaintainRemaining({ remaining: 3 }, { activeEntries: 100, breaker: { minActiveEntries: 100, maxChangedPercent: 10 } }),
    { remaining: 3, bounded: true });
  assert.deepEqual(wikiMaintainRemaining({ remaining: null }, { activeEntries: 100, breaker: { minActiveEntries: 100, maxChangedPercent: 10 } }),
    { remaining: 0, bounded: false }, 'a reading that bounds nothing bounds nothing here either');
  assert.deepEqual(wikiMaintainRemaining(null, { activeEntries: 100, breaker: { minActiveEntries: 100, maxChangedPercent: 10 } }),
    { remaining: 10, bounded: true });
  assert.deepEqual(wikiMaintainRemaining(null, { activeEntries: 99, breaker: { minActiveEntries: 100, maxChangedPercent: 10 } }),
    { remaining: 0, bounded: false }, 'below the floor there is no breaker at all');
});

test('the breaker holds back every op from the first page that does not fit, and the cursor stops there', () => {
  const op = (session: string, title: string): WikiMaintainOp => ({ body: {}, topic: 'testing', session, title });
  const batches: WikiMaintainBatch[] = [
    { topic: 'testing', ops: [op('s1', 'a'), op('s2', 'b')], changes: [true, true] },
    { topic: 'runner', ops: [op('s3', 'c'), op('s4', 'd')], changes: [true, false] },
  ];
  const pageOf = new Map([['s1', 0], ['s2', 0], ['s3', 1], ['s4', 2]]);
  // Two entries may still change: page 0 needs two and fits; page 1's needs one more, so it is held back.
  const held = wikiMaintainBreakerHold(batches, pageOf, 3, 2);
  assert.equal(held.stop, 1);
  assert.equal(held.heldBack, 2, 'the op of page 1 and the unchanged one of page 2 are both held back');
  assert.deepEqual(held.batches.map((batch) => batch.ops.map((one) => one.title)), [['a', 'b']]);
  // Everything fits: nothing is held back and no cursor stops.
  assert.deepEqual(wikiMaintainBreakerHold(batches, pageOf, 3, 10), { batches, heldBack: 0, stop: null });
});

test('an answer\'s outcomes are read by position, with the first refusal\'s code and message', () => {
  const ops = [
    { seq: 0, status: 'pending', waitsFor: 'verification', entryId: 'e-1' },
    { seq: 1, status: 'refused', reasons: [{ code: 'WIKI_QUOTA', message: 'circuit breaker: this run has already changed 10 of the 100' }] },
    { seq: 2, status: 'applied', entryId: 'e-2' },
  ];
  assert.deepEqual(wikiMaintainOutcomeAt(ops, 0), { status: 'pending', code: '', message: '', waitsFor: 'verification' });
  assert.equal(wikiMaintainOutcomeAt(ops, 1).code, 'WIKI_QUOTA');
  assert.equal(wikiMaintainOutcomeAt(ops, 2).status, 'applied');
  assert.equal(wikiMaintainOutcomeAt(ops, 9).status, '', 'no answer at all is no status');
  assert.equal(wikiMaintainOutcomeAt([], 0).status, '');
});
