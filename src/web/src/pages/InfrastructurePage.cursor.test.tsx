// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunnerEngineHealth } from '@orbit/shared';
import type { Runner } from '../components/TasksSidePanel';
import { encodeId } from '../lib/idCodec';
import type { ProviderRow } from '../lib/providerAdmin';
import { InfrastructurePage } from './InfrastructurePage';

/**
 * Cursor CLI on /infrastructure (the owner's board, docs/mocks/cursor-engine Web 2 and Web 4): nothing of
 * it while no runner of the account knows it; once one does, the machines and accounts signed in to it,
 * and the Cursor keys with the model a session on one starts on (Auto) — nothing on a machine's card where
 * it is signed out — a Cursor card in the vendor gallery, and on a Cursor key's row what Cursor answered
 * the last check: refused, or out of reach, which is asked again from there.
 */

vi.mock('../api', async (original) => ({ ...(await original<typeof import('../api')>()), api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const id = (n: number) => encodeId(`0195c0de-0000-7000-8000-${String(n).padStart(12, '0')}`);
const HPC = id(2);
const PIN = '2026.10.14-941492e';

const cursor = (over: Partial<RunnerEngineHealth> = {}): RunnerEngineHealth => ({
  engine: 'cursor',
  installed: true,
  version: PIN,
  auth: 'yes',
  accounts: [
    { id: 'default', home: '/root/.orbit/cursor/default', auth: 'yes' },
    { id: '5c2e91a0', name: 'Team', home: '/root/.orbit/cursor-accounts/5c2e91a0', auth: 'yes' },
  ],
  ...over,
});
const hpc = (engine: RunnerEngineHealth | null = cursor(), capabilities = ['provider:cursor', 'cursor-account-login/v1']): Runner => ({
  id: HPC,
  name: 'HPC',
  online: true,
  activeSessions: 0,
  maxConcurrent: 4,
  lastHeartbeatAt: new Date().toISOString(),
  capabilities,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }, ...(engine ? [engine] : [])],
  modelCatalog: { cursor: [{ value: 'default', label: 'Auto' }, { value: 'composer-2.5', label: 'Composer 2.5' }] },
});
const cursorKey = (over: Partial<ProviderRow> = {}): ProviderRow => ({
  id: id(105),
  slug: 'cursor-api',
  label: 'Cursor',
  runtime: 'cursor',
  engines: ['cursor'] as ProviderRow['engines'],
  baseUrl: 'https://api2.cursor.sh',
  models: [],
  defaultModel: null,
  presetSlug: 'cursor-api',
  followsPreset: true,
  enabled: true,
  hasApiKey: true,
  poolRefusal: null,
  keyCheckState: 'VALID',
  keyCheckedAt: new Date(Date.now() - 35 * 60_000).toISOString(),
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let runners: Runner[] = [];
let keys: ProviderRow[] = [];
let sent: Array<{ method: string; path: string }> = [];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  runners = [hpc()];
  keys = [cursorKey()];
  sent = [];
  apiMock.mockImplementation((async (p: string, init?: { method?: string }) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({ method, path: p });
      if (p.endsWith('/key-check')) {
        return { ok: true, keyCheck: 'VALID', message: 'Cursor accepted this key.', recorded: true, keyCheckState: 'VALID', keyCheckedAt: new Date().toISOString() };
      }
      return {};
    }
    if (p === '/runners') return runners;
    if (p === '/providers/mine') return keys;
    if (p.endsWith('/login')) return { status: null, engine: null, url: null, userCode: null, message: null, account: null };
    return [];
  }) as typeof api);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  apiMock.mockReset();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/infrastructure']}>
          <Routes>
            <Route path="/infrastructure" element={<InfrastructurePage />} />
            <Route path="*" element={<div>elsewhere</div>} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  await settle();
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('Cursor CLI on the Machines & models page', () => {
  it('is nowhere while no runner of the account knows it', async () => {
    runners = [hpc(null, [])];
    keys = [];
    await mount();
    expect(document.body.querySelector('[data-engine="cursor"]')).toBeNull();
    expect(document.body.querySelector('a[href="/providers/new/cursor-api"]')).toBeNull();
  });

  it('chips the accounts signed in to it on the machine’s card, and starts each of its keys on Auto', async () => {
    await mount();
    // The machine's card chips both accounts, and the key's row says what a session on it starts on.
    expect(text(document.body.querySelector('.re-runner-card .mc-row'))).toContain('Cursor CLI ×2');
    expect(text(document.body.querySelector('.vk-row .vk-model'))).toBe('Starts on Auto');
  });

  it('draws no chip on the machine’s card for Cursor CLI signed out there: its row, once open, says so', async () => {
    runners = [hpc(cursor({ auth: 'no', accounts: [{ id: 'default', home: '/root/.orbit/cursor/default', auth: 'no' }] }))];
    await mount();
    const head = document.body.querySelector<HTMLElement>('.re-runner-card .re-head')!;
    expect([...head.querySelectorAll('.mc-chip')].map((chip) => text(chip))).toEqual(['Claude Code']);
    expect(head.querySelector('button[aria-label="Sign in to Cursor CLI on HPC"]')).toBeNull();
  });

  it('offers Cursor in the vendor gallery, on its own connect page, as already signed in on the machine', async () => {
    keys = [];
    await mount();
    const card = document.body.querySelector<HTMLAnchorElement>('a[href="/providers/new/cursor-api"]');
    expect(text(card?.querySelector('.pc-name'))).toBe('Cursor');
    expect(text(card?.querySelector('.pc-sub'))).toBe('Already signed in on HPC');
  });

  it('says on a key Cursor refused that it was refused, and where a new one is pasted', async () => {
    keys = [cursorKey({ keyCheckState: 'INVALID', keyCheckedAt: new Date(Date.now() - 4 * 60_000).toISOString() })];
    await mount();
    const line = document.body.querySelector('.vk-cards .dsb-line.fail');
    expect(text(line)).toBe('Rejected by Cursor · 4m ago · Paste a new key');
    expect(line?.querySelector('a')?.getAttribute('href')).toBe(`/providers/${keys[0].id}`);
  });

  it('asks again from a key Cursor could not be reached to check, and says nothing of one it accepted', async () => {
    keys = [cursorKey({ keyCheckState: 'UNREACHABLE', keyCheckedAt: new Date(Date.now() - 12 * 60_000).toISOString() })];
    await mount();
    const line = document.body.querySelector('.vk-cards .dsb-line.fail');
    expect(text(line)).toBe('Couldn’t reach Cursor to check this key · 12m ago · Retry');
    await act(async () => line!.querySelector<HTMLButtonElement>('button')!.click());
    await settle();
    expect(sent).toContainEqual({ method: 'POST', path: `/providers/mine/${keys[0].id}/key-check` });

    act(() => root?.unmount());
    host?.remove();
    keys = [cursorKey()];
    await mount();
    expect(document.body.querySelector('.vk-cards .dsb-line.fail')).toBeNull();
  });
});
