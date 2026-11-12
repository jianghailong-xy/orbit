// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import start from '../../../shared/src/wiki-start.fixture.json';
import { WikiPage } from '../pages/WikiPage';
import { WikiCreateDialog } from './WikiSetUpDialog';

/**
 * Another wiki (docs/wiki-explicit-creation-design.md §3.4, board 46 parts 4-5), on the real routes against a fake
 * `/api`: the wiki head picker ends in New wiki… under a divider, which opens the Create wiki form and leaves the
 * head where it was; the form greys a repository that has a wiki in use as a group, tagged Has a wiki, and offers
 * none of its workspaces; and a wiki made meanwhile is the server's 409 WIKI_SPACE_EXISTS, whose message it shows.
 * The workspaces are the shared fixture's (`workspaces.choices`), the repositories with a wiki its `hasWiki.wikis`.
 */

const UP = '0196e300-0000-7000-8000-0000000000d1';
const DOWN = '0196e300-0000-7000-8000-0000000000d2';
/** The fixture's workspaces under ids the server would give them: the forms compare ids in their public spelling. */
const uuid = (index: number) => `0196e300-0000-7000-8000-0000000000${(0xa0 + index).toString(16)}`;
const ID: Record<string, string> = Object.fromEntries(start.workspaces.choices.map((choice, index) => [choice.id, uuid(index)]));
const choices = start.workspaces.choices.map((choice) => ({ ...choice, id: ID[choice.id]! }));
const WORKSPACES = choices.map((choice) => {
  const [name, runner] = choice.label.split(' · ');
  return { id: choice.id, name, repoUrl: choice.repoUrl, runner: { id: choice.online ? UP : DOWN, name: runner } };
});
const RUNNERS = [
  { id: UP, name: 'build-01', online: true },
  { id: DOWN, name: 'build-02', online: false },
];

const spaceOf = (repository: string, index = 0) => ({
  id: `0196e300-0000-7000-8000-0000000001${String(index).padStart(2, '0')}`,
  slug: repository.replace(/[./]/g, '-'),
  title: repository.split('/').at(-1),
  repoUrlNorm: repository,
  rootCommitSha: null,
  settings: { reviewMode: 'tiered', maintenance: {} },
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  pendingOps: 0,
  planWaiting: 0,
  workspaceIds: [],
  docs: null,
});

let spaces: ReturnType<typeof spaceOf>[] = [];
let refusal: { status: number; code: string; message: string } | null = null;
let writes: Array<{ method: string; path: string; body: unknown }> = [];

const reply = (status: number, body: unknown): Response =>
  ({ ok: status < 400, status, statusText: '', text: async () => JSON.stringify(body), json: async () => body }) as unknown as Response;

async function serve(url: string, init?: RequestInit): Promise<Response> {
  const [path] = url.split('?');
  const method = init?.method ?? 'GET';
  if (method !== 'GET') {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    writes.push({ method, path: path!, body });
    if (refusal) return reply(refusal.status, { statusCode: refusal.status, code: refusal.code, message: refusal.message });
    return reply(201, spaceOf('github.com/acme/billing-api'));
  }
  if (path === '/api/wiki/spaces') return reply(200, spaces);
  if (path === '/api/wiki/trash') return reply(200, { spaces: [] });
  if (path === '/api/workspaces') return reply(200, WORKSPACES);
  if (path === '/api/runners') return reply(200, RUNNERS);
  const space = spaces.find((row) => path!.startsWith(`/api/wiki/spaces/${row.id}`));
  if (space) {
    const rest = path!.slice(`/api/wiki/spaces/${space.id}`.length);
    if (rest === '') return reply(200, space);
    if (rest === '/docs') return reply(200, { spaceId: space.id, plan: null, docs: { total: 0, written: 0 }, categories: [] });
    if (rest === '/articles') return reply(200, { spaceId: space.id, categories: [], uncategorized: [] });
    if (rest === '/plan') return reply(200, { spaceId: space.id, confirmed: null, draft: null, proposals: [], job: null });
    if (rest === '/workspaces') return reply(200, { workspaces: [], addable: [] });
    if (rest === '/entries') return reply(200, []);
    if (rest === '/health') return reply(200, { spaceId: space.id, entries: 0, maintenance: null });
    if (rest === '/share') return reply(200, { link: null, counts: { documents: 0, footnotes: 0 } });
  }
  return reply(404, { message: `${url} is not in this fixture` });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  spaces = start.hasWiki.wikis.map((repository, index) => spaceOf(repository, index));
  refusal = null;
  writes = [];
  vi.stubGlobal('ResizeObserver', class { observe(): void {} unobserve(): void {} disconnect(): void {} });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('fetch', vi.fn(serve));
  sessionStorage.clear();
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

async function render(path: string, element?: JSX.Element): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <Where />
          {element ?? (
            <Routes>
              <Route path="/wiki/:space" element={<WikiPage route="home" />} />
            </Routes>
          )}
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

const words = (node: Element | null | undefined): string => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const where = (): string => words(container.querySelector('[data-where]'));
const dialog = (): Element | null => document.querySelector('.wk-setup-dialog');
const picker = (): HTMLSelectElement => container.querySelector<HTMLSelectElement>('.wk-select select')!;
const button = (label: string, scope: ParentNode): HTMLElement =>
  [...scope.querySelectorAll('button')].find((node) => words(node) === label) as HTMLElement;
const press = async (node: Element): Promise<void> => {
  expect(node).toBeTruthy();
  await act(async () => (node as HTMLElement).click());
  await settle();
};
const openList = async (): Promise<void> => press(document.getElementById('wk-setup-workspace')!);
const groups = (): Array<{ label: string; options: Array<{ label: string; disabled: boolean }> }> =>
  [...document.querySelectorAll('.orbit-select-popup [role="group"]')].map((node) => ({
    label: words(node.querySelector('.orbit-select-group-label')),
    options: [...node.querySelectorAll('.orbit-select-option')].map((option) => ({
      label: words(option),
      disabled: option.hasAttribute('data-disabled'),
    })),
  }));

const SHOP = 'github-com-acme-shop-cli';

describe('the wiki head picker', () => {
  it('ends in New wiki… under a divider, after every wiki', async () => {
    await render(`/wiki/${SHOP}`);
    const children = [...picker().children];
    expect(children.map((node) => node.tagName)).toEqual(['OPTION', 'OPTION', 'HR', 'OPTION']);
    expect(words(children.at(-1))).toBe(start.hasWiki.newWiki);
  });

  it('opens the Create wiki form from New wiki…, and the head stays on its wiki', async () => {
    await render(`/wiki/${SHOP}`);
    const item = [...picker().options].find((option) => option.text === start.hasWiki.newWiki)!;
    await act(async () => {
      picker().value = item.value;
      picker().dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(words(dialog()?.querySelector('.orbit-overlay-title'))).toBe('Create wiki');
    expect(where()).toBe(`/wiki/${SHOP}`);
    expect(picker().value).toBe(SHOP);
    await press(button('Cancel', dialog()!));
    expect(dialog()).toBeNull();
  });
});

describe('the Create wiki form once a wiki exists', () => {
  it('greys a repository that has a wiki as a group, tagged Has a wiki, and none of its workspaces can be picked', async () => {
    await render('/', <WikiCreateDialog onClose={() => {}} />);
    await openList();
    const label = (id: string) => choices.find((choice) => choice.id === ID[id])!.label;
    const offline = (id: string) => (choices.find((choice) => choice.id === ID[id])!.online ? '' : 'offline');
    expect(groups()).toEqual(
      start.hasWiki.groups.map((group) => ({
        label: `${group.repository}${group.hasWiki ? start.hasWiki.label : ''}`,
        options: group.choices.map((id) => ({ label: `${label(id)}${offline(id)}`, disabled: group.hasWiki })),
      })),
    );
  });

  it('opens on a workspace of a repository with no wiki, even when asked for one that has a wiki', async () => {
    await render('/', <WikiCreateDialog workspaceId={ID.sg} onClose={() => {}} />);
    const pick = start.hasWiki.defaults.find((row) => row.from === 'sg')!.pick!;
    expect(words(document.getElementById('wk-setup-workspace'))).toBe(choices.find((choice) => choice.id === ID[pick])!.label);
  });

  it('opens on the workspace it is asked for (a WIKI_CREATE card’s Change settings…)', async () => {
    spaces = [];
    await render('/', <WikiCreateDialog workspaceId={ID.eu} onClose={() => {}} />);
    expect(words(document.getElementById('wk-setup-workspace'))).toBe(choices.find((choice) => choice.id === ID.eu)!.label);
  });

  it('greys nothing while there is no wiki', async () => {
    spaces = [];
    await render('/', <WikiCreateDialog onClose={() => {}} />);
    await openList();
    expect(groups().every((group) => group.options.every((option) => !option.disabled))).toBe(true);
    expect(words(document.querySelector('.orbit-select-popup'))).not.toContain(start.hasWiki.label);
  });

  it('shows the server’s message when the repository got a wiki meanwhile (409 WIKI_SPACE_EXISTS), and stays open', async () => {
    refusal = start.hasWiki.refusal;
    await render('/', <WikiCreateDialog onClose={() => {}} />);
    await press(button('Create wiki', dialog()!));
    expect(writes.map((write) => `${write.method} ${write.path}`)).toEqual(['POST /api/wiki/spaces']);
    expect(words(dialog()!.querySelector('[role="alert"]'))).toBe(start.hasWiki.refusal.message);
    expect(dialog()).toBeTruthy();
  });

  it('can press nothing when every repository has a wiki', async () => {
    spaces = start.hasWiki.allHaveWikis.wikis.map((repository, index) => spaceOf(repository, index));
    await render('/', <WikiCreateDialog onClose={() => {}} />);
    expect(button('Create wiki', dialog()!).hasAttribute('disabled')).toBe(true);
  });
});
