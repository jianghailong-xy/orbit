// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntdApp } from 'antd';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlanUsage, RunnerEngineHealth, RunnerInstallState } from '@orbit/shared';
import type { Runner } from '../components/TasksSidePanel';
import { openRunnerMenu } from '../components/RunnerEngines.test-helpers';
import { RunnerDetailPage } from './RunnerDetailPage';

/**
 * A machine's Engines on its own page: the rows of its card in Infrastructure, so an engine is signed
 * in, installed and its accounts managed right where it is listed — nothing sends the reader to
 * another page for it. Above them, the machine's own controls (Refresh models, Update engines, and
 * the update's report); among them, the CLIs those controls update that nothing signs in.
 */

vi.mock('../api', async (original) => ({ ...(await original<typeof import('../api')>()), api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';

const health = (over: Partial<RunnerEngineHealth>): RunnerEngineHealth => ({
  engine: 'claude',
  installed: true,
  auth: 'yes',
  ...over,
});

/** wikova, online: Claude Code signed out, two Codex accounts signed in, Kimi Code not installed, and
 *  OpenCode and DeepSeek Harness, which nothing signs in. */
const machine = (over: Partial<Runner> = {}): Runner =>
  ({
    id: RUNNER_ID,
    name: 'wikova',
    online: true,
    maxConcurrent: 4,
    activeSessions: 0,
    capabilities: ['provider:dsh'],
    engines: [
      health({ engine: 'claude', version: '2.1.291 (Claude Code)', auth: 'no' }),
      health({
        engine: 'codex',
        version: 'codex-cli 0.160.1',
        accounts: [
          { id: 'default', home: '/root/.codex', auth: 'yes' },
          { id: '1fda3f43', name: 'Work', home: '/root/.orbit/codex-accounts/1fda3f43', auth: 'yes' },
        ],
      }),
      health({ engine: 'kimi', installed: false, auth: 'unknown' }),
      health({ engine: 'opencode', version: '1.18.33', auth: 'unknown' }),
      health({ engine: 'dsh', version: '0.2.0-rc.2', auth: 'unknown' }),
    ],
    ...over,
  }) as Runner;

const relay = (over: Partial<RunnerInstallState>): RunnerInstallState => ({
  status: null,
  engine: null,
  command: null,
  message: null,
  mode: null,
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let scrolledTo: Element[] = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // No /dl/version.json here: the latest release is the runners' own.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
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
  // Claude's sign-in parks a tab for its page; a browser that blocks it gets the card's own link.
  vi.stubGlobal('open', () => null);
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolledTo.push(this);
  };
});
afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  vi.unstubAllGlobals();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  apiMock.mockReset();
  scrolledTo = [];
  document.body.innerHTML = '';
  // A group of accounts opened in one case stays open for the next otherwise (useOpenAccounts).
  localStorage.clear();
});

/** Where the page is: its own address, unless something sent the reader elsewhere. */
function Here() {
  const location = useLocation();
  return <div data-testid="here">{`${location.pathname}${location.search}`}</div>;
}

/** The machine's page over one runner. Every request that changes something is collected. */
async function mount(runner: Runner) {
  const sent: Array<{ method: string; path: string; body?: unknown }> = [];
  apiMock.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    const method = options?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({ method, path, ...(options?.body !== undefined ? { body: options.body } : {}) });
      return path.endsWith('/login')
        ? { status: 'pending', engine: 'claude', url: null, userCode: null, message: null, account: null }
        : {};
    }
    if (path === '/runners') return [runner];
    if (path.endsWith('/login')) {
      return { status: null, engine: null, url: null, userCode: null, message: null, account: null };
    }
    return [];
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <AntdApp>
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={[`/runners/${RUNNER_ID}`]}>
            <Routes>
              <Route path="/runners/:id" element={<RunnerDetailPage />} />
              <Route path="*" element={<div data-testid="elsewhere" />} />
            </Routes>
            <Here />
          </MemoryRouter>
        </QueryClientProvider>
      </AntdApp>,
    ),
  );
  await settle();
  return { sent };
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}
const $ = <T extends Element = HTMLElement>(selector: string, within: ParentNode = document.body) => {
  const found = within.querySelector<T & Element>(selector);
  if (!found) throw new Error(`nothing matches ${selector}`);
  return found as T;
};
const $$ = (selector: string, within: ParentNode = document.body) => [...within.querySelectorAll<HTMLElement>(selector)];
const text = (el: Element | null | undefined) => el?.textContent?.trim() ?? null;
const click = async (el: HTMLElement) => {
  await act(async () => el.click());
  await settle();
};
const button = (label: string, within: ParentNode = document.body) => {
  const found = $$('button', within).find((b) => text(b) === label);
  if (!found) throw new Error(`no button reading "${label}" in ${text(within as Element)}`);
  return found;
};
/** An engine's row in Engines, and the buttons on it (not the ones in a panel open under it). */
const row = (engine: string) => $(`.rd-engines [data-engine="${engine}"]`);
const actions = (el: Element) => $$(':scope > .re-act button', el).map((b) => text(b) || b.getAttribute('aria-label'));
const here = () => text($('[data-testid="here"]'));

describe('an engine on its machine’s page', () => {
  it('signs in from its own row, and the page stays where it is', async () => {
    const { sent } = await mount(machine());
    const claude = row('claude');
    expect(actions(claude)).toEqual(['Add account', 'Sign in']);

    await click(button('Sign in', claude));
    // Its sign-in opens under the row, on this page.
    expect(here()).toBe(`/runners/${RUNNER_ID}`);
    expect(document.querySelector('[data-testid="elsewhere"]')).toBeNull();
    const panel = $('.re-panel', claude);
    await click(button('Sign in to Claude Code', panel));
    expect(sent).toEqual([{ method: 'POST', path: `/runners/${RUNNER_ID}/login`, body: { engine: 'claude' } }]);
    expect(here()).toBe(`/runners/${RUNNER_ID}`);
  });

  it('installs one the machine lacks, from its row', async () => {
    const { sent } = await mount(machine());
    const kimi = row('kimi');
    expect(text($('.re-meta', kimi))).toBe('Not installed — Orbit can install it here');
    await click(button('Install', kimi));
    expect(sent).toEqual([{ method: 'POST', path: `/runners/${RUNNER_ID}/install`, body: { engine: 'kimi' } }]);
  });

  it('keeps each account on a row of its own, with its menu, and adds another from the engine’s row', async () => {
    const { sent } = await mount(machine());
    const codex = row('codex');
    expect(text($('.re-meta', codex))).toBe('0.160.1 · 2 of 2 accounts available');
    // Folded at first, as on the machine's card: the head speaks for its accounts until it is opened.
    expect($$('.rd-engines .re-acct')).toEqual([]);
    await click($('.re-grp-toggle', codex));
    expect($$('.rd-engines .re-acct .re-name-text').map(text)).toEqual(['Default', 'Work']);

    const work = $$('.rd-engines .re-acct')[1];
    const menu = await openRunnerMenu(work);
    expect($$('[role="menuitem"]', menu).map(text)).toEqual(['Rename', 'Re-sign in', 'Pause account…', 'Remove account']);

    await click(button('Add account', codex));
    expect(text($('.re-add-label', codex))).toBe('Account name');
    // The sign-in starts as the panel opens, under the name it picked.
    expect(sent).toEqual([
      { method: 'POST', path: `/runners/${RUNNER_ID}/login`, body: { engine: 'codex', accountName: 'Account 3' } },
    ]);
  });
});

describe('an engine’s quota on its machine’s page', () => {
  it('says a Kimi login whose plan has no quota limit apart from one whose read found nothing', async () => {
    // The runner read the account and the answer held no window: no quota limit, not a failed
    // read — Codex's windowless snapshot here is what a failed one still reads as.
    await mount(
      machine({
        planUsage: {
          kimi: { provider: 'kimi', fetchedAt: new Date().toISOString() },
          codex: { provider: 'codex', fetchedAt: new Date().toISOString() },
        } as PlanUsage,
        engines: [health({ engine: 'kimi' }), health({ engine: 'codex' })],
      }),
    );
    expect(text($('.re-quota-none', row('kimi')))).toBe('No quota limit');
    expect(text($('.re-quota-none', row('codex')))).toBe('No quota reported');
  });
});

describe('the machine’s own controls over its engines', () => {
  it('re-reads the model lists and updates every CLI, from Engines’ head', async () => {
    const { sent } = await mount(machine());
    expect($$('.rd-engines .rd-section-head button').map(text)).toEqual(['Refresh models', 'Update engines']);
    await click(button('Refresh models'));
    await click(button('Update engines'));
    expect(sent).toEqual([
      { method: 'POST', path: `/runners/${RUNNER_ID}/refresh-models` },
      { method: 'POST', path: `/runners/${RUNNER_ID}/engine-update` },
    ]);
  });

  it('reports what an update did, including what it left alone, until it is dismissed', async () => {
    const { sent } = await mount(
      machine({
        install: relay({
          status: 'done',
          mode: 'update',
          command: 'orbit engine-update',
          message: 'Claude Code updated 2.1.290 → 2.1.291\nOpenCode — already up to date (1.18.33)',
        }),
      }),
    );
    const report = $('.rd-engines .rd-engine-relay');
    expect(text($('.rd-engine-relay-row', report))).toBe(
      'Claude Code updated 2.1.290 → 2.1.291\nOpenCode — already up to date (1.18.33)',
    );
    expect(text($('code', report))).toBe('orbit engine-update');
    await click(button('Dismiss', report));
    expect(sent).toEqual([{ method: 'DELETE', path: `/runners/${RUNNER_ID}/install` }]);
  });

  it('leaves an engine’s own install to its row', async () => {
    await mount(
      machine({ install: relay({ status: 'failed', mode: 'install', engine: 'kimi', message: 'curl: (6) could not resolve host' }) }),
    );
    expect(document.querySelector('.rd-engines .rd-engine-relay')).toBeNull();
    expect(text($('.re-panel.bad .re-panel-row', row('kimi')))).toBe('curl: (6) could not resolve host');
  });

  it('lists the CLIs it updates that nothing signs in, after the ones that sign in', async () => {
    await mount(machine());
    expect($$('.rd-engines .re-row:not(.re-acct)').map((el) => el.dataset.engine)).toEqual([
      'claude',
      'codex',
      'antigravity',
      'kimi',
      'opencode',
      'dsh',
    ]);
    // OpenCode has its card's row here too, with nothing to press: it signs in per provider, on the machine.
    expect([text($('.re-name', row('opencode'))), text($('.re-meta', row('opencode')))]).toEqual([
      'OpenCode',
      '1.18.33 · the CLI wouldn\'t say',
    ]);
    expect(text($('.re-login-note', row('opencode')))).toMatch(/^Run opencode auth login on that machine/);
    expect([text($('.re-name', row('dsh'))), text($('.re-status', row('dsh')))]).toEqual(['DeepSeek Harness', 'Uses API keys']);
    expect(actions(row('opencode'))).toEqual([]);
  });

  it('says on a row that is not keeping current why, and points at nothing but this page’s Update engines', async () => {
    const days = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();
    await mount(
      machine({
        engines: [
          health({
            engine: 'claude',
            version: '2.1.226 (Claude Code)',
            update: {
              status: 'failed',
              at: days(1 / 24),
              okAt: days(2),
              latest: '2.1.228',
              behindSince: days(9),
              message: '2.1.226 → 2.1.228: `claude update` was still running after 5m1s and was stopped.',
            },
          }),
        ],
      }),
    );
    const claude = row('claude');
    expect(text($('.re-upd.warn', claude))).toBe('· 9d behind 2.1.228');
    expect(text($('.re-panel.warn .re-panel-row', claude))).toBe(
      '2.1.226 → 2.1.228: `claude update` was still running after 5m1s and was stopped.',
    );
    expect(text($('.re-panel.warn .re-panel-hint', claude))).toBe('Orbit tries every 30 min.');
    expect($$('.rd-engines a[href^="/runners/"]')).toEqual([]);
    expect(text($('.rd-engines > .rd-hint'))).toBe(
      'Orbit keeps these CLIs updated every 30 min. Sign-ins live on this machine — a session spends that subscription, nothing to paste.',
    );
  });

  it('never reads a runner that has not reported its engines as an empty machine', async () => {
    await mount(machine({ engines: null }));
    expect(text($('.rd-engines .re-unreported'))).toMatch(/^This runner hasn't reported its engines yet\./);
    expect(document.querySelector('.rd-engines > .rd-hint')).toBeNull();
  });
});
