// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { meQuery, type Me, type UserPreferences } from '../lib/queries';

/**
 * Smart model selection, one switch for the whole account (`preferences.modelRouting`) under Session
 * defaults. Unlike the other switches on the page it is OFF until turned on: an account that never
 * wrote it reads off.
 */

// The theme control reaches for localStorage and matchMedia, and it is not what these tests are about.
vi.mock('../lib/theme', () => ({ useThemeMode: () => ({ mode: 'system', setMode: () => {} }) }));
vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
}));
const { api } = await import('../api');
const apiMock = vi.mocked(api);
const { SettingsPage } = await import('./SettingsPage');

const LABEL = 'Smart model selection';
const HINT =
  "Coordinators suggest a tier for each task, and Agents you turn this on for run their tasks on that tier's model and effort. Off: tasks run exactly as before.";

const me = (preferences: UserPreferences): Me => ({
  id: 'u1',
  email: 'a@b.c',
  name: 'A',
  createdAt: '2026-01-01T00:00:00Z',
  preferences,
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;
/** Answers the PATCH in flight, with the account as the server returns it. */
let reply: ((value: Me) => void) | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** The page with the query it reads seeded, so nothing has to be fetched. */
async function mount(preferences: UserPreferences): Promise<void> {
  const next = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  next.setQueryData(meQuery().queryKey, me(preferences));
  client = next;
  container = document.createElement('div');
  document.body.appendChild(container);
  const created = createRoot(container);
  root = created;
  await act(async () => {
    created.render(
      <QueryClientProvider client={next}>
        <MemoryRouter>
          <SettingsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

/** The row that names it: its label, its hint and its switch. */
const label = (): HTMLElement => {
  const found = [...container!.querySelectorAll<HTMLElement>('div')].find(
    (el) => el.children.length === 0 && el.textContent === LABEL,
  );
  if (!found) throw new Error(`no "${LABEL}" row`);
  return found;
};
const smartSwitch = (): HTMLElement => label().parentElement!.parentElement!.querySelector<HTMLElement>('[role="switch"]')!;
const checked = () => smartSwitch().getAttribute('aria-checked');

/** The PATCHes the page sent to the account's preferences, as their bodies. */
const patches = () =>
  apiMock.mock.calls
    .filter(([path, options]) => path === '/users/me/preferences' && options?.method === 'PATCH')
    .map(([, options]) => options?.body);

async function toggle(): Promise<void> {
  await act(async () => {
    smartSwitch().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

async function answer(value: Me): Promise<void> {
  expect(reply, 'a PATCH is in flight').toBeTruthy();
  await act(async () => reply!(value));
  await settle();
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  apiMock.mockReset();
  reply = null;
  // A PATCH waits for the test to answer it; a read stays in flight, so the page shows the account
  // as seeded or as the PATCH returned it, and nothing else.
  apiMock.mockImplementation(((_path: string, options?: { method?: string }) =>
    options?.method === 'PATCH'
      ? new Promise<Me>((resolve) => {
          reply = resolve;
        })
      : new Promise(() => {})) as never);
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  client?.clear();
  client = null;
  container?.remove();
  container = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('smart model selection, one switch for the whole account', () => {
  it('sits in Session defaults under Default permission mode, saying what it does', async () => {
    await mount({});
    expect(label().nextElementSibling?.textContent).toBe(HINT);
    // The card it sits in is a region named by its title.
    const card = label().closest<HTMLElement>('section[aria-labelledby]')!;
    expect(document.getElementById(card.getAttribute('aria-labelledby')!)?.textContent).toBe('Session defaults');
    const text = card.textContent ?? '';
    expect(text.indexOf('Default permission mode')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(LABEL)).toBeGreaterThan(text.indexOf('Default permission mode'));
  });

  it('is off for an account that never said otherwise', async () => {
    // Absent means OFF: only turning it on has to be written.
    await mount({});
    expect(checked()).toBe('false');
  });

  it('reads off when the account turned it off, and on when it turned it on', async () => {
    await mount({ modelRouting: false });
    expect(checked()).toBe('false');
    await act(async () => root!.unmount());
    root = null;
    container!.remove();

    await mount({ modelRouting: true });
    expect(checked()).toBe('true');
  });

  it('turning it on sends modelRouting: true, and then reads as the saved account says', async () => {
    await mount({});
    await toggle();
    expect(patches()).toEqual([{ modelRouting: true }]);

    await answer(me({ modelRouting: true }));
    expect(checked()).toBe('true');
    expect(client!.getQueryData<Me>(meQuery().queryKey)?.preferences).toEqual({ modelRouting: true });
  });

  it('turning it off sends modelRouting: false, and then reads as the saved account says', async () => {
    await mount({ modelRouting: true });
    await toggle();
    expect(patches()).toEqual([{ modelRouting: false }]);

    await answer(me({ modelRouting: false }));
    expect(checked()).toBe('false');
  });

  it('shows what the server saved, not what was asked for', async () => {
    await mount({});
    await toggle();
    expect(patches()).toEqual([{ modelRouting: true }]);

    // The account as returned is the account: an answer without the switch on leaves it off.
    await answer(me({}));
    expect(checked()).toBe('false');
  });
});
