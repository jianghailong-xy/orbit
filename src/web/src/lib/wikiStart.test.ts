// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WikiDocsDirectory, WikiPlanJob, WikiPlanProposal, WikiPlanState, WikiPlanVersion } from '@orbit/shared';
import {
  WIKI_CREATE,
  WIKI_CREATE_CHANGE_SETTINGS,
  WIKI_CREATE_MAINTENANCE,
  WIKI_CREATE_NOT_HERE,
  WIKI_CREATE_READS_FROM,
  WIKI_CREATE_REPOSITORY,
  WIKI_HAS_A_WIKI,
  WIKI_NEW,
  wikiCreateCardFacts,
  wikiCreateOffered,
  wikiRepositoryGroups,
  wikiRepositoryName,
  wikiRepositoryTitle,
  wikiStartCard,
  wikiStartFirstCard,
  wikiStartShown,
  wikiWorkspaceChoicesInOrder,
  wikiWorkspaceDefault,
  type WikiCreateCardFacts,
  type WikiStartCard,
  type WikiWorkspaceChoice,
} from './wikiStart';

/**
 * The Wiki while it has nothing to read (design §12.3.1, mock 41), proved against
 * `src/shared/src/wiki-start.fixture.json` — the cases OrbitKit's `WikiStartParityTests` and Android's
 * `WikiStartLogicTest` read too: the card of every state of the plan, whether it is drawn, and the workspaces
 * its two forms offer. The states are `plan.states` of `wiki-docs.fixture.json`, the ones every other reading of
 * the plan is held to.
 */

interface PlanStateSpec {
  confirmed: string | null;
  draft: string | null;
  proposals: boolean;
  job: string | null;
  runnerOnline: boolean | null;
}

interface DocsFixture {
  timeZone: string;
  now: string;
  docs: { directory: { read: WikiDocsDirectory } };
  plan: {
    versions: Record<string, WikiPlanVersion>;
    proposals: WikiPlanProposal[];
    jobs: Record<string, WikiPlanJob>;
    states: Record<string, { spec: PlanStateSpec }>;
  };
}

interface StartFixture {
  timeZone: string;
  now: string;
  context: { maintenance: boolean; readsFrom: string };
  states: Record<string, WikiStartCard>;
  firstDrafts: Record<string, { spec: PlanStateSpec; card: WikiStartCard }>;
  writingOffline: { spec: PlanStateSpec; card: WikiStartCard };
  maintenanceOff: WikiStartCard;
  readsFromUnknown: WikiStartCard;
  first: { workspaces: WikiStartCard; noRepository: WikiStartCard };
  shown: Array<{ written: number; topics: number; shown: boolean }>;
  repositories: Array<{ url: string; repository: string | null; title: string | null }>;
  workspaces: {
    choices: WikiWorkspaceChoice[];
    inOrder: string[];
    groups: Array<{ repository: string; choices: string[] }>;
    defaults: Array<{ current: string | null; from: string | null; pick: string | null }>;
    allOffline: string | null;
    none: string | null;
  };
  hasWiki: {
    newWiki: string;
    label: string;
    wikis: string[];
    groups: Array<{ repository: string; choices: string[]; hasWiki: boolean }>;
    offered: string[];
    defaults: Array<{ current: string | null; from: string | null; pick: string | null }>;
    allHaveWikis: { wikis: string[]; offered: string[]; pick: string | null };
    refusal: { status: number; code: string; message: string };
  };
  wikiCreateCard: {
    labels: { repository: string; readsFrom: string; maintenance: string };
    buttons: string[];
    cases: Array<{ request: { repoUrlNorm: string | null; workspaceId: string | null }; facts: WikiCreateCardFacts }>;
  };
}

function read<T>(name: string): T {
  const candidates = [resolve(process.cwd(), `../shared/src/${name}`), resolve(process.cwd(), `src/shared/src/${name}`)];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error(`${name} not found from ${process.cwd()}`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

const docs = read<DocsFixture>('wiki-docs.fixture.json');
const start = read<StartFixture>('wiki-start.fixture.json');
const now = Date.parse(start.now);

const stateOf = (spec: PlanStateSpec): WikiPlanState => ({
  spaceId: 'sp1',
  confirmed: spec.confirmed ? docs.plan.versions[spec.confirmed]! : null,
  draft: spec.draft ? docs.plan.versions[spec.draft]! : null,
  proposals: spec.proposals ? docs.plan.proposals : [],
  job: spec.job ? docs.plan.jobs[spec.job]! : null,
});

const context = (spec: PlanStateSpec) => ({
  now,
  ...start.context,
  runnerOnline: spec.runnerOnline,
  directory: spec.confirmed ? docs.docs.directory.read : null,
});

function inTimeZone<T>(tz: string, fn: () => T): T {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}

describe('the card of every state of the plan', () => {
  it('covers every state the plan has', () => {
    expect(Object.keys(start.states).sort()).toEqual(Object.keys(docs.plan.states).sort());
    expect(start.now).toBe(docs.now);
  });

  for (const [name, { spec }] of Object.entries(docs.plan.states)) {
    it(`${name}: what each step says, and the one thing to press`, () => {
      expect(inTimeZone(start.timeZone, () => wikiStartCard(stateOf(spec), context(spec)))).toEqual(start.states[name]);
    });
  }

  for (const [name, { spec, card }] of Object.entries(start.firstDrafts)) {
    it(`the first draft, ${name}: what the second step says with no version confirmed`, () => {
      expect(inTimeZone(start.timeZone, () => wikiStartCard(stateOf(spec), context(spec)))).toEqual(card);
    });
  }

  it('sends documents whose writing waits for an offline runner to the runners', () => {
    const { spec, card } = start.writingOffline;
    expect(inTimeZone(start.timeZone, () => wikiStartCard(stateOf(spec), context(spec)))).toEqual(card);
  });

  it('asks for the repository when maintenance is off and nothing is on its way', () => {
    const { spec } = docs.plan.states.none!;
    expect(wikiStartCard(stateOf(spec), { ...context(spec), maintenance: false })).toEqual(start.maintenanceOff);
  });

  it('says it is connected while the workspace’s name is not read yet', () => {
    const { spec } = docs.plan.states.noneDrafting!;
    expect(wikiStartCard(stateOf(spec), { ...context(spec), readsFrom: null })).toEqual(start.readsFromUnknown);
  });

  it('never offers more than one primary button', () => {
    const firstDrafts = Object.values(start.firstDrafts).map((row) => row.card);
    for (const card of [...Object.values(start.states), ...firstDrafts, start.first.workspaces, start.first.noRepository]) {
      expect(card.steps.filter((step) => step.action?.primary).length).toBeLessThanOrEqual(1);
    }
  });

  it('has exactly one step in motion, and every step before it is done', () => {
    for (const card of Object.values(start.states)) {
      const moving = card.steps.filter((step) => step.state === 'wait' || step.state === 'run');
      expect(moving).toHaveLength(1);
    }
  });
});

describe('the card of an account with no wiki', () => {
  it('makes one from a workspace on a repository', () => {
    expect(wikiStartFirstCard(true)).toEqual(start.first.workspaces);
  });

  it('says what is missing, and offers nothing, with no workspace on a repository', () => {
    expect(wikiStartFirstCard(false)).toEqual(start.first.noRepository);
    expect(start.first.noRepository.steps[0].action).toBeNull();
  });
});

describe('whether the card is drawn', () => {
  it('stands until there is something to read', () => {
    for (const row of start.shown) expect(wikiStartShown(row.written, row.topics)).toBe(row.shown);
  });
});

describe('the workspaces the two forms offer', () => {
  const { choices, inOrder, groups, defaults, allOffline, none } = start.workspaces;

  it('names a repository as the server does, however its URL is spelled', () => {
    for (const row of start.repositories) {
      expect(wikiRepositoryName(row.url), row.url).toBe(row.repository);
      expect(row.repository ? wikiRepositoryTitle(row.repository) : null, row.url).toBe(row.title);
    }
    expect(wikiRepositoryName(null)).toBeNull();
    expect(wikiRepositoryName(undefined)).toBeNull();
  });

  it('offers what a draft could start on first, then by name', () => {
    expect(wikiWorkspaceChoicesInOrder(choices).map((row) => row.id)).toEqual(inOrder);
  });

  it('groups them by repository and leaves out one with none', () => {
    expect(wikiRepositoryGroups(choices).map((group) => ({ repository: group.repository, choices: group.choices.map((row) => row.id) }))).toEqual(groups);
  });

  it('opens on the workspace in use, else the reader’s if it is up, else the first that is', () => {
    for (const row of defaults) expect(wikiWorkspaceDefault(choices, row), JSON.stringify(row)).toBe(row.pick);
    expect(wikiWorkspaceDefault(choices.filter((row) => !row.online), { current: null, from: null })).toBe(allOffline);
    expect(wikiWorkspaceDefault([], { current: null, from: null })).toBe(none);
  });
});

describe('the Create wiki form once a wiki exists (design §3.4)', () => {
  const { choices } = start.workspaces;
  const { newWiki, label, wikis, groups, offered, defaults, allHaveWikis } = start.hasWiki;

  it('names the way to another wiki and the mark of a repository that has one', () => {
    expect(WIKI_NEW).toBe(newWiki);
    expect(WIKI_HAS_A_WIKI).toBe(label);
  });

  it('greys a repository that has a wiki in use as a whole group', () => {
    const read = wikiRepositoryGroups(choices, wikis).map((group) => ({
      repository: group.repository,
      choices: group.choices.map((row) => row.id),
      hasWiki: group.hasWiki,
    }));
    expect(read).toEqual(groups);
  });

  it('offers only the workspaces of repositories with no wiki, and opens on one of them', () => {
    const left = wikiCreateOffered(wikiRepositoryGroups(choices, wikis));
    expect(left.map((row) => row.id)).toEqual(offered);
    for (const row of defaults) expect(wikiWorkspaceDefault(left, row), JSON.stringify(row)).toBe(row.pick);
  });

  it('offers nothing to pick when every repository has a wiki', () => {
    const left = wikiCreateOffered(wikiRepositoryGroups(choices, allHaveWikis.wikis));
    expect(left.map((row) => row.id)).toEqual(allHaveWikis.offered);
    expect(wikiWorkspaceDefault(left, { current: null, from: null })).toBe(allHaveWikis.pick);
  });

  it('greys nothing without a wiki, as the first wiki’s form did', () => {
    expect(wikiRepositoryGroups(choices).every((group) => !group.hasWiki)).toBe(true);
  });
});

describe('the WIKI_CREATE card (design §3.6)', () => {
  const { labels, buttons, cases } = start.wikiCreateCard;

  it('says what it makes under the fixture’s labels, with its three buttons in order', () => {
    expect({ repository: WIKI_CREATE_REPOSITORY, readsFrom: WIKI_CREATE_READS_FROM, maintenance: WIKI_CREATE_MAINTENANCE }).toEqual(labels);
    expect([WIKI_CREATE, WIKI_CREATE_CHANGE_SETTINGS, WIKI_CREATE_NOT_HERE]).toEqual(buttons);
  });

  for (const row of cases) {
    it(`reads ${row.request.repoUrlNorm} from ${row.request.workspaceId}`, () => {
      expect(wikiCreateCardFacts(row.request, start.workspaces.choices)).toEqual(row.facts);
    });
  }
});
