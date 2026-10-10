import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WIKI_DOC_BUILD_RULES, WIKI_DOCS_BUILD_JOB, type WikiDocMaterialRecord } from '@orbit/shared';

import {
  runWikiDocsBuild,
  WikiDocsCallFailed,
  WikiDocsWriteRefused,
  type WikiDocsBuildDeps,
  type WikiDocsBuildOptions,
  type WikiDocsStoredSection,
  type WikiDocsWriteAnswer,
  type WikiDocsWriteRequest,
} from './wiki-docs-build';
import { WikiDocsSnapshotRepo } from './wiki-docs-build-job';
import { WIKI_DOCS_BUILD_SYSTEM_PROMPT, wikiDocCleanPath, type WikiDocRepo, type WikiDocShown, type WikiDocsPlanDoc, type WikiDocViewForOverview } from './wiki-docs-writer';

/**
 * A build of a space's documents on the server (wiki-docs-build.ts), case for case the end-to-end cases of
 * `src/runner-go/wiki_docs_build_test.go`: the same confirmed plan (an overview, a mechanism with a design document,
 * code and a contract, and conventions with a session condition), the same records, the same files at the commit,
 * and the same scripted model — each answer naming the section by its title, as the prompt gives it. Where the
 * runner's test read a git checkout and a door over HTTP, these read a repository and a server in memory; where it
 * spawned a clean Claude Code, these hand the call to the queue's stand-in. What both implementations must answer
 * byte for byte is wiki-docs-build-golden.spec.ts; the job against PostgreSQL is wiki-docs-build-job.pg.spec.ts.
 */

// ── The confirmed plan ──────────────────────────────────────────────────────────────────────────

const empty = { docs: [], code: [], contracts: [], sessions: null };

function plan(): WikiDocsPlanDoc[] {
  const section = (key: string, title: string, kind: string, sources: WikiDocsPlanDoc['sections'][number]['sources']) => ({
    key, title, kind, covers: `${title}讲什么。`, length: 400, sources,
  });
  return [{
    slug: 'session-runtime',
    title: '会话运行模型',
    question: '一个会话怎么运转？',
    audience: ['新加入的开发者：读完能讲清一轮怎么投递'],
    sections: [
      section('s1', '总览', 'overview', { ...empty }),
      section('s2', 'turn 怎么投递', 'flow', {
        docs: [{ path: 'docs/design.md', section: '2. Delivery' }],
        code: [{ path: 'src/runloop.go', symbols: ['runLoop'] }],
        contracts: [{ path: 'contracts/session.contract.json' }],
        sessions: null,
      }),
      section('s3', '约定', 'conventions', {
        docs: [], code: [], contracts: [],
        sessions: {
          projects: [{ id: '01a0e39d-4375-7280-8aad-5200529cdec3' }],
          since: '2026-09-01', until: null, keywords: ['runner 宿主'], anchorPaths: ['src/'],
          entryKinds: ['convention'], topics: [], evidence: 'owner 说测试在哪跑',
        },
      }),
    ],
  }];
}

// The records the server hands out for s3: the owner's words, the settlement card's template (from the owner's
// client, so they read as the owner's), a delivery comment and the same comment again, a command's output found
// through an entry, and a record the merge will drop.
const OWNER_WORDS = '全量测试在 runner 宿主上跑，别在引擎的 Bash 里跑。';
const TEMPLATE_TURN = 'About “Runner 托管后台作业” — Orbit has not recorded it done. Every criterion is met.\n\nBlocked:\n(no criterion is individually blocked)';
const DELIVERY = '交付：在 runner 宿主上跑完整包，env -u 清掉会话变量后 0 FAIL。';
const OUTPUT = '$ go test ./...\nok  orbit 412.7s\nthe suite ran on the runner host: 0 FAIL';
const OFF_TOPIC = '今天午饭吃了面。';

function record(kind: string, ref: string, weight: string, owner: boolean, text: string, via: WikiDocMaterialRecord['via']): WikiDocMaterialRecord {
  const length = Array.from(text).length;
  return {
    kind, ref, found: via ? 'entry' : 'search', via, weight, ownerWords: owner, label: 'message', at: '2026-09-20T10:00:00.000Z',
    sessionId: 'sess-1', sessionTitle: '协调会话', taskId: null, taskTitle: null, projectId: null, projectTitle: 'Runner 托管后台作业',
    notePath: null, text, chars: { start: 0, end: length }, length,
  } as unknown as WikiDocMaterialRecord;
}

function material(): WikiDocMaterialRecord[] {
  const via = { entryId: 'entry-1', title: '全量测试在宿主上跑', kind: 'convention', quote: 'the suite ran on the runner host' } as WikiDocMaterialRecord['via'];
  return [
    record('turn', 'turn-owner', 'decision', true, OWNER_WORDS, null),
    record('turn', 'turn-template', 'decision', true, TEMPLATE_TURN, null),
    record('task_comment', 'comment-1', 'merge', false, DELIVERY, null),
    record('task_comment', 'comment-2', 'merge', false, DELIVERY, null),
    record('tool_call', 'call-1', 'output', false, OUTPUT, via),
    record('turn', 'turn-lunch', 'decision', true, OFF_TOPIC, null),
  ];
}

// ── The repository at the commit ────────────────────────────────────────────────────────────────

const DESIGN = '# Design\n\n## 1. Transport\n\nThe runner polls the server over outbound HTTP; no inbound port is needed.\n\n'
  + '## 2. Delivery\n\nA turn is stored before it is delivered, and delivered at least once.\nDelivery is idempotent on the turn\'s id.\n\n'
  + '### 2.1 Retries\n\nA lost delivery is retried after the lease expires.\n\n## 3. Recovery\n\nSeq stays monotonic across respawn.\n';
const RUNLOOP = 'package main\n\n// runLoop claims work from the server and keeps the heartbeat going.\n// It never opens an inbound port.\n'
  + 'func runLoop() {\n\tfor {\n\t\tclaim()\n\t}\n}\n\n// claim asks the server for the next session.\nfunc claim() {}\n';
const CONTRACT = '{\n  "name": "session",\n  "delivery": "at least once, idempotent on the turn id"\n}\n';

function files(over: Record<string, string> = {}): Record<string, string> {
  return { 'docs/design.md': DESIGN, 'src/runloop.go': RUNLOOP, 'contracts/session.contract.json': CONTRACT, ...over };
}

/** The checkout at one commit, in memory: what `git show <sha>:<path>` and `git ls-tree` would answer. */
class MemoryRepo implements WikiDocRepo {
  readonly prepared: string[] = [];

  constructor(readonly sha: string, private readonly contents: Record<string, string>) {}

  show(raw: string): WikiDocShown | null {
    const path = wikiDocCleanPath(raw);
    if (path === '') return null;
    if (path in this.contents) return { text: this.contents[path], cut: false };
    return null;
  }

  under(dir: string): string[] {
    const prefix = `${wikiDocCleanPath(dir).replace(/\/$/u, '')}/`;
    return Object.keys(this.contents).sort().filter((path) => path.startsWith(prefix));
  }
}

const HEAD = 'a'.repeat(40);

// ── The model ───────────────────────────────────────────────────────────────────────────────────

// The writer's answers for the two sections: s2 cites the design document, the code (a comment quoted across two
// of its lines) and the contract, with one quote from elsewhere in the design document and one made up; s3 cites
// the owner's words and the delivery comment — first with a paragraph that marks only its last sentence and with
// no quote for the comment, then marked sentence by sentence.
const WRITE_S2 = '### How a turn is delivered\n'
  + 'A turn is stored before it is delivered, and delivered at least once[D1]. The runner takes its work by polling outbound, and opens no '
  + 'inbound port[C1]. The contract writes delivery as at least once, idempotent on the turn id[K1]. The sequence stays monotonic across a '
  + 'respawn[D1][S9], and the priority is still [P0].\n\n'
  + 'Quotes:\n'
  + '[D1] "A turn is stored before it is delivered"\n'
  + '[D1] "Seq stays monotonic across respawn"\n'
  + '[C1] "keeps the heartbeat going. It never opens an inbound port."\n'
  + '[K1] "The contract says delivery is exactly once"\n';
// The owner's words and the delivery comment are Chinese, and quoted as they are: a quote is never translated.
const WRITE_S3_FIRST = '### Conventions\n'
  + "There are two conventions for running. The full suite must run on the `runner host`, never in the engine's Bash. After the whole "
  + 'package has run, look for 0 FAIL[S1][S3].\n\n'
  + 'Quotes:\n[S1] "全量测试在 runner 宿主上跑"\n';
const WRITE_S3_SECOND = '### Conventions\n'
  + "The full suite must run on the `runner host`, never in the engine's Bash[S1]. After the whole package has run, look for 0 FAIL[S3].\n\n"
  + 'Quotes:\n[S1] "全量测试在 runner 宿主上跑"\n';
const REPAIR_S3 = '[S3] "在 runner 宿主上跑完整包"\n';

/** The id the prompt gave the piece whose text begins with `text` (`docsIDOf`). */
function idOf(prompt: string, text: string): string {
  const at = prompt.indexOf(text);
  if (at < 0) return '';
  const headers = [...prompt.slice(0, at).matchAll(/^\[([A-Z]\d+)\] /gmu)];
  return headers.length === 0 ? '' : headers[headers.length - 1][1];
}

/** The fake model's side of a run (`docsModel`): what each prompt is answered with. */
class ScriptedModel {
  readonly prompts: string[] = [];
  readonly calls: Array<{ step: string; unit: string; system: string; prompt: string }> = [];
  write: Record<string, string[]> = { 'turn 怎么投递': [WRITE_S2], 约定: [WRITE_S3_FIRST, WRITE_S3_SECOND] };
  repair: Record<string, string> = { S3: REPAIR_S3 };
  /** Set: every call fails the way it names. */
  failing: 'content' | 'platform' | null = null;

  answer(prompt: string): string {
    const title = /## This section\n«([^»]+)» \(/u.exec(prompt)?.[1] ?? '';
    if (prompt.includes('the "merge"')) {
      const lines = [...prompt.matchAll(/^\[([A-Z]\d+)\] /gmu)].map(([, id]) => {
        if (id === idOf(prompt, OFF_TOPIC)) return `${id} | drop | unrelated to this section`;
        if (id === idOf(prompt, OUTPUT)) return `${id} | merge into ${idOf(prompt, OWNER_WORDS)} | it says the same thing, and the owner's words weigh more`;
        return `${id} | adopt | it is just what this section covers`;
      });
      return `${lines.join('\n')}\nCurrent state:\n- the point this section makes [S1]\n`;
    }
    if (prompt.includes('give the footnotes below their verbatim quotes')) {
      return [...prompt.matchAll(/^## \[([A-Z]\d+)\] marks/gmu)].map(([, id]) => this.repair[id] ?? '').join('');
    }
    if (prompt.includes('(the overview, about')) {
      return '### Overview\nA turn is stored first and delivered after, at least once[F1]. The convention for running is that the full suite runs on '
        + 'the runner host[F4].\n';
    }
    if (prompt.includes('# Task: write the document')) {
      const answers = this.write[title] ?? [];
      if (answers.length === 0) return '';
      return prompt.includes('What was wrong with the last draft') && answers.length > 1 ? answers[1] : answers[0];
    }
    return '?';
  }

  async ask(call: { step: string; unit: string; system: string; prompt: string }): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
    this.prompts.push(call.prompt);
    this.calls.push(call);
    if (this.failing === 'content') throw new WikiDocsCallFailed('the model request ended failed: 400');
    if (this.failing === 'platform') throw new Error("the request waited past its step's limit (180 s)");
    const text = this.answer(call.prompt);
    return { text, inputTokens: Math.ceil(call.prompt.length / 3), outputTokens: Math.ceil(text.length / 2) + 1 };
  }
}

// ── The server ──────────────────────────────────────────────────────────────────────────────────

/** The server's half: what is written, a section's material, the document as written, and the writes. */
class MemoryServer {
  readonly writes: Array<{ slug: string; request: WikiDocsWriteRequest }> = [];
  readonly materialRead: string[] = [];
  readonly viewsRead: string[] = [];
  view: WikiDocViewForOverview | null = null;
  refuse: string | null = null;

  async material(_doc: WikiDocsPlanDoc, key: string) {
    this.materialRead.push(key);
    return key === 's3' ? { records: material(), unresolved: [] } : { records: [], unresolved: [] };
  }

  async readView(slug: string): Promise<WikiDocViewForOverview | null> {
    this.viewsRead.push(slug);
    return this.view;
  }

  async write(slug: string, request: WikiDocsWriteRequest): Promise<WikiDocsWriteAnswer> {
    // The server's schema: a section's footnotes and ledger are lists, empty or not, and never null.
    for (const section of request.sections) {
      assert.ok(Array.isArray(section.footnotes) && Array.isArray(section.dispositions), `${section.key} sends its footnotes and ledger as lists`);
    }
    if (this.refuse) throw new WikiDocsWriteRefused(this.refuse);
    this.writes.push({ slug, request: JSON.parse(JSON.stringify(request)) as WikiDocsWriteRequest });
    return {
      status: 'ok',
      sections: request.sections.map((section) => ({
        key: section.key, outcome: 'written',
        stats: { sentences: 3, footnotes: section.footnotes.length, verified: 0, notFound: 0, noQuote: 0, unresolved: 0, markersDropped: 0, chars: 0 },
      })),
      counts: { sentences: 9, sourced: 8, transition: 1, unsourced: 0, unverified: 0, withdrawn: 0 },
    };
  }

  /** The section of that key as the writes carried it, the last time. */
  written(key: string): WikiDocsWriteRequest['sections'][number] {
    for (let i = this.writes.length - 1; i >= 0; i -= 1) {
      const found = this.writes[i].request.sections.find((section) => section.key === key);
      if (found) return found;
    }
    assert.fail(`section ${key} was never written`);
  }
}

interface Harness {
  model: ScriptedModel;
  server: MemoryServer;
  logs: string[];
}

function harness(): Harness {
  return { model: new ScriptedModel(), server: new MemoryServer(), logs: [] };
}

function build(h: Harness, repo: WikiDocRepo, over: Partial<WikiDocsBuildOptions> = {}) {
  const deps: WikiDocsBuildDeps = {
    repo,
    prepare: async (paths) => {
      if (repo instanceof MemoryRepo) repo.prepared.push(...paths);
    },
    material: (doc, key) => h.server.material(doc, key),
    view: (slug) => h.server.readView(slug),
    write: (slug, request) => h.server.write(slug, request),
    ask: (call) => h.model.ask(call),
    model: 'qwen3.8-27b-fp8',
    log: (message) => h.logs.push(message),
  };
  return runWikiDocsBuild(deps, { spaceId: 'space-1', planVersion: 3, docs: plan(), stored: new Map(), ...over });
}

/** What the server holds after a run: every section at the fingerprint it was written from. */
function storedAfter(h: Harness, stale: Record<string, boolean> = {}): Map<string, Map<string, WikiDocsStoredSection>> {
  const sections = new Map<string, WikiDocsStoredSection>();
  for (const key of ['s1', 's2', 's3']) sections.set(key, { materialSha256: h.server.written(key).materialSha256, stale: stale[key] ?? false });
  return new Map([['session-runtime', sections]]);
}

// ── A run ───────────────────────────────────────────────────────────────────────────────────────

test('each section is written through the queue, the overview last, as the System model at the commit (TestWikiArticleBuildWritesEachSectionThroughACleanClaudeCodeAndTheOverviewLast)', async () => {
  const h = harness();
  const summary = await build(h, new MemoryRepo(HEAD, files()));
  assert.deepEqual(
    [summary.written, summary.failed, summary.unchanged, summary.planVersion, summary.repoSha, summary.model],
    [3, 0, 0, 3, HEAD, 'qwen3.8-27b-fp8'],
  );
  // The server's half: s3's material alone (the only section with a session condition), and one write per section,
  // the overview's last.
  assert.deepEqual(h.server.materialRead, ['s3']);
  const order = h.server.writes.map((write) => write.request.sections[0].key);
  assert.equal(order[2], 's1', 'the overview is written last');
  assert.deepEqual([...order.slice(0, 2)].sort(), ['s2', 's3']);
  for (const { request } of h.server.writes) {
    assert.deepEqual([request.planVersion, request.repoSha, request.model, request.sections.length], [3, HEAD, 'qwen3.8-27b-fp8', 1]);
  }
  // Every call is the writer's: its system prompt and a step of the documents' (their wait limit and budget).
  const steps = new Set(Object.values(WIKI_DOCS_BUILD_JOB.steps));
  for (const call of h.model.calls) {
    assert.equal(call.system, WIKI_DOCS_BUILD_SYSTEM_PROMPT);
    assert.ok(steps.has(call.step as never) && call.step.startsWith('docs_'), `a call of step ${call.step}`);
    assert.match(call.unit, /^session-runtime#s[123]#[0-9a-f]{12}$/u);
  }
  // Merge and write for each of the two sections; s2's made-up contract quote asked about once more; the s3 draft
  // asked again (a paragraph marked only at its end) and its missing quote asked for once; and the overview.
  assert.equal(summary.calls, 3 + 4 + 1, `${h.model.prompts.length} prompts`);
  assert.equal(h.model.prompts.length, 8);
  assert.ok(summary.usage.inputTokens > 0 && summary.usage.outputTokens > 0, 'the usage is counted');
  // The run reports its sections in the plan's order, whatever order they were written in.
  assert.deepEqual(summary.docs[0].sections.map((section) => [section.key, section.outcome]), [['s1', 'written'], ['s2', 'written'], ['s3', 'written']]);
});

// ── The material: its cap, and the platform's template messages ─────────────────────────────────

test('the template messages and a repeated text never reach the model, and say so in the ledger (TestWikiArticleBuildCapsTheMaterialAndFiltersTheTemplateMessages)', async () => {
  const h = harness();
  await build(h, new MemoryRepo(HEAD, files()));
  for (const prompt of h.model.prompts) {
    assert.ok(!prompt.includes('Orbit has not recorded it done'), 'the settlement card\'s template reached the model');
    assert.ok(prompt.split(DELIVERY).length - 1 <= 1, 'the same comment was handed to the model twice');
  }
  const ledger = new Map(h.server.written('s3').dispositions.map((disposition) => [disposition.ref, disposition]));
  assert.equal(ledger.get('turn-template')?.action, 'filtered');
  assert.match(ledger.get('turn-template')?.reason ?? '', /review template message/u);
  assert.equal(ledger.get('comment-2')?.action, 'filtered');
  assert.match(ledger.get('comment-2')?.reason ?? '', /the same original as/u);
});

// ── What became of each piece ───────────────────────────────────────────────────────────────────

test('what became of every piece is written with its section (TestWikiArticleBuildSendsWhatBecameOfEveryPieceWithItsSection)', async () => {
  const h = harness();
  await build(h, new MemoryRepo(HEAD, files()));
  const s3 = h.server.written('s3');
  for (const disposition of s3.dispositions) assert.ok(disposition.reason.trim() !== '', `${disposition.material} has no reason`);
  assert.deepEqual(
    s3.dispositions.map((d) => [d.material, d.kind, d.ref, d.action, d.into ?? '']),
    [
      ['S1', 'turn', 'turn-owner', 'adopt', ''],
      ['S2', 'turn', 'turn-template', 'filtered', ''],
      ['S3', 'task_comment', 'comment-1', 'adopt', ''],
      ['S4', 'task_comment', 'comment-2', 'filtered', ''],
      ['S5', 'tool_call', 'call-1', 'merge', 'S1'],
      ['S6', 'turn', 'turn-lunch', 'drop', ''],
    ],
  );
  // Every piece of s2's material is in its ledger too, a repository piece named by its path and lines.
  assert.deepEqual(
    h.server.written('s2').dispositions.map((d) => `${d.material} ${d.kind} ${d.ref} ${d.action}`),
    [
      'D1 design_doc docs/design.md#L7-14 adopt',
      'C1 code src/runloop.go#L3-9 adopt',
      'K1 contract contracts/session.contract.json#L1-4 adopt',
    ],
  );
  // The overview merges nothing: its material is the other sections as written.
  assert.deepEqual(h.server.written('s1').dispositions, []);
});

// ── The footnotes ───────────────────────────────────────────────────────────────────────────────

test('every footnote gets its verbatim quote; one missing is asked for once more, and a paragraph marked only at its end is written again (TestWikiArticleBuildGivesEveryFootnoteItsVerbatimQuote)', async () => {
  const h = harness();
  await build(h, new MemoryRepo(HEAD, files()));
  const s2 = h.server.written('s2');
  // The body: markers numbered by first appearance, no material id and no quote block left, a marker naming no
  // piece of the section (S9) dropped, and brackets that are the text's own ([P0]) left alone.
  assert.equal(s2.markdown, 'A turn is stored before it is delivered, and delivered at least once[1]. The runner takes its work by polling outbound, and opens '
    + 'no inbound port[2]. The contract writes delivery as at least once, idempotent on the turn id[3]. The sequence stays monotonic across a respawn[1], '
    + 'and the priority is still [P0].');
  assert.equal(s2.footnotes.length, 3);
  for (const footnote of s2.footnotes) {
    assert.ok(footnote.quote !== null && footnote.sha === HEAD && footnote.lines && typeof footnote.verified === 'boolean' && footnote.excerpt && footnote.ref === undefined,
      `a repository footnote = ${JSON.stringify(footnote)}`);
  }
  const [design, code, contract] = s2.footnotes;
  assert.deepEqual([design.kind, design.path, design.section, design.quote], ['design_doc', 'docs/design.md', '2. Delivery', 'A turn is stored before it is delivered']);
  assert.deepEqual([code.kind, code.symbol, code.quote], ['code', 'runLoop', 'keeps the heartbeat going. It never opens an inbound port.']);
  assert.deepEqual([contract.kind, contract.quote], ['contract', 'The contract says delivery is exactly once']);

  // s3: a record's footnote carries its id, the range the server handed out and the entry it came through; the
  // quote the model left out was asked for once more, and the paragraph marked only at its end was written again.
  const s3 = h.server.written('s3');
  assert.equal(s3.markdown, "The full suite must run on the `runner host`, never in the engine's Bash[1]. After the whole package has run, look for 0 FAIL[2].");
  assert.equal(s3.footnotes.length, 2);
  const [owner, comment] = s3.footnotes;
  assert.deepEqual([owner.kind, owner.ref, (owner.chars as { end: number }).end, owner.quote, owner.sha, owner.verified],
    ['turn', 'turn-owner', Array.from(OWNER_WORDS).length, '全量测试在 runner 宿主上跑', undefined, undefined]);
  assert.deepEqual([comment.kind, comment.ref, comment.quote], ['task_comment', 'comment-1', '在 runner 宿主上跑完整包']);
  // s2 and s3 are written side by side, so the repair asked about s3 is found by what it asks about.
  const repair = h.model.prompts.find((prompt) => prompt.includes('give the footnotes below their verbatim quotes') && prompt.includes('## [S3] marks')) ?? '';
  assert.ok(repair.includes('[S3]') && repair.includes(DELIVERY) && !repair.includes('[S1] marks'), `the quote was asked for as ${repair}`);
  const again = h.model.prompts.find((prompt) => prompt.includes('What was wrong with the last draft')) ?? '';
  assert.ok(again.includes('There are two conventions for running'), 'the paragraph marked only at its end was asked about');
  // Every footnote of every section has its quote.
  for (const { request } of h.server.writes) {
    for (const section of request.sections) {
      for (const footnote of section.footnotes) assert.ok(typeof footnote.quote === 'string' && footnote.quote.trim() !== '', `${section.key}: ${JSON.stringify(footnote)}`);
    }
  }
  // The write prompt asks for the quotes, sentence by sentence, and for an abbreviation explained first.
  for (const prompt of h.model.prompts.filter((p) => p.includes('# Task: write the document') && !p.includes('(the overview, about'))) {
    for (const rule of ['Every id that appears in the body must have a line of quote', 'never only once at the end of the paragraph', 'SR50',
      'is explained in half a sentence where it first appears']) assert.ok(prompt.includes(rule), `the write prompt does not say ${rule}`);
  }
});

// ── The repository's quotes, at the commit ──────────────────────────────────────────────────────

test('a repository quote is checked in the file at the commit the run reads, and its lines are where it was found (TestWikiArticleBuildChecksRepositoryQuotesInTheFileAtTheCommit)', async () => {
  const h = harness();
  // origin's main moved: the run reads this commit.
  const moved = 'b'.repeat(40);
  const summary = await build(h, new MemoryRepo(moved, files({
    'docs/design.md': DESIGN.replace('and delivered at least once', 'and delivered at least once, by the lease holder'),
  })));
  assert.equal(summary.repoSha, moved);
  const [design, code, contract] = h.server.written('s2').footnotes;
  // Found where it was taken from: the lines it is on.
  assert.deepEqual([design.verified, design.sha, design.lines], [true, moved, { start: 9, end: 9 }]);
  assert.match(String(design.excerpt), /by the lease holder/u);
  // A comment's words quoted across two lines of it: found with the comment markers off.
  assert.deepEqual([code.verified, code.lines], [true, { start: 3, end: 4 }]);
  // Made up: not found, and said so; its lines the piece it names.
  assert.deepEqual([contract.verified, contract.lines], [false, { start: 1, end: 4 }]);
  for (const footnote of h.server.written('s2').footnotes) assert.equal(footnote.sha, moved);
});

// ── The overview, last; and a section whose material did not change ─────────────────────────────

test('a section whose material did not change is left as it is; the overview is written from what is written (TestWikiArticleBuildLeavesASectionWhoseMaterialDidNotChangeAndWritesTheOverviewFromWhatIsWritten)', async () => {
  const h = harness();
  await build(h, new MemoryRepo(HEAD, files()));
  const first = new Map(['s1', 's2', 's3'].map((key) => [key, h.server.written(key)]));
  // The overview was written from the sections as written: their text with their footnotes as [F<n>], and its own
  // footnotes are theirs — the same originals and the same quotes.
  const overviewPrompt = h.model.prompts.find((prompt) => prompt.includes('(the overview, about')) ?? '';
  for (const want of ['[Section 2: turn 怎么投递]', 'at least once[F1]', '[Section 3: 约定]', '[F1] "A turn is stored before it is delivered"']) {
    assert.ok(overviewPrompt.includes(want), `the overview prompt does not carry ${want}`);
  }
  const s1 = first.get('s1')!;
  assert.equal(s1.markdown, 'A turn is stored first and delivered after, at least once[1]. The convention for running is that the full suite runs on the runner host[2].');
  assert.equal(s1.footnotes.length, 2);
  assert.deepEqual([s1.footnotes[0].path, s1.footnotes[0].quote, s1.footnotes[0].verified], ['docs/design.md', first.get('s2')!.footnotes[0].quote, true]);
  assert.deepEqual([s1.footnotes[1].ref, s1.footnotes[1].quote], ['turn-owner', first.get('s3')!.footnotes[0].quote]);
  assert.ok(s1.footnotes[1].chars, 'the record footnote keeps its range');
  for (const [key, section] of first) assert.match(section.materialSha256, /^[0-9a-f]{64}$/u, `${key}'s fingerprint`);
  assert.notEqual(first.get('s2')!.materialSha256, first.get('s3')!.materialSha256);
  assert.notEqual(first.get('s1')!.materialSha256, first.get('s2')!.materialSha256);

  // Nothing changed: nothing is asked of the model and nothing written — and a new commit that changes nothing a
  // section reads changes no fingerprint.
  const unrelated = new MemoryRepo('c'.repeat(40), files({ 'README.md': 'unrelated\n' }));
  const second = harness();
  let summary = await build(second, unrelated, { stored: storedAfter(h) });
  assert.deepEqual([summary.unchanged, summary.written, summary.calls, second.model.prompts.length, second.server.writes.length], [3, 0, 0, 0, 0]);
  for (const section of summary.docs[0].sections) assert.equal(section.materialSha256, first.get(section.key)!.materialSha256, `${section.key}'s fingerprint moved`);

  // A section a sentence was withdrawn from is written again, though its material is the same; the overview,
  // whose sections' fingerprints did not move, is not.
  const third = harness();
  summary = await build(third, unrelated, { stored: storedAfter(h, { s3: true }) });
  assert.deepEqual(third.server.writes.map((write) => write.request.sections[0].key), ['s3']);
  assert.deepEqual([summary.written, summary.unchanged], [1, 2]);

  // The design document changes where s2 reads it: s2 is written again, and so is the overview, from s2 as just
  // written and from s3 as the server holds it (the document's read).
  const fourth = harness();
  fourth.server.view = storedView();
  summary = await build(fourth, new MemoryRepo('d'.repeat(40), files({ 'docs/design.md': DESIGN.replace('at least once', 'at least once, and acknowledged') })), { stored: storedAfter(h) });
  assert.deepEqual(fourth.server.writes.map((write) => write.request.sections[0].key), ['s2', 's1']);
  assert.deepEqual([summary.written, summary.unchanged], [2, 1]);
  assert.notEqual(fourth.server.written('s2').materialSha256, first.get('s2')!.materialSha256, 's2\'s fingerprint moved with its design document');
  assert.deepEqual(fourth.server.viewsRead, ['session-runtime'], 'the overview read the sections it left alone');
  assert.ok(fourth.server.written('s1').footnotes.some((footnote) => footnote.ref === 'turn-owner' && JSON.stringify(footnote.chars) === JSON.stringify({ start: 0, end: 16 })),
    'the overview\'s footnotes carry s3\'s as the server holds them');
});

/** The document as the server holds it after the first run: s3's one sentence (`docsBuildView`). */
function storedView(): WikiDocViewForOverview {
  return {
    sections: [
      { key: 's1', written: true, blocks: [] },
      { key: 's2', written: true, blocks: [] },
      { key: 's3', written: true, blocks: [{ kind: 'paragraph', text: null, sentences: [{ text: '全量测试必须在 `runner 宿主` 上跑，不能在引擎 Bash 里跑。', notes: [4] }] }] },
    ],
    footnotes: [{
      n: 4, kind: 'turn', quote: '全量测试在 runner 宿主上跑', recordId: 'turn-owner', charStart: 0, charEnd: 16,
      path: null, lineStart: null, lineEnd: null, section: null, symbol: null, viaEntryId: null,
    }],
  };
}

// ── A failure: the call's own, and the platform's ───────────────────────────────────────────────

test('a call that fails is its section\'s: the run goes on and says what it left unwritten', async () => {
  const h = harness();
  h.model.failing = 'content';
  const summary = await build(h, new MemoryRepo(HEAD, files()));
  assert.deepEqual([summary.written, summary.failed], [0, 3]);
  assert.equal(h.server.writes.length, 0);
  const why = Object.fromEntries(summary.docs[0].sections.map((section) => [section.key, section.why]));
  assert.match(why.s2 ?? '', /^the merge: /u);
  assert.match(why.s1 ?? '', /none of the sections it sums up is written yet/u);
});

test('a failure of the platform stops the run, and nothing more is written (TestWikiArticleBuildStopsAtTheFirst401)', async () => {
  const h = harness();
  h.model.failing = 'platform';
  await assert.rejects(build(h, new MemoryRepo(HEAD, files())), /waited past its step's limit/u);
  assert.equal(h.server.writes.length, 0);
  // Two sections were in flight at most; nothing was tried again, and the overview never asked.
  assert.ok(h.model.prompts.length >= 1 && h.model.prompts.length <= 2, `${h.model.prompts.length} calls`);
});

test('a write the server refuses is its section\'s: the run goes on', async () => {
  const h = harness();
  h.server.refuse = 'the plan changed while the documents were written (WIKI_PLAN_STALE): nothing more was written, and the next run writes them from the plan in force';
  const summary = await build(h, new MemoryRepo(HEAD, files()));
  assert.deepEqual([summary.written, summary.failed], [0, 3]);
  assert.match(summary.docs[0].sections.find((section) => section.key === 's2')?.why ?? '', /WIKI_PLAN_STALE/u);
});

// ── One section ─────────────────────────────────────────────────────────────────────────────────

test('only the section asked for is written, and no other section\'s material is read (TestWikiArticleBuildWritesOnlyTheSectionItIsAskedFor)', async () => {
  const h = harness();
  const summary = await build(h, new MemoryRepo(HEAD, files()), { doc: 'session-runtime', section: 's2' });
  assert.deepEqual(h.server.writes.map((write) => write.request.sections[0].key), ['s2']);
  assert.deepEqual([summary.written, summary.docs[0].sections.length], [1, 1]);
  assert.deepEqual(h.server.materialRead, []);
});

test('a section the plan gives no material is written from one call, its footnotes and ledger empty lists (TestWikiArticleBuildWritesASectionWithNoMaterialAsEmptyLists)', async () => {
  const h = harness();
  const docs = plan();
  docs[0].sections.push({ key: 's4', title: '边界', kind: 'conventions', covers: '本篇不讲什么。', length: 200, sources: { ...empty } });
  h.model.write['边界'] = ['### Boundaries\nThis document covers only how a session runs; how tasks are dispatched has a document of its own.\n'];
  const summary = await build(h, new MemoryRepo(HEAD, files()), { docs, doc: 'session-runtime', section: 's4' });
  assert.deepEqual([summary.written, summary.calls], [1, 1], 'written from one call, with no merge');
  assert.equal(h.model.prompts.length, 1);
  assert.ok(h.model.prompts[0].includes('No material is left after the merge') && !h.model.prompts[0].includes('the "merge"'));
  const s4 = h.server.written('s4');
  assert.deepEqual([s4.footnotes, s4.dispositions, s4.markdown], [[], [], 'This document covers only how a session runs; how tasks are dispatched has a document of its own.']);
});

test('sections that name one file all wait for its read: a plan of v27\'s shape is built through the space\'s runner (2026-10-09)', async () => {
  // Version 27 named docs/article-durable-agent-work.md in several sections of one document. The server reads the
  // repository through the space's runner, so a read lands later than the sections that want it are started.
  const article = 'docs/article-durable-agent-work.md';
  const contents = files({ [article]: '# Durable agent work\n\nA turn outlives the runner that ran it.\n' });
  const sizes = new Map(Object.entries(contents).map(([path, text]) => [path, Buffer.byteLength(text)]));
  const reads: string[][] = [];
  const repo = new WikiDocsSnapshotRepo(HEAD, sizes, [...sizes.keys()].sort(), async (paths) => {
    reads.push([...paths]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return new Map(paths.map((path) => [path, { path, state: 'found' as const, text: contents[path], sizeBytes: sizes.get(path) ?? 0 }]));
  });
  const docs = plan();
  docs[0].sections[1].sources.docs = [...(docs[0].sections[1].sources.docs ?? []), { path: article, section: null }];
  docs[0].sections[2].sources.docs = [{ path: article, section: null }];
  const h = harness();
  const summary = await runWikiDocsBuild({
    repo,
    prepare: (paths) => repo.prepare(paths),
    material: (doc, key) => h.server.material(doc, key),
    view: (slug) => h.server.readView(slug),
    write: (slug, request) => h.server.write(slug, request),
    ask: (call) => h.model.ask(call),
    model: 'qwen3.8-27b-fp8',
    log: (message) => h.logs.push(message),
  }, { spaceId: 'space-1', planVersion: 27, docs, stored: new Map() });
  assert.deepEqual([summary.written, summary.failed], [3, 0], h.logs.join('\n'));
  assert.equal(reads.flat().filter((path) => path === article).length, 1, 'the article is read once, for both sections');
  for (const key of ['s2', 's3']) {
    assert.ok(h.server.written(key).dispositions.some((disposition) => disposition.ref.startsWith(`${article}#L`)), `${key} was handed the article`);
  }
});

test('the build reads only the files its sections name, and takes the material cap from the contract', async () => {
  const h = harness();
  const repo = new MemoryRepo(HEAD, files({ 'README.md': 'not read\n' }));
  await build(h, repo);
  assert.deepEqual([...new Set(repo.prepared)].sort(), ['contracts/session.contract.json', 'docs/design.md', 'src/runloop.go']);
  assert.equal(WIKI_DOC_BUILD_RULES.parallel, 4);
});
