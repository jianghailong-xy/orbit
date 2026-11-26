// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HelpArticle, HelpIndex } from '@orbit/shared';
import { App } from './App';
import { BootGate } from './components/BootGate';
import { ThemeProvider } from './lib/theme';
import { HELP_DRAWER_EVENT } from './lib/help/openHelpDrawer';

/**
 * The help center at /help and /help/:category/:slug (docs/mocks/help-center board 01 §3–4), mounted as main.tsx
 * mounts the app — theme, BootGate, the real routes under jsdom's own history — against a stand-in server that
 * answers the help doors and, signed in, the account reads the pages make. `location.href` writes (the client's
 * bounce to /login) are recorded rather than followed.
 */

const article = (over: Partial<HelpArticle>): HelpArticle => ({
  slug: 'machine-offline',
  title: 'A machine shows Offline',
  summary: 'Why it happens.',
  category: 'machines-and-engines',
  routes: [],
  errors: [],
  platforms: ['web', 'macos', 'ios', 'android'],
  common: true,
  updated: '2026-11-14',
  body: '',
  ...over,
});

const OFFLINE = article({
  body: [
    'Orbit marks a machine **Offline** when its runner has not checked in.',
    '',
    '## 1. Is the computer awake?',
    '',
    'Wake it.',
    '',
    '::: platform ios',
    'On iPhone, pull down to refresh the machine list.',
    ':::',
    '',
    '## 2. Is the runner running?',
    '',
    '```bash',
    'orbit status',
    '```',
    '',
    '[Open the machine](orbit:/settings/machines/:id)',
    '',
    'See [Add a machine](orbit:/help/machines-and-engines/add-a-machine) or [Waiting on you](orbit:/waiting) for more.',
  ].join('\n'),
});

const INDEX: HelpIndex = {
  categories: [
    { slug: 'get-started', title: 'Get started' },
    { slug: 'machines-and-engines', title: 'Machines & engines' },
  ],
  articles: [
    article({ slug: 'orbit-in-five-minutes', title: 'Orbit in five minutes', category: 'get-started', common: false }),
    article({ slug: 'add-a-machine', title: 'Add a machine', common: false }),
    article({ slug: 'machine-offline', title: 'A machine shows Offline' }),
  ],
};

/** The same index and article as a reader of Chinese gets them: the prose translated, everything else the same. */
const ZH_INDEX: HelpIndex = {
  categories: INDEX.categories,
  articles: INDEX.articles.map((a) =>
    a.slug === 'machine-offline' ? { ...a, title: '机器显示为离线', summary: '为什么会这样。' } : a,
  ),
};

const ZH_OFFLINE: HelpArticle = {
  ...OFFLINE,
  title: '机器显示为离线',
  summary: '为什么会这样。',
  body: [
    '当 Runner 90 秒没有签到时，Orbit 会把机器标记为 **Offline**。',
    '',
    '## 1. 电脑醒着吗？',
    '',
    '唤醒它。',
  ].join('\n'),
};

/** What the signed-in account has, for the reads /help makes. */
interface Account {
  runners: unknown[];
  workspaces: unknown[];
  keys: unknown[];
  pools: unknown[];
  doneTasks: unknown[];
}
const NEW_ACCOUNT: Account = { runners: [], workspaces: [], keys: [], pools: [], doneTasks: [] };
let account: Account = NEW_ACCOUNT;
let sessionAlive = true;
/** What `GET /users/me` says under `preferences`. */
let mePreferences: Record<string, unknown> = {};

let container: HTMLDivElement;
let root: Root | null = null;
let requests: Array<{ url: string; auth: string | null }> = [];
let sentTo: string[] = [];
/** Every POST /api/help/feedback body, in order. */
let votes: unknown[] = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  requests = [];
  sentTo = [];
  votes = [];
  account = NEW_ACCOUNT;
  sessionAlive = true;
  mePreferences = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? null;
      requests.push({ url, auth });
      const signedIn = auth !== null && sessionAlive;
      if (url === '/api/help/feedback' && init?.method === 'POST' && signedIn) {
        votes.push(JSON.parse(String(init.body)));
        return new Response(null, { status: 204 });
      }
      const answer: [number, unknown] =
        auth !== null && !sessionAlive
          ? [401, { statusCode: 401, message: 'Unauthorized' }]
          : url === '/api/help'
            ? [200, INDEX]
            : url === '/api/help?lang=zh-Hans'
              ? [200, ZH_INDEX]
              : url === '/api/help/articles/machine-offline'
                ? [200, OFFLINE]
                : url === '/api/help/articles/machine-offline?lang=zh-Hans'
                  ? [200, ZH_OFFLINE]
                  : url.startsWith('/api/help/articles/')
                    ? [404, { statusCode: 404, message: 'no such help article' }]
                    : url === '/api/users/me' && signedIn
                      ? [200, { id: 'u1', email: 'ada@example.com', name: 'Ada', createdAt: '', role: 'MEMBER', preferences: mePreferences }]
                    : url === '/api/runners' && signedIn
                      ? [200, account.runners]
                      : url === '/api/workspaces' && signedIn
                        ? [200, account.workspaces]
                        : url === '/api/providers/mine' && signedIn
                          ? [200, account.keys]
                          : url === '/api/providers/pools' && signedIn
                            ? [200, account.pools]
                            : url.startsWith('/api/tasks/page?status=DONE') && signedIn
                              ? [200, { items: account.doneTasks, nextCursor: null }]
                              : url === '/api/auth/refresh'
                                ? [401, { statusCode: 401, message: 'Unauthorized' }]
                                : [404, { statusCode: 404, message: `Cannot GET ${url}` }];
      return new Response(JSON.stringify(answer[1]), { status: answer[0], headers: { 'content-type': 'application/json' } });
    }),
  );
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }));
  const real = window.location;
  vi.stubGlobal(
    'location',
    new Proxy({} as Location, {
      get: (_, key) => {
        const value: unknown = Reflect.get(real, key, real);
        return typeof value === 'function' ? value.bind(real) : value;
      },
      set: (_, key, value) => {
        if (key !== 'href') return Reflect.set(real, key, value, real);
        sentTo.push(String(value));
        return true;
      },
    }),
  );
});

afterEach(async () => {
  await unmount();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

async function unmount(): Promise<void> {
  if (!root) return;
  const mounted = root;
  root = null;
  await act(async () => mounted.unmount());
  container.remove();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function visit(path: string): Promise<void> {
  await unmount();
  window.history.replaceState(null, '', path);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <BrowserRouter>
            <BootGate>
              <App />
            </BootGate>
          </BrowserRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

const addressBar = (): string => window.location.pathname + window.location.search;
const body = () => container.querySelector('.help-md') as HTMLElement;
const actions = () => [...container.querySelectorAll('a.help-md-action')].map((a) => [a.textContent, a.getAttribute('href')]);
const signIn = () => localStorage.setItem('orbit_token', 'access-token');

describe('an article page', () => {
  it('renders signed out at its own address, asking the help door with no credential', async () => {
    await visit('/help/machines-and-engines/machine-offline');

    expect(addressBar()).toBe('/help/machines-and-engines/machine-offline');
    expect(sentTo, 'sent to log in').toEqual([]);
    expect(container.querySelector('input[type="password"]'), 'a login form').toBeNull();
    expect(container.querySelector('h1')?.textContent).toBe('A machine shows Offline');
    expect(container.querySelector('.help-meta')?.textContent).toBe('1 min read · Updated Nov 14, 2026 · Web, macOS, iPhone, Android');
    expect(container.querySelector('.help-breadcrumb')?.textContent).toBe('Help › Machines & engines');
    expect(requests.map((r) => r.url)).toContain('/api/help/articles/machine-offline');
    expect(requests.every((r) => r.auth === null), 'no request carries a credential').toBe(true);
    // Nothing of the account is read signed out.
    expect(requests.map((r) => r.url).filter((u) => !u.startsWith('/api/help'))).toEqual([]);

    // On this page: the ## headings, linking the anchors the headings carry.
    const toc = [...container.querySelectorAll('.help-toc a')].map((a) => [a.textContent, a.getAttribute('href')]);
    expect(toc).toEqual([
      ['1. Is the computer awake?', '#1-is-the-computer-awake'],
      ['2. Is the runner running?', '#2-is-the-runner-running'],
    ]);
    expect(document.getElementById('1-is-the-computer-awake')?.tagName).toBe('H2');

    // Signed out, the in-app buttons are not drawn: the lone one with its paragraph, an inline one as its words.
    expect(actions()).toEqual([]);
    expect(body().textContent).not.toContain('Open the machine');
    expect(body().textContent).toContain('or Waiting on you for more.');
    // A link to another article is still a link.
    expect(container.querySelector('.help-md a[href="/help/machines-and-engines/add-a-machine"]')?.textContent).toBe('Add a machine');
    // The code block, with its Copy.
    expect(body().querySelector('pre')?.textContent).toContain('orbit status');
    expect(body().querySelector('.help-md-copy')?.textContent).toBe('Copy');
    // Did this help?, rendered; signed out a press is shown and not sent (there is no one to count once).
    expect([...container.querySelectorAll('.help-feedback button')].map((b) => b.textContent)).toEqual(['Yes', 'No']);
    await act(async () => container.querySelector<HTMLButtonElement>('.help-feedback [data-answer="no"]')!.click());
    expect(container.querySelector('.help-feedback [data-answer="no"]')!.getAttribute('aria-pressed')).toBe('true');
    expect(requests.map((r) => r.url)).not.toContain('/api/help/feedback');
  });

  it('signed in, Did this help? sends the article\'s Yes / No to POST /api/help/feedback', async () => {
    signIn();
    await visit('/help/machines-and-engines/machine-offline');
    const press = async (answer: 'yes' | 'no') => {
      await act(async () => container.querySelector<HTMLButtonElement>(`.help-feedback [data-answer="${answer}"]`)!.click());
      await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    };
    await press('yes');
    await press('no');
    expect(votes).toEqual([
      { kind: 'article', id: 'machine-offline', helpful: true },
      { kind: 'article', id: 'machine-offline', helpful: false },
    ]);
    expect([...container.querySelectorAll('.help-feedback button')].map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true']);
  });

  it('hides the iPhone-only passage on the web', async () => {
    await visit('/help/machines-and-engines/machine-offline');
    expect(body().textContent).toContain('Wake it.');
    expect(body().textContent).not.toContain('On iPhone, pull down to refresh');
    expect(body().textContent).not.toContain(':::');
  });

  it('stays open signed out when the stored session turns out dead', async () => {
    sessionAlive = false;
    localStorage.setItem('orbit_token', 'expired-access-token');
    localStorage.setItem('orbit_refresh', 'revoked-refresh-token');
    await visit('/help/machines-and-engines/machine-offline');

    expect(sentTo, 'sent to log in').toEqual([]);
    expect(addressBar()).toBe('/help/machines-and-engines/machine-offline');
    expect(localStorage.getItem('orbit_token')).toBeNull();
  });

  it("signed in, resolves the machine button to the account's offline machine", async () => {
    signIn();
    account = {
      ...NEW_ACCOUNT,
      runners: [
        { id: 'r-up', name: 'gpu-01', online: true, lastHeartbeatAt: new Date().toISOString() },
        { id: 'r-down', name: 'build-box', online: false, lastHeartbeatAt: '2026-11-01T00:00:00Z' },
      ],
    };
    await visit('/help/machines-and-engines/machine-offline');

    expect(actions()).toEqual([
      ['Open the machine ›', '/settings/machines/r-down'],
      ['Waiting on you ›', '/waiting'],
    ]);
  });

  it('signed in with no machine, hides the machine button whose target does not exist', async () => {
    signIn();
    await visit('/help/machines-and-engines/machine-offline');

    expect(actions()).toEqual([['Waiting on you ›', '/waiting']]);
    expect(body().textContent).not.toContain('Open the machine');
  });

  it('moves an address with the wrong category to the article’s own', async () => {
    await visit('/help/get-started/machine-offline');
    expect(addressBar()).toBe('/help/machines-and-engines/machine-offline');
  });

  it('says so for an article that does not exist', async () => {
    await visit('/help/wiki/nothing-here');
    expect(container.querySelector('h1')?.textContent).toBe("This article doesn't exist");
  });
});

describe('the article language', () => {
  const picker = () => container.querySelector<HTMLSelectElement>('select[aria-label="Article language"]');
  const choose = async (language: string) => {
    const select = picker()!;
    await act(async () => {
      select.value = language;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
  };

  it('choosing 中文 reads the articles in Chinese, and remembers the choice across visits', async () => {
    await visit('/help');
    expect(picker()?.value).toBe('en');
    expect(container.querySelector('.help-list-row')?.textContent).toBe('A machine shows Offline');

    await choose('zh-Hans');
    expect(localStorage.getItem('orbit.help.language')).toBe('zh-Hans');
    expect(requests.map((r) => r.url)).toContain('/api/help?lang=zh-Hans');
    expect(container.querySelector('.help-list-row')?.textContent).toBe('机器显示为离线');

    await visit('/help/machines-and-engines/machine-offline');
    expect(picker()?.value).toBe('zh-Hans');
    expect(container.querySelector('h1')?.textContent).toBe('机器显示为离线');
    expect(body().textContent).toContain('当 Runner 90 秒没有签到时');
    // Only the article is translated: the help center's own chrome stays English.
    expect(container.querySelector('.help-breadcrumb')?.textContent).toBe('Help › Machines & engines');
    expect([...container.querySelectorAll('.help-feedback button')].map((b) => b.textContent)).toEqual(['Yes', 'No']);
    expect(requests.map((r) => r.url)).toContain('/api/help/articles/machine-offline?lang=zh-Hans');
  });

  it("a signed-in account whose Your language is Chinese reads the articles in Chinese until it chooses otherwise", async () => {
    signIn();
    mePreferences = { translationLanguage: 'zh-Hans' };
    await visit('/help');
    expect(picker()?.value).toBe('zh-Hans');
    expect(requests.map((r) => r.url)).toContain('/api/help?lang=zh-Hans');
  });
});

describe('the /help home', () => {
  const checklist = () =>
    [...container.querySelectorAll('.help-step')].map((li) => [li.getAttribute('data-step'), li.getAttribute('data-done')]);

  it('signed out: search, topics with their counts and common problems, no checklist and no Ask', async () => {
    await visit('/help');

    expect(sentTo).toEqual([]);
    expect(addressBar()).toBe('/help');
    expect(container.querySelector('h1')?.textContent).toBe('How can we help?');
    expect(container.querySelector('input[aria-label="Search help"]')).not.toBeNull();
    expect(container.querySelector('.help-get-started')).toBeNull();
    expect(container.querySelector('.help-ask')).toBeNull();
    expect([...container.querySelectorAll('.help-topic')].map((t) => [t.querySelector('.help-topic-title')?.textContent, t.querySelector('.help-topic-count')?.textContent])).toEqual([
      ['Get started', '1 article'],
      ['Machines & engines', '2 articles'],
    ]);
    expect([...container.querySelectorAll('.help-list-row')].map((r) => [r.textContent, r.getAttribute('href')])).toEqual([
      ['A machine shows Offline', '/help/machines-and-engines/machine-offline'],
    ]);
  });

  it('ticks nothing for a new account, and offers Start on the first step', async () => {
    signIn();
    await visit('/help');

    expect(container.querySelector('.help-get-started-title')?.textContent).toBe('Get started · 0 of 4 done');
    expect(checklist()).toEqual([
      ['machine', 'false'],
      ['model', 'false'],
      ['workspace', 'false'],
      ['task', 'false'],
    ]);
    expect(container.querySelector('.help-step--next')?.getAttribute('data-step')).toBe('machine');
  });

  it('ticks the steps the account has done, from its real state', async () => {
    signIn();
    account = {
      ...NEW_ACCOUNT,
      runners: [
        { id: 'r1', name: 'mia-macbook', online: true, lastHeartbeatAt: new Date().toISOString(), engines: [{ engine: 'claude', installed: true, auth: 'yes' }] },
      ],
      workspaces: [],
    };
    await visit('/help');

    expect(container.querySelector('.help-get-started-title')?.textContent).toBe('Get started · 2 of 4 done');
    expect(checklist()).toEqual([
      ['machine', 'true'],
      ['model', 'true'],
      ['workspace', 'false'],
      ['task', 'false'],
    ]);
    expect(container.querySelector('[data-step="machine"] .help-step-detail')?.textContent).toBe('mia-macbook is online');
    expect(container.querySelector('[data-step="model"] .help-step-detail')?.textContent).toBe('Claude Code signed in');
    expect(container.querySelector('.help-step--next')?.getAttribute('data-step')).toBe('workspace');
  });

  it("folds to You're set up when all four are done, and Hide puts it away", async () => {
    signIn();
    account = {
      runners: [{ id: 'r1', name: 'm', online: true, lastHeartbeatAt: new Date().toISOString() }],
      workspaces: [{ id: 'w1', name: 'orbit' }],
      keys: [{ id: 'k1', label: 'Anthropic' }],
      pools: [],
      doneTasks: [{ id: 't1' }],
    };
    await visit('/help');

    expect(container.querySelector('.help-steps')).toBeNull();
    expect(container.querySelector('.help-get-started--done')?.textContent).toContain("You're set up");
    const hide = [...container.querySelectorAll('.help-get-started button')].find((b) => b.textContent === 'Hide')!;
    await act(async () => (hide as HTMLButtonElement).click());
    expect(container.querySelector('.help-get-started')).toBeNull();

    await visit('/help');
    expect(container.querySelector('.help-get-started'), 'still hidden after a reload').toBeNull();
  });

  it("Ask opens the help drawer's Ask tab", async () => {
    signIn();
    const opened: unknown[] = [];
    const listen = (event: Event) => opened.push((event as CustomEvent).detail);
    window.addEventListener(HELP_DRAWER_EVENT, listen);
    try {
      await visit('/help');
      await act(async () => (container.querySelector('.help-ask') as HTMLButtonElement).click());
      expect(opened).toEqual([{ tab: 'ask', query: null }]);
    } finally {
      window.removeEventListener(HELP_DRAWER_EVENT, listen);
    }
  });

  it('signed in, Ask opens the help drawer docked beside the page on its Ask tab, and Esc closes it', async () => {
    signIn();
    await visit('/help');
    const drawer = () => container.querySelector('aside.help-drawer[aria-label="Help"]');
    expect(drawer(), 'closed until asked').toBeNull();

    await act(async () => (container.querySelector('.help-ask') as HTMLButtonElement).click());
    // Docked: the shell's last child, a sibling of the page's main area, not an overlay.
    const shell = container.querySelector('.help-shell')!;
    expect(drawer()).not.toBeNull();
    expect(shell.lastElementChild).toBe(drawer());
    expect(drawer()!.previousElementSibling?.classList.contains('help-main')).toBe(true);
    expect(drawer()!.querySelector('[data-help-pane]')?.getAttribute('data-help-pane')).toBe('ask');

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(drawer(), 'closed by Esc').toBeNull();
  });

  it('signed out, renders with no drawer, and the drawer event opens none', async () => {
    await visit('/help');
    expect(container.querySelector('.help-shell')!.lastElementChild?.classList.contains('help-main')).toBe(true);
    await act(async () => {
      window.dispatchEvent(new CustomEvent(HELP_DRAWER_EVENT, { detail: { tab: 'ask' } }));
    });
    expect(container.querySelector('.help-drawer')).toBeNull();
  });

  it('lists the categories and More in its nav, the open category listing its articles', async () => {
    await visit('/help/machines-and-engines/machine-offline');
    const nav = container.querySelector('nav[aria-label="Help"]')!;
    expect([...nav.querySelectorAll('a')].map((a) => a.textContent)).toEqual([
      'Home',
      'Get started',
      'Machines & engines',
      'Add a machine',
      'A machine shows Offline',
      "What's new",
    ]);
    expect(nav.querySelector('a.active')?.textContent).toBe('A machine shows Offline');
    expect(nav.querySelector('button')?.textContent).toBe('Back to Orbit');
  });
});
