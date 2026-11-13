// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunnerSelfUpdate } from '@orbit/shared';
import { runnerUpdateCard } from '../lib/runnerUpdateCard';
import { isRunnerUpdateResume, runnerTakesUpdateNow } from '../lib/runnerUpdateNow';
import { clearToasts } from '../lib/toastStore';
import { RunnerUpdateNowButton } from './RunnerUpdateNow';
import type { Runner } from './TasksSidePanel';
import { ToastViewport } from './ToastViewport';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../api', async (original) => ({
  ...(await original<typeof import('../api')>()),
  api: vi.fn(),
}));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

// Update Now… (docs/runner-update-drain-design.md §2, D4; board 3 ⑧, board 4).

const DRAINING: RunnerSelfUpdate = {
  state: 'waitingForIdle', phase: 'draining', targetVersion: '0.1.254',
  availableSince: '2026-11-12T01:58:00Z', drainingSince: '2026-11-12T02:58:00Z', turnsInFlight: 2, turnsAtDrain: 8,
};

function studioMac(turns: Runner['updateTurns'], selfUpdate: RunnerSelfUpdate = DRAINING): Runner {
  return {
    id: '34w8RunnerStudioMac0001', name: 'studio-mac', capabilities: ['self-update-now/v1'], selfUpdate, updateTurns: turns,
  };
}
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000 - 5_000).toISOString();

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null, addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => {
    clearToasts();
    root?.unmount();
  });
  host?.remove();
  root = host = null;
  apiMock.mockReset();
  document.body.innerHTML = '';
});

async function settle() {
  for (let i = 0; i < 5; i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}
async function mount(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<QueryClientProvider client={qc}><MemoryRouter>{node}<ToastViewport /></MemoryRouter></QueryClientProvider>));
  await settle();
}
const dialog = () => document.body.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
const buttons = () => [...(dialog()?.querySelectorAll<HTMLButtonElement>('button') ?? [])];

describe('Update Now…’s confirmation', () => {
  it('reads as board 3 ⑧: the runner, the turns with how long each has run, the jobs, and the red Interrupt 2 Turns and Update', async () => {
    const sent: Array<{ path: string; method?: string; body?: unknown }> = [];
    apiMock.mockImplementation(async (path: string, options?: { method?: string; body?: unknown }) => {
      sent.push({ path, method: options?.method, body: options?.body });
      return { requestedAt: new Date().toISOString(), turns: 2 };
    });
    await mount(<RunnerUpdateNowButton machine="studio-mac" runner={studioMac([
      { id: 's1', title: 'Backfill missing shard rows', startedAt: minutesAgo(112) },
      { id: 's2', title: 'Why are 11-08 metrics zero', startedAt: minutesAgo(47) },
    ])} />);
    const trigger = host!.querySelector<HTMLButtonElement>('button.runner-update-now-button')!;
    expect(trigger.textContent?.trim()).toBe('Update Now…');
    await act(async () => trigger.click());
    await settle();
    const box = dialog()!;
    expect(box.textContent).toContain('Update studio-mac now?');
    expect(box.textContent).toContain(
      'It stops these turns, installs 0.1.254 and restarts — usually under a minute. Each one then continues where it stopped, with a note that the update interrupted it.',
    );
    const rows = [...box.querySelectorAll('.runner-update-now-turns > li')].map((li) => [
      li.querySelector('.runner-update-now-turn-title')?.textContent,
      li.querySelector('.runner-update-now-turn-running')?.textContent,
    ]);
    expect(rows).toEqual([
      ['Backfill missing shard rows', 'running 1 h 52 min'],
      ['Why are 11-08 metrics zero', 'running 47 min'],
    ]);
    expect(box.textContent).toContain(
      'Background jobs in those sessions keep running; services they started are stopped. Waiting work starts once it is back.',
    );
    const confirm = buttons().find((b) => b.textContent?.trim() === 'Interrupt 2 Turns and Update')!;
    expect(confirm).toBeTruthy();
    expect(confirm.className).toMatch(/danger/);
    expect(buttons().map((b) => b.textContent?.trim())).toContain('Cancel');
    expect(sent).toHaveLength(0);

    await act(async () => confirm.click());
    await settle();
    expect(sent).toEqual([{ path: '/runners/34w8RunnerStudioMac0001/self-update/now', method: 'POST', body: { interruptTurns: true } }]);
    expect(document.body.textContent).toContain('Restarting into 0.1.254…');
  });

  it('one turn reads in the singular, none says nothing is running, and Cancel sends nothing', async () => {
    await mount(<RunnerUpdateNowButton machine="studio-mac" runner={studioMac([{ id: 's1', title: null, startedAt: null }])} />);
    await act(async () => host!.querySelector<HTMLButtonElement>('button.runner-update-now-button')!.click());
    await settle();
    expect(dialog()!.textContent).toContain('It stops this turn, installs 0.1.254 and restarts — usually under a minute. It then continues where it stopped, with a note that the update interrupted it.');
    expect(dialog()!.textContent).toContain('Untitled session');
    expect(buttons().map((b) => b.textContent?.trim())).toContain('Interrupt 1 Turn and Update');
    await act(async () => buttons().find((b) => b.textContent?.trim() === 'Cancel')!.click());
    await settle();
    expect(apiMock).not.toHaveBeenCalled();
    act(() => root?.unmount());
    root = null;

    await mount(<RunnerUpdateNowButton machine="studio-mac" runner={studioMac([])} />);
    await act(async () => host!.querySelector<HTMLButtonElement>('button.runner-update-now-button')!.click());
    await settle();
    expect(dialog()!.textContent).toContain('No turn is running. It installs 0.1.254 and restarts — usually under a minute.');
    expect(dialog()!.textContent).not.toContain('Background jobs');
    expect(buttons().map((b) => b.textContent?.trim())).toContain('Update Now');
  });

  it('says why when the server refuses', async () => {
    apiMock.mockRejectedValue(new Error('Runner is too old to update on request — it reports no self-update state'));
    await mount(<RunnerUpdateNowButton machine="studio-mac" runner={studioMac([])} />);
    await act(async () => host!.querySelector<HTMLButtonElement>('button.runner-update-now-button')!.click());
    await settle();
    await act(async () => buttons().find((b) => b.textContent?.trim() === 'Update Now')!.click());
    await settle();
    expect(document.body.textContent).toContain('Runner is too old to update on request');
  });
});

describe('who is offered Update Now…', () => {
  it('a runner that declares self-update-now/v1 with a release waiting; not an old one, nor one restarting', () => {
    expect(runnerTakesUpdateNow(studioMac([]))).toBe(true);
    expect(runnerTakesUpdateNow({ ...studioMac([]), selfUpdate: { ...DRAINING, phase: 'available' } })).toBe(true);
    expect(runnerTakesUpdateNow({ ...studioMac([]), selfUpdate: { ...DRAINING, phase: 'postponed' } })).toBe(true);
    expect(runnerTakesUpdateNow({ ...studioMac([]), capabilities: [] })).toBe(false);
    expect(runnerTakesUpdateNow({ ...studioMac([]), selfUpdate: { ...DRAINING, phase: 'restarting' } })).toBe(false);
  });
});

describe('the Restarting and Updated cards (board 4)', () => {
  const now = Date.parse('2026-11-12T12:21:30Z');
  it('Restarting names the turns Update Now interrupted', () => {
    const card = runnerUpdateCard({ state: 'enabled', phase: 'restarting', targetVersion: '0.1.254', interruptedTurns: 2 }, now);
    expect([card?.title, card?.tag, card?.body]).toEqual([
      'Restarting into 0.1.254…', 'Restarting', '2 interrupted turns continue once it is back. Usually under a minute.',
    ]);
    expect(runnerUpdateCard({ state: 'enabled', phase: 'restarting', targetVersion: '0.1.254' }, now)?.body).toBe('Usually under a minute.');
  });

  it('Updated says how long it took and the turns resumed, for a day', () => {
    const updated: RunnerSelfUpdate = {
      state: 'enabled', lastUpdatedAt: '2026-11-12T12:21:00Z', lastUpdatedFrom: '0.1.253', lastUpdatedTo: '0.1.254',
      lastUpdateSeconds: 34, lastUpdateInterruptedTurns: 2,
    };
    const card = runnerUpdateCard(updated, now);
    expect(card?.phase).toBe('updated');
    expect(card?.title).toBe('Updated to 0.1.254');
    expect(card?.body).toBe('Took 34 s. 2 interrupted turns resumed.');
    expect(card?.tag).toMatch(/^\d\d:\d\d$/);
    expect(runnerUpdateCard({ ...updated, lastUpdateSeconds: 72, lastUpdateInterruptedTurns: 1 }, now)?.body).toBe('Took 1 min 12 s. 1 interrupted turn resumed.');
    expect(runnerUpdateCard({ ...updated, lastUpdateSeconds: undefined, lastUpdateInterruptedTurns: undefined }, now)?.body).toBe('');
    expect(runnerUpdateCard(updated, now + 25 * 3_600_000)).toBeNull();
  });
});

describe('the turn Orbit sends to continue', () => {
  it('is told apart by the note it opens with', () => {
    expect(isRunnerUpdateResume('[Orbit] The runner update interrupted this turn; continue. Orbit updated its runner to 0.1.254 at the owner’s request')).toBe(true);
    expect(isRunnerUpdateResume('[Orbit] The last message you were working on was interrupted because its runner restarted')).toBe(false);
    expect(isRunnerUpdateResume('The runner update interrupted this turn; continue.')).toBe(false);
  });
});
