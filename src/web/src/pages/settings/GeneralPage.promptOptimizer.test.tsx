// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { meQuery, type Me, type UserPreferences } from '../../lib/queries';

/**
 * Settings › General › Prompt optimizer (docs/mocks/prompt-optimizer/01-board.png, frames 1 and 1b):
 * one switch for the account under Suggested replies, absent = on
 * (owner's decision of 2026-11-16) and only an explicit false turns it off. A server without a DeepSeek key
 * draws it disabled with the frame 1b notice.
 */

vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api')>()),
  api: vi.fn(),
}));
const { api } = await import('../../api');
const apiMock = vi.mocked(api);
const { GeneralSettingsPage } = await import('./GeneralPage');

const me = (preferences: UserPreferences, promptOptimizerAvailable: boolean | 'absent' = true): Me => ({
  id: 'u1',
  email: 'a@b.c',
  name: 'A',
  createdAt: '2026-01-01T00:00:00Z',
  preferences,
  translationAvailable: true,
  ...(promptOptimizerAvailable === 'absent' ? {} : { promptOptimizerAvailable }),
});

let container: HTMLDivElement;
let root: Root | null = null;
let client: QueryClient | null = null;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(account: Me): Promise<void> {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(meQuery().queryKey, account);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const qc = client;
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <GeneralSettingsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

const optimizerSwitch = (): HTMLElement =>
  document.querySelector<HTMLElement>('[role="switch"][aria-label="Prompt optimizer"]')!;
const rowTitles = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[role="switch"]')].map((s) => s.getAttribute('aria-label') ?? '');
const NOTICE = 'This server has no DeepSeek key (DEEPSEEK_API_KEY), so it cannot optimize prompts.';

const patches = () =>
  apiMock.mock.calls
    .filter(([path, options]) => path === '/users/me/preferences' && options?.method === 'PATCH')
    .map(([, options]) => options?.body);

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
  apiMock.mockImplementation(((_path: string, options?: { method?: string; body?: UserPreferences }) =>
    options?.method === 'PATCH'
      ? Promise.resolve(me({ ...options.body }))
      : new Promise(() => {})) as never);
});

afterEach(async () => {
  const mounted = root;
  root = null;
  if (mounted) await act(async () => mounted.unmount());
  client?.clear();
  container?.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe('Settings › General › Prompt optimizer', () => {
  it('sits right under Suggested replies, with the board copy', async () => {
    await mount(me({}));
    const titles = rowTitles();
    expect(titles.indexOf('Prompt optimizer')).toBe(titles.indexOf('Suggested replies') + 1);
    const text = document.body.textContent ?? '';
    expect(text).toContain(
      "Show an Optimize button in the composer. DeepSeek rewrites your draft with this session's context; you review it before it replaces the draft.",
    );
    expect(text).not.toContain(NOTICE);
  });

  it('is on for an account that never said otherwise', async () => {
    await mount(me({}));
    expect(optimizerSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('turning it off and on saves promptOptimizer', async () => {
    await mount(me({}));
    await act(async () => optimizerSwitch().click());
    await settle();
    expect(patches()).toEqual([{ promptOptimizer: false }]);
    expect(optimizerSwitch().getAttribute('aria-checked')).toBe('false');
    await act(async () => optimizerSwitch().click());
    await settle();
    expect(patches()).toEqual([{ promptOptimizer: false }, { promptOptimizer: true }]);
    expect(optimizerSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('reads it off when the account saved it off', async () => {
    await mount(me({ promptOptimizer: false }));
    expect(optimizerSwitch().getAttribute('aria-checked')).toBe('false');
  });

  for (const [label, available] of [
    ['false', false],
    ['absent (an older server)', 'absent'],
  ] as const) {
    it(`without a DeepSeek key (promptOptimizerAvailable ${label}): disabled, off, with the frame 1b notice`, async () => {
      await mount(me({ promptOptimizer: true }, available));
      expect(document.body.textContent).toContain(NOTICE);
      expect(optimizerSwitch().getAttribute('aria-checked')).toBe('false');
      expect(
        optimizerSwitch().hasAttribute('disabled') || optimizerSwitch().getAttribute('aria-disabled') === 'true',
      ).toBe(true);
      await act(async () => optimizerSwitch().click());
      await settle();
      expect(patches()).toEqual([]);
    });
  }
});
