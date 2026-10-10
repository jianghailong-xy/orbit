import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { uuidToBase62, WIKI_DOC_BUILD_RULES, WIKI_DOC_SCHEMA, WIKI_REPO_OPS, type WikiRepoFileRead } from '@orbit/shared';

import { WikiDocsSnapshotRepo, wikiDocsShownOf } from './wiki-docs-build-job';
import {
  wikiDocApplyMerge,
  wikiDocCodePieces,
  wikiDocContract,
  wikiDocDefinition,
  wikiDocDispositions,
  wikiDocDocSection,
  wikiDocFilter,
  wikiDocFingerprint,
  wikiDocFootnoteWire,
  wikiDocLocate,
  wikiDocPiece,
  wikiDocRepoPieces,
  wikiDocSelect,
  type WikiDocPiece,
  type WikiDocRepo,
  type WikiDocShown,
  type WikiDocsPlanSection,
} from './wiki-docs-writer';

/**
 * The writer's deterministic half (wiki-docs-writer.ts), case for case the unit cases of
 * `src/runner-go/wiki_docs_build_test.go` and `wiki_docs_test.go` — the material's cap and filter, the merge read
 * strictly, a quote found in a file and its lines, the fingerprint, a section's heading — and, where the server
 * reads the repository differently from a checkout, a file the read cut short and a directory shown as git shows a
 * tree.
 */

const CONTRACT = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../contracts/wiki.contract.json'), 'utf8')) as {
  docs: { schema: Record<string, string[]>; requests: { write: string }; dispositionActions: Record<string, string>; build: { rules: Record<string, number> } };
};

const piece = (over: Partial<WikiDocPiece>): WikiDocPiece => wikiDocPiece(over);

/** A piece's id with what became of it: handed, or its action (`actions` in the Go test). */
function actions(pieces: readonly WikiDocPiece[]): string {
  return pieces.map((p) => `${p.id}=${p.handed ? 'handed' : p.action}`).join(' ');
}

// ── The material's cap and the filter (TestWikiArticleBuildCapsTheMaterialAndFiltersTheTemplateMessages) ──

test('the cap takes a mechanism\'s documents and code first and the rest\'s records first, the first piece whatever its size', () => {
  const big = '字'.repeat(9000);
  const pieces = () => [
    piece({ id: 'D1', kind: 'design_doc', text: big }), piece({ id: 'C1', kind: 'code', text: big }),
    piece({ id: 'S1', kind: 'turn', text: big }), piece({ id: 'S2', kind: 'turn', text: big }),
  ];
  const mechanism = pieces();
  wikiDocSelect('flow', mechanism);
  const conventions = pieces();
  wikiDocSelect('conventions', conventions);
  assert.equal(actions(mechanism), 'D1=handed C1=handed S1=over_cap S2=over_cap');
  assert.equal(actions(conventions), 'D1=over_cap C1=over_cap S1=handed S2=handed');
  const huge = [piece({ id: 'S1', kind: 'turn', text: '字'.repeat(30000) }), piece({ id: 'S2', kind: 'turn', text: '短' })];
  wikiDocSelect('pitfalls', huge);
  assert.ok(huge[0].handed && !huge[1].handed && huge[1].action === 'over_cap' && huge[1].reason.includes('22000'),
    'the first piece is handed over whatever its size, and nothing after it past the cap');
  const total = conventions.filter((p) => p.handed).reduce((sum, p) => sum + Array.from(p.text).length + WIKI_DOC_BUILD_RULES.materialHeaderChars, 0);
  assert.ok(total <= WIKI_DOC_BUILD_RULES.materialMaxChars, `${total} characters handed over`);
});

test('taken out by rule: a turn that is the settlement card\'s template, whoever\'s client sent it, and the same text twice', () => {
  const filtered = [
    piece({ id: 'S1', kind: 'turn', text: 'About "Orbit Wiki" — Orbit has not recorded it done. …' }),
    piece({ id: 'S2', kind: 'turn', text: 'About the design: Orbit has not recorded it done yet, the owner says' }),
    piece({ id: 'S3', kind: 'task_comment', text: 'About “x” — Orbit has not recorded it done.' }),
    piece({ id: 'S4', kind: 'turn', text: 'same' }),
    piece({ id: 'S5', kind: 'turn', text: ' same ' }),
  ];
  wikiDocFilter(filtered);
  assert.equal(actions(filtered), 'S1=filtered S2= S3= S4= S5=filtered');
  assert.match(filtered[4].reason, /the same original as S4/u);
});

// ── The merge, read strictly (TestWikiArticleBuildSendsWhatBecameOfEveryPieceWithItsSection) ─────

test('a merge into a piece that is not the section\'s is an adoption, and a piece the merge said nothing of is adopted — each saying so', () => {
  const pieces = [piece({ id: 'S1', handed: true }), piece({ id: 'S2', handed: true }), piece({ id: 'S3', handed: true }), piece({ id: 'S4' })];
  const state = wikiDocApplyMerge("S1 | adopt | the owner's words\nS2 | merge into S9 | the same thing\n[S4] | drop | not handed to it\nCurrent state:\n- the first point [S1]\n- the second\n", pieces);
  assert.deepEqual(pieces.map((p) => p.action), ['adopt', 'adopt', 'adopt', '']);
  assert.match(pieces[1].reason, /S9/u);
  assert.match(pieces[2].reason, /read as adopt|adopted/u);
  assert.equal(pieces[2].reason, 'the merge said nothing of this material: adopted and handed to the writing');
  assert.deepEqual(state, ['the first point [S1]', 'the second']);
  // The words read in any case at their start, as a model capitalizes a line.
  const capital = [piece({ id: 'S1', handed: true }), piece({ id: 'S2', handed: true })];
  assert.deepEqual(wikiDocApplyMerge('S1 | Drop | off the topic\nS2 | Merge into S1 | the same\ncurrent state:\n- one\n', capital), ['one']);
  assert.deepEqual(capital.map((p) => [p.action, p.into]), [['drop', ''], ['merge', 'S1']]);
});

// ── A quote in a file (TestWikiArticleBuildChecksRepositoryQuotesInTheFileAtTheCommit) ───────────

const DESIGN = '# Design\n\n## 1. Transport\n\nThe runner polls the server over outbound HTTP; no inbound port is needed.\n\n'
  + '## 2. Delivery\n\nA turn is stored before it is delivered, and delivered at least once.\nDelivery is idempotent on the turn\'s id.\n\n'
  + '### 2.1 Retries\n\nA lost delivery is retried after the lease expires.\n\n## 3. Recovery\n\nSeq stays monotonic across respawn.\n';

test('a quote is found within the lines it was taken from first, then anywhere; a translation, a splice or a quote too short is found nowhere', () => {
  const within = { start: 7, end: 14 };
  const cases: Array<[string, { start: number; end: number } | null]> = [
    ['A turn is stored before it is delivered', { start: 9, end: 9 }],
    ["Delivery is idempotent on the turn's id.", { start: 10, end: 10 }],
    ['Seq stays monotonic across respawn', { start: 18, end: 18 }],
    ['一轮 turn 先落库再投递', null],
    ['A turn is stored before it is delivered. Seq stays monotonic', null],
    ['A turn', { start: 9, end: 9 }],
    ['Ab', null],
    ['“A turn is stored”，before it', null],
  ];
  for (const [quote, want] of cases) assert.deepEqual(wikiDocLocate(DESIGN, quote, within), want, quote);
  // Full-width punctuation and Markdown emphasis are folded as the server folds a record's quote.
  assert.ok(wikiDocLocate('先存后投，**再**投递。', '先存后投,再投递.', null), 'a quote folded differently from its original');
  // A comment's words quoted across two of its lines: found with the comment markers off.
  const code = 'package main\n\n// runLoop claims work from the server and keeps the heartbeat going.\n// It never opens an inbound port.\nfunc runLoop() {}\n';
  assert.deepEqual(wikiDocLocate(code, 'keeps the heartbeat going. It never opens an inbound port.', { start: 3, end: 5 }), { start: 3, end: 4 });
});

// ── The fingerprint (TestWikiArticleBuildFingerprintIsTheDefinitionAndTheMaterial) ───────────────

function conventions(projectId: string): WikiDocsPlanSection {
  return {
    key: 's3', title: '约定', kind: 'conventions', covers: '约定讲什么。', length: 400,
    sources: {
      docs: [], code: [], contracts: [],
      sessions: {
        projects: [{ id: projectId }], since: '2026-09-01', until: null, keywords: ['runner 宿主'], anchorPaths: ['src/'],
        entryKinds: ['convention'], topics: [], evidence: 'owner 说测试在哪跑',
      },
    },
  };
}

test('the fingerprint is the section\'s definition and its material, spelled one way, and not the commit it was read at', () => {
  const project = '01a0e39d-4375-7280-8aad-5200529cdec3';
  const pieces = (ref: string) => [piece({ id: 'S1', kind: 'turn', ref, chars: { start: 0, end: 4 }, text: '原话一句' })];
  const base = wikiDocFingerprint(conventions(project), pieces(project));
  assert.match(base, /^[0-9a-f]{64}$/u);
  assert.equal(wikiDocFingerprint(conventions(uuidToBase62(project)), pieces(uuidToBase62(project))), base,
    'a project or record id spelled the other way moved the fingerprint');
  const changed = pieces(project);
  changed[0].text = '原话两句';
  assert.notEqual(wikiDocFingerprint(conventions(project), changed), base, 'a piece\'s text changed and the fingerprint did not');
  assert.notEqual(wikiDocFingerprint({ ...conventions(project), covers: '别的' }, pieces(project)), base, 'the definition changed and the fingerprint did not');
  assert.deepEqual(Object.keys(wikiDocDefinition(conventions(project))).sort(), ['covers', 'kind', 'length', 'sources', 'title']);
});

// ── A section's heading (TestWikiArticleBuildTakesTheHeadingASectionNamesBeforeOneItsNameContains) ──

/** A checkout in memory: each path's text, whole or cut short by a read, at one commit. */
function repoOf(contents: Record<string, string | WikiDocShown>, sha = 'a'.repeat(40)): WikiDocRepo {
  return {
    sha,
    show: (raw) => {
      const found = contents[raw.trim().replace(/^`+|`+$/gu, '').replace(/^\.\//u, '')];
      if (found === undefined) return null;
      return typeof found === 'string' ? { text: found, cut: false } : found;
    },
    under: () => [],
  };
}

/** One file as the read cache answered it (`wiki_repo_file`). */
function file(path: string, state: WikiRepoFileRead['state'], text: string, sizeBytes: number): WikiRepoFileRead {
  return { path, state, text, sizeBytes };
}

test('the heading a section names — by its words or its number — is taken before one whose name only contains it', () => {
  const repo = repoOf({
    'docs/contract.md': '# Contract\n\n## 2. Space\n\nOne space a repository.\n\n## 19. 维护作业：由事实建任务\n\nThe trigger.\n\n'
      + '### 19.4 `orbit wiki maintain --space <id> [--json]`\n\nThe run\'s steps.\n\n### 19.5 `orbit wiki check --space <id>`\n\nThe check.\n',
  });
  const cases: Record<string, string> = {
    // Its number names it, though a shorter heading's words («space») are in the name as well.
    '19.4 `orbit wiki maintain --space <id> [--model MODEL] [--json]`': '19.4 `orbit wiki maintain --space <id> [--json]`',
    '§19.5 `orbit wiki check --space <id> --expect-cursor <token>`': '19.5 `orbit wiki check --space <id>`',
    '2. Space': '2. Space',
    // With no heading of that name or number, one whose words contain the name still answers.
    维护作业: '19. 维护作业：由事实建任务',
  };
  for (const [cited, want] of Object.entries(cases)) assert.equal(wikiDocDocSection(repo, 'docs/contract.md', cited).piece?.section, want, `§ ${cited}`);
});

// ── A file the read cut short (the bounded window a runner without the whole-file capability gives) ─

test('in a file a read cut short only the heading named is looked for, and what it cannot see is missing, never another section', () => {
  // The heading named lies past the cut; a heading before it contains the name's words — on the runner's whole
  // file the number would have found 19.4, so here it is missing rather than "Orbit Wiki".
  const cut: WikiDocShown = { text: '# Orbit Wiki\n\nThe design.\n\n## 2. Space\n\nOne space a repository.\n', cut: true };
  const repo = repoOf({ 'docs/contract.md': cut, 'src/big.ts': { text: '// big\nexport function early() {}\n', cut: true } });
  const found = wikiDocDocSection(repo, 'docs/contract.md', '19.4 orbit wiki maintain');
  assert.deepEqual([found.piece, found.past], [null, true]);
  // A heading within what was read is taken as on the runner.
  assert.equal(wikiDocDocSection(repo, 'docs/contract.md', '2. Space').piece?.section, '2. Space');
  const section: WikiDocsPlanSection = {
    key: 's2', title: '流程', kind: 'flow', covers: '', length: 300,
    sources: {
      docs: [{ path: 'docs/contract.md', section: '19.4 orbit wiki maintain' }],
      code: [{ path: 'src/big.ts', symbols: ['late', 'early'] }],
      contracts: [],
      sessions: null,
    },
  };
  const { pieces, missing } = wikiDocRepoPieces(repo, section);
  assert.deepEqual(pieces.map((p) => `${p.id} ${p.symbol}`), ['C1 early']);
  assert.deepEqual(missing, [
    `docs/contract.md § 19.4 orbit wiki maintain (past the first ${WIKI_REPO_OPS.boundedChars} characters a read of the file gives)`,
    `src/big.ts :: late (past the first ${WIKI_REPO_OPS.boundedChars} characters a read of the file gives)`,
  ]);
});

test('a read cut short keeps the file\'s whole lines before the cut, and an empty file is not a missing one', () => {
  assert.deepEqual(wikiDocsShownOf(file('docs/big.md', 'cut', 'line 1\nline 2\nhalf a li\n… (rest omitted)\n', 90_000), 90_000), { text: 'line 1\nline 2\n', cut: true });
  // The marker an older runner ends its cut read with, which the read cache may still hold.
  assert.deepEqual(wikiDocsShownOf(file('docs/big.md', 'cut', 'line 1\nline 2\nhalf a li\n…（后略）\n', 90_000), 90_000), { text: 'line 1\nline 2\n', cut: true });
  assert.deepEqual(wikiDocsShownOf(file('docs/a.md', 'found', 'whole\n', 6), 6), { text: 'whole\n', cut: false });
  assert.deepEqual(wikiDocsShownOf(file('docs/empty.md', 'missing', '', 0), 0), { text: '', cut: false });
  assert.equal(wikiDocsShownOf(file('docs/gone.md', 'missing', '', 12), 12), null);
  // A file over the cap is missing with its reason, not a cut text: nothing of it is worth writing from.
  assert.equal(wikiDocsShownOf(file('docs/huge.md', 'too_large', '', 3_000_000), 3_000_000), null);
});

// ── A directory, as git shows a tree ────────────────────────────────────────────────────────────

test('a directory shows as `git show <sha>:<dir>` shows a tree — the runner\'s writer read one that way — and its files are read before they are shown', async () => {
  const sha = 'c'.repeat(40);
  const files = ['contracts/a.json', 'contracts/sub/b.json', 'contracts/a.b.json', 'src/x.go'];
  const reads: string[][] = [];
  const repo = new WikiDocsSnapshotRepo(sha, new Map(files.map((file) => [file, 10])), [...files].sort(), async (paths) => {
    reads.push([...paths]);
    return new Map(paths.map((path) => [path, file(path, 'found', `${path}\n`, 10)]));
  });
  assert.deepEqual(repo.show('contracts'), { text: `tree ${sha}:contracts\n\na.b.json\na.json\nsub/\n`, cut: false });
  assert.deepEqual(repo.show('contracts/')?.text.split('\n')[0], `tree ${sha}:contracts/`);
  assert.equal(repo.show('nowhere'), null);
  assert.throws(() => repo.show('src/x.go'), /shown before it was read/u);
  await repo.prepare(['src/x.go', './src/x.go', '`contracts/a.json`', 'nowhere']);
  assert.deepEqual(reads, [['src/x.go', 'contracts/a.json']], 'one read for the files wanted, each once; a path with no file reads nothing');
  assert.deepEqual(repo.show('src/x.go'), { text: 'src/x.go\n', cut: false });
  // A code source naming a directory gives no piece and misses nothing, as on the runner; a contract naming one is
  // the tree's listing.
  const code = wikiDocCodePieces(repo, 'contracts', [], ['json']);
  assert.deepEqual([code.pieces.length, code.missing], [0, []]);
  assert.equal(wikiDocContract(repo, 'contracts/sub')?.text, `tree ${sha}:contracts/sub\n\nb.json`);
});

test('a file another section is already reading is shown only once that read landed (v27, 2026-10-09: «was shown before it was read»)', async () => {
  const article = 'docs/article-durable-agent-work.md';
  const sizes = new Map([[article, 40], ['docs/design.md', 10]]);
  const reads: string[][] = [];
  let land = (): void => undefined;
  const landed = new Promise<void>((resolve) => {
    land = resolve;
  });
  const repo = new WikiDocsSnapshotRepo('e'.repeat(40), sizes, [...sizes.keys()].sort(), async (paths) => {
    reads.push([...paths]);
    // The article's read goes through the space's runner and lands later; the design document's is at hand.
    if (paths.includes(article)) await landed;
    return new Map(paths.map((path) => [path, file(path, 'found', `${path}\n`, sizes.get(path) ?? 0)]));
  });
  // Two sections of one document, built side by side, both name the article: the first starts its read, and the
  // second — reading its own design document as well — prepares and shows while that read is still in flight.
  const first = repo.prepare([article]);
  const second = (async () => {
    await repo.prepare([article, 'docs/design.md']);
    return repo.show(article);
  })().then((shown) => ({ shown }), (error: Error) => ({ error: error.message }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  land();
  await first;
  assert.deepEqual(await second, { shown: { text: `${article}\n`, cut: false } }, 'the second section waited for the read the first one started');
  assert.deepEqual(reads, [[article], ['docs/design.md']], 'the article is read once');
});

test('a file already read is not read again, and one the cache has no answer for is missing', async () => {
  const sizes = new Map([['a', 12_000], ['b', 9_000], ['gone', 5]]);
  const reads: string[][] = [];
  const repo = new WikiDocsSnapshotRepo('d'.repeat(40), sizes, [...sizes.keys()].sort(), async (paths) => {
    reads.push([...paths]);
    return new Map(paths.map((path) => [path, path === 'gone' ? null : file(path, 'found', `${path}\n`, sizes.get(path) ?? 0)]));
  });
  await repo.prepare(['a', 'b', 'gone']);
  assert.deepEqual(reads, [['a', 'b', 'gone']], 'one read for the files wanted, in the order they were asked for');
  assert.deepEqual(repo.show('a'), { text: 'a\n', cut: false });
  // Read once: the second ask, and the paths the cache answered for, are served without reading again.
  await repo.prepare(['a', 'b', 'gone']);
  assert.equal(reads.length, 1);
  assert.equal(repo.show('gone'), null);
});

// ── The write's shape (wiki_docs_test.go, TestWikiDocWriteCarriesTheContractsFieldsAndNoOther) ───

test('a write carries the contract\'s fields at each level and no other, and a footnote with no quote says so as null', () => {
  const schema = CONTRACT.docs.schema;
  const sorted = (keys: Iterable<string>) => [...keys].sort();
  const repoFootnote = wikiDocFootnoteWire({
    kind: 'code', path: 'src/apiserver/src/tasks/tasks.service.ts', sha: 'b'.repeat(40), lines: { start: 10, end: 20 }, section: 'Claim',
    symbol: 'claimTask', excerpt: 'export function claimTask(id: string) {', verified: true, quote: 'export function claimTask(', viaEntryId: '34WEntry',
  });
  const recordFootnote = wikiDocFootnoteWire({ kind: 'turn', ref: '34WTurn', chars: { start: 0, end: 40 }, quote: 'export function claimTask(', viaEntryId: '34WEntry' });
  const [disposition] = wikiDocDispositions([piece({ id: 'C1', kind: 'code', path: 'src/apiserver/src/tasks/tasks.service.ts', lines: { start: 10, end: 20 }, action: 'merge', into: 'C2', reason: '同一件事' })]);
  const section = { key: 's2', materialSha256: 'd'.repeat(64), markdown: '派发由 `claimTask` 开始[1]。先存后投[2]。', footnotes: [repoFootnote, recordFootnote], dispositions: [disposition] };
  const write = { planVersion: 3, repoSha: 'c'.repeat(40), model: 'qwen3.8-27b-fp8', sections: [section] };
  assert.deepEqual(sorted(Object.keys(write)), sorted(schema.write));
  assert.deepEqual(sorted(Object.keys(section)), sorted(schema.section));
  assert.deepEqual(sorted(Object.keys(repoFootnote)), sorted(schema.repoFootnote));
  assert.deepEqual(sorted(Object.keys(recordFootnote)), sorted(schema.recordFootnote));
  assert.deepEqual(sorted(Object.keys(repoFootnote.lines as object)), sorted(schema.lines));
  assert.deepEqual(sorted(Object.keys(recordFootnote.chars as object)), sorted(schema.chars));
  assert.deepEqual(sorted(Object.keys(disposition)), sorted(schema.disposition));
  for (const key of Object.keys(write)) assert.ok(CONTRACT.docs.requests.write.includes(key), `${key} is not named by the contract's write request`);
  assert.deepEqual(WIKI_DOC_SCHEMA.write, schema.write);
  assert.equal(JSON.stringify(wikiDocFootnoteWire({ kind: 'tool_call', ref: '34WCall', quote: null })), '{"kind":"tool_call","ref":"34WCall","quote":null}');
  // The ledger names every action the contract has, in its order.
  assert.deepEqual(Object.keys(CONTRACT.docs.dispositionActions), ['adopt', 'merge', 'drop', 'over_cap', 'filtered']);
  assert.deepEqual(CONTRACT.docs.build.rules, { ...WIKI_DOC_BUILD_RULES });
});
