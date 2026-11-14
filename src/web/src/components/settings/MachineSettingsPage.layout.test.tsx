// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MACHINE_RESOURCES_CAPABILITY, type RunnerResourcesAnswer } from '@orbit/shared';
import type { Runner } from '../TasksSidePanel';
import type { RunnerAttentionInput } from '../../lib/runnerAttention';
import cases from '../../lib/runnerAttention.cases.json';
import { MachineSettingsPage } from './MachineSettingsPage';
import { SettingsWorkspacePage } from './WorkspaceSettingsPage';
import { ToastViewport } from '../ToastViewport';
import { clearToasts } from '../../lib/toastStore';

/**
 * A machine's Settings page as board-3 lays it out (docs/mocks/settings-redesign): one column — the
 * name with its status pill and ⋯, Needs Attention, then Engines, Capacity, the workspaces on it
 * (listed and linked only), About and Delete. Mounted over runnerAttention.cases.json's machines (wikova, the offline Mac
 * mini, and one with everything wrong at once), so every sentence asserted is the rule's own.
 */

vi.mock('../../api', async (original) => ({
  ...(await original<typeof import('../../api')>()),
  api: vi.fn(),
  // Called inside api.ts, where a mock of the exported `api` can't reach.
  cleanUpWorkspaceRepo: vi.fn(),
}));
vi.mock('../../lib/clipboard', () => ({ copyText: vi.fn(async () => true) }));
const { api, cleanUpWorkspaceRepo } = await import('../../api');
const { copyText } = await import('../../lib/clipboard');
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

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let scrolledTo: Element[] = [];
/** What /dl/version.json publishes: the mounted case's latest release. */
let published: string | null = null;
/** What GET /runners/:id/resources answers. */
let resourcesAnswer: RunnerResourcesAnswer | null = null;

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
  // The Actions menu measures its button, and jsdom ships no layout to measure.
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
  act(() => {
    clearToasts();
    root?.unmount();
  });
  host?.remove();
  root = host = null;
  apiMock.mockReset();
  vi.mocked(cleanUpWorkspaceRepo).mockReset();
  vi.mocked(copyText).mockClear();
  scrolledTo = [];
  published = null;
  resourcesAnswer = null;
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
    if (path === `/runners/${RUNNER_ID}/resources`) return resourcesAnswer ?? { at: null, latest: null, samples: [] };
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
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/settings/machines/${RUNNER_ID}`]}>
          <Routes>
            <Route path="/settings/machines/:id" element={<MachineSettingsPage />} />
            {/* Where a workspace row and Add workspace go: the workspace's own Settings page. */}
            <Route path="/settings/workspaces/:id" element={<SettingsWorkspacePage />} />
            <Route path="*" element={<Arrived />} />
          </Routes>
          <ToastViewport />
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
const $$ = (selector: string, within: ParentNode = document.body) => [
  ...within.querySelectorAll<HTMLElement>(selector),
];
const text = (el: Element | null | undefined) => el?.textContent?.trim() ?? null;
const click = async (el: HTMLElement) => {
  await act(async () => el.click());
  await settle();
};
/** A mouse press as a browser delivers it — pointer and mouse down and up, then the click — which a
 *  list option needs before it takes a click as a choice rather than a keyboard activation. */
const press = async (el: HTMLElement) => {
  await act(async () => {
    const init = { bubbles: true, cancelable: true, button: 0, buttons: 1, detail: 1 };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mousedown', init));
    el.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0 }));
  });
  await settle();
};
/** A dialog's name and description, as assistive technology reads them. */
const nameOf = (el: Element) => text(document.getElementById(el.getAttribute('aria-labelledby') ?? ''));
const descriptionOf = (el: Element) => text(document.getElementById(el.getAttribute('aria-describedby') ?? ''));
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
/** Each Resources tile: which figure, and everything it says. */
const tiles = () => $$('.machine-res-tile').map((tile) => [tile.dataset.resource, text(tile)]);
const sectionTitles = () => $$('.machine-page .settings-section-title').map(text);
/** About's rows: the label, the value's own text, and the note beside it. */
const about = () =>
  $$('.machine-section-about .settings-row').map((row) => {
    const value = $('.machine-about-value', row).cloneNode(true) as HTMLElement;
    const note = text(value.querySelector('small'));
    value.querySelectorAll('small, button').forEach((el) => el.remove());
    return [text($('.settings-row-title', row)), text(value), note];
  });
/** A Capacity row by its title. */
const capacityRow = (title: string) => {
  const found = $$('.machine-section-capacity .settings-row').find((row) => text($('.settings-row-title', row)) === title);
  if (!found) throw new Error(`no Capacity row ${title}`);
  return found;
};
/** Opens the header's ⋯ and reads what it holds. */
async function openActions() {
  await click($('.machine-more'));
  return $$('[role="menuitem"]', $('[role="menu"]'));
}

/** Types into a number field the way a person does: the text changes, then focus leaves or Enter is
 *  pressed. */
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
  await click($('[role="combobox"][aria-label="Keep Free"]'));
  return $$('[role="listbox"] [role="option"]');
}

describe('a runner’s page, laid out as web.png', () => {
  it('puts Needs Attention under the header, then Engines, Capacity, Workspaces, About and Delete in one column', async () => {
    await mount(machine('real wikova'));
    const page = $('.machine-page');
    expect([...page.children].map((el) => el.className)).toEqual([
      'machine-head',
      'rd-attention machine-attention',
      'settings-section machine-section-resources',
      'settings-section machine-section-engines',
      'machine-capacity',
      'settings-section machine-section-workspaces',
      'settings-section machine-section-about',
      'settings-section machine-section-delete',
    ]);
    expect($('.rd-attention').getAttribute('aria-label')).toBe('Needs Attention');
    expect(sectionTitles()).toEqual([
      'Resources',
      'Engines',
      'Capacity',
      'Workspaces on this machine',
      'About This Runner',
      'Delete machine',
    ]);
    // The header: its name, a status pill with how many of its sessions run, and who it is on one line.
    expect(text($('.machine-title'))).toBe('wikova');
    expect(text($('[data-testid="machine-status"]'))).toBe('Online · 4 of 12 running');
    // Amber: something on it needs a person (the nav's dot says the same).
    expect($('[data-testid="machine-status"]').className).toContain('machine-pill--attention');
    expect(text($('.machine-metaline'))).toBe('vmi3129740 · v0.1.197 · Last Check-in just now');
    expect(document.body.textContent).not.toContain('Details');
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

  it('keeps the disk card when Default is spent but another Claude account has room', async () => {
    await mount(machine('Claude Default spent but another signed-in account has room'));
    expect(cards().map(({ title }) => title)).toEqual(['Disk 92% full']);
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
    expect(document.body.textContent).toContain('Command copied');

    // Set a Reserve…: Capacity comes into view with Keep Free focused.
    await click(button('Set a Reserve…'));
    expect(scrolledTo).toEqual([$('.machine-capacity')]);
    expect($('.rd-keep-free').contains(document.activeElement)).toBe(true);

    // Repair: asks first, in a session merge bar's words, then repairs through the first workspace.
    await click(button('Repair'));
    const confirm = $('[role="alertdialog"]');
    expect(nameOf(confirm)).toBe('Clean up this checkout?');
    expect(descriptionOf(confirm)).toContain('Orbit will save everything /srv/app currently holds');
    await click(button('Save and clean up', confirm));
    expect(sent.at(-1)).toEqual({ method: 'POST', path: '/workspaces/ws-app/repo-cleanup' });

    // Sign In: on that engine's own row in Engines, without leaving the page — the row comes into
    // view with its sign-in open.
    await click(button('Sign In'));
    expect(document.querySelector('[data-testid="arrived"]')).toBeNull();
    const claude = $('.machine-section-engines [data-engine="claude"]');
    expect(claude.className).toContain('focused');
    expect(scrolledTo.at(-1)).toBe(claude);
    expect(text($('.re-panel .rsi-btn', claude))).toBe('Sign in to Claude Code');
  });

  it('reads Max Concurrent as a meter, changes it from Edit in a dialog, and Keep Free as it is picked', async () => {
    const { sent } = await mount(machine('real wikova'));
    // Its use of the limit: `4 of 12 running` and a bar across the row, amber once every slot is taken.
    const row = capacityRow('Max Concurrent');
    expect(text($('.machine-meter-value', row))).toBe('4 of 12 running');
    expect($('.machine-meter-bar', row).className).toBe('rd-disk-bar machine-meter-bar');
    expect($<HTMLElement>('.machine-meter-bar > span', row).style.width).toBe('33%');
    const value = $<HTMLButtonElement>('.machine-max-edit', row);
    expect(text(value)).toBe('Edit');
    expect(value.getAttribute('aria-label')).toBe('Edit Max Concurrent');
    expect(document.querySelector('.rd-max-concurrent')).toBeNull();

    // Cancel sends nothing.
    await click(value);
    expect($<HTMLInputElement>('.rd-max-concurrent input').value).toBe('12');
    await typeNumber($<HTMLInputElement>('.rd-max-concurrent input'), '5', 'blur');
    await click(button('Cancel'));
    expect(sent).toEqual([]);
    // Save sends what was typed.
    await click($('.machine-max-edit'));
    expect($<HTMLInputElement>('.rd-max-concurrent input').value).toBe('12');
    await typeNumber($<HTMLInputElement>('.rd-max-concurrent input'), '8', 'blur');
    await click(button('Save'));
    expect(sent).toEqual([{ method: 'PATCH', path: `/runners/${RUNNER_ID}`, body: { maxConcurrent: 8 } }]);
    // There is no ceiling: a big machine keeps what is typed, and Enter saves too.
    await click($('.machine-max-edit'));
    await typeNumber($<HTMLInputElement>('.rd-max-concurrent input'), '99', 'enter');
    expect(sent.at(-1)).toEqual({ method: 'PATCH', path: `/runners/${RUNNER_ID}`, body: { maxConcurrent: 99 } });

    expect(text($('.rd-keep-free'))).toBe('Off');
    const offered = await keepFreeOptions();
    expect(offered.map(text)).toEqual(['Off', '10 GB', '20 GB', '50 GB']);
    await press(offered[2]);
    expect(sent.at(-1)).toEqual({ method: 'PATCH', path: `/runners/${RUNNER_ID}`, body: { minFreeDiskMb: 20480 } });
    expect(sent).toHaveLength(3);
  });

  it('fills Max Concurrent’s bar amber once every slot is taken', async () => {
    await mount(machine('real wikova', { activeSessions: 12 }));
    expect(text($('.machine-meter-value', capacityRow('Max Concurrent')))).toBe('12 of 12 running');
    expect($('.machine-meter-bar', capacityRow('Max Concurrent')).className).toContain('warn');
    expect($<HTMLElement>('.machine-meter-bar > span', capacityRow('Max Concurrent')).style.width).toBe('100%');
  });

  it('shows a floor set to something else as it is, and Off clears it', async () => {
    const { sent } = await mount(machine('real wikova', { minFreeDiskMb: 15000 }));
    expect(text($('.rd-keep-free'))).toBe('15 GB');
    const offered = await keepFreeOptions();
    expect(offered.map(text)).toEqual(['Off', '10 GB', '15 GB', '20 GB', '50 GB']);
    await press(offered[0]);
    expect(sent).toEqual([{ method: 'PATCH', path: `/runners/${RUNNER_ID}`, body: { minFreeDiskMb: null } }]);
  });

  it('a runner that reads no resources: Update runner for CPU and memory, the disk its workspaces fill first, amber from 90%', async () => {
    await mount(machine('real wikova'));
    expect(text($('.machine-section-resources .machine-section-note'))).toBe('Disk is read from your workspaces');
    expect(tiles()).toEqual([
      ['cpu', 'CPUUpdate runnerThis runner predates CPU readings.'],
      ['mem', 'MemoryUpdate runnerThis runner predates memory readings.'],
      ['disk', 'Disk95%187 of 197 GB used · 9.4 GB free'],
    ]);
    expect($('[data-resource="disk"]').className).toBe('machine-res-tile warn');
    expect($$('.machine-res-spark')).toEqual([]);
    // Capacity keeps the two settings; the disk is a reading, under Resources.
    expect($$('.machine-section-capacity .settings-row-title').map(text)).toEqual(['Max Concurrent', 'Keep Free']);
    expect(text($('.machine-section-capacity .rd-hint'))).toBe(
      'Max Concurrent applies to the next session it picks up — no restart. Below Keep Free, task runs stop ' +
        'being sent here and finished worktrees are cleaned up sooner.',
    );
  });

  it('a runner that reads its resources: each figure large, its hour under it, memory amber from 90%', async () => {
    const at = new Date(NOW - 20_000).toISOString();
    const GB = 1024 ** 3;
    resourcesAnswer = {
      at,
      latest: {
        cpuPercent: 38.4, cpuCores: 8, load1: 3.04, memTotalBytes: 32 * GB, memAvailableBytes: 2 * GB,
        diskTotalBytes: 926 * GB, diskFreeBytes: 198 * GB,
      },
      samples: [
        { at: new Date(NOW - 50 * 60_000).toISOString(), cpu: 20, mem: 90, disk: 78 },
        { at: new Date(NOW - 49.5 * 60_000).toISOString(), cpu: 25, mem: 91, disk: 78 },
        // Unheard for most of an hour: the line breaks.
        { at: new Date(NOW - 50_000).toISOString(), cpu: 30, mem: 92, disk: 79 },
        { at, cpu: 38.4, mem: 94, disk: 79 },
      ],
    };
    await mount(machine('real wikova', { capabilities: [MACHINE_RESOURCES_CAPABILITY] }));
    expect(text($('.machine-section-resources .machine-section-note'))).toBe('Live · every 30 s · last hour');
    expect(tiles()).toEqual([
      ['cpu', 'CPU38%8 cores · load 3.0'],
      ['mem', 'Memory94%30 of 32 GB usedNearly full — new sessions may be slow to start.'],
      ['disk', 'Disk79%728 of 926 GB used · 198 GB free'],
    ]);
    expect($('[data-resource="cpu"]').className).toBe('machine-res-tile');
    expect($('[data-resource="mem"]').className).toBe('machine-res-tile warn');
    const runs = $$('polyline', $('[data-resource="cpu"]'));
    expect(runs).toHaveLength(2);
    expect(runs[0].getAttribute('points')).toBe('40.0,35.2 42.0,33.0');
  });

  it('an offline machine shows its last reading in grey, and when it came', async () => {
    resourcesAnswer = {
      at: new Date(NOW - 14 * 60_000).toISOString(),
      latest: { cpuPercent: 12, cpuCores: 4 },
      samples: [],
    };
    await mount(machine('real wikova', { capabilities: [MACHINE_RESOURCES_CAPABILITY], online: false }));
    expect(text($('.machine-section-resources .machine-section-note'))).toBe('Offline · last reading 14m ago');
    expect($('[data-resource="cpu"]').className).toBe('machine-res-tile off');
    expect(tiles()[0]).toEqual(['cpu', 'CPU12%4 cores']);
    expect(tiles()[1]).toEqual(['mem', 'Memory—No reading yet']);
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
    expect(text($('.machine-section-about .rd-hint'))).toBe('Runs as root, so sessions here can’t use Bypass permissions.');
    await click(button('Rename', $('.machine-section-about')));
    expect(nameOf($('[role="dialog"]'))).toBe('Rename runner');
  });

  it('says a root runner behind the release installs it when idle, and a regular user can’t update itself', async () => {
    await mount(machine('root and behind'));
    expect(about()[2]).toEqual(['Version', '0.1.190', 'installs when no turn is running']);
    expect(about()[3]).toEqual(['Runs As', 'root', null]);

    act(() => root?.unmount());
    host?.remove();
    await mount(machine('not root and behind'));
    expect(about()[2]).toEqual(['Version', '0.1.190', 'Can’t update itself']);
    expect($('.machine-section-about small').className).toBe('warn');
    expect(about()[3]).toEqual(['Runs As', 'regular user', null]);
    expect(document.body.querySelector('.machine-section-about .rd-hint')).toBeNull();
  });

  it('keeps the machine’s actions in the header’s ⋯: Rename, the updates, Rotate token and Delete', async () => {
    const { sent } = await mount(machine('real wikova'));
    const items = await openActions();
    // Update runner now only where a check can change something: wikova runs the latest release.
    expect(items.map(text)).toEqual(['Rename', 'Update engines', 'Refresh models', 'Rotate token', 'Delete']);
    // Rotate token asks, then shows the new token once — the Runners list's own dialogs.
    await click(items[3]);
    const confirm = $('[role="alertdialog"]');
    expect(nameOf(confirm)).toBe('Rotate token for “wikova”?');
    await click(button('Rotate token', confirm));
    expect(sent).toEqual([{ method: 'POST', path: `/runners/${RUNNER_ID}/rotate-token` }]);
    expect(text($('.runner-token-box'))).toBe('orbit_rt_fresh');
  });

  it('renames from the ⋯, and deletes from it or from Delete machine once asked', async () => {
    const { sent } = await mount(machine('real wikova'));
    await click((await openActions())[0]);
    expect(nameOf($('[role="dialog"]'))).toBe('Rename runner');
    await click(button('Cancel', $('[role="dialog"]')));

    await click((await openActions()).at(-1)!);
    let confirm = $('[role="alertdialog"]');
    expect(nameOf(confirm)).toBe('Delete “wikova”?');
    await click(button('Cancel', confirm));
    expect(sent).toEqual([]);

    await click(button('Delete', $('.machine-section-delete')));
    confirm = $('[role="alertdialog"]');
    expect(descriptionOf(confirm)).toBe(
      'This removes the runner and its workspaces from your account. Re-register the machine to add it back.',
    );
    await click(button('Delete', confirm));
    expect(sent).toEqual([{ method: 'DELETE', path: `/runners/${RUNNER_ID}` }]);
    // With no machine left, Settings' General.
    expect(text($('[data-testid="arrived"]'))).toBe('/settings/general');
  });

  it('lists the workspaces on it, each a link to its own page, with its folder and running sessions', async () => {
    await mount(machine('real wikova'), [{ workspaceId: 'ws-orbit', running: 4 }]);
    const rows = $$('.machine-workspace-row').map((row) => [
      text($('.settings-row-title', row)),
      row.getAttribute('href'),
      text(row.querySelector('.rd-workspace-running')),
    ]);
    expect(rows.map(([name, , running]) => [name, running])).toEqual([
      ['orbit', '4 running'],
      ['wikova-develop', null],
      ['wikova-prod', null],
    ]);
    expect(rows.every(([, href]) => href?.startsWith('/settings/workspaces/'))).toBe(true);
    // Listed and linked only: no workspace form on this page.
    expect(document.querySelector('.rd-workspace-form')).toBeNull();
    expect(document.querySelector('input[aria-label="Working directory"]')).toBeNull();
    // A row opens that workspace's own Settings page.
    await click($('.machine-workspace-row'));
    expect(text($('.settings-header-title'))).toBe('orbit');
    expect($$('.settings-section-title').map(text)).toEqual(['Location', 'Sessions', 'Agent environment', 'Danger zone']);
  });

  it('the Mac mini, offline: when it was last seen, how to wake it, and the command that updates it', async () => {
    await mount(machine('real longdeMac-mini.local'));
    expect(text($('[data-testid="machine-status"]'))).toMatch(/^Offline · last seen /);
    expect($('[data-testid="machine-status"]').className).toContain('machine-pill--offline');
    // Offline, its count of running sessions is stale, so Max Concurrent has just its limit and no bar.
    expect(text($('.machine-meter-value', capacityRow('Max Concurrent')))).toBe('16');
    expect(capacityRow('Max Concurrent').querySelector('.machine-meter-bar')).toBeNull();
    expect(cards().map(({ tone, title, action }) => [tone, title, action])).toEqual([
      ['idle', 'Offline for 14 days', null],
      ['warn', 'Can’t update itself', 'Copy Command'],
    ]);
    expect(cards()[0].detail).toBe('Start the runner on that machine — it reconnects within 30 seconds.');
    // Nothing on it can be updated, re-read or signed in from here while it is away, and the page
    // says why.
    expect($$('.machine-section-engines button').filter((b) => !(b as HTMLButtonElement).disabled).map(text)).toEqual([]);
    expect(text($('.machine-section-engines .rd-hint'))).toBe('Signing in and updating need the runner online.');
    expect(about()[2]).toEqual(['Version', '0.1.155', 'Can’t update itself']);
  });
});

// docs/mocks/first-workspace-in-conversation 02 ("不再沉默", the machine page) and rule 10 of 04: a
// machine where no coding CLI is signed in says so in one card, with a workspace or without one.
describe('a machine where no coding CLI is signed in', () => {
  it('orbit@austin: one card for it, whose Sign In opens Claude Code’s, and none per login', async () => {
    await mount(machine('no CLI signed in and no workspace'));
    expect(cards()).toEqual([
      {
        tone: 'bad',
        title: 'No coding CLI is signed in',
        detail: 'Nothing can run on this machine until one is. Claude Code and Codex are installed here.',
        action: 'Sign In',
      },
    ]);
    await click(button('Sign In'));
    expect(document.querySelector('[data-testid="arrived"]')).toBeNull();
    const claude = $('.machine-section-engines [data-engine="claude"]');
    expect(claude.className).toContain('focused');
    expect(scrolledTo.at(-1)).toBe(claude);
    expect(text($('.re-panel .rsi-btn', claude))).toBe('Sign in to Claude Code');
  });

  it('is still the one card while its workspaces run on those logins', async () => {
    await mount(machine('no CLI signed in and its workspaces run on those logins'));
    expect(cards().map(({ tone, title, action }) => [tone, title, action])).toEqual([
      ['bad', 'No coding CLI is signed in', 'Sign In'],
    ]);
  });

  it('is not raised where a workspace runs on a key, which needs no sign-in', async () => {
    await mount(machine('no CLI signed in, but a workspace runs on a DeepSeek key'));
    expect(document.querySelector('.rd-attention')).toBeNull();
  });
});

// A machine with no workspace (board rule 12): the way in is a session, which asks for the folder as it
// starts. The form stays, a step back, for whoever wants to set one up by hand.
describe('the Workspaces section of a machine with none', () => {
  const addWorkspace = () => button('Add workspace');

  it('says Start a session, the same next step as the approval page and Add a runner', async () => {
    await mount(machine('no CLI signed in and no workspace'));
    expect(text($('.rd-empty'))).toBe(
      'No workspaces on orbit@austin yet. Start a session and pick the folder it works in as you go — or add one here.Start a session',
    );
    await click(button('Start a session', $('.rd-empty')));
    expect(text($('[data-testid="arrived"]'))).toBe(`/runners/${RUNNER_ID}/new`);
  });

  it('names the machine as the app does', async () => {
    await mount(machine('no CLI signed in and no workspace', { displayName: 'Austin box' }));
    expect(text($('.rd-empty'))).toContain('No workspaces on Austin box yet.');
  });

  it('Add workspace, a quiet button in the section’s head, opens New workspace with this machine picked', async () => {
    await mount(machine('no CLI signed in and no workspace'));
    expect(addWorkspace().className).toContain('orbit-button-default');
    expect(button('Start a session').className).toContain('orbit-button-primary');
    await click(addWorkspace());
    expect(text($('.settings-header-title'))).toBe('New workspace');
    expect(text($('.settings-header-description'))).toBe('On orbit@austin · Change machine');
    expect($('input[aria-label="Name"]')).toBeTruthy();
  });

  it('with workspaces, nothing says Start a session', async () => {
    await mount(machine('real wikova'));
    expect(addWorkspace()).toBeTruthy();
    expect($$('button').some((b) => text(b) === 'Start a session')).toBe(false);
  });
});

// The Add workspace form, reached from this page (New workspace with this machine picked): a workspace
// made here says which folder it runs in (P0 of docs/mocks/first-workspace-in-conversation, 04). A
// saved one is edited on its own page, row by row.
describe('the Add workspace form', () => {
  const field = (label: string) => $<HTMLInputElement>(`input[aria-label="${label}"]`);
  const submit = (label: string) => button(label) as HTMLButtonElement;
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await settle();
  };
  const pressEnter = async (input: HTMLInputElement) => {
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await settle();
  };

  it('creates a workspace only once it has a name and a working directory', async () => {
    const { sent } = await mount(machine('no CLI signed in and no workspace'));
    await click(button('Add workspace'));
    expect(field('Working directory').placeholder).toBe('/path/to/project on the runner');
    expect(submit('Create').disabled).toBe(true);

    await type(field('Name'), 'app');
    expect(submit('Create').disabled).toBe(true);
    // Enter in the name creates nothing while the folder is missing.
    await pressEnter(field('Name'));
    await type(field('Working directory'), '   ');
    expect(submit('Create').disabled).toBe(true);
    expect(sent).toEqual([]);

    await type(field('Working directory'), '~/code/app');
    expect(submit('Create').disabled).toBe(false);
    await click(submit('Create'));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: 'POST',
      path: '/workspaces',
      body: { name: 'app', workDir: '~/code/app', runnerId: RUNNER_ID },
    });
  });

  it('a saved workspace’s working directory, emptied on its page, goes back to what is saved and sends nothing', async () => {
    const { sent } = await mount(machine('real wikova'));
    await click($('[data-workspace-id="ws-orbit"]'));
    expect(field('Working directory').value).toBe('/root/orbit');
    await type(field('Working directory'), '');
    await act(async () => {
      field('Working directory').dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    await settle();
    expect(sent).toEqual([]);
    expect(field('Working directory').value).toBe('/root/orbit');
  });
});
