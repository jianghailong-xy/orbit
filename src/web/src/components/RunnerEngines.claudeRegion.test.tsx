// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CLAUDE_REGIONS_SOURCE_URL, type RunnerEngineHealth, type RunnerRegionView } from '@orbit/shared';
import { runnerAttention } from '../lib/runnerAttention';
import { machineChipsOf, RunnerEngines } from './RunnerEngines';
import type { Runner } from './TasksSidePanel';

/**
 * A machine whose Claude connection comes out where Anthropic doesn't offer Claude, on Machines &
 * models (docs/claude-region-check-contract.md, board 02 A): the card's attention line, no Claude
 * Code chip, the Claude Code row's badge, — for its quota, Check again where Add account was, and the
 * note with the check under it. A runner that reads no region draws what it draws today.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

// = uuidToBase62('019fc086-c7c7-7c92-8215-778ad8a6280a').
const RUNNER_ID = '33zx0JhRhJo8rd25d3qAM';

const claude: RunnerEngineHealth = {
  engine: 'claude',
  installed: true,
  auth: 'yes',
  version: '2.1.302',
  accounts: [
    { id: 'default', name: 'Personal', home: '/root/.claude', auth: 'yes' },
    { id: 'slot-2', name: 'Work', home: '/root/.orbit/claude-accounts/1e84046c', auth: 'yes' },
    { id: 'slot-3', name: 'Team', home: '/root/.orbit/claude-accounts/7b2d90aa', auth: 'no' },
  ],
};
const codex: RunnerEngineHealth = { engine: 'codex', installed: true, auth: 'yes', version: '0.164.0' };

/** Checked two and a half minutes ago: "Checked 2m ago". */
const blocked = (over: Partial<RunnerRegionView> = {}): RunnerRegionView => ({
  verdict: 'blocked',
  country: 'CN',
  regionCode: null,
  name: 'mainland China',
  viaProxy: false,
  checkedAt: new Date(Date.now() - 150_000).toISOString(),
  ...over,
});

const hpc = (over: Partial<Runner> = {}): Runner => ({
  id: RUNNER_ID,
  name: 'HPC',
  displayName: 'HPC',
  online: true,
  maxConcurrent: 16,
  activeSessions: 5,
  engines: [claude, codex],
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
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
  localStorage.clear();
});

/** The card open, as on the board, with Claude Code's accounts folded under its row unless `open`. */
function mount(runner: Runner, { open = false } = {}) {
  localStorage.setItem('orbit:providers-expanded-runners', JSON.stringify([runner.id]));
  localStorage.setItem('orbit:providers-open-accounts', JSON.stringify(open ? [`${runner.id}/claude`] : []));
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/runners') return [runner];
    if (path.endsWith('/region-check')) return { requestedAt: new Date().toISOString() };
    return {};
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['runners'], [runner]);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={['/infrastructure']}>
        <QueryClientProvider client={qc}>
          <RunnerEngines
            attentionOf={(r) => runnerAttention({ runner: r, workspaces: [], nowMs: Date.now(), latestVersion: null })}
          />
        </QueryClientProvider>
      </MemoryRouter>,
    ),
  );
  return host;
}

const claudeRow = (el: ParentNode) => el.querySelector<HTMLElement>('.re-row[data-engine="claude"]')!;
const buttons = (el: ParentNode) => [...el.querySelectorAll<HTMLButtonElement>('button')].map((b) => b.textContent?.trim());
const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();
/** A page's markup without the ids each mount generates afresh (useId, dnd-kit's live regions). */
const markup = (el: Element) =>
  el.innerHTML
    .replace(/(DndDescribedBy|DndLiveRegion)-\d+/g, '$1')
    .replace(/«[^»]+»|:r[0-9a-z]+:|_r_[0-9a-z]+_/g, 'ID');

describe('a machine blocked for the Claude region', () => {
  it('says so under the machine’s name, and draws no Claude Code chip', () => {
    const page = mount(hpc({ region: blocked() }));
    const attention = page.querySelector('.re-runner-card .runner-attention');
    expect(text(attention)).toBe('Claude Code can’t use Anthropic here');
    expect(attention?.classList.contains('warn')).toBe(true);
    const chips = [...page.querySelectorAll('.mc-chip')].map((chip) => text(chip));
    expect(chips).toEqual(['Codex']);
    expect(machineChipsOf(hpc({ region: blocked() })).map((chip) => chip.engine)).toEqual(['codex']);
  });

  it('draws the Claude Code row as board 02 A: the badge, — for its quota, Check again, the note and the check', () => {
    const row = claudeRow(mount(hpc({ region: blocked() })));
    // Its accounts stay where they are, folded under it.
    expect(row.classList.contains('re-grp')).toBe(true);
    expect(row.classList.contains('folded')).toBe(true);
    expect(text(row.querySelector('.re-meta'))).toContain('2.1.302 · 3 accounts');
    expect(text(row.querySelector('.re-status'))).toBe('Region not supported');
    expect(row.querySelector('.re-status .orbit-badge')?.className).toContain('orange');
    expect(text(row.querySelector('.re-quota'))).toBe('—');
    // Check again where Add account was, and nothing that would sign Claude in.
    expect(buttons(row.querySelector('.re-act')!)).toEqual(['Check again']);
    expect(buttons(row).join(' ')).not.toMatch(/Add account|Sign in/);
    const note = row.querySelectorAll('.re-login-note .rsi-hint');
    expect(text(note[0])).toBe(
      'Claude’s connection from this machine is in mainland China, where Anthropic doesn’t offer Claude, so Orbit won’t use Anthropic accounts or keys here, or start a Claude sign-in. Claude Code still runs with other providers’ keys. Supported regions',
    );
    expect(note[0].querySelector('a')?.getAttribute('href')).toBe(CLAUDE_REGIONS_SOURCE_URL);
    expect(text(note[1])).toBe('Checked 2m ago · Claude’s connection: mainland China (no proxy)');
  });

  it('says a proxy when the check went through one', () => {
    const row = claudeRow(mount(hpc({ region: blocked({ viaProxy: true, name: 'Russia', country: 'RU' }) })));
    expect(text(row.querySelectorAll('.re-login-note .rsi-hint')[1])).toBe(
      'Checked 2m ago · Claude’s connection: Russia (through a proxy)',
    );
  });

  it('asks the runner to check again', async () => {
    const row = claudeRow(mount(hpc({ region: blocked() })));
    const check = [...row.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Check again')!;
    await act(async () => check.click());
    expect(apiMock).toHaveBeenCalledWith(`/runners/${RUNNER_ID}/region-check`, { method: 'POST' });
  });

  it('holds Check again while the machine is offline, as every press on its card is', () => {
    const row = claudeRow(mount(hpc({ region: blocked(), online: false })));
    const check = [...row.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Check again')!;
    expect(check.disabled).toBe(true);
  });

  it('keeps its accounts open to see, with no sign-in and no usage read on any of them', () => {
    const page = mount(hpc({ region: blocked() }), { open: true });
    const row = claudeRow(page);
    // Open, the head still speaks for the machine in the status and quota columns.
    expect(text(row.querySelector('.re-status'))).toBe('Region not supported');
    const accounts = [...page.querySelectorAll<HTMLElement>('.re-acct')];
    expect(accounts).toHaveLength(3);
    for (const account of accounts) {
      expect(text(account.querySelector('.re-quota'))).toBe('—');
      expect(buttons(account)).not.toContain('Sign in');
    }
    // Signed in, never Available: none of them can take a session here, and none is next.
    expect(accounts.slice(0, 2).map((account) => text(account.querySelector('.re-status')))).toEqual(['Signed in', 'Signed in']);
    expect(text(page)).not.toContain('NEXT');
    // Team is signed out: it says so, and offers nothing that would start a Claude sign-in.
    expect(text(accounts[2].querySelector('.re-status'))).toContain('Signed out');
    expect(text(page)).not.toContain('Sign in to see quota');
  });
});

describe('a runner that reads no region, or an allowed one', () => {
  /** The card as today's page draws it, with no region field at all. */
  const today = () => {
    const page = mount(hpc());
    const html = markup(page);
    act(() => root?.unmount());
    host?.remove();
    root = host = null;
    return html;
  };

  it('draws what it draws today', () => {
    const before = today();
    expect(before).toContain('Add account');
    expect(before).not.toContain('Region not supported');
    expect(markup(mount(hpc({ region: null })))).toBe(before);
  });

  it('draws what it draws today where the region is allowed', () => {
    const before = today();
    const allowed = { ...blocked(), verdict: 'allowed' as const, country: 'US', name: 'United States' };
    expect(markup(mount(hpc({ region: allowed })))).toBe(before);
  });
});
