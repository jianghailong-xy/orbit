// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDialog } from '../components/RunnerEngines.test-helpers';
import type { Runner } from '../components/TasksSidePanel';
import { encodeId } from '../lib/idCodec';
import type { ProviderRow } from '../lib/providerAdmin';
import { InfrastructurePage } from './InfrastructurePage';

/**
 * /infrastructure as a page (docs/mocks/infrastructure-page/02-after-*.png): its name, its line and
 * Add, then what the agents can run on (InfrastructurePage.overview.test.tsx), Machines, API keys and
 * Account pools in that order — each with what it says before there
 * is anything in it — a key's own Edit and Delete, and a machine's engines with every way in they
 * had on Providers.
 */

vi.mock('../api', async (original) => ({ ...(await original<typeof import('../api')>()), api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const MAC = '33zx0JhRhJo8rd25d3qAM';
const HPC = encodeId('0195c0de-0000-7000-8000-0000000000b2');
const THINKPAD = encodeId('0195c0de-0000-7000-8000-0000000000b3');
const ANTHROPIC: ProviderRow = {
  id: encodeId('0195c0de-0000-7000-8000-0000000000c1'),
  slug: 'anthropic-1',
  label: 'Anthropic',
  runtime: 'claude',
  engines: ['claude', 'opencode'] as ProviderRow['engines'],
  baseUrl: 'https://api.anthropic.com',
  models: [],
  defaultModel: null,
  presetSlug: 'anthropic',
  followsPreset: true,
  enabled: true,
  hasApiKey: true,
  poolRefusal: null,
};

const machine = (id: string, name: string, over: Partial<Runner> = {}): Runner => ({
  id,
  name,
  online: true,
  activeSessions: 0,
  maxConcurrent: 4,
  engines: [],
  ...over,
});
const MACHINES = [
  machine(MAC, 'Mac Studio', {
    activeSessions: 2,
    hostname: 'mac-studio.local',
    version: '0.1.240',
    engines: [
      // One account of its own: its menu is where it is paused.
      { engine: 'claude', installed: true, auth: 'yes', version: '2.1.4', accounts: [{ id: 'default', home: '/Users/me/.claude', auth: 'yes' }] },
      { engine: 'codex', installed: true, auth: 'no', version: '0.160.0' },
      { engine: 'kimi', installed: false, auth: 'unknown' },
    ],
  }),
  machine(HPC, 'HPC', { activeSessions: 5, maxConcurrent: 8 }),
  // Offline: its slots are nobody's.
  machine(THINKPAD, 'ThinkPad', { online: false, activeSessions: 0, maxConcurrent: 3 }),
];

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let path = '';
let runners: Runner[] = [];
let keys: ProviderRow[] = [];
let sent: Array<{ method: string; path: string; body?: unknown }> = [];

function Probe() {
  const location = useLocation();
  path = location.pathname + location.hash;
  return null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  runners = MACHINES;
  keys = [ANTHROPIC];
  sent = [];
  apiMock.mockImplementation((async (p: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({ method, path: p, ...(init?.body === undefined ? {} : { body: init.body }) });
      return {};
    }
    if (p === '/runners') return runners;
    if (p === '/providers/mine') return keys;
    if (p.endsWith('/usage')) return { providerId: p.split('/')[3], engines: [], sessions: 0, tasks: 0 };
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
  // Dropdowns measure their trigger; jsdom has no ResizeObserver, nor any scrolling.
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

async function mount(at = '/infrastructure') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[at]}>
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
/** An element's words, without the monograms drawn on its marks (OpenCode's "O"). */
const words = (el: Element | null | undefined) => {
  if (!el) return null;
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('.provider-tile').forEach((tile) => tile.remove());
  return copy.textContent?.replace(/\s+/g, ' ').trim() ?? null;
};

const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error('nothing to click');
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await settle();
};
const button = (words: string, scope: ParentNode = document.body) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((el) => text(el) === words) ?? null;
const sectionHead = (title: string) =>
  [...document.body.querySelectorAll<HTMLElement>('.re-sec-head')].find((el) => text(el.querySelector('h3')) === title) ?? null;
/** The items of the menu `trigger` opens, once its portal is drawn (a frame or two late on a slow host). */
const openMenu = async (trigger: Element | null) => {
  await click(trigger);
  let items: HTMLElement[] = [];
  await act(async () => {
    await vi.waitFor(() => {
      items = [...document.body.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')];
      if (items.length === 0) throw new Error('no menu is open');
    }, { timeout: 20_000, interval: 20 });
  });
  return items;
};
const card = (name: string) =>
  [...document.body.querySelectorAll<HTMLElement>('.re-runner-card')].find((el) => text(el.querySelector('.re-runner')) === name)!;

describe('/infrastructure', () => {
  it('heads the page with its name, its line and Add, then what the agents can run on, Machines, API keys and Account pools in that order', async () => {
    await mount();
    expect(text(document.body.querySelector('h1'))).toBe('Infrastructure');
    expect(text(document.body.querySelector('.prov-page-sub'))).toBe('Where your agents run, and whose model quota they spend.');
    expect(button('Add')).not.toBeNull();
    expect([...document.body.querySelectorAll('.re-sec-head h3')].map(text)).toEqual([
      'What your agents can run on',
      'Machines',
      'API keys',
      'Account pools',
    ]);
    expect(text(sectionHead('Machines')?.querySelector('.re-sec-sub'))).toBe(
      'Subscriptions signed in here are spent only by sessions on that machine.',
    );
    // Slots on the machines that can take work: the offline one's are nobody's.
    expect(text(sectionHead('Machines')?.querySelector('.re-sec-count'))).toBe('3 machines · 7 / 12 slots busy');
    expect(text(sectionHead('API keys')?.querySelector('.re-sec-sub'))).toBe(
      'On your account and usable from every machine — billed per token.',
    );
    expect(text(sectionHead('Account pools')?.querySelector('.re-sec-sub'))).toBe('Several accounts under one name.');
    // Each machine's card says how busy it is, and leads to its page.
    expect(text(card('Mac Studio').querySelector('.re-runner-meta'))).toBe('2 / 4 running · mac-studio.local · v0.1.240');
    expect(text(card('HPC').querySelector('.re-manage'))).toBe('Details →');
  });

  it('adds what each section holds from Add: a machine, a key, or a pool', async () => {
    await mount();
    const items = await openMenu(button('Add'));
    expect(items.map((item) => [text(item.querySelector('b')), text(item.querySelector('.infra-add > span'))])).toEqual([
      ['Register a machine', 'Run agents on a computer you own, on its subscriptions'],
      ['Connect an API key', 'Usable from every machine, billed per token'],
      ['New account pool', 'Several accounts behind one name'],
    ]);
    await click(items[0]);
    expect(path).toBe('/runners/register');

    act(() => root?.unmount());
    host?.remove();
    await mount();
    await click((await openMenu(button('Add')))[1]);
    expect(path).toBe('/providers/new');

    act(() => root?.unmount());
    host?.remove();
    await mount();
    await click((await openMenu(button('Add')))[2]);
    // The dialog the pools' own New pool opens.
    expect(await openDialog('New account pool')).not.toBeNull();
    expect(path).toBe('/infrastructure');
  });

  it('says what each section is for before there is anything in it', async () => {
    runners = [];
    keys = [];
    await mount();
    const empty = document.body.querySelector<HTMLElement>('.re-empty')!;
    expect(text(empty.querySelector('h4'))).toBe('Already pay for Claude, Codex or Kimi?');
    expect(empty.querySelector('a')?.getAttribute('href')).toBe('/runners/register');
    expect(text(empty.querySelector('a'))).toBe('Register a machine');
    expect(sectionHead('Machines')?.querySelector('.re-sec-count')).toBeNull();
    const noKeys = document.body.querySelector<HTMLElement>('.provider-empty')!;
    expect(text(noKeys.querySelector('h3'))).toBe('No keys yet');
    expect(text(noKeys.querySelector('p'))).toBe('Pick a provider and paste your API key — or skip it and sign a machine in above.');
    expect(noKeys.querySelector('a[href="/providers/new/anthropic"]')).not.toBeNull();
    expect(button('New pool', document.body.querySelector('.pool-sec')!)).not.toBeNull();
  });

  it('keeps the gallery under the keys there are, edits a key on its page, and deletes one once asked', async () => {
    await mount();
    const row = document.body.querySelector<HTMLElement>('.provider-keys tbody tr.prov-key')!;
    expect(text(row.querySelector('.prov-cell-name'))).toBe('Anthropic');
    expect(text(document.body.querySelector('.provider-more h3'))).toBe('Connect another provider');
    expect(document.body.querySelector('.provider-more a[href="/providers/new/openai"]')).not.toBeNull();

    await click(button('Delete', row));
    expect(sent).toEqual([]);
    // The question is a dialog named by itself, saying what the key goes from — here, nothing uses it.
    const confirm = await openDialog('Delete Anthropic?');
    await act(async () => {
      await vi.waitFor(() => expect(text(confirm)).toContain('Nothing uses it right now.'));
    });
    expect([...confirm.querySelectorAll('.key-impact-row')].map(words)).toEqual(['Claude Code — not in use', 'OpenCode — not in use']);
    await click(button('Delete key', confirm));
    expect(sent).toEqual([{ method: 'DELETE', path: `/providers/mine/${ANTHROPIC.id}` }]);

    await click(button('Edit', row));
    expect(path).toBe(`/providers/${ANTHROPIC.id}`);
  });

  it('brings the pools into view for #pools, where a pool’s page goes back to', async () => {
    await mount('/infrastructure#pools');
    const scroll = vi.mocked(Element.prototype.scrollIntoView);
    expect(scroll.mock.calls).toEqual([[{ block: 'start' }]]);
    expect(scroll.mock.contexts[0]).toBe(document.body.querySelector('#pools'));
    expect(text((scroll.mock.contexts[0] as HTMLElement).querySelector('h3'))).toBe('Account pools');
  });

  it('opens a machine on its engines, with each way in Providers had: sign in, install, add an account, pause it', async () => {
    await mount();
    await click(card('Mac Studio').querySelector('.re-toggle'));
    const row = (engine: string) => card('Mac Studio').querySelector<HTMLElement>(`.re-row[data-engine="${engine}"]`)!;
    expect(button('Sign in', row('codex'))).not.toBeNull();
    expect(button('Add account', row('claude'))).not.toBeNull();
    const items = await openMenu(row('claude').querySelector('button[aria-label="More actions"]'));
    expect(items.map(text)).toEqual(['Re-sign in', 'Pause account…']);

    await click(button('Install', row('kimi')));
    expect(sent).toEqual([{ method: 'POST', path: `/runners/${MAC}/install`, body: { engine: 'kimi' } }]);
  });
});
