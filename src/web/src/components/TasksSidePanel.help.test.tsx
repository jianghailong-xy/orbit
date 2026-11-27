// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TasksSidePanel } from './TasksSidePanel';
import { HelpDrawer } from './HelpDrawer';
import { HELP_DRAWER_EVENT, HelpDrawerProvider } from '../lib/helpDrawer';

/**
 * The ways into help on the web (board docs/mocks/help-center/01-web.png ⓪): the account menu's Help center row (the
 * full /help) and the ? key, which is a character while typing; Esc closes the drawer. The sidebar's foot holds the
 * account button alone. The drawer's frame (①): Help, Articles | Ask, ↗ to /help, and close.
 */

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
vi.mock('../lib/theme', () => ({ useThemeMode: () => ({ mode: 'system', setMode: () => {} }) }));
const { api } = await import('../api');

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let pathname = '';

function RouterProbe() {
  pathname = useLocation().pathname;
  return null;
}

function serve(role: 'ADMIN' | 'MEMBER') {
  vi.mocked(api).mockImplementation((async (path: string) => {
    if (path === '/projects/sidebar') return [];
    if (path === '/runners') return [];
    if (path === '/workspaces') return [];
    if (path === '/sessions/counts') return [];
    if (path === '/users/me') return { id: 'me', name: 'Me', email: 'me@example.com', role, avatarUpdatedAt: null };
    if (path === '/wiki/spaces') return [];
    throw new Error(`unstubbed ${path}`);
  }) as never);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function visit(path: string): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  const next = createRoot(container);
  root = next;
  await act(async () => {
    next.render(
      <MemoryRouter initialEntries={[path]}>
        <QueryClientProvider client={client}>
          <HelpDrawerProvider>
            <TasksSidePanel />
            <input aria-label="A field" />
            <textarea aria-label="A text area" />
            <div aria-label="An editor" contentEditable suppressContentEditableWarning />
            <HelpDrawer />
          </HelpDrawerProvider>
          <RouterProbe />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

const drawer = () => document.querySelector<HTMLElement>('aside.help-drawer');

async function press(node: HTMLElement): Promise<void> {
  await act(async () => node.click());
  await settle();
}

/** A key pressed where focus is: on `target`, or on the page's body. */
async function key(init: KeyboardEventInit, target: HTMLElement = document.body): Promise<KeyboardEvent> {
  target.focus();
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  await act(async () => {
    target.dispatchEvent(event);
  });
  await settle();
  return event;
}
const QUESTION = { key: '?', code: 'Slash', shiftKey: true };

async function openAccountMenu(): Promise<void> {
  await press(container!.querySelector<HTMLButtonElement>('.tp-user-trigger')!);
}
const menuRows = () =>
  [...document.querySelectorAll('[role="menu"].tp-account-menu [role="menuitem"]:not(.tp-account-profile):not([aria-haspopup])')].map(
    (row) => row.textContent,
  );

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
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
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => mounted.unmount());
  }
  container?.remove();
  container = null;
  root = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.mocked(api).mockReset();
});

describe('the sidebar foot', () => {
  it('holds the account button and no ? button', async () => {
    serve('MEMBER');
    await visit('/projects');
    const foot = container!.querySelector('.tp-user')!;
    expect([...foot.children].map((child) => child.className.split(' ')[0])).toEqual(['tp-user-trigger']);
  });
});

describe('the help drawer', () => {
  it('opens the drawer frame: Help, Articles | Ask, open in /help and close', async () => {
    serve('MEMBER');
    await visit('/projects');
    await key(QUESTION);
    const frame = drawer()!;
    expect(frame.querySelector('.help-drawer-title')?.textContent).toBe('Help');
    expect([...frame.querySelectorAll('[role="radio"]')].map((tab) => tab.textContent)).toEqual(['Articles', 'Ask']);
    expect(frame.querySelector('[data-help-pane="articles"]')).toBeTruthy();

    await press(frame.querySelectorAll<HTMLElement>('[role="radio"]')[1]!);
    expect(drawer()!.querySelector('[data-help-pane="ask"]')).toBeTruthy();

    await press(drawer()!.querySelector<HTMLElement>('[aria-label="Open in help center"]')!);
    expect(pathname).toBe('/help');
    expect(drawer()).toBeNull();

    await key(QUESTION);
    await press(drawer()!.querySelector<HTMLElement>('[aria-label="Close help"]')!);
    expect(drawer()).toBeNull();
  });

  it('opens at an article or a tab when asked by the window event others send', async () => {
    serve('MEMBER');
    await visit('/projects');
    await act(async () => {
      window.dispatchEvent(new CustomEvent(HELP_DRAWER_EVENT, { detail: { slug: 'machine-offline' } }));
    });
    expect(drawer()!.querySelector('[data-help-pane="article"]')?.getAttribute('data-help-slug')).toBe('machine-offline');
    await act(async () => {
      window.dispatchEvent(new CustomEvent(HELP_DRAWER_EVENT, { detail: { tab: 'ask', query: 'offline' } }));
    });
    expect(drawer()!.querySelector('[data-help-pane="ask"]')?.getAttribute('data-help-query')).toBe('offline');
  });
});

describe('the account menu', () => {
  it('has Help center before Settings and Admin, and it opens /help', async () => {
    serve('ADMIN');
    await visit('/projects');
    await openAccountMenu();
    expect(menuRows()).toEqual(['MachinesNone', 'Model routingBalance', 'Help center', 'Settings', 'Admin', 'Log out']);

    const row = [...document.querySelectorAll<HTMLElement>('[role="menu"].tp-account-menu [role="menuitem"]')].find(
      (item) => item.textContent === 'Help center',
    )!;
    await press(row);
    expect(pathname).toBe('/help');
  });

  it('has Help center before Settings for a member too', async () => {
    serve('MEMBER');
    await visit('/projects');
    await openAccountMenu();
    expect(menuRows()).toEqual(['MachinesNone', 'Model routingBalance', 'Help center', 'Settings', 'Log out']);
  });
});

describe('the ? key', () => {
  it('toggles the drawer from the page', async () => {
    serve('MEMBER');
    await visit('/projects');
    const event = await key(QUESTION);
    expect(drawer()).toBeTruthy();
    expect(event.defaultPrevented).toBe(true);
    await key(QUESTION);
    expect(drawer()).toBeNull();
  });

  it('is a character while typing: in an input, a textarea or an editable', async () => {
    serve('MEMBER');
    await visit('/projects');
    for (const label of ['A field', 'A text area', 'An editor']) {
      const target = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)!;
      const event = await key(QUESTION, target);
      expect(drawer(), label).toBeNull();
      expect(event.defaultPrevented, label).toBe(false);
    }
  });

  it('is not taken with a modifier (⌘? / Ctrl+?)', async () => {
    serve('MEMBER');
    await visit('/projects');
    await key({ ...QUESTION, metaKey: true });
    await key({ ...QUESTION, ctrlKey: true });
    expect(drawer()).toBeNull();
  });
});

describe('Esc', () => {
  it('closes the open drawer, and an Esc that closes it is not passed on', async () => {
    serve('MEMBER');
    await visit('/projects');
    await key(QUESTION);
    expect(drawer()).toBeTruthy();
    let seen: boolean | null = null;
    const later = (event: KeyboardEvent) => (seen = event.defaultPrevented);
    document.addEventListener('keydown', later);
    await key({ key: 'Escape' });
    document.removeEventListener('keydown', later);
    expect(drawer()).toBeNull();
    expect(seen, 'Settings reads defaultPrevented and does not leave').toBe(true);
  });

  it('leaves Esc alone while the drawer is closed', async () => {
    serve('MEMBER');
    await visit('/projects');
    const event = await key({ key: 'Escape' });
    expect(event.defaultPrevented).toBe(false);
  });

  it('closes the drawer even from a field', async () => {
    serve('MEMBER');
    await visit('/projects');
    await key(QUESTION);
    await key({ key: 'Escape' }, document.querySelector<HTMLElement>('[aria-label="A field"]')!);
    expect(drawer()).toBeNull();
  });
});
