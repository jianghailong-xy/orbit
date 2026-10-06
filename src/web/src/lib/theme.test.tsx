// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, getToken } from '../api';
import { meQuery, type Me } from './queries';
import { ThemeProvider, useThemeMode, type ThemeMode } from './theme';

vi.mock('../api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api')>()),
  api: vi.fn(),
  getToken: vi.fn(),
}));

const account: Me = {
  id: 'theme-user', email: 'theme@example.test', name: 'Theme fixture',
  createdAt: '2026-10-04T00:00:00.000Z', preferences: { theme: 'light', defaultModel: 'test-model' },
};

function ThemeControls() {
  const { mode, resolved, setMode } = useThemeMode();
  return <>
    <output>{mode}/{resolved}</output>
    {(['system', 'light', 'dark'] as const).map((value) => (
      <button key={value} onClick={() => setMode(value)}>{value}</button>
    ))}
  </>;
}

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
let media: EventTarget & { matches: boolean };
let themeColor: HTMLMetaElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.mocked(getToken).mockReturnValue(null);
  vi.mocked(api).mockResolvedValue(account);
  media = Object.assign(new EventTarget(), { matches: false });
  vi.stubGlobal('matchMedia', vi.fn(() => media));
  themeColor = document.createElement('meta');
  themeColor.id = 'theme-color';
  document.head.appendChild(themeColor);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  themeColor.remove();
  document.documentElement.removeAttribute('data-theme');
  localStorage.clear();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function mount() {
  await act(async () => root.render(
    <QueryClientProvider client={client}>
      <ThemeProvider><ThemeControls /></ThemeProvider>
    </QueryClientProvider>,
  ));
}

async function choose(mode: ThemeMode) {
  await act(async () => {
    [...container.querySelectorAll('button')].find((button) => button.textContent === mode)!.click();
  });
}

async function systemDark(matches: boolean) {
  await act(async () => {
    media.matches = matches;
    media.dispatchEvent(new Event('change'));
  });
}

function expectTheme(mode: ThemeMode, resolved: 'light' | 'dark') {
  expect(container.querySelector('output')?.textContent).toBe(`${mode}/${resolved}`);
  expect(document.documentElement.dataset.theme).toBe(resolved);
  expect(themeColor.content).toBe(resolved === 'dark' ? '#202023' : '#ffffff');
  expect(localStorage.getItem('orbit-theme')).toBe(mode);
}

describe('the shared theme follows local and account preferences', () => {
  it('uses system by default and follows live OS changes without an account request', async () => {
    await mount();
    expectTheme('system', 'light');
    await systemDark(true);
    expectTheme('system', 'dark');
    await systemDark(false);
    expectTheme('system', 'light');
    expect(api).not.toHaveBeenCalled();
  });

  it.each(['light', 'dark'] as const)('restores cached %s and ignores OS changes until system is selected', async (mode) => {
    localStorage.setItem('orbit-theme', mode);
    media.matches = mode !== 'dark';
    await mount();
    expectTheme(mode, mode);
    await systemDark(!media.matches);
    expectTheme(mode, mode);
    await choose('system');
    expectTheme('system', media.matches ? 'dark' : 'light');
    await systemDark(!media.matches);
    expectTheme('system', media.matches ? 'dark' : 'light');
    expect(api).not.toHaveBeenCalled();
  });

  it('adopts a fetched account preference and subsequent account changes', async () => {
    localStorage.setItem('orbit-theme', 'dark');
    vi.mocked(getToken).mockReturnValue('token');
    await mount();
    await act(async () => {
      // Query data arrives before its batched observer notification updates the provider.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expectTheme('light', 'light');
    expect(api).toHaveBeenCalledWith('/users/me');
    await act(async () => {
      client.setQueryData<Me>(meQuery().queryKey, { ...account, preferences: { theme: 'system' } });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expectTheme('system', 'light');
    await systemDark(true);
    expectTheme('system', 'dark');
  });

  it('applies a local choice immediately, preserves other account preferences, and keeps it if sync fails', async () => {
    vi.mocked(getToken).mockReturnValue('token');
    client.setQueryData(meQuery().queryKey, account);
    await mount();
    expectTheme('light', 'light');
    vi.mocked(api).mockRejectedValueOnce(new Error('offline'));
    await choose('dark');
    expectTheme('dark', 'dark');
    expect(client.getQueryData<Me>(meQuery().queryKey)?.preferences).toEqual({
      theme: 'dark', defaultModel: 'test-model',
    });
    expect(api).toHaveBeenCalledExactlyOnceWith('/users/me/preferences', {
      method: 'PATCH', body: { theme: 'dark' },
    });
    await systemDark(false);
    expectTheme('dark', 'dark');
  });
});
