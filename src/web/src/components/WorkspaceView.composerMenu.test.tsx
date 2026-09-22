// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';

/** The stylesheet itself, as text — the working directory is not the same under every runner. */
const stylesPath = [resolve(process.cwd(), 'src/index.css'), resolve(process.cwd(), 'src/web/src/index.css')].find(
  existsSync,
);
if (!stylesPath) throw new Error('index.css not found from the test working directory');
const indexCss = readFileSync(stylesPath, 'utf8');

/**
 * The composer's `+` menu.
 *
 * One component draws it for both clients, and the two clients draw it from opposite ends: this
 * menu opens upward, so the array's LAST entry sits beside the `+`, while the native menu
 * (ComposerView.swift `addMenu`) hands its items to the system first-nearest-the-button and gets
 * them back reversed. The order asserted below is therefore the order on screen, and it is the
 * native menu's order — Command under the thumb, File at the far end, a divider between the two
 * groups — which is what the phone screenshot this was reported from was missing. See
 * docs/mocks/composer-attach-menu-phone.html.
 *
 * The same two clients want different DENSITY, so the phone half of that lives in index.css under
 * the phone breakpoint and is pinned here too: jsdom has no layout engine, so the metrics are read
 * off the stylesheet the way WorkspaceView.projectBackLink.test.ts reads its flex contract.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn() };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSessionEventPage } = await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-0000000000b1';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000b2');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-0000000000b3');

const RUNNER = {
  id: RUNNER_ID,
  name: 'wikova',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

const SESSION = {
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  title: '把 + 菜单排成 iOS 的样子',
  status: 'OPEN',
  provider: 'claude',
  createdAt: '2026-09-22T09:00:00Z',
  updatedAt: '2026-09-22T09:05:00Z',
};

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

describe('the composer + menu', { timeout: 60_000 }, () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let client: QueryClient | null = null;

  const mounted = (): HTMLDivElement => {
    if (!container) throw new Error('WorkspaceView is not mounted');
    return container;
  };

  const mount = async (): Promise<void> => {
    vi.mocked(getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
    const nextClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
    });
    const nextContainer = document.createElement('div');
    const nextRoot = createRoot(nextContainer);
    client = nextClient;
    container = nextContainer;
    root = nextRoot;
    document.body.appendChild(nextContainer);
    await act(async () => {
      nextRoot.render(
        <QueryClientProvider client={nextClient}>
          <MemoryRouter initialEntries={[`/sessions/${SESSION_PUBLIC}`]}>
            <AntApp>
              <WorkspaceView runner={RUNNER} />
            </AntApp>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
  };

  /** Opens the menu the way a thumb does, and hands back the popup as antd mounted it. */
  const openMenu = async (): Promise<HTMLElement> => {
    await mount();
    await act(async () => {
      await vi.waitFor(
        () => expect(mounted().querySelector('[aria-label="Add attachment"]')).not.toBeNull(),
        { timeout: 20_000, interval: 20 },
      );
    });
    const button = mounted().querySelector<HTMLElement>('[aria-label="Add attachment"]')!;
    await act(async () => {
      button.click();
    });
    await act(async () => {
      await vi.waitFor(() => expect(document.querySelector('.composer-attach-menu')).not.toBeNull(), {
        timeout: 20_000,
        interval: 20,
      });
    });
    const menu = document.querySelector<HTMLElement>('.composer-attach-menu');
    if (!menu) throw new Error(`the + menu did not open:\n${mounted().innerHTML.slice(0, 2000)}`);
    return menu;
  };

  /** What the menu draws, top to bottom. The divider counts as a row: it is what groups them. */
  const drawn = (menu: HTMLElement): (string | undefined)[] =>
    [...menu.querySelectorAll('.ant-dropdown-menu-item, .ant-dropdown-menu-item-divider')].map((el) => {
      if (el.classList.contains('ant-dropdown-menu-item-divider')) return '─';
      // Shell appends what one particular session cannot do. Which session this is has nothing to
      // do with the order the menu draws its rows in, which is what this test is about.
      return el.textContent?.trim().replace(/ \(session unavailable\)$/, '');
    });

  const item = (menu: HTMLElement, label: string): HTMLElement => {
    const found = [...menu.querySelectorAll<HTMLElement>('.ant-dropdown-menu-item')].find((el) =>
      el.textContent?.trim().startsWith(label),
    );
    if (!found) throw new Error(`no ${label} row in the menu:\n${menu.outerHTML}`);
    return found;
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('EventSource', FakeEventSource);
    apiMock.mockReset();
    apiMock.mockImplementation((path: string) => {
      const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
      if (path === '/users/me') {
        return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
      }
      if (path === '/workspaces') {
        return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
      }
      if (path.startsWith(`/sessions/${SESSION_PUBLIC}`)) {
        if (path.includes('/events/page')) return reply({ events: [], hasMore: false });
        if (path.includes('/diff')) return reply({ files: [] });
        if (path.includes('/turns') || path.includes('/approvals') || path.includes('/background')) return reply([]);
        return reply(SESSION);
      }
      if (path.startsWith('/sessions')) return reply([SESSION]);
      if (path.startsWith('/tasks/evidence-decisions/pending')) {
        return reply({ decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
      }
      if (path.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
      if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
      return reply([]);
    });
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    }));
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
  });

  afterEach(async () => {
    const mountedRoot = root;
    const mountedClient = client;
    const node = container;
    root = null;
    client = null;
    container = null;
    try {
      if (mountedRoot) await act(async () => mountedRoot.unmount());
    } finally {
      if (mountedClient) {
        await mountedClient.cancelQueries();
        mountedClient.clear();
      }
      node?.remove();
      document.body.innerHTML = '';
      delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
      vi.unstubAllGlobals();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    }
  });

  it('draws the native menu: command group under the thumb, media group above the rule', async () => {
    const menu = await openMenu();

    expect(drawn(menu)).toEqual(['File', 'Image', '─', 'Shell', 'Skill', 'Command']);
  });

  it('gives Command and Shell the glyphs the native menu gives them', async () => {
    const menu = await openMenu();

    expect(item(menu, 'Command').querySelector('svg[data-glyph="slash-command"]')).not.toBeNull();
    // The terminal box, which @ant-design/icons v6 spells `CodeOutlined`.
    expect(item(menu, 'Shell').querySelector('.anticon-code')).not.toBeNull();
    // …and the SQL monitor that appeared in neither client is gone for good.
    expect(menu.querySelector('.anticon-console-sql')).toBeNull();
  });
});

/** The body of every `@media (max-width: 600px)` block, brace-matched — what a phone gets. */
function phoneBlocks(css: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const query = '@media (max-width: 600px)';
  let from = 0;
  for (;;) {
    const at = css.indexOf(query, from);
    if (at < 0) return ranges;
    const open = css.indexOf('{', at);
    let depth = 0;
    let end = open;
    for (let i = open; i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    ranges.push([at, end + 1]);
    from = end + 1;
  }
}

describe('the composer menu on a phone', () => {
  const css = indexCss;
  const ranges = phoneBlocks(css);
  const phone = ranges.map(([from, to]) => css.slice(from, to)).join('\n');
  const desktop = ranges.reduceRight((acc, [from, to]) => acc.slice(0, from) + acc.slice(to), css);

  it('is sized like the native one', () => {
    expect(phone).toContain('.composer-attach-menu');
    // The box, in the numbers the iOS screenshot measures: 250 wide, 42.4 rows, 17px type,
    // a 26px corner, and the divider inset 24 from either edge.
    expect(phone).toMatch(/\.composer-attach-menu\.ant-dropdown-menu\s*\{[^}]*min-width:\s*250px/);
    expect(phone).toMatch(/\.composer-attach-menu\.ant-dropdown-menu\s*\{[^}]*border-radius:\s*26px/);
    expect(phone).toMatch(/\.composer-attach-menu \.ant-dropdown-menu-item\s*\{[^}]*height:\s*42\.4px/);
    expect(phone).toMatch(/\.composer-attach-menu \.ant-dropdown-menu-item\s*\{[^}]*font-size:\s*17px/);
    expect(phone).toMatch(/composer-attach-menu[^{]*\.ant-dropdown-menu-item-divider\s*\{[^}]*margin:\s*9\.5px 24px/);
    // One row's label ("Shell (session unavailable)") is wider than 250 at 17px. A card that
    // wraps it stops reading as the native menu, so 250 is a floor and the row stays one line.
    expect(phone).toMatch(/\.composer-attach-menu\.ant-dropdown-menu\s*\{[^}]*width:\s*max-content/);
    expect(phone).toMatch(/\.composer-attach-menu \.ant-dropdown-menu-item\s*\{[^}]*white-space:\s*nowrap/);
  });

  it('leaves the desktop menu at antd density', () => {
    // Desktop is the box the mock's "before" column measured; a phone-sized menu there would be a
    // menu nobody asked for, so the metrics must not leak out of the breakpoint.
    expect(desktop).not.toContain('42.4px');
    expect(desktop).not.toMatch(/composer-attach-menu[^}]*250px/);
  });
});
