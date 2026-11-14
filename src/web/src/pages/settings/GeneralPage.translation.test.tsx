// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { meQuery, type Me, type UserPreferences } from '../../lib/queries';

/**
 * Settings › Translation (docs/mocks/session-translation/01-board.png, frames 1 and 2), a section of
 * Settings → General: one switch for the account, absent = off, the language the owner writes and reads
 * in, and "Agents work in" fixed to English. A server without a DeepSeek key draws it all disabled with
 * the frame 2 notice.
 */

vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api')>()),
  api: vi.fn(),
}));
const { api } = await import('../../api');
const apiMock = vi.mocked(api);
const { GeneralSettingsPage } = await import('./GeneralPage');

const me = (preferences: UserPreferences, translationAvailable = true): Me => ({
  id: 'u1',
  email: 'a@b.c',
  name: 'A',
  createdAt: '2026-01-01T00:00:00Z',
  preferences,
  translationAvailable,
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

/** The section titled Translation. */
const card = (): HTMLElement =>
  [...document.querySelectorAll<HTMLElement>('section[aria-labelledby]')].find(
    (section) => document.getElementById(section.getAttribute('aria-labelledby')!)?.textContent === 'Translation',
  )!;
const translateSwitch = (): HTMLElement => card().querySelector<HTMLElement>('[role="switch"][aria-label="Translate conversations"]')!;
const select = (name: string): HTMLElement => card().querySelector<HTMLElement>(`[aria-label="${name}"]`)!;
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

describe('Settings › Translation', () => {
  it('sits between New sessions and Orchestration, with the board copy', async () => {
    await mount(me({}));
    const titles = [...document.querySelectorAll('section[aria-labelledby]')].map(
      (section) => document.getElementById(section.getAttribute('aria-labelledby')!)?.textContent,
    );
    expect(titles).toEqual(['New sessions', 'Translation', 'Orchestration']);
    const text = card().textContent ?? '';
    expect(text).toContain('Translate conversations');
    expect(text).toContain(
      'Agents read and write in English; you write and read in your language. Your messages are translated before the agent gets them, its replies before you see them. Tool calls, output and code stay as they are.',
    );
    expect(text).toContain('Your language');
    expect(text).toContain('What you write in, and what replies are shown in.');
    expect(text).toContain('Agents work in');
    expect(text).toContain('What the agent receives and answers in.');
    expect(text).toContain(
      "Translated by the server's DeepSeek model. Applies to every session from its next message; what's already in a conversation stays as it was.",
    );
    expect(text).not.toContain('DEEPSEEK_API_KEY');
  });

  it('is off for an account that never said otherwise, with the default language', async () => {
    await mount(me({}));
    expect(translateSwitch().getAttribute('aria-checked')).toBe('false');
    expect(select('Your language').textContent).toContain('Chinese (Simplified)');
    // Agents always work in English: shown, never offered.
    expect(select('Agents work in').textContent).toContain('English');
    expect(select('Agents work in').getAttribute('aria-disabled') ?? select('Agents work in').hasAttribute('data-disabled')).toBeTruthy();
  });

  it('turning it on and off saves translationEnabled', async () => {
    await mount(me({}));
    await act(async () => translateSwitch().click());
    await settle();
    expect(patches()).toEqual([{ translationEnabled: true }]);
    expect(translateSwitch().getAttribute('aria-checked')).toBe('true');
    await act(async () => translateSwitch().click());
    await settle();
    expect(patches()).toEqual([{ translationEnabled: true }, { translationEnabled: false }]);
    expect(translateSwitch().getAttribute('aria-checked')).toBe('false');
  });

  it('reads the saved language, and offers the seven', async () => {
    await mount(me({ translationEnabled: true, translationLanguage: 'ja' }));
    expect(translateSwitch().getAttribute('aria-checked')).toBe('true');
    expect(select('Your language').textContent).toContain('Japanese');
    await act(async () => select('Your language').click());
    await settle();
    const options = [...document.querySelectorAll('.orbit-select-option')].map((o) => o.textContent?.trim());
    expect(options).toEqual([
      'Chinese (Simplified)',
      'Chinese (Traditional)',
      'Japanese',
      'Korean',
      'Spanish',
      'French',
      'German',
    ]);
  });

  it('picking a language saves translationLanguage', async () => {
    await mount(me({ translationEnabled: true }));
    await act(async () => select('Your language').click());
    await settle();
    const korean = [...document.querySelectorAll<HTMLElement>('.orbit-select-option')].find(
      (o) => o.textContent?.trim() === 'Korean',
    )!;
    await act(async () => korean.click());
    await settle();
    expect(patches()).toEqual([{ translationLanguage: 'ko' }]);
  });

  it('without a DeepSeek key on the server: disabled, with the frame 2 notice', async () => {
    await mount(me({ translationEnabled: true }, false));
    expect(card().textContent).toContain(
      "This server has no DeepSeek key, so it can't translate. Whoever runs it sets DEEPSEEK_API_KEY and restarts it.",
    );
    expect(translateSwitch().getAttribute('aria-checked')).toBe('false');
    expect(translateSwitch().hasAttribute('disabled') || translateSwitch().getAttribute('aria-disabled') === 'true').toBe(true);
    expect(select('Your language').hasAttribute('data-disabled') || select('Your language').getAttribute('aria-disabled') === 'true').toBe(true);
    await act(async () => translateSwitch().click());
    await settle();
    expect(patches()).toEqual([]);
  });
});
