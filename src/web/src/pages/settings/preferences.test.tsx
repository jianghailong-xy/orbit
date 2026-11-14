// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { meQuery, type Me, type UserPreferences } from '../../lib/queries';

/**
 * Every switch on the Personal pages saves as the one Settings page did: a PATCH of /users/me/preferences
 * with its own field and nothing else, the account it answers with taken as the account, and a
 * "Setting saved" toast — or "Couldn't save the setting" with the server's reason. The theme saves
 * through the theme context, as before.
 */

const setMode = vi.fn();
vi.mock('../../lib/theme', () => ({ useThemeMode: () => ({ mode: 'system', setMode }) }));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('../../lib/toast', () => ({ useToast: () => toast }));
vi.mock('../../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api')>()),
  api: vi.fn(),
}));
const { api } = await import('../../api');
const apiMock = vi.mocked(api);
const { GeneralSettingsPage } = await import('./GeneralPage');
const { NotificationsSettingsPage } = await import('./NotificationsPage');
const { AppearanceSettingsPage } = await import('./AppearancePage');

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

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mount(page: ReactElement, preferences: UserPreferences = {}): Promise<void> {
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
        <MemoryRouter>{page}</MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

const switchNamed = (label: string): HTMLElement => {
  const found = container!.querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`);
  if (!found) throw new Error(`no "${label}" switch`);
  return found;
};

async function press(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
}

const patches = () =>
  apiMock.mock.calls
    .filter(([path, options]) => path === '/users/me/preferences' && options?.method === 'PATCH')
    .map(([, options]) => options?.body);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  apiMock.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  setMode.mockReset();
  // A PATCH answers with the account as patched; a read stays in flight.
  apiMock.mockImplementation(((_path: string, options?: { method?: string; body?: UserPreferences }) =>
    options?.method === 'PATCH' ? Promise.resolve(me({ ...options.body })) : new Promise(() => {})) as never);
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

describe('each switch saves through the preference field it always had', () => {
  const cases: Array<[string, () => ReactElement, string, keyof UserPreferences, boolean]> = [
    ['General', () => <GeneralSettingsPage />, 'Smart model selection', 'modelRouting', true],
    ['General', () => <GeneralSettingsPage />, 'Suggested replies', 'promptSuggestions', false],
    ['General', () => <GeneralSettingsPage />, 'Session recaps', 'recaps', false],
    ['General', () => <GeneralSettingsPage />, 'Let sessions orchestrate', 'enableOrchestration', false],
    ['Notifications', () => <NotificationsSettingsPage />, 'When a session finishes', 'notifySessionFinished', false],
    ['Notifications', () => <NotificationsSettingsPage />, 'When an agent asks for you', 'notifyAgentMessage', false],
  ];

  it.each(cases)('%s → %s writes %s', async (_page, page, label, field, written) => {
    await mount(page());
    await press(switchNamed(label));
    expect(patches()).toEqual([{ [field]: written }]);
    expect(toast.success).toHaveBeenCalledWith('Setting saved');
    expect(client!.getQueryData<Me>(meQuery().queryKey)?.preferences).toEqual({ [field]: written });
    expect(switchNamed(label).getAttribute('aria-checked')).toBe(String(written));
  });

  it('says why when the server refuses', async () => {
    apiMock.mockImplementation((() => Promise.reject(new Error('Nope'))) as never);
    await mount(<NotificationsSettingsPage />);
    await press(switchNamed('When a session finishes'));
    expect(toast.error).toHaveBeenCalledWith("Couldn't save the setting", 'Nope');
    expect(switchNamed('When a session finishes').getAttribute('aria-checked')).toBe('true');
  });
});

describe('Settings → Notifications', () => {
  it('reads both alerts on when absent and off when turned off, under the wording they had', async () => {
    await mount(<NotificationsSettingsPage />);
    expect(container!.querySelector('h1')?.textContent).toBe('Notifications');
    expect(switchNamed('When a session finishes').getAttribute('aria-checked')).toBe('true');
    expect(switchNamed('When an agent asks for you').getAttribute('aria-checked')).toBe('true');
    expect(container!.textContent).toContain('Alert your devices when a run finishes on its own or fails for good.');
    expect(container!.textContent).toContain('At most one per session per minute.');
    await act(async () => root!.unmount());
    root = null;
    container!.remove();

    await mount(<NotificationsSettingsPage />, { notifySessionFinished: false, notifyAgentMessage: false });
    expect(switchNamed('When a session finishes').getAttribute('aria-checked')).toBe('false');
    expect(switchNamed('When an agent asks for you').getAttribute('aria-checked')).toBe('false');
  });
});

describe('Settings → Appearance', () => {
  it('sets the theme through the theme context, as before', async () => {
    await mount(<AppearanceSettingsPage />);
    expect(container!.querySelector('h1')?.textContent).toBe('Appearance');
    expect(container!.textContent).toContain('Synced to your account across devices.');
    const dark = [...container!.querySelectorAll<HTMLElement>('[aria-label="Theme"] *')].find(
      (el) => el.textContent === 'Dark' && el.children.length === 0,
    );
    expect(dark).toBeTruthy();
    await press(dark!);
    expect(setMode).toHaveBeenCalledWith('dark');
    expect(patches()).toEqual([]);
  });
});
