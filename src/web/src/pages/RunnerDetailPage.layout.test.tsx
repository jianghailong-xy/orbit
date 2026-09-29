// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntdApp } from 'antd';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Runner } from '../components/TasksSidePanel';
import type { RunnerAttentionInput } from '../lib/runnerAttention';
import cases from '../lib/runnerAttention.cases.json';
import { RunnerDetailPage } from './RunnerDetailPage';

/**
 * A runner's page as web.png lays it out: the header, Needs Attention across the top, then the
 * machine's Engines and Workspaces beside its Capacity and About — one column on a phone, in the
 * iPhone page's order. Mounted over runnerAttention.cases.json's machines (wikova, the offline Mac
 * mini, and one with everything wrong at once), so every sentence asserted is the rule's own.
 */

vi.mock('../api', async (original) => ({
  ...(await original<typeof import('../api')>()),
  api: vi.fn(),
  // Called inside api.ts, where a mock of the exported `api` can't reach.
  cleanUpWorkspaceRepo: vi.fn(),
}));
vi.mock('../lib/clipboard', () => ({ copyText: vi.fn(async () => true) }));
const { api, cleanUpWorkspaceRepo } = await import('../api');
const { copyText } = await import('../lib/clipboard');
const apiMock = vi.mocked(api);

interface AttentionCase {
  name: string;
  input: RunnerAttentionInput;
}
const CASES = cases as unknown as AttentionCase[];
const caseNamed = (prefix: string): AttentionCase => {
  const found = CASES.find((c) => c.name.startsWith(prefix));
  if (!found) throw new Error(`runnerAttention.cases.json has no case starting ${JSON.stringify(prefix)}`);
  return found;
};

const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';
const ENROLLED = '2026-06-18T09:00:00Z';
const NOW = caseNamed('real wikova').input.nowMs;

type Workspace = RunnerAttentionInput['workspaces'][number] & { runnerId: string };

interface Machine {
  runner: Runner;
  workspaces: Workspace[];
  /** The case's latest release, which the page reads from /dl/version.json. */
  latest: string | null;
}

/** A case's runner as GET /runners answers it (with the fields only this page reads), its
 *  workspaces as GET /workspaces does, and the release the case calls the latest. */
function machine(prefix: string, over: Partial<Runner> = {}): Machine {
  const { runner, workspaces, latestVersion } = caseNamed(prefix).input;
  return {
    runner: { ...runner, id: RUNNER_ID, enrolledAt: ENROLLED, ...over } as Runner,
    workspaces: workspaces.map((workspace) => ({ ...workspace, runnerId: RUNNER_ID })),
    latest: latestVersion,
  };
}

const css = readFileSync(
  [resolve(process.cwd(), 'src/index.css'), resolve(process.cwd(), 'src/web/src/index.css')].find(existsSync)!,
  'utf8',
);

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let scrolledTo: Element[] = [];
/** What /dl/version.json publishes: the mounted case's latest release. */
let published: string | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url !== '/dl/version.json' || published === null) throw new Error(`no ${url} here`);
      return { ok: true, json: async () => ({ version: published }) };
    }),
  );
  // antd's Select measures its box, and jsdom ships no layout to measure.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
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
  // jsdom has no scrolling; record where the page asked to go.
  Element.prototype.scrollIntoView = function (this: Element) {
    scrolledTo.push(this);
  };
});
afterAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  apiMock.mockReset();
  vi.mocked(cleanUpWorkspaceRepo).mockReset();
  vi.mocked(copyText).mockClear();
  scrolledTo = [];
  published = null;
  document.body.innerHTML = '';
});

/** Where a link out of the page arrived. */
function Arrived() {
  const location = useLocation();
  return <div data-testid="arrived">{`${location.pathname}${location.search}`}</div>;
}

/** The runner's page over one machine. Every request that changes something is collected. */
async function mount(m: Machine, counts: Array<{ workspaceId: string; running: number }> = []) {
  const sent: Array<{ method: string; path: string; body?: unknown }> = [];
  published = m.latest;
  apiMock.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
    const method = options?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({ method, path, ...(options?.body !== undefined ? { body: options.body } : {}) });
      return path.endsWith('/rotate-token') ? { token: 'orbit_rt_fresh' } : {};
    }
    if (path === '/runners') return [m.runner];
    if (path === '/workspaces') return m.workspaces;
    if (path === '/sessions/counts') {
      return counts.map((count) => ({ ...count, active: count.running, needsYou: 0 }));
    }
    return [];
  });
  vi.mocked(cleanUpWorkspaceRepo).mockImplementation(async (workspaceId: string) => {
    sent.push({ method: 'POST', path: `/workspaces/${workspaceId}/repo-cleanup` });
    return {};
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
              <Route path="/providers" element={<Arrived />} />
            </Routes>
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
const $$ = (selector: string, within: ParentNode = document.body) => [
  ...within.querySelectorAll<HTMLElement>(selector),
];
const text = (el: Element | null | undefined) => el?.textContent?.trim() ?? null;
const click = async (el: HTMLElement) => {
  await act(async () => el.click());
  await settle();
};
const button = (label: string, within: ParentNode = document.body) => {
  const found = $$('button', within).find((b) => text(b) === label);
  if (!found) throw new Error(`no button reading "${label}"`);
  return found;
};
const cards = () =>
  $$('.rd-attention-card').map((card) => ({
    tone: card.className.replace('rd-attention-card', '').trim(),
    title: text($('.rd-attention-title', card)),
    detail: text($('.rd-attention-detail', card)),
    action: text(card.querySelector('.rd-attention-action button')),
  }));
const sectionTitles = (selector: string) => $$(`${selector} > .rd-section`).map((s) => text($('.rd-section-title', s)));
/** About's rows: the label, the value's own text, and the note beside it. */
const about = () =>
  $$('.rd-about .rd-kv').map((row) => {
    const value = $('.rd-kv-value', row).cloneNode(true) as HTMLElement;
    const note = text(value.querySelector('small'));
    value.querySelectorAll('small, button').forEach((el) => el.remove());
    return [text($('.rd-kv-label', row)), text(value), note];
  });

/** Types into an antd InputNumber the way a person does: the text changes, then focus leaves or
 *  Enter is pressed. */
async function typeNumber(input: HTMLInputElement, value: string, finish: 'blur' | 'enter') {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    if (finish === 'enter') {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    } else {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    }
  });
  await settle();
}

/** Opens Keep Free and reads what it offers. */
async function keepFreeOptions() {
  await act(async () => {
    $('.rd-keep-free .ant-select-content').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await settle();
  return $$('.ant-select-item-option');
}

describe('a runner’s page, laid out as web.png', () => {
  it('puts Needs Attention under the title, then Engines and Workspaces beside Capacity and About', async () => {
    await mount(machine('real wikova'));
    const page = $('.rd-page');
    expect([...page.children].map((el) => el.className)).toEqual([
      'rd-head',
      'rd-title-row',
      'rd-metaline',
      'rd-attention',
      'rd-cols',
    ]);
    expect($('.rd-attention').getAttribute('aria-label')).toBe('Needs Attention');
    expect(sectionTitles('.rd-col-main')).toEqual(['Engines', 'Workspaces']);
    expect(sectionTitles('.rd-col-side')).toEqual(['Capacity', 'About This Runner']);
    // The header keeps its title and one line of who it is; the Details ▾ grid is gone — About has it.
    expect(text($('.rd-title-row h1'))).toBe('wikova');
    expect($$('.rd-metaline > span').map(text)).toEqual(['Online', '4 of 12 running', 'v0.1.197', 'vmi3129740']);
    expect(document.body.textContent).not.toContain('Details');
  });

  it('is one column on a phone, in the iPhone page’s order', () => {
    // The layout itself is CSS, which jsdom computes nothing of: the ≤640px block is read instead.
    const phone = [...css.matchAll(/@media \(max-width: 640px\) \{\n([\s\S]*?)\n\}\n/g)]
      .map((m) => m[1])
      .filter((block) => block.includes('.rd-cols'));
    expect(phone).toHaveLength(1);
    const [block] = phone;
    expect(block).toMatch(/\.rd-col \{\s*display: contents;\s*\}/);
    // Every section the phone's full width — the desktop grid's `align-items: start` would size
    // each one to its content instead.
    expect(block).toMatch(/\.rd-cols \{\s*display: flex;\s*flex-direction: column;\s*align-items: stretch;\s*\}/);
    expect(block).toMatch(/\.rd-attention \{\s*grid-template-columns: minmax\(0, 1fr\);\s*\}/);
    const order = (section: string) => Number(new RegExp(`\\.${section} \\{\\s*order: (\\d+);`).exec(block)?.[1]);
    const sections = ['rd-about', 'rd-workspaces', 'rd-capacity', 'rd-engines'];
    expect(sections.every((section) => Number.isInteger(order(section)))).toBe(true);
    expect([...sections].sort((a, b) => order(a) - order(b))).toEqual([
      'rd-capacity',
      'rd-engines',
      'rd-workspaces',
      'rd-about',
    ]);
    // And two columns from 641px up, the settings column the narrower one.
    expect(css).toMatch(/\.rd-cols \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\) 290px;/);
  });

  it('gives each item a card of its own, with the reset time in front of a quota', async () => {
    await mount(machine('real wikova'));
    const [quota, disk] = cards();
    expect(cards()).toHaveLength(2);
    expect(quota.tone).toBe('warn');
    expect(quota.title).toBe('Claude weekly limit at 98%');
    expect(quota.detail).toMatch(
      /^Resets .+\. wikova-develop runs on this machine’s Claude login — its sessions pause if the limit runs out\.$/,
    );
    expect(quota.action).toBeNull();
    expect(disk).toEqual({
      tone: 'warn',
      title: 'Disk 95% full',
      detail: '9.4 GB free of 197 GB. No reserve is set, so task runs keep landing here until the disk fills.',
      action: 'Set a Reserve…',
    });
  });

  it('offers each card’s one action, and each does what it says', async () => {
    const lab = machine('everything at once');
    const { sent } = await mount(lab);
    expect(cards().map(({ tone, title, action }) => [tone, title, action])).toEqual([
      ['bad', 'Claude is signed out', 'Sign In'],
      ['bad', 'app checkout stuck in a rebase', 'Repair'],
      ['warn', 'Claude weekly limit at 99%', null],
      ['warn', 'Codex 5-hour limit at 95%', null],
      ['warn', 'Disk 95% full', 'Set a Reserve…'],
      ['warn', 'Can’t update itself', 'Copy Command'],
      ['warn', 'Claude Code update failed', 'Update Engines Now'],
    ]);
    // A window with no reset time reported says nothing about one.
    expect(cards()[3].detail).toBe('tools runs on this machine’s Codex login — its sessions pause if the limit runs out.');

    // Update Engines Now: the engine update the Engines section starts.
    await click(button('Update Engines Now'));
    expect(sent).toEqual([{ method: 'POST', path: `/runners/${RUNNER_ID}/engine-update` }]);

    // Copy Command: the command, on the clipboard.
    await click(button('Copy Command'));
    expect(copyText).toHaveBeenCalledWith('sudo orbit upgrade');
    expect(document.body.textContent).toContain('Copied');

    // Set a Reserve…: Capacity comes into view with Keep Free focused.
    await click(button('Set a Reserve…'));
    expect(scrolledTo).toEqual([$('.rd-capacity')]);
    expect($('.rd-keep-free').contains(document.activeElement)).toBe(true);

    // Repair: asks first, in a session merge bar's words, then repairs through the first workspace.
    await click(button('Repair'));
    const confirm = $('.ant-modal-confirm');
    expect(text($('.ant-modal-confirm-title', confirm))).toBe('Clean up this checkout?');
    expect(text($('.ant-modal-confirm-content', confirm))).toContain('Orbit will save everything /srv/app currently holds');
    await click(button('Save and clean up', confirm));
    expect(sent.at(-1)).toEqual({ method: 'POST', path: '/workspaces/ws-app/repo-cleanup' });

    // Sign In: that engine's card on Providers, opened.
    await click(button('Sign In'));
    expect(text($('[data-testid="arrived"]'))).toBe(`/providers?runner=${RUNNER_ID}&engine=claude`);
  });

  it('saves Max Concurrent as it is typed — on blur, and on Enter — and Keep Free as it is picked', async () => {
    const { sent } = await mount(machine('real wikova'));
    const input = $<HTMLInputElement>('.rd-max-concurrent input');
    expect(input.value).toBe('12');

    await typeNumber(input, '8', 'blur');
    expect(sent).toEqual([{ method: 'PATCH', path: `/runners/${RUNNER_ID}`, body: { maxConcurrent: 8 } }]);
    // Past the ceiling is the ceiling, not an error.
    await typeNumber($<HTMLInputElement>('.rd-max-concurrent input'), '99', 'enter');
    expect(sent.at(-1)).toEqual({ method: 'PATCH', path: `/runners/${RUNNER_ID}`, body: { maxConcurrent: 64 } });

    expect(text($('.rd-keep-free'))).toBe('Off');
    const offered = await keepFreeOptions();
    expect(offered.map(text)).toEqual(['Off', '10 GB', '20 GB', '50 GB']);
    await click(offered[2]);
    expect(sent.at(-1)).toEqual({ method: 'PATCH', path: `/runners/${RUNNER_ID}`, body: { minFreeDiskMb: 20480 } });
    expect(sent).toHaveLength(3);
  });

  it('shows a floor set to something else as it is, and Off clears it', async () => {
    const { sent } = await mount(machine('real wikova', { minFreeDiskMb: 15000 }));
    expect(text($('.rd-keep-free'))).toBe('15 GB');
    const offered = await keepFreeOptions();
    expect(offered.map(text)).toEqual(['Off', '10 GB', '15 GB', '20 GB', '50 GB']);
    await click(offered[0]);
    expect(sent).toEqual([{ method: 'PATCH', path: `/runners/${RUNNER_ID}`, body: { minFreeDiskMb: null } }]);
  });

  it('draws the disk its workspaces fill first, amber from 90%', async () => {
    await mount(machine('real wikova'));
    expect(text($('.rd-disk .rd-kv-row'))).toBe('Disk187 of 197 GB used');
    expect($('.rd-disk-bar').className).toBe('rd-disk-bar warn');
    expect($<HTMLElement>('.rd-disk-bar > span').style.width).toBe('95%');
    expect(text($('.rd-capacity .rd-hint'))).toBe(
      'Max Concurrent applies to the next session it picks up — no restart. Below Keep Free, task runs stop ' +
        'being sent here and finished worktrees are cleaned up sooner.',
    );
  });

  it('says in About what the Details grid said, with Rename beside the name', async () => {
    await mount(machine('real wikova'));
    expect(about()).toEqual([
      ['Name', 'wikova', null],
      ['Hostname', 'vmi3129740', null],
      ['Version', '0.1.197', 'Latest'],
      ['Runs As', 'root', null],
      ['Repos Folder', '/root/orbit-repos', null],
      ['Last Check-in', 'just now', null],
      ['Registered', new Date(ENROLLED).toLocaleDateString([], { month: 'short', day: 'numeric' }), null],
    ]);
    expect(text($('.rd-about .rd-hint'))).toBe('Runs as root, so sessions here can’t use Bypass permissions.');
    await click(button('Rename', $('.rd-about')));
    expect(text($('.ant-modal-title'))).toBe('Rename runner');
  });

  it('says a root runner behind the release installs it when idle, and a regular user can’t update itself', async () => {
    await mount(machine('root and behind'));
    expect(about()[2]).toEqual(['Version', '0.1.190', 'installs when no turn is running']);
    expect(about()[3]).toEqual(['Runs As', 'root', null]);

    act(() => root?.unmount());
    host?.remove();
    await mount(machine('not root and behind'));
    expect(about()[2]).toEqual(['Version', '0.1.190', 'Can’t update itself']);
    expect($('.rd-about small').className).toBe('warn');
    expect(about()[3]).toEqual(['Runs As', 'regular user', null]);
    expect(document.body.querySelector('.rd-about .rd-hint')).toBeNull();
  });

  it('keeps Rename, Rotate token and Delete in Actions — Max Concurrent moved to Capacity', async () => {
    const { sent } = await mount(machine('real wikova'));
    await click(button('Actions'));
    const menu = $('.ant-dropdown-menu');
    expect($$('.ant-dropdown-menu-item', menu).map(text)).toEqual(['Rename', 'Rotate token', 'Delete']);
    // Rotate token asks, then shows the new token once — the Runners list's own dialogs.
    await click($$('.ant-dropdown-menu-item', menu)[1]);
    const confirm = $('.ant-modal-confirm');
    expect(text($('.ant-modal-confirm-title', confirm))).toBe('Rotate token for “wikova”?');
    await click(button('Rotate token', confirm));
    expect(sent).toEqual([{ method: 'POST', path: `/runners/${RUNNER_ID}/rotate-token` }]);
    expect(text($('.runner-token-box'))).toBe('orbit_rt_fresh');
  });

  it('counts each workspace’s running sessions on its row', async () => {
    await mount(machine('real wikova'), [{ workspaceId: 'ws-orbit', running: 4 }]);
    const rows = $$('.rd-workspace-row').map((row) => [
      text($('.rd-workspace-name', row)),
      text(row.querySelector('.rd-workspace-running')),
    ]);
    expect(rows).toEqual([
      ['orbit', '4 running'],
      ['wikova-develop', null],
      ['wikova-prod', null],
    ]);
  });

  it('the Mac mini, offline: when it was last seen, how to wake it, and the command that updates it', async () => {
    await mount(machine('real longdeMac-mini.local'));
    expect(text($('.rd-metaline > span'))).toMatch(/^Offline · last seen /);
    expect(cards().map(({ tone, title, action }) => [tone, title, action])).toEqual([
      ['idle', 'Offline for 14 days', null],
      ['warn', 'Can’t update itself', 'Copy Command'],
    ]);
    expect(cards()[0].detail).toBe('Start the runner on that machine — it reconnects within 30 seconds.');
    // Nothing on it can be updated or re-read from here while it is away, and the page says why.
    expect($$('.rd-engines button').map(text)).toEqual([]);
    expect(text($('.rd-engines .rd-hint'))).toBe('Signing in and updating need the runner online.');
    expect(about()[2]).toEqual(['Version', '0.1.155', 'Can’t update itself']);
  });
});
