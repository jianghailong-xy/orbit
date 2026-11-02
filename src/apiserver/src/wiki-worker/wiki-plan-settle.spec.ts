import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { WikiPlanMaterials } from '@orbit/shared';

import { wikiPlanAdoptCatalogue, wikiPlanNameCatalogue } from './wiki-plan-draft-job';
import { parseWikiPlanCatalogue, parseWikiPlanDocBody, wikiPlanIdentifier, type WikiPlanDocRead } from './wiki-plan-format';
import { wikiPlanAssemble, wikiPlanSettle, wikiPlanSettleNames } from './wiki-plan-gate';
import type { WikiPlanRunState } from './wiki-plan-prompts';
import type { WikiPlanRepo } from './wiki-plan-repo';

/**
 * What a draft's own words can no longer cost it. The first draft of 2026-11-02 that found all of its 1,099 references
 * failed the plan check with 40 errors, one for each of its 9 category keys and 31 document slugs: the model had kept
 * the label of the template around each, `<slug: storage>`. No owner can act on that, and each redo round printed the
 * same label back to the model. The draft before it had failed on 4 references of 953.
 *
 * So a way of writing a name is put right before the gate reads it, and what the third round still leaves is settled:
 * a draft the model wrote is stored, the owner reads what is left to judge, and the gate's errors stay the model's.
 */

/** The repository of a draft: everything found, unless a test says otherwise. */
function repository(found: (ref: string) => boolean = () => true): WikiPlanRepo {
  return {
    sha: 'fdea6bd000000000000000000000000000000000',
    hasPath: (path: string) => found(path),
    hasDocSection: (path: string, section: string) => found(`${path} § ${section}`),
    hasSymbol: (path: string, symbol: string) => found(`${path}: ${symbol}`),
    headingsOf: () => [],
    symbolsOf: () => [],
  } as unknown as WikiPlanRepo;
}

function run(over: Partial<WikiPlanRunState> = {}): WikiPlanRunState {
  return {
    spaceTitle: 'App', date: '2026-11-02', sessionsText: '', instructions: '', base: null, baseIds: new Map(), baseDocs: new Map(),
    cats: [], units: [], moves: [], target: { min: 1, max: 50 }, repo: repository(),
    materials: { projects: [], topics: [] } as unknown as WikiPlanMaterials,
    ...over,
  };
}

const BODY = 'Length: 1000–2000 characters\n### 1. Overview | overview | 500\nCovers: all of it\n### 2. Flow | flow | 500\nCovers: the flow\n';

/** A unit's body as a round wrote it. */
function write(r: WikiPlanRunState): void {
  const { sections } = parseWikiPlanDocBody(BODY);
  for (const unit of r.units) {
    unit.header = { ...unit.header, audience: ['A developer: can follow it'], scopeIn: ['it'], length: '1000–2000 characters' };
    unit.sections = sections;
    unit.hasBody = true;
    unit.refs = new Map();
  }
}

test('a key or a slug reads as one, whatever the model wrote around it', () => {
  for (const [wrote, read] of [
    ['<category key: build-orchestration>', 'build-orchestration'],
    ['<slug: build-pipeline>', 'build-pipeline'],
    ['slug: build-pipeline', 'build-pipeline'],
    ['<build-pipeline>', 'build-pipeline'],
    ['Bad_Slug', 'bad-slug'],
    ['Build  Pipeline', 'build-pipeline'],
    ['--a--b--', 'a-b'],
    ['storage', 'storage'],
    ['存储', ''],
    ['', ''],
  ] as const) assert.equal(wikiPlanIdentifier(wrote), read, wrote);
  assert.equal(wikiPlanIdentifier('x'.repeat(70)), 'x'.repeat(64));
  assert.equal(wikiPlanIdentifier(`${'x'.repeat(63)}-y`).length, 63, 'no hyphen left at the end of a cut');
});

test('a catalogue that kept the template\'s labels on every key and slug reaches the gate clean: the 40 errors of 2026-11-02', () => {
  const sizes = [3, 4, 3, 3, 3, 4, 4, 4, 3];
  let text = '';
  let n = 0;
  sizes.forEach((docs, c) => {
    text += `## ${c + 1}. Category ${c + 1} \`<category key: category-${c + 1}>\` — What it answers${c === sizes.length - 1 ? ' [agents]' : ''}\n`;
    for (let d = 1; d <= docs; d += 1) {
      n += 1;
      text += `- ${c + 1}.${d} Document ${n} \`<slug: document-${n}>\` | What does it answer? | Includes: a; b\n`;
    }
  });
  const r = run();
  wikiPlanAdoptCatalogue(r, parseWikiPlanCatalogue(text)!, false);
  write(r);
  const a = wikiPlanAssemble(r);
  assert.deepEqual(a.errors, []);
  assert.equal(a.plan.categories.length, 9);
  assert.equal(a.plan.docs.length, 31);
  assert.equal(a.plan.categories[0].key, 'category-1');
  assert.equal(a.plan.docs[0].slug, 'document-1');
  assert.equal(a.plan.docs[0].category, 'category-1');
});

test('a name that is nothing falls back, one that repeats takes the next number, and the same answer names the same again', () => {
  const answer = [
    '## 1. 产品 `产品` — What it is',
    '- 1.1 Storage `存储` | How is data kept? | Includes: a',
    '- 1.2 Storage `storage` | And again? | Includes: b',
    '- 1.3 存储 `存储` | 怎么存？ | Includes: c',
    '## 2. Product `c1` — The same key as the number above',
    '- 2.1 Testing `testing` | How to test? | Includes: d',
  ].join('\n');
  const names = (): { keys: string[]; slugs: string[]; changed: number } => {
    const catalogue = parseWikiPlanCatalogue(answer)!;
    const changed = wikiPlanNameCatalogue(catalogue);
    return { keys: catalogue.cats.map((c) => c.key), slugs: catalogue.units.map((u) => u.slug), changed };
  };
  const first = names();
  assert.deepEqual(first.keys, ['c1', 'c1-2']);
  assert.equal(first.slugs[0], 'storage', 'its title, when its slug is nothing');
  assert.equal(first.slugs[1], 'storage-2');
  assert.match(first.slugs[2], /^doc-[0-9a-f]{8}$/u, 'a digest of its title, when its title is nothing either');
  assert.equal(first.slugs[3], 'testing');
  assert.equal(first.changed, 5, 'what it changed is counted: the two keys and three slugs');
  assert.deepEqual(names(), first, 'the next round finds each document under the same name');
});

test('a document keeps what was written of it when the next round writes its slug right', () => {
  const r = run();
  wikiPlanAdoptCatalogue(r, parseWikiPlanCatalogue('## 1. Product `<category key: product>` — What it is\n- 1.1 Storage `<slug: storage>` | How is data kept? | Includes: a\n')!, false);
  write(r);
  wikiPlanAdoptCatalogue(r, parseWikiPlanCatalogue('## 1. Product `product` — What it is\n- 1.1 Storage `storage` | How is data kept? | Includes: a\n')!, false);
  assert.equal(r.units[0].hasBody, true, 'no document is written again for a form of its name');
});

/** A draft's first catalogue in the line format: two categories, the second for the agents. */
const CATALOGUE = [
  '## 1. Product `product` — What it is',
  '- 1.1 Storage `storage` | How is data kept? | Includes: a',
  '- 1.2 Search `search` | How is it found? | Includes: b',
  '## 2. Conventions `conventions` — How to work here [agents]',
  '- 2.1 Testing `testing` | How to test? | Includes: c',
].join('\n');

function drafted(over: Partial<WikiPlanRunState> = {}, catalogue = CATALOGUE): WikiPlanRunState {
  const r = run(over);
  wikiPlanAdoptCatalogue(r, parseWikiPlanCatalogue(catalogue)!, false);
  write(r);
  return r;
}

const body = (lines: string): ReturnType<typeof parseWikiPlanDocBody> => parseWikiPlanDocBody(lines);

test('a clean draft has nothing to settle: no error, no note, and every field as the model wrote it', () => {
  const r = drafted();
  const before = JSON.stringify(wikiPlanAssemble(r).plan);
  const a = wikiPlanSettle(r);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(a.notes, []);
  assert.equal(JSON.stringify(a.plan), before);
});

test('a reference the repository does not have stays on its section, and says so: the 4 of 953 of 2026-11-02', () => {
  const r = drafted({ repo: repository((ref) => ref !== 'docs/a.md § Gone' && ref !== 'src/a.ts: gone()' && ref !== 'src/b.ts') });
  const { sections } = body([
    '### 1. Flow | flow | 500',
    'Covers: the flow',
    '- Docs: docs/a.md § Here',
    '- Docs: docs/a.md § Gone',
    '- Code: src/a.ts: here(), gone()',
    '- Code: src/b.ts',
  ].join('\n'));
  r.units[0].sections = sections;
  assert.equal(wikiPlanAssemble(r).errors.length, 3, 'three errors, for the model, while it has rounds');
  const a = wikiPlanSettle(r);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(a.plan.docs[0].sections[0].sources.docs, [{ path: 'docs/a.md', section: 'Here' }, { path: 'docs/a.md', section: 'Gone' }]);
  assert.deepEqual(a.plan.docs[0].sections[0].sources.code, [{ path: 'src/a.ts', symbols: ['here()', 'gone()'] }, { path: 'src/b.ts', symbols: [] }]);
  assert.deepEqual(a.repo.missing.map((miss) => [miss.kind, miss.ref, miss.at]), [
    ['docSection', 'docs/a.md § Gone', 'plan.docs[0].sections[0].sources.docs[1].section'],
    ['symbol', 'src/a.ts: gone()', 'plan.docs[0].sections[0].sources.code[0].symbols[1]'],
    ['file', 'src/b.ts', 'plan.docs[0].sections[0].sources.code[1].path'],
  ]);
  assert.deepEqual(a.notes, [], 'the report of the references says what they are: no note repeats it');
});

test('a name no account or space has goes, the rest of its condition stays, and the owner is told which', () => {
  const r = drafted();
  r.materials = { projects: [{ id: 'p1', title: 'Real' }], topics: [{ slug: 'storage' }] } as unknown as WikiPlanMaterials;
  r.units[0].sections = body('### 1. Pitfalls | pitfalls | 500\nCovers: what went wrong\n- Sessions: projects 「Real」「Made up」; keywords disk; kind pitfall/nonsense; topics storage, invented; look for: an outage').sections;
  const a = wikiPlanSettle(r);
  const c = a.plan.docs[0].sections[0].sources.sessions!;
  assert.deepEqual(c.projects, ['Real']);
  assert.deepEqual(c.topics, ['storage']);
  assert.deepEqual(c.entryKinds, ['pitfall']);
  assert.deepEqual(c.keywords, ['disk'], 'what it said to look for stays');
  assert.deepEqual(a.notes, [
    { check: 'references', text: 'A project name couldn’t be matched and was left out: Made up.' },
    { check: 'references', text: 'A topic isn’t this wiki’s and was left out: invented.' },
    { check: 'references', text: 'An entry kind doesn’t exist and was left out: nonsense.' },
  ]);
});

test('what the server refuses of a settled draft goes the same way, and many names are counted', () => {
  const r = drafted();
  r.units[0].sections = body('### 1. Pitfalls | pitfalls | 500\nCovers: x\n- Sessions: projects 「a」「b」「c」「d」「e」「f」「g」; keywords disk; look for: an outage').sections;
  const a = wikiPlanSettle(r);
  const notes = [...a.notes];
  wikiPlanSettleNames(a, ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((_, i) => ({
    check: 'references' as const, path: `plan.docs[0].sections[0].sources.sessions.projects[${i}]`, message: 'no project',
  })), notes);
  assert.deepEqual(a.plan.docs[0].sections[0].sources.sessions!.projects, []);
  assert.deepEqual(notes, [{ check: 'references', text: '7 project names couldn’t be matched and were left out: a, b, c, d, e and 2 more.' }]);
});

test('what the plan cannot keep as it was written is put within its rules', () => {
  const r = drafted();
  const unit = r.units[0];
  unit.header = { ...unit.header, title: 'x'.repeat(200), question: '', audience: [], scopeIn: [], length: 'long' };
  unit.cardScope = [];
  unit.question = '';
  unit.stray = ['a line that is no field'];
  unit.sections = body('### 1. Fine | diagram | a lot\nCovers: \nA line that is no field\n- Sessions: dates 2026-13-40 to 2026-01-01; keywords disk').sections;
  unit.sections[0].covers = '';
  unit.sections[0].sessions!.since = '2026-13';
  const a = wikiPlanSettle(r);
  const doc = a.plan.docs[0];
  assert.equal([...doc.title].length, 120);
  assert.equal(doc.question, doc.title, 'a question nobody wrote is the title');
  assert.deepEqual(doc.audience, ['A reader of this wiki']);
  assert.deepEqual(doc.scopeIn, [doc.question.slice(0, 1000)]);
  assert.equal(doc.sections[0].kind, 'other');
  assert.equal(doc.sections[0].length, 500);
  assert.equal(doc.sections[0].covers, 'Fine');
  assert.equal(doc.sections[0].sources.sessions!.since, null);
  assert.deepEqual(doc.length, { min: 500, max: 750 });
  assert.deepEqual(a.notes, [{ check: 'schema', text: 'A section has a type Orbit doesn’t know, now marked Other.' }]);
});

test('a document never written is left out and said to be, the others numbered without it', () => {
  const r = drafted();
  r.units[0].sections = [];
  r.units[0].hasBody = false;
  r.units[0].header = { ...r.units[0].header, audience: [] };
  r.units[1].sections = body('### 1. Overview | overview | 500\nCovers: the rest, see 2.1').sections;
  r.units[1].refs = new Map(r.units.map((unit) => [unit.id, unit.slug]));
  const a = wikiPlanSettle(r);
  assert.deepEqual(a.plan.docs.map((doc) => doc.slug), ['search', 'testing']);
  assert.deepEqual(a.units.map((unit) => unit.id), ['1.1', '2.1']);
  assert.deepEqual(a.notes, [{ check: 'docCount', text: 'Storage was left out: nothing was written for it.' }]);
});

test('a count outside the target stays, for the owner: it is no error and no note, their report says it', () => {
  const r = drafted({ target: { min: 20, max: 35 } });
  assert.equal(wikiPlanAssemble(r).errors.filter((e) => e.check === 'docCount').length, 1);
  const a = wikiPlanSettle(r);
  assert.equal(a.plan.docs.length, 3);
  assert.deepEqual(a.errors, []);
  assert.deepEqual(a.notes, []);
});

test('a plan with no category for the agents says so', () => {
  const r = drafted({}, CATALOGUE.replace(' [agents]', ''));
  assert.deepEqual(wikiPlanSettle(r).notes, [{ check: 'schema', text: 'No category for the agents’ conventions. Redraft to add one.' }]);
});

/** A version with a protected document that leaves something to another, and a section that may not move. */
function revised(catalogue: string): WikiPlanRunState {
  const section = (title: string, kind: string): WikiPlanDocRead['sections'][number] => ({
    key: title, title, kind, covers: title, length: 500, extra: null, sources: { docs: [], code: [], contracts: [], sessions: null },
  });
  const doc = (slug: string, category: string, over: Partial<WikiPlanDocRead> = {}): WikiPlanDocRead => ({
    category, slug, title: slug.toUpperCase(), question: `What of ${slug}?`, audience: ['A developer'], scopeIn: ['it'], scopeOut: [],
    length: { min: 1000, max: 2000 }, protected: false, extra: null, sections: [section('Overview', 'overview'), section('Rules', 'conventions')], ...over,
  });
  const docs = [
    doc('storage', 'product', { protected: true, scopeOut: [{ text: 'how it is found', docs: ['search'] }] }),
    doc('search', 'product'),
    doc('testing', 'conventions'),
  ];
  const r = run({
    base: {
      version: 1, status: 'confirmed', target: { min: 1, max: 50 }, newFields: [], docs,
      categories: [
        { key: 'product', title: 'Product', question: 'What it is', forAgents: false },
        { key: 'conventions', title: 'Conventions', question: 'How to work', forAgents: true },
      ],
    },
    baseIds: new Map([['1.1', 'storage'], ['1.2', 'search'], ['2.1', 'testing']]),
    baseDocs: new Map(docs.map((one) => [one.slug, one])),
  });
  wikiPlanAdoptCatalogue(r, parseWikiPlanCatalogue(catalogue)!, true);
  return r;
}

test('a catalogue that left out what is protected gets it back as it was, and what it points at', () => {
  const r = revised([
    '## 1. Conventions `conventions` — How to work [agents]',
    '- 1.1 Testing `testing` | How to test? | Sources: 2.1 | Includes: c',
  ].join('\n'));
  const a = wikiPlanSettle(r);
  assert.deepEqual(a.plan.categories.map((cat) => cat.key), ['conventions', 'product']);
  assert.deepEqual(a.plan.docs.map((doc) => doc.slug).sort(), ['search', 'storage', 'testing']);
  const storage = a.plan.docs.find((doc) => doc.slug === 'storage')!;
  assert.equal(storage.protected, true);
  assert.equal(storage.category, 'product');
  assert.deepEqual(storage.scopeOut, [{ text: 'how it is found', docs: ['search'] }]);
  assert.deepEqual(a.notes, [
    { check: 'protected', text: 'STORAGE is protected, so it stays as it was.' },
    { check: 'protected', text: 'SEARCH stays: STORAGE is protected and points at it.' },
  ]);
});

test('a move that cannot be is called off, and its section stays where it was', () => {
  const r = revised([
    '## 1. Product `product` — What it is',
    '- 1.1 Storage `storage` | How is it kept? | Sources: 1.1 | Includes: a',
    '- 1.2 Search `search` | How is it found? | Sources: 1.2 | Includes: b',
    '## 2. Conventions `conventions` — How to work [agents]',
    '- 2.1 Testing `testing` | How to test? | Sources: 2.1 | Includes: c',
    '### Sections moved into the agents\' category',
    '- 1.2 §1 → 2.1',
    '- 1.1 §2 → 2.1',
    '- 1.2 §2 → 2.1',
  ].join('\n'));
  assert.equal(r.units.find((unit) => unit.slug === 'search')!.keptDrop!.size, 2);
  const target = r.units.find((unit) => unit.slug === 'testing')!;
  Object.assign(target, { sections: parseWikiPlanDocBody(BODY).sections, hasBody: true, refs: new Map() });
  target.header = { ...target.header, audience: ['A developer'], scopeIn: ['it'], length: '1000–2000 characters' };
  const a = wikiPlanSettle(r);
  const search = a.plan.docs.find((doc) => doc.slug === 'search')!;
  assert.deepEqual(search.sections.map((section) => section.title), ['Overview'], 'the convention moved, the overview did not');
  assert.deepEqual(a.notes, [
    { check: 'protected', text: '§1 Overview stays in SEARCH: it can’t move to the agents’ category.' },
    { check: 'protected', text: '§2 Rules stays in STORAGE: it can’t move to the agents’ category.' },
  ]);
});
