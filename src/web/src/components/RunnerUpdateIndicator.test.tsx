// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { SELF_UPDATE_NOW_V1, type RunnerSelfUpdate } from '@orbit/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runnerUpdateIndicator, runnerUpdateIndicatorWaits } from '../lib/runnerUpdateIndicator';
import { RunnerUpdateIndicator } from './RunnerUpdateIndicator';
import type { Runner } from './TasksSidePanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The update indicator (docs/mocks/runner-update-indicator), which took the place of board 3 ⑥'s banner.

const DRAINING: RunnerSelfUpdate = {
  state: 'waitingForIdle', phase: 'draining', targetVersion: '0.1.257',
  drainingSince: '2026-11-12T09:00:00.000Z', turnsInFlight: 5, turnsAtDrain: 5,
};
const turn = (id: string, title: string) => ({ id, title, startedAt: null });
const runner = (over: Partial<Runner> = {}): Runner => ({
  id: 'hpcRunner', name: 'workstation-gpu', online: true, capabilities: [SELF_UPDATE_NOW_V1],
  selfUpdate: DRAINING, drainWaiting: { sessions: 10, messages: 19 },
  updateTurns: [
    turn('turn1', 'Backfill missing shard rows'),
    turn('turn2', 'Rebuild the wiki index'),
    turn('turn3', 'Port the gauge to Android'),
    turn('turn4', 'Tidy the release notes'),
    turn('turn5', 'Fix login redirect'),
  ],
  ...over,
} as Runner);

describe('the indicator’s words', () => {
  it('reads as the board draws it', () => {
    expect(runnerUpdateIndicator(runner(), 'HPC')).toEqual({
      pill: 'HPC updating · 5 turns left',
      short: '5',
      title: 'HPC is updating to 0.1.257',
      body: 'It installs once these turns finish. Nothing is lost — waiting work starts right after.',
      waits: '10 sessions and 19 messages of yours wait for it.',
    });
  });
  it('says restarting once no turn is left, and counts in English', () => {
    const restarting = runnerUpdateIndicator(runner({ selfUpdate: { ...DRAINING, turnsInFlight: 0, targetVersion: undefined } }), 'HPC');
    expect([restarting?.pill, restarting?.short, restarting?.title]).toEqual(['HPC restarting', '', 'HPC is updating']);
    expect(runnerUpdateIndicator(runner({ selfUpdate: { ...DRAINING, turnsInFlight: 1 } }), 'HPC')?.pill).toBe('HPC updating · 1 turn left');
    expect(runnerUpdateIndicatorWaits({ sessions: 1, messages: 0 })).toBe('1 session of yours waits for it.');
    expect(runnerUpdateIndicatorWaits({ sessions: 0, messages: 3 })).toBe('3 messages of yours wait for it.');
  });
  it('is nothing unless the runner drains with the reader’s work waiting', () => {
    expect(runnerUpdateIndicator(runner({ drainWaiting: undefined }), 'HPC')).toBeNull();
    expect(runnerUpdateIndicator(runner({ drainWaiting: null }), 'HPC')).toBeNull();
    expect(runnerUpdateIndicator(runner({ drainWaiting: { sessions: 0, messages: 0 } }), 'HPC')).toBeNull();
  });
});

beforeAll(() => {
  // Bare stubs: the popover draws Base UI menus and buttons that ask for these in jsdom.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function render(r: Runner) {
  act(() => root!.render(
    <QueryClientProvider client={qc}><MemoryRouter><RunnerUpdateIndicator runner={r} machine="HPC" /></MemoryRouter></QueryClientProvider>,
  ));
}
function mount(r: Runner) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  render(r);
}
const pill = () => host!.querySelector<HTMLButtonElement>('.runner-update-pill');
const popover = () => document.querySelector<HTMLElement>('.runner-update-popover');
async function open() {
  await act(async () => { pill()!.click(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

describe('the pill left of the header’s ⋯', () => {
  it('is a quiet pill, with no banner, Later or × until it is opened', () => {
    mount(runner());
    expect(pill()?.querySelector('.runner-update-pill-label')?.textContent).toBe('HPC updating · 5 turns left');
    expect(host!.querySelectorAll('button')).toHaveLength(1);
    expect(popover()).toBeNull();
  });

  it('opens the release, three of the turns, what waits, Later ▾, Update Now… and the runner', async () => {
    mount(runner());
    await open();
    const pop = popover()!;
    expect(pop.querySelector('.orbit-popover-title')?.textContent).toBe('HPC is updating to 0.1.257');
    expect([...pop.querySelectorAll('.runner-update-popover-turns li')].map((li) => li.textContent))
      .toEqual(['Backfill missing shard rows', 'Rebuild the wiki index', 'Port the gauge to Android', 'and 2 more']);
    expect(pop.querySelector('.runner-update-popover-waits')?.textContent).toBe('10 sessions and 19 messages of yours wait for it.');
    const actions = pop.querySelector('.runner-update-popover-actions')!;
    expect([...actions.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(['Later', 'Update Now…']);
    expect(actions.querySelector('a')?.textContent).toBe('Open HPC');
  });

  it('offers no Update Now… on a runner too old to take it', async () => {
    mount(runner({ capabilities: [] }));
    await open();
    expect([...popover()!.querySelectorAll('.runner-update-popover-actions button')].map((b) => b.textContent?.trim())).toEqual(['Later']);
  });

  it('comes and goes with the drain', () => {
    mount(runner({ drainWaiting: undefined }));
    expect(pill()).toBeNull();
    render(runner());
    expect(pill()).not.toBeNull();
    render(runner({ selfUpdate: { state: 'enabled' }, drainWaiting: undefined }));
    expect(pill()).toBeNull();
  });
});
