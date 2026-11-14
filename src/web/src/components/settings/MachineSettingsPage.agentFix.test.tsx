// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunnerAgentFix, RunnerEngineHealth, RunnerInstallState } from '@orbit/shared';
import type { Runner } from '../TasksSidePanel';
import { openRunnerMenu } from '../RunnerEngines.test-helpers';
import { MachineSettingsPage } from './MachineSettingsPage';

/**
 * Fix with an agent on a machine's page (boards: the task's fix-with-agent board and
 * docs/mocks/install-failed-fix-with-agent/01-board.png). One press on a warning whose fix is work on that
 * machine starts a session there at once — no sheet, nothing to pick. The button is on the Needs Attention
 * cards for an engine that won't update and a runner that can't update itself (updates turned off
 * included), and on an engine's Install failed panel; never on offline, signed-out or other cards. While
 * that session is open the button gives way to "An agent is fixing this in <workspace> · Open session";
 * when none can start it is disabled with the reason. The server decides both (runner.agentFix).
 */

vi.mock('../../api', async (original) => ({ ...(await original<typeof import('../../api')>()), api: vi.fn() }));
const { api } = await import('../../api');
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
/** What /dl/version.json publishes in a case; null when it can't be read. */
let published: string | null = null;
let host: HTMLDivElement | null = null;
let scrolledTo: Element[] = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // No /dl/version.json here: the latest release is the runners' own.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: published !== null, json: async () => ({ version: published }) })));
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
  published = null;
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
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/settings/machines/${RUNNER_ID}`]}>
          <Routes>
            <Route path="/settings/machines/:id" element={<MachineSettingsPage />} />
            <Route path="*" element={<div data-testid="elsewhere" />} />
          </Routes>
          <Here />
        </MemoryRouter>
      </QueryClientProvider>,
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
const row = (engine: string) => $(`.machine-section-engines [data-engine="${engine}"]`);
const actions = (el: Element) => $$(':scope > .re-act button', el).map((b) => text(b) || b.getAttribute('aria-label'));

const SESSION = '5vpM0Nw3kDpVzIyj3VFzMj';
const days = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();
/** orbit@austin's Codex: 0.159.2, 13 days behind 0.169.0, its update failing. */
const codexBehind = () =>
  health({
    engine: 'codex',
    version: 'codex-cli 0.159.2',
    update: {
      status: 'failed', at: days(1 / 24), okAt: days(14), latest: '0.169.0', behindSince: days(13.2),
      message: 'Error: No such file or directory (os error 2)',
    },
  });
const ready = (over: Partial<RunnerAgentFix> = {}): RunnerAgentFix => ({
  workspaceId: 'ws1', workspaceName: 'orbit-dev', engine: 'claude', engineName: 'Claude Code', blocked: null, fixing: [], ...over,
});
const signedOutLine = "An agent can't run here: orbit-dev uses Claude Code, which is signed out on this machine.";

const card = (title: string) => {
  const found = $$('.machine-attention .rd-attention-card').find((c) => text($('.rd-attention-title', c)) === title);
  if (!found) throw new Error(`no card titled ${title}`);
  return found;
};
const cardButtons = (el: Element) => $$('.rd-attention-action button', el).map((b) => text(b));
const fixButton = (within: ParentNode) => $$('button', within).find((b) => text(b) === 'Fix with an agent') ?? null;
const lineOf = (within: ParentNode) => text(within.querySelector('.agent-fix-line'));
/** Every Fix with an agent on the page, by where it sits. */
const everyFixButton = () => $$('button').filter((b) => text(b) === 'Fix with an agent');

/** The machine with Claude Code signed in and Codex behind: one "Codex update failed" card. */
const behind = (over: Partial<Runner> = {}) =>
  machine({ engines: [health({ engine: 'claude', version: '2.1.325 (Claude Code)' }), codexBehind()], agentFix: ready(), ...over });

/** Serve the next read of the runner with `next` in place of what was mounted. */
function thenServe(next: Runner) {
  const served = apiMock.getMockImplementation()!;
  apiMock.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) =>
    path === '/runners' && !options?.method ? [next] : served(path, options),
  );
}

describe('on a Needs Attention card', () => {
  it('sits after Update Engines Now and before Dismiss; a press starts the session and the card says where', async () => {
    const runner = behind();
    const { sent } = await mount(runner);
    const codex = card('Codex update failed');
    expect(cardButtons(codex)).toEqual(['Update Engines Now', 'Fix with an agent', 'Dismiss until next Codex release']);
    expect(lineOf(codex)).toBeNull();

    thenServe({
      ...runner,
      agentFix: ready({ fixing: [{ kind: 'engineNotUpdating', engine: 'codex', sessionId: SESSION, workspaceId: 'ws1', workspaceName: 'orbit-dev' }] }),
    });
    await click(fixButton(codex)!);
    // No sheet, nothing to pick: one request, the warning and its engine.
    expect(sent).toEqual([{ method: 'POST', path: `/runners/${RUNNER_ID}/attention/engineNotUpdating/fix`, body: { engine: 'codex' } }]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    const after = card('Codex update failed');
    expect(fixButton(after)).toBeNull();
    expect(cardButtons(after)).toEqual(['Update Engines Now', 'Dismiss until next Codex release']);
    expect(lineOf(after)).toBe('An agent is fixing this in orbit-dev · Open session');
    const open = $<HTMLAnchorElement>('.agent-fix-line a', after);
    expect(open.getAttribute('href')).toBe(`/sessions/${SESSION}`);
    await click(open);
    expect(text($('[data-testid="here"]'))).toBe(`/sessions/${SESSION}`);
  });

  it('is on the runner that can\'t update itself, updates turned off included, and sends the latest release', async () => {
    published = '0.1.256';
    const runner = behind({
      version: '0.1.250',
      engines: [health({ engine: 'claude', version: '2.1.325 (Claude Code)' })],
      selfUpdate: { state: 'disabledByEnv', reason: 'ORBIT_NO_SELFUPDATE is set' },
    });
    const { sent } = await mount(runner);
    const off = card('Updates are turned off');
    expect(cardButtons(off)).toEqual(['Fix with an agent']);
    await click(fixButton(off)!);
    expect(sent).toEqual([{ method: 'POST', path: `/runners/${RUNNER_ID}/attention/cannotSelfUpdate/fix`, body: { latest: '0.1.256' } }]);
  });

  it('is on a runner whose update failed, beside Update Runner Now', async () => {
    published = '0.1.256';
    await mount(behind({
      version: '0.1.250',
      engines: [health({ engine: 'claude', version: '2.1.325 (Claude Code)' })],
      selfUpdate: { state: 'failed', reason: 'download failed: 502 Bad Gateway' },
    }));
    expect(cardButtons($('.machine-attention .rd-attention-card'))).toEqual(['Update Runner Now', 'Fix with an agent']);
  });

  it('is on no other card: signed out, and nothing at all while the machine is offline', async () => {
    // Claude Code signed out is a card of its own, fixed by signing in, not by an agent.
    await mount(behind({
      engines: [health({ engine: 'claude', version: '2.1.325', auth: 'no' }), codexBehind()],
      agentFix: ready({ blocked: { code: 'engineSignedOut', message: signedOutLine } }),
    }));
    const titles = $$('.machine-attention .rd-attention-title').map((t) => text(t));
    expect(titles).toContain('Codex update failed');
    expect(everyFixButton()).toHaveLength(1);
    expect(everyFixButton()[0].closest('.rd-attention-card')).toBe(card('Codex update failed'));
    act(() => root?.unmount());
    document.body.innerHTML = '';

    published = '0.1.256';
    await mount(behind({
      online: false,
      lastHeartbeatAt: days(1),
      version: '0.1.250',
      runsAsRoot: false,
      agentFix: ready({ blocked: { code: 'offline', message: 'This machine is offline.' } }),
    }));
    expect($$('.machine-attention .rd-attention-title').map((t) => text(t))).toContain('Can’t update itself');
    expect(everyFixButton()).toEqual([]);
    expect(document.querySelector('.agent-fix-line')).toBeNull();
  });

  for (const [code, message] of [
    ['noWorkspace', 'No workspace runs on this machine yet.'],
    ['engineSignedOut', signedOutLine],
  ] as const) {
    it(`is disabled with the reason when no agent can start (${code})`, async () => {
      const { sent } = await mount(behind({ agentFix: ready({ blocked: { code, message } }) }));
      const codex = card('Codex update failed');
      const pressed = fixButton(codex)!;
      expect(pressed.hasAttribute('disabled') || pressed.getAttribute('aria-disabled') === 'true').toBe(true);
      expect(lineOf(codex)).toBe(message);
      await click(pressed);
      expect(sent).toEqual([]);
    });
  }

  it('is not drawn by a server that does not say where an agent would run', async () => {
    await mount(behind({ agentFix: undefined }));
    expect(cardButtons(card('Codex update failed'))).toEqual(['Update Engines Now', 'Dismiss until next Codex release']);
  });
});

describe('on an engine\'s Install failed panel', () => {
  /** vmi3753066: Codex's install failed, npm missing; Claude Code signed in. */
  const failed = (over: Partial<Runner> = {}) =>
    machine({
      name: 'vmi3753066',
      engines: [health({ engine: 'claude', version: '2.1.325' }), health({ engine: 'codex', installed: false, auth: 'unknown' })],
      install: relay({ status: 'failed', engine: 'codex', command: 'npm install -g @openai/codex', message: 'exit status 127: sh: 1: npm: not found', mode: 'install' }),
      agentFix: ready({ workspaceName: 'orbit-develop' }),
      ...over,
    });
  const panel = () => $('.re-panel.bad', row('codex'));

  it('sits before Dismiss and says where it runs; a press starts the session, Retry stays', async () => {
    const runner = failed();
    const { sent } = await mount(runner);
    expect(text($('.re-panel-row', panel()))).toBe('exit status 127: sh: 1: npm: not found');
    expect($$('.agent-fix-row button', panel()).map((b) => text(b))).toEqual(['Fix with an agent', 'Dismiss']);
    expect(lineOf(panel())).toBe('Starts a session in orbit-develop on this machine, with Claude Code.');
    expect(actions(row('codex'))).toContain('Retry');

    thenServe({
      ...runner,
      agentFix: ready({ workspaceName: 'orbit-develop', fixing: [{ kind: 'installFailed', engine: 'codex', sessionId: SESSION, workspaceId: 'ws1', workspaceName: 'orbit-develop' }] }),
    });
    await click(fixButton(panel())!);
    expect(sent).toEqual([{ method: 'POST', path: `/runners/${RUNNER_ID}/attention/installFailed/fix`, body: { engine: 'codex' } }]);

    // Fixing: the panel stays, the button gives way to the session, Dismiss and the row's Retry stay.
    expect(fixButton(panel())).toBeNull();
    expect(lineOf(panel())).toBe('An agent is fixing this in orbit-develop · Open session');
    expect($<HTMLAnchorElement>('.agent-fix-line a', panel()).getAttribute('href')).toBe(`/sessions/${SESSION}`);
    expect($$('button', panel()).map((b) => text(b))).toEqual(['Dismiss']);
    expect(actions(row('codex'))).toContain('Retry');
  });

  for (const [code, message, line] of [
    ['engineSignedOut', "An agent can't run here: orbit-develop uses Claude Code, which is signed out on this machine.",
      "An agent can't run here: orbit-develop uses Claude Code, which is signed out on this machine. Sign in to Claude Code above to use this."],
    ['noWorkspace', 'No workspace runs on this machine yet.', 'No workspace runs on this machine yet.'],
    ['offline', 'This machine is offline.', 'This machine is offline.'],
  ] as const) {
    it(`is disabled with the reason in the same place (${code}); no other engine is offered`, async () => {
      const { sent } = await mount(failed({ agentFix: ready({ workspaceName: 'orbit-develop', blocked: { code, message } }) }));
      const pressed = fixButton(panel())!;
      expect(pressed.hasAttribute('disabled') || pressed.getAttribute('aria-disabled') === 'true').toBe(true);
      expect(lineOf(panel())).toBe(line);
      await click(pressed);
      expect(sent).toEqual([]);
    });
  }

  it('belongs to the failed engine\'s panel only, and a failed engine update gets none', async () => {
    await mount(failed());
    expect($$('.machine-section-engines .re-panel.bad')).toHaveLength(1);
    expect(fixButton(row('claude'))).toBeNull();
  });
});
