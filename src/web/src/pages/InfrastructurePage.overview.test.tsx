// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from '../components/TasksSidePanel';
import { encodeId } from '../lib/idCodec';
import type { ProviderRow } from '../lib/providerAdmin';
import type { ProviderPool } from '../lib/providerPools';
import { InfrastructurePage } from './InfrastructurePage';

/**
 * What /infrastructure says about what the agents can run on (docs/mocks/infrastructure-focus): on each
 * machine's card, its engines — a chip each for what its sessions can run on, and none for an engine
 * signed out there, which its row signs in once the card is open — with no block above the machines to
 * say it a second time: an offline machine's card and an unavailable pool's say theirs.
 */

vi.mock('../api', async (original) => ({ ...(await original<typeof import('../api')>()), api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const id = (n: number) => encodeId(`0195c0de-0000-7000-8000-${String(n).padStart(12, '0')}`);
const MAC = id(1);
const HPC = id(2);
const THINKPAD = id(3);
const POOL = id(9);

const machine = (runnerId: string, name: string, over: Partial<Runner> = {}): Runner => ({
  id: runnerId,
  name,
  online: true,
  activeSessions: 0,
  maxConcurrent: 4,
  lastHeartbeatAt: new Date().toISOString(),
  engines: [],
  ...over,
});
// The mock's three machines: Mac Studio with two Claude accounts and Codex signed out, HPC signed in
// to Claude, to two Codex accounts and to Kimi, and ThinkPad gone since yesterday.
const MAC_STUDIO = machine(MAC, 'Mac Studio', {
  engines: [
    {
      engine: 'claude',
      installed: true,
      auth: 'yes',
      accounts: [
        { id: 'default', name: 'Personal Max', home: '/Users/me/.orbit/default', auth: 'yes' },
        { id: 'slot-2', name: 'Work', home: '/Users/me/.orbit/slot-2', auth: 'yes' },
      ],
    },
    { engine: 'codex', installed: true, auth: 'no' },
    { engine: 'kimi', installed: false, auth: 'unknown' },
  ],
});
const HPC_BOX = machine(HPC, 'HPC', {
  engines: [
    { engine: 'claude', installed: true, auth: 'yes' },
    {
      engine: 'codex',
      installed: true,
      auth: 'yes',
      accounts: [
        { id: 'default', home: '/root/.codex', auth: 'yes' },
        { id: 'slot-2', name: 'Team', home: '/root/.orbit/codex-2', auth: 'yes' },
      ],
    },
    { engine: 'kimi', installed: true, auth: 'yes' },
  ],
});
const THINKPAD_BOX = machine(THINKPAD, 'ThinkPad', {
  online: false,
  lastHeartbeatAt: new Date(Date.now() - DAY - HOUR).toISOString(),
  // What it last said: offline, none of it is anything a session can use, or sign in.
  engines: [
    { engine: 'claude', installed: true, auth: 'yes' },
    { engine: 'codex', installed: true, auth: 'no' },
  ],
});

const key = (n: number, label: string, over: Partial<ProviderRow> = {}): ProviderRow => ({
  id: id(100 + n),
  slug: `key-${n}`,
  label,
  runtime: 'claude',
  engines: ['claude', 'opencode'] as ProviderRow['engines'],
  baseUrl: 'https://api.anthropic.com',
  models: [
    { value: 'claude-opus-5', label: 'Claude Opus 5' },
    { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  ],
  defaultModel: 'claude-opus-5',
  presetSlug: 'anthropic',
  followsPreset: true,
  enabled: true,
  hasApiKey: true,
  poolRefusal: null,
  ...over,
});
const ANTHROPIC = key(1, 'Anthropic (Claude)');

const claudePool = (over: Partial<ProviderPool> = {}): ProviderPool => ({
  id: POOL,
  slug: 'claude-keys',
  label: 'Claude keys',
  engine: 'claude',
  resetsAt: null,
  unavailable: null,
  members: [
    {
      id: ANTHROPIC.id,
      slug: ANTHROPIC.slug,
      label: ANTHROPIC.label,
      presetSlug: 'anthropic',
      enabled: true,
      planUsage: null,
      state: 'NO_QUOTA',
      resetsAt: null,
      next: true,
    },
  ],
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let path = '';
let runners: Runner[] = [];
let keys: ProviderRow[] = [];
let pools: ProviderPool[] = [];
let sent: Array<{ method: string; path: string; body?: unknown }> = [];

function Probe() {
  const location = useLocation();
  path = location.pathname + location.search;
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  runners = [MAC_STUDIO, HPC_BOX, THINKPAD_BOX];
  keys = [ANTHROPIC];
  pools = [claudePool()];
  sent = [];
  apiMock.mockImplementation((async (p: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({ method, path: p, ...(init?.body === undefined ? {} : { body: init.body }) });
      return {};
    }
    if (p === '/runners') return runners;
    if (p === '/providers/mine') return keys;
    if (p === '/providers/pools') return pools;
    if (p.endsWith('/login')) return { status: null, engine: null, url: null, userCode: null, message: null, account: null };
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
          <Probe />
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

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error('nothing to click');
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
};
const button = (words: string, scope: ParentNode = document.body) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((el) => text(el) === words) ?? null;

/** A machine's card, by its name. */
const machineCard = (name: string) =>
  [...document.body.querySelectorAll<HTMLElement>('.re-runner-card')].find(
    (card) => text(card.querySelector('.re-runner')) === name,
  )!;
/** What a machine's card says it runs on, a chip each. */
const chips = (name: string) =>
  [...machineCard(name).querySelectorAll<HTMLElement>('.mc-chip')].map((chip) => ({
    says: text(chip),
    out: chip.classList.contains('out'),
  }));

describe('a machine’s engines, on its card', () => {
  it('chips what its sessions can run on, and leaves an engine signed out to its row, which signs it in', async () => {
    await mount();
    // Nothing above the machines says it again.
    expect(document.body.querySelector('.infra-attn')).toBeNull();
    // Mac Studio's Codex is signed out: no chip of its own, and nothing to press on the folded card.
    expect(chips('Mac Studio')).toEqual([{ says: 'Claude Code ×2', out: false }]);
    expect(chips('HPC')).toEqual([
      { says: 'Claude Code', out: false },
      { says: 'Codex ×2', out: false },
      { says: 'Kimi Code', out: false },
    ]);
    // ThinkPad is offline: what it last said it runs on.
    expect(chips('ThinkPad')).toEqual([{ says: 'Claude Code', out: false }]);
    expect(machineCard('ThinkPad').querySelector('.re-runner-status')?.textContent).toBe('Offline');

    // Opened, the card's Codex row says it is signed out, and its Sign in opens the sign-in.
    const mac = machineCard('Mac Studio');
    expect(mac.classList.contains('collapsed')).toBe(true);
    expect(button('Sign in', mac.querySelector('.re-head')!)).toBeNull();
    await click(mac.querySelector('.re-toggle'));
    expect(mac.classList.contains('collapsed')).toBe(false);
    const codex = mac.querySelector<HTMLElement>('.re-row[data-engine="codex"]')!;
    await click(button('Sign in', codex));
    expect(codex.querySelector('.rsi')).not.toBeNull();
    await click(button('Sign in to Codex', codex));
    expect(sent).toEqual([{ method: 'POST', path: `/runners/${MAC}/login`, body: { engine: 'codex' } }]);
  });

  it('signs nothing in for an engine still running on another account, and draws none whose CLI would not say', async () => {
    runners = [
      machine(HPC, 'HPC', {
        engines: [
          // Default is out, Work is in: sessions there still run on Claude Code.
          {
            engine: 'claude',
            installed: true,
            auth: 'no',
            accounts: [
              { id: 'default', home: '/root/.claude', auth: 'no' },
              { id: 'slot-2', name: 'Work', home: '/root/.orbit/claude-2', auth: 'yes' },
            ],
          },
          { engine: 'codex', installed: true, auth: 'unknown' },
          { engine: 'kimi', installed: false, auth: 'no' },
        ],
      }),
    ];
    pools = [];
    await mount();
    // Claude Code still runs on Work, so its chip says how many of its two accounts are in, in amber,
    // with no Sign in of the engine's own — Default's row has it; Codex wouldn't say, so it has none.
    expect(chips('HPC')).toEqual([{ says: 'Claude Code 1 of 2 signed in', out: true }]);
  });

  it('leaves an offline machine to its card and an unavailable pool to its own, and opens each one’s page', async () => {
    // Its one account switched off: nothing in it can run, and the server says so.
    const off = { ...claudePool().members[0], enabled: false, state: 'DISABLED' as const, next: false };
    pools = [claudePool({ unavailable: 'No account can run', members: [off] })];
    await mount();
    const thinkpad = machineCard('ThinkPad');
    expect(thinkpad.classList.contains('offline')).toBe(true);
    await click(thinkpad.querySelector('a.re-manage'));
    expect(path).toBe(`/runners/${THINKPAD}`);

    act(() => root?.unmount());
    host?.remove();
    await mount();
    const pool = document.body.querySelector<HTMLElement>(`.pool-card[data-pool="${POOL}"]`)!;
    expect(text(pool.querySelector('.re-head .pool-gauge'))).toBe('No account can run');
    await click(pool.querySelector('a.re-manage'));
    expect(path).toBe(`/providers/pools/${POOL}`);
  });
});
