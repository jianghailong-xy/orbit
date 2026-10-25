// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunnerSelfUpdate } from '@orbit/shared';
import type { Runner } from '../components/TasksSidePanel';
import { runnerAttention, runnerCanUpdateNow, type RunnerAttentionInput } from '../lib/runnerAttention';
import cases from '../lib/runnerAttention.cases.json';
import { RunnerDetailPage } from './RunnerDetailPage';
import { ToastViewport } from '../components/ToastViewport';
import { clearToasts } from '../lib/toastStore';

/**
 * A runner that reports where its updates of itself stand (`selfUpdate`) gets the card its state
 * calls for, and one too old to report it keeps the card it always had. The states are
 * runnerAttention.cases.json's own machines — the file OrbitKit runs against its port — so what is
 * asserted here is what the case file says, plus everything the file cannot carry: each card's
 * sentence and action, About's line for the states that raise no card, the last update, and
 * Update Runner Now.
 */

vi.mock('../api', async (original) => ({
  ...(await original<typeof import('../api')>()),
  api: vi.fn(),
}));
vi.mock('../lib/clipboard', () => ({ copyText: vi.fn(async () => true) }));
const { api } = await import('../api');
const { copyText } = await import('../lib/clipboard');
const apiMock = vi.mocked(api);

interface AttentionCase {
  name: string;
  input: RunnerAttentionInput;
}
const CASES = cases as unknown as AttentionCase[];
const caseNamed = (prefix: string): AttentionCase => {
  const found = CASES.filter((c) => c.name.startsWith(prefix));
  if (found.length !== 1) throw new Error(`runnerAttention.cases.json has ${found.length} cases starting ${prefix}`);
  return found[0];
};

const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';
const NOW = caseNamed('selfUpdate failed and behind').input.nowMs;

const inputOf = (prefix: string): RunnerAttentionInput => caseNamed(prefix).input;

/** A case's input with its runner's report replaced — `undefined` removes it, as an older runner
 *  sends it. */
function reporting(prefix: string, report: RunnerSelfUpdate | null | undefined): RunnerAttentionInput {
  const { input } = caseNamed(prefix);
  const runner = { ...input.runner };
  if (report === undefined) delete runner.selfUpdate;
  else runner.selfUpdate = report;
  return { ...input, runner };
}

/** The one card a case raises, offline aside. */
function cardOf(input: RunnerAttentionInput) {
  const items = runnerAttention(input).filter((item) => item.kind !== 'offline');
  expect(items).toHaveLength(1);
  return items[0];
}

// MARK: the rule

describe('each selfUpdate state, as the rule words it', () => {
  it('dirNotWritable: the folder it can’t write, and the command that moves the install', () => {
    const card = cardOf(inputOf('selfUpdate dirNotWritable and behind'));
    expect(card.title).toBe('Install folder isn’t writable');
    expect(card.short).toBe('Install folder isn’t writable');
    expect(card.detail).toBe(
      'It can’t write to /usr/local/bin, so it can’t replace its own binary — still on 0.1.190, latest is 0.1.197. ' +
        'On that machine, run sudo orbit upgrade once; after that it updates itself.',
    );
    expect(card.action).toEqual({ kind: 'copyCommand', command: 'sudo orbit upgrade' });
    expect(card.params).toEqual({
      version: '0.1.190',
      latest: '0.1.197',
      state: 'dirNotWritable',
      installDir: '/usr/local/bin',
    });
    // A runner that didn't say which folder.
    expect(cardOf(reporting('selfUpdate dirNotWritable and behind', { state: 'dirNotWritable' })).detail).toBe(
      'It can’t write to its install folder, so it can’t replace its own binary — still on 0.1.190, latest is ' +
        '0.1.197. On that machine, run sudo orbit upgrade once; after that it updates itself.',
    );
  });

  it('disabledByEnv: what turned it off, and how to turn it back on where there is a switch', () => {
    const card = cardOf(inputOf('selfUpdate disabledByEnv and behind'));
    expect(card.title).toBe('Updates are turned off');
    expect(card.short).toBe('Updates are turned off');
    expect(card.detail).toBe(
      'ORBIT_NO_SELFUPDATE is set, so it doesn’t update itself — still on 0.1.190, latest is 0.1.197. ' +
        'To turn them back on, remove ORBIT_NO_SELFUPDATE from the runner’s environment and restart it — ' +
        'on a Mac, opening the latest Orbit app does this.',
    );
    expect(card.action).toBeUndefined();
    expect(card.params).toEqual({
      version: '0.1.190',
      latest: '0.1.197',
      state: 'disabledByEnv',
      reason: 'ORBIT_NO_SELFUPDATE is set',
    });
    // A development build or a platform with no release has no switch: the reason alone.
    const off = (reason?: string) =>
      cardOf(reporting('selfUpdate disabledByEnv and behind', { state: 'disabledByEnv', ...(reason ? { reason } : {}) }))
        .detail;
    expect(off('development build')).toBe(
      'Development build, so it doesn’t update itself — still on 0.1.190, latest is 0.1.197.',
    );
    expect(off('no release is published for linux/riscv64')).toBe(
      'No release is published for linux/riscv64, so it doesn’t update itself — still on 0.1.190, latest is 0.1.197.',
    );
    expect(off()).toBe('Its updater is switched off, so it doesn’t update itself — still on 0.1.190, latest is 0.1.197.');
  });

  it('failed: the runner’s own words, and Update Runner Now', () => {
    const card = cardOf(inputOf('selfUpdate failed and behind'));
    expect(card.title).toBe('Runner update failed');
    expect(card.short).toBe('Runner update failed');
    expect(card.detail).toBe(
      'Installing 0.1.197: sha256 mismatch for orbit-linux-amd64.gz. Still on 0.1.190, latest is 0.1.197. ' +
        'It retries every 10 min — Update Runner Now tries again right away.',
    );
    expect(card.action).toEqual({ kind: 'updateRunner' });
    expect(card.params).toEqual({
      version: '0.1.190',
      latest: '0.1.197',
      state: 'failed',
      reason: 'installing 0.1.197: sha256 mismatch for orbit-linux-amd64.gz',
    });
    // Its own full stop is not doubled, and no reason at all still makes a sentence.
    const failed = (reason?: string) =>
      cardOf(reporting('selfUpdate failed and behind', { state: 'failed', ...(reason ? { reason } : {}) })).detail;
    expect(failed('cannot read the release to install: 502 Bad Gateway.')).toBe(
      'Cannot read the release to install: 502 Bad Gateway. Still on 0.1.190, latest is 0.1.197. ' +
        'It retries every 10 min — Update Runner Now tries again right away.',
    );
    expect(failed()).toBe(
      'Its last update didn’t go through. Still on 0.1.190, latest is 0.1.197. ' +
        'It retries every 10 min — Update Runner Now tries again right away.',
    );
  });

  it('waitingForIdle, heldByRollout and enabled: no card, though not root and behind', () => {
    for (const prefix of [
      'selfUpdate waitingForIdle and behind',
      'selfUpdate heldByRollout and behind',
      'selfUpdate enabled and behind',
    ]) {
      const input = inputOf(prefix);
      expect(input.runner.runsAsRoot, prefix).toBe(false);
      expect(runnerAttention(input), prefix).toEqual([]);
    }
  });

  it('a runner that reports nothing keeps the card it always had', () => {
    for (const report of [undefined, null]) {
      const card = cardOf(reporting('selfUpdate dirNotWritable and behind', report));
      expect(card.title).toBe('Can’t update itself');
      expect(card.detail).toBe(
        'It runs as a regular user, so it can’t replace its own binary — still on 0.1.190, latest is 0.1.197. ' +
          'On that machine, run sudo orbit upgrade.',
      );
      expect(card.action).toEqual({ kind: 'copyCommand', command: 'sudo orbit upgrade' });
      expect(card.params).toEqual({ version: '0.1.190', latest: '0.1.197' });
    }
    // …and a root one still gets none: it installs the release itself.
    const root = reporting('selfUpdate failed and behind', undefined);
    expect(root.runner.runsAsRoot).toBe(true);
    expect(runnerAttention(root)).toEqual([]);
  });

  it('offers Update Runner Now where a check can change something, and only while it is online', () => {
    const can = (input: RunnerAttentionInput) => runnerCanUpdateNow(input.runner, NOW);
    expect(can(inputOf('selfUpdate failed and behind'))).toBe(true);
    expect(can(inputOf('selfUpdate enabled and behind'))).toBe(true);
    expect(can(inputOf('selfUpdate waitingForIdle and behind'))).toBe(true);
    expect(can(inputOf('selfUpdate heldByRollout and behind'))).toBe(true);
    expect(can(inputOf('selfUpdate dirNotWritable and behind'))).toBe(false);
    expect(can(inputOf('selfUpdate disabledByEnv and behind'))).toBe(false);
    expect(can(inputOf('selfUpdate failed while offline'))).toBe(false);
    expect(can(reporting('selfUpdate failed and behind', undefined))).toBe(false);
    expect(can(reporting('selfUpdate failed and behind', null))).toBe(false);
  });
});

// MARK: the page

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  // The case's latest release, as /dl/version.json publishes it.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url !== '/dl/version.json') throw new Error(`no ${url} here`);
      return { ok: true, json: async () => ({ version: '0.1.197' }) };
    }),
  );
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
  vi.mocked(copyText).mockClear();
  document.body.innerHTML = '';
});

/** The runner's page over one case's machine. Every request that changes something is collected;
 *  `refuse` is what the server says to Update Runner Now instead of taking it. */
async function mount(input: RunnerAttentionInput, refuse?: string) {
  const sent: Array<{ method: string; path: string }> = [];
  const runner = { ...input.runner, id: RUNNER_ID, enrolledAt: '2026-06-18T09:00:00Z' } as Runner;
  apiMock.mockImplementation(async (path: string, options?: { method?: string }) => {
    const method = options?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({ method, path });
      if (refuse && path.endsWith('/self-update')) throw new Error(refuse);
      return path.endsWith('/self-update') ? { requestedAt: new Date(NOW).toISOString() } : {};
    }
    if (path === '/runners') return [runner];
    return [];
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[`/runners/${RUNNER_ID}`]}>
          <Routes>
            <Route path="/runners/:id" element={<RunnerDetailPage />} />
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
const $$ = (selector: string, within: ParentNode = document.body) => [
  ...within.querySelectorAll<HTMLElement>(selector),
];
const text = (el: Element | null | undefined) => el?.textContent?.trim() ?? null;
const click = async (el: HTMLElement) => {
  await act(async () => el.click());
  await settle();
};
const cards = () =>
  $$('.rd-attention-card').map((card) => ({
    tone: card.className.replace('rd-attention-card', '').trim(),
    title: text(card.querySelector('.rd-attention-title')),
    detail: text(card.querySelector('.rd-attention-detail')),
    action: text(card.querySelector('.rd-attention-action button')),
  }));
/** About's rows: the label, the value's own text, and the note beside it. */
const about = () =>
  $$('.rd-about .rd-kv').map((row) => {
    const value = row.querySelector('.rd-kv-value')!.cloneNode(true) as HTMLElement;
    const note = text(value.querySelector('small'));
    value.querySelectorAll('small, button').forEach((el) => el.remove());
    return [text(row.querySelector('.rd-kv-label')), text(value), note];
  });
const aboutRow = (label: string) => about().find(([name]) => name === label) ?? null;
/** What About's head offers beside its title. */
const aboutActions = () => $$('.rd-about .rd-section-head button').map(text);

describe('each selfUpdate state on a runner’s page', () => {
  it('dirNotWritable: the card says which folder, and Copy Command copies the upgrade', async () => {
    await mount(inputOf('selfUpdate dirNotWritable and behind'));
    expect(cards()).toEqual([
      {
        tone: 'warn',
        title: 'Install folder isn’t writable',
        detail:
          'It can’t write to /usr/local/bin, so it can’t replace its own binary — still on 0.1.190, latest is ' +
          '0.1.197. On that machine, run sudo orbit upgrade once; after that it updates itself.',
        action: 'Copy Command',
      },
    ]);
    expect(aboutRow('Version')).toEqual(['Version', '0.1.190', 'Install folder isn’t writable']);
    // A check now would find the same folder: nothing to press but the command.
    expect(aboutActions()).toEqual([]);
    await click($$('.rd-attention-action button')[0]);
    expect(copyText).toHaveBeenCalledWith('sudo orbit upgrade');
  });

  it('disabledByEnv: the card says what turned it off and how to turn it on, with no button', async () => {
    await mount(inputOf('selfUpdate disabledByEnv and behind'));
    expect(cards()).toEqual([
      {
        tone: 'warn',
        title: 'Updates are turned off',
        detail:
          'ORBIT_NO_SELFUPDATE is set, so it doesn’t update itself — still on 0.1.190, latest is 0.1.197. ' +
          'To turn them back on, remove ORBIT_NO_SELFUPDATE from the runner’s environment and restart it — ' +
          'on a Mac, opening the latest Orbit app does this.',
        action: null,
      },
    ]);
    expect(aboutRow('Version')).toEqual(['Version', '0.1.190', 'Updates are turned off']);
    expect(aboutActions()).toEqual([]);
  });

  it('failed: the card gives the reason and Update Runner Now, which asks the runner to check now', async () => {
    const { sent } = await mount(inputOf('selfUpdate failed and behind'));
    expect(cards()).toEqual([
      {
        tone: 'warn',
        title: 'Runner update failed',
        detail:
          'Installing 0.1.197: sha256 mismatch for orbit-linux-amd64.gz. Still on 0.1.190, latest is 0.1.197. ' +
          'It retries every 10 min — Update Runner Now tries again right away.',
        action: 'Update Runner Now',
      },
    ]);
    expect(aboutRow('Version')).toEqual(['Version', '0.1.190', 'Runner update failed']);
    expect(aboutActions()).toEqual(['Update Runner Now']);

    await click($$('.rd-attention-action button')[0]);
    expect(sent).toEqual([{ method: 'POST', path: `/runners/${RUNNER_ID}/self-update` }]);
    expect(document.body.textContent).toContain(
      'Checking for a runner release now — a new one installs once no turn is running.',
    );
  });

  it('waitingForIdle: no card — About says it installs once no turn is running', async () => {
    await mount(inputOf('selfUpdate waitingForIdle and behind'));
    expect(cards()).toEqual([]);
    expect(document.querySelector('.rd-attention')).toBeNull();
    expect(aboutRow('Version')).toEqual(['Version', '0.1.190', 'installs when no turn is running']);
    expect(aboutActions()).toEqual(['Update Runner Now']);
  });

  it('heldByRollout: no card — About says the release hasn’t rolled out to it yet', async () => {
    await mount(inputOf('selfUpdate heldByRollout and behind'));
    expect(cards()).toEqual([]);
    expect(aboutRow('Version')).toEqual(['Version', '0.1.190', 'not rolled out to it yet']);
    expect(aboutActions()).toEqual(['Update Runner Now']);
  });

  it('enabled: no card, though it runs as a regular user — it installs the release itself', async () => {
    await mount(inputOf('selfUpdate enabled and behind'));
    expect(cards()).toEqual([]);
    expect(aboutRow('Version')).toEqual(['Version', '0.1.190', 'installs when no turn is running']);
    expect(aboutRow('Runs As')).toEqual(['Runs As', 'regular user', null]);
  });

  it('failed, offline: only offline — Update Runner Now waits for it to come back', async () => {
    await mount(inputOf('selfUpdate failed while offline'));
    expect(cards().map(({ tone, title, action }) => [tone, title, action])).toEqual([
      ['idle', 'Offline for 2 days', null],
    ]);
    expect(aboutRow('Version')).toEqual(['Version', '0.1.190', null]);
    expect(aboutActions()).toEqual([]);
  });

  it('dirNotWritable, offline: still says so — it is as true, and as fixable, while the machine is away', async () => {
    await mount(inputOf('selfUpdate dirNotWritable while offline'));
    expect(cards().map(({ tone, title, action }) => [tone, title, action])).toEqual([
      ['idle', 'Offline for 2 days', null],
      ['warn', 'Install folder isn’t writable', 'Copy Command'],
    ]);
  });
});

describe('the last update, and Update Runner Now from About', () => {
  it('shows when the runner last updated itself, and from which version to which', async () => {
    const input = inputOf('selfUpdate enabled and behind');
    const at = input.runner.selfUpdate!.lastUpdatedAt!;
    await mount(input);
    const when = new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    expect(aboutRow('Last Update')).toEqual(['Last Update', `${when} · 0.1.189 → 0.1.190`, null]);
    // Right under Version, where the versions are.
    expect(about().map(([label]) => label).slice(2, 4)).toEqual(['Version', 'Last Update']);
  });

  it('says none for a runner that reports but has not updated itself yet', async () => {
    await mount(inputOf('selfUpdate heldByRollout and behind'));
    expect(aboutRow('Last Update')).toEqual(['Last Update', '—', null]);
  });

  it('asks the runner to check now, and says what the server said when it would not', async () => {
    const { sent } = await mount(
      inputOf('selfUpdate waitingForIdle and behind'),
      'Runner is offline — it can only update while connected',
    );
    await click($$('.rd-about .rd-section-head button')[0]);
    expect(sent).toEqual([{ method: 'POST', path: `/runners/${RUNNER_ID}/self-update` }]);
    expect(document.body.textContent).toContain("Couldn't start the runner update");
    expect(document.body.textContent).toContain('Runner is offline — it can only update while connected');
  });
});

describe('a runner too old to report it', () => {
  it('keeps the card, the command and About’s line it always had — and offers no Update Runner Now', async () => {
    await mount(inputOf('selfUpdate null'));
    expect(cards()).toEqual([
      {
        tone: 'warn',
        title: 'Can’t update itself',
        detail:
          'It runs as a regular user, so it can’t replace its own binary — still on 0.1.190, latest is 0.1.197. ' +
          'On that machine, run sudo orbit upgrade.',
        action: 'Copy Command',
      },
    ]);
    expect(aboutRow('Version')).toEqual(['Version', '0.1.190', 'Can’t update itself']);
    expect(aboutRow('Last Update')).toBeNull();
    expect(aboutActions()).toEqual([]);
  });

  it('a root one behind still installs when idle, with no card', async () => {
    await mount(reporting('selfUpdate failed and behind', undefined));
    expect(cards()).toEqual([]);
    expect(aboutRow('Version')).toEqual(['Version', '0.1.190', 'installs when no turn is running']);
    expect(aboutRow('Last Update')).toBeNull();
    expect(aboutActions()).toEqual([]);
  });
});
