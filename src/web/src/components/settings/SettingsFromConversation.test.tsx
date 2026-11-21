// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { resetSettingsReturn } from '../../lib/settingsReturn';

/**
 * Settings from a conversation, on the Settings side (docs/settings-from-conversation-design.md §6, §8.2; board
 * docs/mocks/settings-from-conversation parts 2 and 3):
 *
 *  - an `orbit-settings:` link in an agent's Markdown is drawn as the Open in Settings card, whose button opens the
 *    setting's page, scrolls to its row and flashes it (SettingsLayout's `data-setting-anchor` behaviour);
 *  - a Settings row whose key `GET /users/me` marks in `changedBy` carries the grey line naming the conversation, how
 *    long ago, and Undo, which is the owner's own PATCH with the `from` value.
 *
 * Mounted through the real App routes and the real SettingsLayout. The conversation page is a stand-in drawing an
 * agent's reply through the Markdown and link the transcript uses; each Personal page draws the index's rows with
 * the real SettingsRow, as SettingsSearch.test.tsx does.
 */

vi.mock('../../api', async (original) => ({ ...(await original<typeof import('../../api')>()), api: vi.fn() }));
const { api } = await import('../../api');
const apiMock = vi.mocked(api);

vi.mock('../../lib/useControlPlane', async (original) => ({
  ...(await original<typeof import('../../lib/useControlPlane')>()),
  ControlPlaneProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../AppShell', async () => {
  const { Outlet } = await import('react-router-dom');
  return {
    AppShell: () => (
      <div data-testid="app-shell">
        <Outlet />
      </div>
    ),
    DocView: ({ children }: { children: ReactNode }) => children,
    FlushView: ({ children }: { children: ReactNode }) => children,
  };
});
// The conversation: an agent's reply as the transcript renders its Markdown links.
vi.mock('../WorkspaceConsole', async () => {
  const { default: Markdown } = await import('../Markdown');
  const { ReferenceLink, referenceUrlTransform } = await import('../../lib/markdownLinks');
  return {
    WorkspaceConsole: () => (
      <div data-page="conversation">
        <Markdown urlTransform={referenceUrlTransform} components={{ a: ReferenceLink }}>
          {"Handing work to other sessions needs **Let sessions orchestrate**, which is off for your account.\n\n"
            + '[Let sessions orchestrate](orbit-settings:enableOrchestration)'}
        </Markdown>
      </div>
    ),
  };
});
vi.mock('../../pages/TaskRoute', () => ({ TaskRoute: () => <p data-page="tasks">the task list</p> }));

const { personalPage } = vi.hoisted(() => ({
  personalPage: async () => {
    const { useLocation } = await import('react-router-dom');
    const { SettingsRow } = await import('./SettingsBlocks');
    const { PERSONAL_SETTINGS: index } = await import('../../pages/settings/settingsIndex');
    return () => {
      const { pathname } = useLocation();
      return (
        <div data-page={pathname}>
          {Object.values(index)
            .filter((s) => s.path === pathname)
            .map((s) => (
              <SettingsRow key={s.anchor} anchor={s.anchor} title={s.title} description={s.description} />
            ))}
        </div>
      );
    };
  },
}));
vi.mock('../../pages/settings/GeneralPage', async () => ({ GeneralSettingsPage: await personalPage() }));
vi.mock('../../pages/settings/NotificationsPage', async () => ({ NotificationsSettingsPage: await personalPage() }));
vi.mock('../../pages/settings/AppearancePage', async () => ({ AppearanceSettingsPage: await personalPage() }));

const NOW = Date.now();
const SESSION_ID = '0196e300-0000-7000-8000-00000000c0de';

let container: HTMLDivElement;
let root: Root | null = null;
let me: Record<string, unknown>;
let writes: Array<{ path: string; method: string; body: unknown }>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem('orbit_token', 'access-token');
  resetSettingsReturn();
  writes = [];
  me = {
    id: 'me',
    email: 'owner@example.com',
    name: 'Owner',
    createdAt: '2026-01-01T00:00:00.000Z',
    preferences: { translationEnabled: true, translationLanguage: 'zh-Hans' },
    changedBy: {
      translationEnabled: {
        sessionId: SESSION_ID,
        requestId: 'req',
        at: new Date(NOW - 2 * 60_000).toISOString(),
        from: false,
        sessionTitle: 'Show replies in Chinese',
      },
      translationLanguage: {
        sessionId: SESSION_ID,
        requestId: 'req',
        at: new Date(NOW - 2 * 60_000).toISOString(),
        from: 'en',
        sessionTitle: 'Show replies in Chinese',
      },
    },
  };
  apiMock.mockImplementation((async (path: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') writes.push({ path, method, body: init?.body });
    if (path === '/users/me/preferences') {
      // The server's PATCH ends the mark of every key it writes (design §5.3).
      const body = init?.body as Record<string, unknown>;
      const changedBy = { ...(me.changedBy as Record<string, unknown>) };
      for (const key of Object.keys(body)) delete changedBy[key];
      me = { ...me, preferences: { ...(me.preferences as object), ...body }, changedBy };
      return me;
    }
    if (path === '/users/me') return me;
    return [];
  }) as typeof api);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
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
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    root = null;
    await act(async () => mounted.unmount());
    container.remove();
  }
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  apiMock.mockReset();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
});

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function visit(path: string): Promise<void> {
  window.history.replaceState(null, '', path);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

async function click(el: Element | null | undefined): Promise<void> {
  expect(el).toBeTruthy();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

/** What a reader sees, each piece of text apart. */
const words = (node: Element | null | undefined): string => {
  if (!node) return '';
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let text = walker.nextNode(); text; text = walker.nextNode()) parts.push(text.textContent ?? '');
  return parts.join(' ').replace(/\s+/g, ' ').trim();
};
const litRow = () => container.querySelector<HTMLElement>('.settings-row--found')?.dataset.settingAnchor ?? null;
const row = (anchor: string) => container.querySelector<HTMLElement>(`[data-setting-anchor="${anchor}"]`);

describe('an orbit-settings: link', () => {
  it('is drawn as the Open in Settings card, whose button opens the page at the row and flashes it', async () => {
    await visit(`/sessions/${SESSION_ID}`);
    const card = container.querySelector('.settings-link-card')!;
    expect(card).toBeTruthy();
    expect(words(card.querySelector('.settings-link-card-title'))).toBe('Let sessions orchestrate');
    expect(words(card.querySelector('.settings-link-card-path'))).toBe('Settings › General › Orchestration');
    // The link is the card, not an inert or blanked anchor.
    expect(container.querySelector('a[href=""]')).toBeNull();
    const open = card.querySelector('button')!;
    expect(words(open)).toBe('Open in Settings');

    await click(open);
    expect(window.location.pathname).toBe('/settings/general');
    expect(litRow()).toBe('enableOrchestration');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });
});

describe('a Settings row changed from a conversation', () => {
  it('carries the grey line naming the conversation, linked, how long ago, and Undo', async () => {
    await visit('/settings/general');
    const switched = row('translationEnabled')!.querySelector('.settings-row-changed')!;
    expect(words(switched)).toBe('Turned on from Show replies in Chinese · 2m ago · Undo');
    expect(switched.querySelector('a')!.getAttribute('href')).toMatch(/^\/sessions\/[0-9A-Za-z]+$/);
    // A value that is not a switch was set, not turned on.
    expect(words(row('translationLanguage')!.querySelector('.settings-row-changed'))).toBe(
      'Set from Show replies in Chinese · 2m ago · Undo',
    );
    // A row nobody changed from a conversation has no line.
    expect(row('recaps')!.querySelector('.settings-row-changed')).toBeNull();
  });

  it('Undo sends the owner PATCH with the from value, and the line goes with the mark', async () => {
    await visit('/settings/general');
    const undo = [...row('translationLanguage')!.querySelectorAll('button')].find((b) => b.textContent === 'Undo');
    await click(undo);
    expect(writes).toEqual([{ path: '/users/me/preferences', method: 'PATCH', body: { translationLanguage: 'en' } }]);
    expect(row('translationLanguage')!.querySelector('.settings-row-changed')).toBeNull();
    expect(row('translationEnabled')!.querySelector('.settings-row-changed')).not.toBeNull();
  });

  it('opening the conversation from the line goes to its session', async () => {
    await visit('/settings/general');
    await click(row('translationEnabled')!.querySelector('.settings-row-changed a'));
    expect(window.location.pathname).toMatch(/^\/sessions\//);
    expect(container.querySelector('[data-page="conversation"]')).not.toBeNull();
  });
});
