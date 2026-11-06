// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WikiDocsDirectory, WikiPlanJob, WikiPlanProposal, WikiPlanState, WikiPlanVersion } from '@orbit/shared';
import {
  wikiRepositoryGroups,
  wikiRepositoryName,
  wikiRepositoryTitle,
  wikiStartCard,
  wikiStartFirstCard,
  wikiStartShown,
  wikiWorkspaceChoicesInOrder,
  wikiWorkspaceDefault,
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
