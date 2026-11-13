// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WikiDocsDirectory, WikiPlanState, WikiSpaceWorkspaces } from '@orbit/shared';
import { WIKI_FROM_WORKSPACE_KEY } from '../lib/wikiSpace';
import { WikiPage } from '../pages/WikiPage';

/**
 * The setup card on the real routes against a fake `/api` (design §12.3.1, mock 41): that the home draws it while
 * it has nothing to read and not after, and that what it offers does what it says — the form opens where the
 * reader is and writes through the owner's door, a draft is asked for on the spot, and an account with no wiki
 * makes one in one request. What each state SAYS is `wikiStart.test.ts`'s, from the shared fixture.
 *
 * WHAT REACHES THE SERVER IS THE CLAIM: the fetch below keeps every write, and the tests read them.
 */

const SPACE_ID = '0196e300-0000-7000-8000-000000000001';
const SG = '0196e300-0000-7000-8000-0000000000a1';
const EU = '0196e300-0000-7000-8000-0000000000a2';
const US = '0196e300-0000-7000-8000-0000000000a3';
const OTHER = '0196e300-0000-7000-8000-0000000000b1';
const NOTES = '0196e300-0000-7000-8000-0000000000c1';
const UP = '0196e300-0000-7000-8000-0000000000d1';
const DOWN = '0196e300-0000-7000-8000-0000000000d2';

const WORKSPACES = [
  { id: EU, name: 'shop-cli @ EU', repoUrl: 'git@github.com:acme/shop-cli.git', runner: { id: DOWN, name: 'build-02' } },
  { id: US, name: 'shop-cli @ US', repoUrl: 'https://github.com/acme/shop-cli', runner: { id: UP, name: 'build-01' } },
  { id: SG, name: 'shop-cli @ SG', repoUrl: 'https://github.com/acme/shop-cli.git', runner: { id: UP, name: 'build-01' } },
  { id: OTHER, name: 'billing-api', repoUrl: 'https://github.com/acme/billing-api', runner: { id: UP, name: 'build-01' } },
  { id: NOTES, name: 'notes', repoUrl: null, runner: { id: UP, name: 'build-01' } },
];
const RUNNERS = [
  { id: UP, name: 'build-01', online: true },
  { id: DOWN, name: 'build-02', online: false },
];

const space = (maintenance: Record<string, unknown> = {}) => ({
  id: SPACE_ID,
  slug: 'github-com-acme-shop-cli',
  title: 'shop-cli',
  repoUrlNorm: 'github.com/acme/shop-cli',
  rootCommitSha: null,
  settings: { reviewMode: 'tiered', maintenance },
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  pendingOps: 0,
  planWaiting: 0,
  workspaceIds: [],
  docs: null,
});

const NO_DOCS: WikiDocsDirectory = { spaceId: SPACE_ID, plan: null, docs: { total: 0, written: 0 }, categories: [] };
const NO_ARTICLES = { spaceId: SPACE_ID, categories: [], uncategorized: [] };
const NO_PLAN: WikiPlanState = { spaceId: SPACE_ID, confirmed: null, draft: null, proposals: [], job: null };
const IN_WIKI: WikiSpaceWorkspaces = {
  workspaces: [EU, SG, US].map((id) => ({ id, name: WORKSPACES.find((row) => row.id === id)!.name, runner: 'build-01', inWiki: true })),
  addable: [],
};

const heldJob = {
  id: 'job-held', kind: 'draft', trigger: 'space_created', state: 'held', held: { reason: 'no_maintenance_workspace', at: '2026-11-01T00:00:00.000Z' },
  requestedAt: '2026-11-01T00:00:00.000Z', startedAt: null, endedAt: null, attempt: null, attemptsMax: 3, version: null, errors: [], error: null, report: null, draft: null, sessionId: null, progress: null,
};
const draftingJob = { ...heldJob, id: 'job-drafting', state: 'running', held: null, startedAt: new Date(Date.now() - 12 * 60_000).toISOString(), attempt: 1 };

let spaces: unknown[] = [];
let docs: WikiDocsDirectory = NO_DOCS;
let articles: unknown = NO_ARTICLES;
let plan: unknown = NO_PLAN;
let workspaces: unknown[] | null = WORKSPACES;
let trashed: unknown[] = [];
let refusal: string | null = null;
let writes: Array<{ method: string; path: string; body: unknown }> = [];
const session = new Map<string, string>();

const reply = (status: number, body: unknown): Response =>
  ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

async function serve(url: string, init?: RequestInit): Promise<Response> {
  const [path] = url.split('?');
  const method = init?.method ?? 'GET';
  const base = `/api/wiki/spaces/${SPACE_ID}`;
  if (method !== 'GET') {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    writes.push({ method, path: path!, body });
    if (refusal) return reply(409, { message: refusal });
    if (method === 'POST' && path === '/api/wiki/spaces') {
      spaces = [space({ enabled: true, workspaceId: body.maintenance.workspaceId })];
      plan = { ...NO_PLAN, job: draftingJob };
      return reply(201, spaces[0]);
    }
    if (method === 'POST' && path === `${base}/plan/redraft`) {
      plan = { ...NO_PLAN, job: draftingJob };
      return reply(200, { created: true, jobId: 'job-drafting' });
    }
    return reply(200, spaces[0] ?? {});
  }
  if (path === '/api/wiki/spaces') return reply(200, spaces);
  if (path === '/api/wiki/trash') return reply(200, { spaces: trashed });
  if (path === base) return reply(200, spaces[0]);
  if (path === `${base}/docs`) return reply(200, docs);
  if (path === `${base}/articles`) return reply(200, articles);
  if (path === `${base}/plan`) return reply(200, plan);
  if (path === `${base}/workspaces`) return reply(200, IN_WIKI);
  if (path === `${base}/entries`) return reply(200, []);
  if (path === `${base}/health`) return reply(200, { spaceId: SPACE_ID, entries: 0, maintenance: null });
  if (path === `${base}/share`) return reply(200, { link: null, counts: { documents: 0, footnotes: 0 } });
  if (path === '/api/workspaces') return workspaces ? reply(200, workspaces) : reply(500, { message: 'the workspaces could not be read' });
  if (path === '/api/runners') return reply(200, RUNNERS);
  if (path === '/api/wiki/system-model') return reply(404, { message: 'no such route' });
  return reply(404, { message: `${url} is not in this fixture` });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  spaces = [space()];
  docs = NO_DOCS;
  articles = NO_ARTICLES;
  plan = NO_PLAN;
  workspaces = WORKSPACES;
  refusal = null;
  writes = [];
  session.clear();
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => session.get(key) ?? null,
    setItem: (key: string, value: string) => void session.set(key, value),
    removeItem: (key: string) => void session.delete(key),
  });
  vi.stubGlobal('fetch', vi.fn(serve));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

function Where() {
  return <span data-where>{useLocation().pathname}</span>;
}

async function open(path = '/wiki/github-com-acme-shop-cli'): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          <Routes>
            <Route path="/wiki" element={<WikiPage route="home" />} />
            <Route path="/wiki/:space" element={<WikiPage route="home" />} />
            <Route path="/wiki/:space/plan" element={<span data-page="plan" />} />
            <Route path="/settings/machines/:id" element={<span data-page="runners" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

const words = (node: Element | null | undefined): string => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const card = (): Element | null => container.querySelector('.wk-start');
const steps = (): Element[] => [...container.querySelectorAll('.wk-start-step')];
const button = (label: string, scope: ParentNode = container): HTMLElement =>
  [...scope.querySelectorAll('button')].find((node) => words(node) === label) as HTMLElement;
const where = (): string => words(container.querySelector('[data-where]'));
const dialog = (): Element => document.querySelector('.wk-setup-dialog')!;
const press = async (node: Element): Promise<void> => {
  expect(node).toBeTruthy();
  await act(async () => (node as HTMLElement).click());
  await settle();
};
const options = async (): Promise<string[]> => {
  await press(document.getElementById('wk-setup-workspace')!);
  return [...document.querySelectorAll('.orbit-select-option')].map(words);
};

describe('the home of a wiki with nothing to read', () => {
  it('asks for the repository while the first draft waits for a workspace, and opens the form where the reader is', async () => {
    plan = { ...NO_PLAN, job: heldJob };
    await open();
    expect(words(container.querySelector('.wk-home-state'))).toBe('No documents yet');
    expect(steps().map((step) => step.className)).toEqual(['wk-start-step is-wait', 'wk-start-step is-todo', 'wk-start-step is-todo']);
    await press(button('Set up…'));
    expect(words(dialog().querySelector('.orbit-overlay-title') ?? dialog())).toContain('Set up maintenance');
    expect(where()).toBe('/wiki/github-com-acme-shop-cli');
  });

  it('offers only this wiki’s workspaces, the first that is up picked, and an offline one last and said so', async () => {
    plan = { ...NO_PLAN, job: heldJob };
    await open();
    await press(button('Set up…'));
    expect(words(document.getElementById('wk-setup-workspace'))).toBe('shop-cli @ SG · build-01');
    expect(await options()).toEqual(['shop-cli @ SG · build-01', 'shop-cli @ US · build-01', 'shop-cli @ EU · build-02offline']);
  });

  it('turns maintenance on in one press, on the workspace the reader came from when it is up', async () => {
    plan = { ...NO_PLAN, job: heldJob };
    session.set(WIKI_FROM_WORKSPACE_KEY, US);
    await open();
    await press(button('Set up…'));
    await press(button('Turn on', dialog()));
    // The chosen workspace's folder is probed first (docs/wiki-repo-tiers-design.md §7.3); then the one write.
    const probe = `/api/wiki/spaces/${SPACE_ID}/maintenance/probe`;
    expect(writes.filter((write) => write.path === probe).map((write) => write.body)).toContainEqual({ workspaceId: US });
    expect(writes.filter((write) => write.path !== probe)).toEqual([
      { method: 'PATCH', path: `/api/wiki/spaces/${SPACE_ID}`, body: { maintenance: { enabled: true, workspaceId: US, dailyRunLimit: 8, lookbackDays: 14 } } },
    ]);
    expect(document.querySelector('.wk-setup-dialog')).toBeNull();
  });

  it('skips the workspace the reader came from when its runner is offline', async () => {
    plan = { ...NO_PLAN, job: heldJob };
    session.set(WIKI_FROM_WORKSPACE_KEY, EU);
    await open();
    await press(button('Set up…'));
    expect(words(document.getElementById('wk-setup-workspace'))).toBe('shop-cli @ SG · build-01');
  });

  it('says a draft is on its way and how long it takes, with nothing it needs pressed', async () => {
    spaces = [space({ enabled: true, workspaceId: SG })];
    plan = { ...NO_PLAN, job: draftingJob };
    await open();
    expect(steps().map((step) => step.className)).toEqual(['wk-start-step is-done', 'wk-start-step is-run', 'wk-start-step is-todo']);
    expect(words(steps()[0])).toContain('Reads from shop-cli @ SG · build-01');
    expect(words(steps()[1])).toContain('Drafting the plan · attempt 1 of 3 · started 12m ago');
    expect(words(steps()[1])).toContain('Usually 1–2 hours. You can leave this page.');
    expect(container.querySelector('.wk-start .orbit-button-primary, .wk-start [data-variant="primary"]')).toBeNull();
    await press(button('Open plan'));
    expect(container.querySelector('[data-page="plan"]')).toBeTruthy();
  });

  it('asks for a draft on the spot where maintenance is on and no job exists, today’s dead end', async () => {
    spaces = [space({ enabled: true, workspaceId: SG })];
    await open();
    await press(button('Draft plan'));
    expect(writes.map((write) => `${write.method} ${write.path}`)).toEqual([`POST /api/wiki/spaces/${SPACE_ID}/plan/redraft`]);
    expect(where()).toBe('/wiki/github-com-acme-shop-cli');
    expect(words(steps()[1])).toContain('Drafting the plan');
  });

  it('sends a runner that is offline to the runners', async () => {
    spaces = [space({ enabled: true, workspaceId: EU })];
    plan = { ...NO_PLAN, job: { ...draftingJob, startedAt: null } };
    await open();
    expect(words(steps()[1])).toContain('The maintenance runner is offline');
    await press(button('View runners'));
    expect(container.querySelector('[data-page="runners"]')).toBeTruthy();
  });

  it('draws the card over the plan’s categories while no document is written, and not once one is', async () => {
    const category = {
      key: 'c1', number: 1, title: 'Product overview', question: 'q', forAgents: false,
      docs: [{ slug: 'd1', number: '1.1', title: 'Overview', question: 'q', written: false, status: null, updatedAt: null, planVersion: null, lead: null, sections: [] }],
    };
    docs = { ...NO_DOCS, plan: { version: 1, confirmedAt: '2026-11-01T00:00:00.000Z' }, docs: { total: 1, written: 0 }, categories: [category] } as WikiDocsDirectory;
    spaces = [space({ enabled: true, workspaceId: SG })];
    await open();
    expect(card()).toBeTruthy();
    const home = [...container.querySelector('.wk-home')!.children].map((node) => node.className.split(' ')[0]);
    expect(home).toEqual(['wk-start', 'wk-pl-cat', 'wk-home-more']);

    act(() => root.unmount());
    root = createRoot(container);
    docs = { ...docs, docs: { total: 1, written: 1 }, categories: [{ ...category, docs: [{ ...category.docs[0]!, written: true, status: 'ok', lead: 'A lead.', updatedAt: '2026-11-01T00:00:00.000Z' }] }] } as WikiDocsDirectory;
    await open();
    expect(card()).toBeNull();
  });

  it('draws no card once the home lists topic articles', async () => {
    articles = { spaceId: SPACE_ID, categories: [{ key: 'clients', title: 'Clients', topics: [{ slug: 'ui', title: 'UI', description: null, category: 'clients', article: { title: 'UI' }, parts: [] }] }], uncategorized: [] };
    await open();
    expect(card()).toBeNull();
  });
});

describe('the Wiki of an account with no wiki', () => {
  beforeEach(() => {
    spaces = [];
    trashed = [];
  });

  it('says nothing of Trash while it is empty (docs/mocks/wiki-trash)', async () => {
    await open('/wiki');
    expect(words(card())).not.toContain('Open Trash');
  });

  it('leads to the wikis in Trash under its lead, while there are any, and opens Trash where the reader is', async () => {
    trashed = [{
      id: 'gone', slug: 'gone', title: 'gone', repoUrlNorm: null,
      deletedAt: '2026-11-07T12:00:00.000Z', purgeAt: '2027-11-07T12:00:00.000Z', entries: 2,
    }];
    await open('/wiki');
    expect(words(card()!.querySelector('.wk-start-h'))).toContain('1 wiki is in Trash. Open Trash');
    await press(button('Open Trash'));
    expect(words(document.querySelector('.wk-trash-dialog .wk-trash-line'))).toBe(
      'Moved to Trash Nov 7, 2026 · 2 entries · deleted for good Nov 7, 2027',
    );
    expect(where()).toBe('/wiki');
  });

  it('is the same card: the first step makes one, and the page says nothing of spaces', async () => {
    await open('/wiki');
    expect(words(card())).toContain('Set up your first wiki');
    expect(words(card())).not.toMatch(/\bspace\b/i);
    expect(button('Create wiki…')).toBeTruthy();
  });

  it('groups the workspaces under their repositories and leaves out one with none', async () => {
    await open('/wiki');
    await press(button('Create wiki…'));
    expect(words(document.querySelector('.wk-setup-dialog .orbit-overlay-title'))).toBe('Create wiki');
    expect(await options()).toEqual(['billing-api · build-01', 'shop-cli @ SG · build-01', 'shop-cli @ US · build-01', 'shop-cli @ EU · build-02offline']);
    expect([...document.querySelectorAll('.orbit-select-group-label')].map(words)).toEqual(['github.com/acme/billing-api', 'github.com/acme/shop-cli']);
  });

  it('says what the wiki will describe, for the workspace picked', async () => {
    session.set(WIKI_FROM_WORKSPACE_KEY, SG);
    await open('/wiki');
    await press(button('Create wiki…'));
    expect(words(dialog())).toContain('This wiki will describe github.com/acme/shop-cli.');
  });

  it('makes the wiki in one request, maintenance on, and goes to it', async () => {
    session.set(WIKI_FROM_WORKSPACE_KEY, SG);
    await open('/wiki');
    await press(button('Create wiki…'));
    await press(button('Create wiki', dialog()));
    expect(writes).toEqual([
      {
        method: 'POST',
        path: '/api/wiki/spaces',
        body: {
          title: 'shop-cli',
          repoUrl: 'https://github.com/acme/shop-cli.git',
          maintenance: { enabled: true, workspaceId: SG, dailyRunLimit: 8, lookbackDays: 14 },
        },
      },
    ]);
    expect(where()).toBe('/wiki/github-com-acme-shop-cli');
    expect(words(container)).not.toContain('No wiki space by that name');
    expect(words(steps()[1])).toContain('Drafting the plan');
  });

  it('keeps the form open and says why when the server refuses', async () => {
    refusal = 'no such workspace';
    await open('/wiki');
    await press(button('Create wiki…'));
    await press(button('Create wiki', dialog()));
    expect(words(dialog().querySelector('[role="alert"]'))).toBe('no such workspace');
    expect(where()).toBe('/wiki');
  });

  it('offers nothing to press with no workspace on a repository, and says so', async () => {
    workspaces = WORKSPACES.filter((row) => row.repoUrl === null);
    await open('/wiki');
    expect(words(card())).toContain('None of your workspaces has a repository yet. Add one, then come back.');
    expect(button('Create wiki…')).toBeUndefined();
  });

  it('does not say an account has no repository because the workspaces could not be read', async () => {
    workspaces = null;
    await open('/wiki');
    expect(words(card())).not.toContain('None of your workspaces');
    expect(button('Create wiki…')).toBeTruthy();
  });

  it('says there is no such wiki at an address that names one', async () => {
    await open('/wiki/nothing');
    expect(words(container)).toContain('No wiki space by that name.');
    expect(card()).toBeNull();
  });
});
