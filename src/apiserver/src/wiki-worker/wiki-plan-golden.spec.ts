import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { WikiPlanGateError, WikiPlanMaterials } from '@orbit/shared';

import { wikiPlanAdoptCatalogue, wikiPlanTextsWanted } from './wiki-plan-draft-job';
import {
  goCompare,
  parseWikiPlanCatalogue,
  parseWikiPlanDetails,
  parseWikiPlanDocBody,
  wikiPlanPaths,
  wikiPlanRange,
  wikiPlanRenumber,
  wikiPlanUnwrap,
  type WikiPlanCatalogue,
  type WikiPlanHeader,
  type WikiPlanSectionDraft,
  type WikiPlanUnit,
} from './wiki-plan-format';
import { wikiPlanAssemble, wikiPlanCatalogueLevel, wikiPlanDocIndex } from './wiki-plan-gate';
import {
  wikiPlanProjectsText,
  wikiPlanSessionsText,
  wikiPlanSpaceText,
  wikiPlanTopicBlocks,
  wikiPlanTopicsBrief,
} from './wiki-plan-materials';
import {
  wikiPlanCatalogueRedoPrompt,
  wikiPlanCatalogueText,
  wikiPlanDetailMaterials,
  wikiPlanDetailPrompt,
  wikiPlanDocMaterials,
  wikiPlanErrorLines,
  wikiPlanFullMaterials,
  wikiPlanOutlinePrompt,
  wikiPlanRedoDocPrompt,
  wikiPlanRevisionCataloguePrompt,
  wikiPlanRewritePrompt,
  wikiPlanRulesPrompt,
  wikiPlanSkeletonPrompt,
  type WikiPlanRunState,
  type WikiPlanVersionRead,
} from './wiki-plan-prompts';
import { WikiPlanRepo, type WikiPlanSnapshotIndex } from './wiki-plan-repo';

/**
 * One repository, one set of materials and answers, one deterministic answer on both paths (project criterion:
 * "the deterministic results — parsing, gate checks — agree on the old path and the new"):
 * `src/shared/src/wiki-plan.fixture.json` holds what the runner's Go code (src/runner-go/wiki_plan_*.go) makes of a
 * real checkout — its snapshot index as wiki-repo-op/v1 builds it, every file's text, the plan's materials — and of
 * a set of rounds' answers: the line format read back, the repository's references checked, the materials laid
 * out, every step's prompt, the draft each round assembles, the gate's errors and the repository check. This holds
 * the server's port to the same bytes, reading the repository the server's way: from the index, and from the text
 * a read at the sha answers for the files the gate looks into. The Go side holds itself to the same file
 * (wiki_plan_fixture_test.go), and writes it.
 */

interface FixtureRound {
  name: string;
  kind: 'draft' | 'revise';
  target: { min: number; max: number };
  base: WikiPlanVersionRead | null;
  instructions: string;
  catalogue: string;
  details: Record<string, string> | null;
  outlines: Record<string, string> | null;
  rewrites: Record<string, string> | null;
  prompts: Record<string, string>;
  draft: unknown;
  errors: WikiPlanGateError[];
  repoCheck: unknown;
}

// From build/wiki-worker back to src/shared.
const FIXTURE = JSON.parse(readFileSync(path.resolve(__dirname, '../../../shared/src/wiki-plan.fixture.json'), 'utf8')) as {
  date: string;
  files: Record<string, string>;
  index: WikiPlanSnapshotIndex;
  materials: WikiPlanMaterials;
  texts: Record<string, string>;
  checks: Array<{ kind: string; where: string; what?: string; found: boolean }>;
  reads: Array<{ kind: string; text: string; read: unknown }>;
  rounds: FixtureRound[];
};

/** The repository as the server reads it: the index, and the texts a read at the sha answers for the files asked. */
function repoWith(files: readonly string[] = []): WikiPlanRepo {
  const repo = new WikiPlanRepo(FIXTURE.index);
  const texts: Record<string, string> = {};
  for (const file of [...repo.overviewFiles(), ...repo.schemaFiles(), ...files]) texts[file] = FIXTURE.files[file] ?? '';
  return repo.withTexts(texts);
}

const header = (h: WikiPlanHeader): Record<string, unknown> => ({
  title: h.title, question: h.question, audience: h.audience, scopeIn: h.scopeIn, scopeOut: h.scopeOut, length: h.length,
  keyDocs: h.keyDocs, keyCode: h.keyCode, keyContracts: h.keyContracts, topics: h.topics, projects: h.projects,
});

const sections = (list: readonly WikiPlanSectionDraft[]): unknown[] => list.map((s) => ({
  title: s.title, kind: s.kind, length: s.length, covers: s.covers,
  docs: s.docs.map((d) => ({ path: d.path, section: d.section })),
  code: s.code.map((c) => ({ path: c.path, symbols: c.symbols })),
  contracts: s.contracts,
  sessions: s.sessions === null ? null : {
    projects: s.sessions.projects, keywords: s.sessions.keywords, anchorPaths: s.sessions.anchorPaths, entryKinds: s.sessions.entryKinds,
    topics: s.sessions.topics, since: s.sessions.since, until: s.sessions.until, evidence: s.sessions.evidence, stray: s.sessions.stray,
  },
  stray: s.stray,
}));

const catalogue = (c: WikiPlanCatalogue | null): unknown => (c === null ? null : {
  cats: c.cats.map((cat) => ({ key: cat.key, title: cat.title, question: cat.question, forAgents: cat.forAgents })),
  units: c.units.map((u) => ({ cat: u.cat, slug: u.slug, title: u.title, question: u.question, cardScope: u.cardScope, sources: u.sources, stray: u.stray })),
  moves: c.moves.map((m) => ({ from: m.from, section: m.section, to: m.to, target: m.target?.slug ?? null })),
  stray: c.stray,
});

/** Go's JSON of a draft beside this one's: a list Go left nil is `null` there and empty here. */
const LISTS = new Set(['categories', 'docs', 'audience', 'scopeIn', 'scopeOut', 'sections', 'code', 'contracts', 'symbols', 'projects',
  'keywords', 'anchorPaths', 'entryKinds', 'topics', 'missing', 'newFields']);

function canon(value: unknown, key = ''): unknown {
  if (value === null && LISTS.has(key)) return [];
  if (Array.isArray(value)) return value.map((item) => canon(item));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => [k, canon(v, k)]));
}

const sorted = (errors: readonly WikiPlanGateError[]): WikiPlanGateError[] =>
  [...errors].sort((a, b) => goCompare(a.check, b.check) || goCompare(a.path, b.path) || goCompare(a.message, b.message));

// ── TestWikiPlanReadsTheCompactLineFormat, and the format's other hard cases ─────────────────────────────────

test('the line format reads as the runner reads it: catalogues, bodies, details, paths, wrappings, lengths, pointers', () => {
  for (const c of FIXTURE.reads) {
    let read: unknown;
    switch (c.kind) {
      case 'catalogue': read = catalogue(parseWikiPlanCatalogue(c.text)); break;
      case 'body': {
        const body = parseWikiPlanDocBody(c.text);
        read = { header: header(body.header), sections: sections(body.sections), stray: body.stray };
        break;
      }
      case 'details': read = Object.fromEntries([...parseWikiPlanDetails(c.text)].map(([id, h]) => [id, header(h)])); break;
      case 'paths': read = wikiPlanPaths(c.text); break;
      case 'unwrap': read = wikiPlanUnwrap(c.text); break;
      case 'range': read = wikiPlanRange(c.text); break;
      case 'renumber': {
        const then = new Map([['1.1', 'a'], ['1.2', 'b'], ['1.3', 'c']]);
        const now = new Map([['a', '1.1'], ['c', '1.2']]);
        read = wikiPlanRenumber(c.text, (id) => (then.has(id) ? now.get(then.get(id)!) ?? null : null));
        break;
      }
      default: assert.fail(`a read of kind ${c.kind}`);
    }
    assert.deepEqual(read, c.read, `${c.kind}: ${JSON.stringify(c.text)}`);
  }
});

// ── TestWikiPlanReferencesAreHeldToTheTreeAtItsSha, on the snapshot ──────────────────────────────────────────

test('every path, docs section and symbol is found or not found on the snapshot as on the checkout', () => {
  for (const c of FIXTURE.checks) {
    const index = repoWith();
    const repo = c.kind === 'symbol' ? repoWith(index.textsWantedFor(c.where, c.what ?? '')) : index;
    const found = c.kind === 'symbol' ? repo.hasSymbol(c.where, c.what ?? '')
      : c.kind === 'docSection' ? repo.hasDocSection(c.where, c.what ?? '')
        : repo.hasPath(c.where);
    assert.equal(found, c.found, `${c.kind} ${c.where} ${c.what ?? ''}`);
  }
});

test('the materials read as the runner lays them out: structure, documents, contracts, overview, code, Orbit', async () => {
  const repo = repoWith();
  const m = FIXTURE.materials;
  const texts: Record<string, string> = {
    'layout/32000': repo.layoutText(32000), 'layout/26000': repo.layoutText(26000), 'layout/900': repo.layoutText(900),
    'docsTree/45000': repo.docsTreeText(45000), 'docsTree/30000': repo.docsTreeText(30000), 'docsTree/600': repo.docsTreeText(600),
    contracts: repo.contractsText(), docIndex: repo.docIndexText(),
    'overview/14000': repo.overviewText(14000), 'overview/10000': repo.overviewText(10000), 'overview/80': repo.overviewText(80),
    codeExcerpt: repo.codeExcerpt(['src/app/', 'src/web/*.ts', '`src/ios/ContentView.swift`', 'src/nope/'], 16000),
    'codeExcerpt/120': repo.codeExcerpt(['src/big/'], 120), 'codeExcerpt/none': repo.codeExcerpt(['docs/'], 16000),
    docBlock: repo.docBlock('docs/wiki-design.md', 6),
    projects: wikiPlanProjectsText(m), sessions: await wikiPlanSessionsText(m, 1), space: wikiPlanSpaceText(m),
    topicsBrief: wikiPlanTopicsBrief(m), topicBlocks: wikiPlanTopicBlocks(m, ['`storage-topic`', 'missing']),
  };
  for (const [name, text] of Object.entries(texts)) assert.equal(text, FIXTURE.texts[name], name);
  assert.deepEqual(Object.keys(texts).sort(), Object.keys(FIXTURE.texts).sort());
});

// ── Whole rounds: the prompts, the draft, the gate's errors and the repository's check ──────────────────────

async function runRound(round: FixtureRound): Promise<{ prompts: Record<string, string>; draft: unknown; errors: WikiPlanGateError[]; repoCheck: unknown }> {
  const repo = repoWith();
  const state: WikiPlanRunState = {
    spaceTitle: FIXTURE.materials.title,
    date: FIXTURE.date,
    repo,
    materials: FIXTURE.materials,
    sessionsText: await wikiPlanSessionsText(FIXTURE.materials, 1),
    target: round.target,
    instructions: round.instructions,
    base: round.base,
    baseIds: new Map(),
    baseDocs: new Map(),
    cats: [],
    units: [],
    moves: [],
  };
  if (state.base) {
    state.base.categories.forEach((cat, c) => {
      let n = 0;
      for (const doc of state.base!.docs) {
        if (doc.category !== cat.key) continue;
        n += 1;
        state.baseIds.set(`${c + 1}.${n}`, doc.slug);
        state.baseDocs.set(doc.slug, doc);
      }
    });
  }
  const revision = round.kind === 'revise' && state.base !== null;
  const prompts: Record<string, string> = {};
  if (revision) prompts['revise-catalogue'] = wikiPlanRevisionCataloguePrompt(state, [], '');
  else prompts.skeleton = `${wikiPlanFullMaterials(state)}\n${wikiPlanSkeletonPrompt(state)}`;
  wikiPlanAdoptCatalogue(state, parseWikiPlanCatalogue(round.catalogue)!, revision);
  const text = wikiPlanCatalogueText(state);
  const refs = (): Map<string, string> => new Map(state.units.map((unit) => [unit.id, unit.slug]));
  if (revision) {
    const now = refs();
    for (const unit of state.units) {
      if (unit.protectedDoc !== null || unit.kept !== null) continue;
      prompts[`revise-doc/${unit.slug}`] = wikiPlanRewritePrompt(state, unit, text);
      const answer = round.rewrites?.[unit.slug];
      if (answer !== undefined) Object.assign(unit, { ...parseWikiPlanDocBody(answer), hasBody: true, refs: now, kept: null });
    }
  } else {
    prompts.rules = wikiPlanRulesPrompt(state);
    const byCat = new Map<number, WikiPlanUnit[]>();
    for (const unit of state.units) byCat.set(unit.cat, [...(byCat.get(unit.cat) ?? []), unit]);
    for (const [c, units] of byCat) {
      const ids = units.map((unit) => unit.id);
      prompts[`details/${c + 1}`] = `${wikiPlanDetailMaterials(state)}\n# 文档目录\n${text}\n${wikiPlanDetailPrompt(state, c, ids)}`;
      const answer = round.details?.[String(c + 1)];
      if (answer === undefined) continue;
      const details = parseWikiPlanDetails(answer);
      for (const unit of units) if (details.has(unit.id)) unit.header = details.get(unit.id)!;
    }
    const now = refs();
    for (const unit of state.units) {
      prompts[`outline/${unit.slug}`] = `${wikiPlanDocMaterials(state, unit)}\n# 文档目录\n${text}\n${wikiPlanOutlinePrompt(unit)}`;
      const answer = round.outlines?.[unit.slug];
      if (answer === undefined) continue;
      const body = parseWikiPlanDocBody(answer);
      Object.assign(unit, { sections: body.sections, stray: body.stray, hasBody: true, refs: now });
    }
  }
  // What the job reads at the sha before it gates the round: the files the gate will look into for a symbol.
  repo.withTexts(Object.fromEntries(wikiPlanTextsWanted(state).map((file) => [file, FIXTURE.files[file] ?? ''])));
  const a = wikiPlanAssemble(state);
  const lines = wikiPlanErrorLines(a.errors, a);
  prompts.errors = lines;
  if (revision) prompts['revise-catalogue-again'] = wikiPlanRevisionCataloguePrompt(state, a.errors, lines);
  else prompts['catalogue-redo'] = wikiPlanCatalogueRedoPrompt(state, lines);
  const byUnit = new Map<WikiPlanUnit, WikiPlanGateError[]>();
  for (const e of a.errors) {
    const i = wikiPlanDocIndex(e.path);
    if (i !== null && !wikiPlanCatalogueLevel(e.path) && i < a.units.length && a.units[i].protectedDoc === null) {
      byUnit.set(a.units[i], [...(byUnit.get(a.units[i]) ?? []), e]);
    }
  }
  const now = wikiPlanCatalogueText(state);
  for (const unit of a.units) {
    const errs = byUnit.get(unit);
    if (errs) prompts[`redo-doc/${unit.slug}`] = `${wikiPlanDocMaterials(state, unit)}\n${wikiPlanRedoDocPrompt(state, unit, errs, a, now)}`;
  }
  return { prompts, draft: JSON.parse(JSON.stringify(a.plan)), errors: a.errors, repoCheck: JSON.parse(JSON.stringify(a.repo)) };
}

for (const round of FIXTURE.rounds) {
  test(`round ${round.name}: the same prompts, the same draft and the same gate errors as the runner`, async () => {
    const got = await runRound(round);
    assert.deepEqual(Object.keys(got.prompts).sort(), Object.keys(round.prompts).sort(), 'the prompts asked');
    for (const [name, prompt] of Object.entries(round.prompts)) assert.equal(got.prompts[name], prompt, `the prompt ${name}`);
    assert.deepEqual(sorted(got.errors), sorted(round.errors), 'the gate errors');
    assert.deepEqual(canon(got.draft), canon(round.draft), 'the draft');
    assert.deepEqual(canon(got.repoCheck), canon(round.repoCheck), 'the repository check');
  });
}

test('the fixture holds rounds that pass the gate and rounds that fail every check, so agreeing is not agreeing on nothing', () => {
  const checks = new Set(FIXTURE.rounds.flatMap((round) => round.errors.map((e) => e.check)));
  assert.deepEqual([...checks].sort(), ['docCount', 'protected', 'references', 'schema']);
  assert.ok(FIXTURE.rounds.some((round) => round.errors.length === 0 && round.kind === 'draft'));
  assert.ok(FIXTURE.rounds.some((round) => round.errors.length === 0 && round.kind === 'revise'));
  assert.ok(FIXTURE.checks.some((c) => c.kind === 'symbol' && c.found && c.what === 'localHelper'), 'a symbol only the text settles');
});
