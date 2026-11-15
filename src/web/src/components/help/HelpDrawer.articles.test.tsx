// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HelpArticle, HelpArticleMeta, HelpIndex, HelpSearchResult } from '@orbit/shared';
import { HelpDrawerProvider, useHelpDrawer } from '../../lib/helpDrawer';
import { HELP_ERROR_ATTR } from '../../lib/help/drawerArticles';
import { HelpDrawer } from '../HelpDrawer';
import { HelpLearnMore } from './HelpLearnMore';
import { HELP_SEARCH_DEBOUNCE_MS } from './HelpArticlesPane';

/**
 * The help drawer's Articles tab (docs/mocks/help-center/01-web.png ①–②): For this page by route, the article for a
 * visible error first, Learn more opening it in place, reading an article, and search as you type with its Ask row.
 * The real drawer and its provider over a stand-in server answering the help doors and the account reads.
 */

const meta = (slug: string, over: Partial<HelpArticleMeta> = {}): HelpArticleMeta => ({
  slug,
  title: slug,
  summary: `About ${slug}.`,
  category: 'machines-and-engines',
  routes: [],
  errors: [],
  platforms: ['web', 'macos', 'ios', 'android'],
  common: false,
  updated: '2026-11-14',
  ...over,
});

const MACHINE = '/settings/machines/:id';
const INDEX: HelpIndex = {
  categories: [
    { slug: 'get-started', title: 'Get started' },
    { slug: 'machines-and-engines', title: 'Machines & engines' },
  ],
  articles: [
    meta('orbit-in-five-minutes', { title: 'Orbit in five minutes', category: 'get-started', routes: ['/'] }),
    meta('your-first-task', { title: 'Your first task, start to merge', category: 'get-started' }),
    meta('add-a-machine', { title: 'Add a machine', routes: [MACHINE] }),
    meta('install-or-update-an-engine', { title: 'Install or update an engine', routes: ['/settings/machines/*'] }),
    meta('move-a-workspace', { title: 'Move a workspace to another machine', routes: [MACHINE] }),
    meta('runner-troubleshooting', { title: 'Runner troubleshooting', routes: ['/settings/**'] }),
    // Last in the library, so only the error pin can put it first.
    meta('machine-offline', { title: 'A machine shows Offline', routes: [MACHINE], errors: ['runner.offline'], common: true }),
  ],
};

const OFFLINE: HelpArticle = {
  ...INDEX.articles[6],
  body: [
    'Orbit marks a machine **Offline** when its runner has not checked in for 90 seconds.',
    '',
    '## 2. Is the runner running?',
    '',
    '```bash',
    'orbit status',
    '```',
    '',
    '::: platform ios',
    'On iPhone, pull down to refresh.',
    ':::',
    '',
    '[Open the machine](orbit:/settings/machines/:id)',
  ].join('\n'),
};

const SEARCH: HelpSearchResult = {
  query: 'offline',
  hits: [
    {
      slug: 'machine-offline',
      title: 'A machine shows Offline',
      category: 'machines-and-engines',
      titleMatches: [{ start: 16, length: 7 }],
      snippet: { text: 'Orbit marks a machine Offline when its runner has not checked in', matches: [{ start: 22, length: 7 }] },
    },
    {
      slug: 'runner-troubleshooting',
      title: 'Runner troubleshooting',
      category: 'machines-and-engines',
      titleMatches: [],
      snippet: { text: 'Enrollment, heartbeat and offline runners.', matches: [{ start: 26, length: 7 }] },
    },
  ],
};

let runners: unknown[] = [];
let requests: string[] = [];
let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  requests = [];
  runners = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requests.push(url);
      const answer: [number, unknown] =
        url === '/api/help'
          ? [200, INDEX]
          : url === '/api/help/articles/machine-offline'
            ? [200, OFFLINE]
            : url.startsWith('/api/help/search?q=')
              ? [200, decodeURIComponent(url.split('q=')[1]) === 'offline' ? SEARCH : { query: 'zzz', hits: [] }]
              : url === '/api/users/me'
                ? [200, { id: 'u1', email: 'ada@example.com', name: 'Ada', createdAt: '', role: 'MEMBER', preferences: {} }]
                : url === '/api/runners'
                  ? [200, runners]
                  : url === '/api/workspaces'
                    ? [200, []]
                    : [404, { statusCode: 404, message: `Cannot GET ${url}` }];
      return new Response(JSON.stringify(answer[1]), { status: answer[0], headers: { 'content-type': 'application/json' } });
    }),
  );
});

async function unmountNow() {
  if (!root) return;
  const mounted = root;
  root = null;
  await act(async () => mounted.unmount());
  container.remove();
}

afterEach(async () => {
  await unmountNow();
  vi.unstubAllGlobals();
  localStorage.clear();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Where the page is, and the drawer's state, for asserting a Learn more left the page where it was. */
function Where() {
  const location = useLocation();
  const help = useHelpDrawer();
  return <div data-testid="where" data-path={location.pathname} data-tab={help.tab} data-open={String(help.open)} />;
}

/** The page under the drawer: optionally an error card naming runner.offline with its Learn more. */
function Page({ errorCard }: { errorCard: boolean }) {
  return (
    <main>
      {errorCard && (
        <div className="rd-attention-card" {...{ [HELP_ERROR_ATTR]: 'runner.offline' }}>
          build-box has been offline for 2 hours.
          <HelpLearnMore slug="machine-offline" />
        </div>
      )}
    </main>
  );
}

/** The drawer opened by whatever opens it (the ? button's toggle stands in), at a page. */
function Opener({ open }: { open: boolean }) {
  const help = useHelpDrawer();
  return open && !help.open ? <button type="button" data-testid="open" onClick={() => help.openHelp()} /> : null;
}

async function mount(path: string, { errorCard = false, open = true }: { errorCard?: boolean; open?: boolean } = {}) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <HelpDrawerProvider>
            <Routes>
              <Route path="*" element={<Page errorCard={errorCard} />} />
            </Routes>
            <Where />
            <Opener open={open} />
            <HelpDrawer />
          </HelpDrawerProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  if (open) await click(container.querySelector<HTMLElement>('[data-testid="open"]')!);
  await settle();
}

async function click(el: HTMLElement) {
  await act(async () => el.click());
  await settle();
}

async function type(value: string) {
  const input = container.querySelector<HTMLInputElement>('.help-drawer input[type="search"]')!;
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function waitDebounce() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, HELP_SEARCH_DEBOUNCE_MS + 20));
  });
  await settle();
}

const drawer = () => container.querySelector<HTMLElement>('.help-drawer')!;
const group = (label: string) => drawer().querySelector<HTMLElement>(`section[aria-label="${label}"]`);
const slugs = (el: HTMLElement | null) => [...(el?.querySelectorAll<HTMLElement>('[data-help-article]') ?? [])].map((b) => b.dataset.helpArticle);
const where = () => container.querySelector<HTMLElement>('[data-testid="where"]')!.dataset;
const buttonNamed = (name: string, within: ParentNode = drawer()) =>
  [...within.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent?.trim() === name)!;

describe('For this page', () => {
  it('lists the route’s articles, at most 4, in the library’s order, with Get started under them', async () => {
    await mount('/settings/machines/r1');
    expect(group('For this page')!.querySelector('h3')!.textContent).toBe('For this page Settings → Machines');
    // Five articles match /settings/machines/r1; the fifth (machine-offline) is cut.
    expect(slugs(group('For this page'))).toEqual(['add-a-machine', 'install-or-update-an-engine', 'move-a-workspace', 'runner-troubleshooting']);
    expect(slugs(group('Get started'))).toEqual(['orbit-in-five-minutes', 'your-first-task']);
    expect(group('For this page')!.querySelector('.help-art-icon.warn')).toBeNull();
  });

  it('is hidden where no article matches, leaving Get started', async () => {
    await mount('/tasks');
    expect(group('For this page')).toBeNull();
    expect(slugs(group('Get started'))).toEqual(['orbit-in-five-minutes', 'your-first-task']);
  });
});

describe('an error on the page', () => {
  it('puts the article for the visible error slug first, with a warning icon', async () => {
    await mount('/settings/machines/r1', { errorCard: true });
    const rows = [...group('For this page')!.querySelectorAll<HTMLElement>('.help-art')];
    expect(rows.map((r) => r.dataset.helpArticle)).toEqual(['machine-offline', 'add-a-machine', 'install-or-update-an-engine', 'move-a-workspace']);
    expect(rows[0].dataset.pinned).toBe('true');
    expect(rows[0].querySelector('.help-art-icon')!.className).toBe('help-art-icon warn');
    expect(rows[1].querySelector('.help-art-icon.warn')).toBeNull();
  });

  it('pins it on a page whose routes it does not list, and drops it when the card goes', async () => {
    await mount('/tasks', { errorCard: true });
    expect(slugs(group('For this page'))).toEqual(['machine-offline']);
    await act(async () => container.querySelector('[data-help-error]')!.removeAttribute(HELP_ERROR_ATTR));
    await settle();
    expect(group('For this page')).toBeNull();
  });

  it('Learn more → opens the drawer at that article, without leaving the page', async () => {
    await mount('/settings/machines/r1', { errorCard: true, open: false });
    expect(container.querySelector('.help-drawer')).toBeNull();
    const learn = container.querySelector<HTMLElement>('main .help-learn-more')!;
    expect(learn.textContent).toBe('Learn more →');
    await click(learn);
    expect(where()).toMatchObject({ path: '/settings/machines/r1', open: 'true', tab: 'articles' });
    const reading = drawer().querySelector<HTMLElement>('[data-help-pane="article"]')!;
    expect(reading.dataset.helpSlug).toBe('machine-offline');
    expect(reading.querySelector('.help-reading-title')!.textContent).toBe('A machine shows Offline');
  });
});

describe('reading an article in the drawer', () => {
  it('breadcrumb, title, read time and date, body with code, other platforms hidden, Did this help, and ‹ back', async () => {
    await mount('/settings/machines/r1');
    await click(drawer().querySelector<HTMLElement>('[data-help-article="add-a-machine"]')!);
    // add-a-machine has no answer from the stand-in server: the drawer says so instead of a blank.
    expect(drawer().querySelector('.help-pane-empty')!.textContent).toMatch(/^This article doesn't exist/);
    await click(drawer().querySelector<HTMLElement>('[aria-label="All articles"]')!);
    expect(slugs(group('For this page'))).toHaveLength(4);
    await unmountNow();

    await readOffline('/settings/machines/r1');
    const reading = drawer().querySelector<HTMLElement>('.help-reading')!;
    expect(reading.querySelector('.help-crumb')!.textContent).toBe('Machines & engines');
    expect(reading.querySelector('.help-reading-meta')!.textContent).toBe('1 min read · Updated Nov 14, 2026');
    expect(reading.querySelector('.help-md-code pre')!.textContent).toContain('orbit status');
    expect(reading.textContent).not.toContain('On iPhone');
    // Signed out: the in-app link's target does not exist for the reader, so no button.
    expect(reading.querySelector('a.help-md-action')).toBeNull();
    const helpful = reading.querySelector<HTMLElement>('[aria-label="Did this help?"]')!;
    expect([...helpful.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Yes', 'No', 'Ask instead']);
  });

  it('an orbit:/ link is a button to the account’s own machine', async () => {
    localStorage.setItem('orbit_token', 'tok');
    runners = [{ id: 'r-mac', name: 'mac', online: true, lastHeartbeatAt: new Date().toISOString() }];
    await readOffline('/tasks');
    const action = drawer().querySelector<HTMLAnchorElement>('a.help-md-action')!;
    expect(action.getAttribute('href')).toBe('/settings/machines/r-mac');
    expect(action.textContent).toBe('Open the machine ›');
  });

  it('Ask instead switches to Ask with the article attached', async () => {
    await readOffline('/tasks');
    await click(buttonNamed('Ask instead'));
    const ask = drawer().querySelector<HTMLElement>('[data-help-pane="ask"]')!;
    expect(ask.dataset.helpArticle).toBe('machine-offline');
    expect(where().tab).toBe('ask');
  });
});

/** Mounted with the drawer opened at machine-offline by the page's Learn more. */
async function readOffline(path: string) {
  await mount(path, { errorCard: true, open: false });
  await click(container.querySelector<HTMLElement>('main .help-learn-more')!);
}

describe('search', () => {
  it('searches as you type, once typing pauses, with the matches highlighted and Ask last', async () => {
    await mount('/settings/machines/r1');
    await type('off');
    await type('offline');
    await settle();
    expect(requests.filter((u) => u.startsWith('/api/help/search'))).toEqual([]);
    await waitDebounce();
    expect(requests.filter((u) => u.startsWith('/api/help/search'))).toEqual(['/api/help/search?q=offline']);
    const results = group('Search results')!;
    expect(results.querySelector('h3')!.textContent).toBe('2 articles');
    expect(group('For this page')).toBeNull();
    const first = results.querySelector<HTMLElement>('.help-res')!;
    expect([...first.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['Offline', 'Offline']);
    expect(first.querySelector('.help-res-title')!.innerHTML).toBe('A machine shows <mark>Offline</mark>');
    expect(first.querySelector('.help-res-category')!.textContent).toBe('Machines & engines');
    const rows = [...results.querySelectorAll<HTMLElement>('button')];
    expect(rows.at(-1)!.hasAttribute('data-help-ask')).toBe(true);
    expect(rows.at(-1)!.querySelector('.help-art-title')!.textContent).toBe('Ask “offline”');
  });

  it('keeps the Ask row when nothing matches, and it opens Ask with the query', async () => {
    await mount('/tasks');
    await type('zzz');
    await waitDebounce();
    const results = group('Search results')!;
    expect(results.querySelector('h3')!.textContent).toBe('0 articles');
    const ask = results.querySelector<HTMLElement>('[data-help-ask]')!;
    expect(ask.textContent).toContain('Ask “zzz”');
    await click(ask);
    expect(drawer().querySelector<HTMLElement>('[data-help-pane="ask"]')!.dataset.helpQuery).toBe('zzz');
  });

  it('a hit opens its article in the drawer; ‹ comes back to the same results', async () => {
    await mount('/tasks');
    await type('offline');
    await waitDebounce();
    await click(group('Search results')!.querySelector<HTMLElement>('[data-help-article="machine-offline"]')!);
    expect(drawer().querySelector<HTMLElement>('[data-help-pane="article"]')!.dataset.helpSlug).toBe('machine-offline');
    await click(drawer().querySelector<HTMLElement>('[aria-label="All articles"]')!);
    expect(drawer().querySelector<HTMLInputElement>('input[type="search"]')!.value).toBe('offline');
    expect(slugs(group('Search results'))).toEqual(['machine-offline', 'runner-troubleshooting']);
  });
});

describe('footer', () => {
  it('Open help center goes to /help; What’s new names the version', async () => {
    await mount('/tasks');
    const foot = drawer().querySelector<HTMLElement>('.help-drawer-foot')!;
    const [open, news] = [...foot.querySelectorAll('button')];
    expect(open.textContent).toBe('Open help center');
    expect(news.textContent).toMatch(/^What's new in \d+\.\d+\.\d+/);
    await click(news);
    expect(where()).toMatchObject({ path: '/help/whats-new', open: 'false' });
  });
});
