// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { SELF_UPDATE_NOW_V1, type RunnerSelfUpdate } from '@orbit/shared';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runnerDrainBanner, runnerDrainBannerText } from '../lib/runnerDrainBanner';
import { RunnerDrainBanner } from './RunnerDrainBanner';
import type { Runner } from './TasksSidePanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The workspace banner (docs/runner-update-drain-design.md §3.4, D3; board 3 ⑥).

const DRAINING: RunnerSelfUpdate = {
  state: 'waitingForIdle', phase: 'draining', targetVersion: '0.1.254',
  drainingSince: '2026-11-12T09:00:00.000Z', turnsInFlight: 2, turnsAtDrain: 2,
};
const runner = (over: Partial<Runner> = {}): Runner => ({
  id: 'r-studio', name: 'studio-mac', online: true, capabilities: [SELF_UPDATE_NOW_V1],
  selfUpdate: DRAINING, drainWaiting: { sessions: 1, messages: 1 }, ...over,
} as Runner);

describe('the banner’s sentence', () => {
  it('reads as board 3 ⑥ draws it', () => {
    expect(runnerDrainBanner(runner(), 'studio-mac')?.text)
      .toBe('studio-mac is updating to 0.1.254 — 1 session and 1 message are waiting for 2 turns to finish.');
  });
  it('counts in English', () => {
    expect(runnerDrainBannerText('studio-mac', '0.1.254', { sessions: 1, messages: 0 }, 1))
      .toBe('studio-mac is updating to 0.1.254 — 1 session is waiting for 1 turn to finish.');
    expect(runnerDrainBannerText('studio-mac', null, { sessions: 0, messages: 3 }, 0))
      .toBe('studio-mac is updating — 3 messages are waiting for it to restart.');
  });
  it('is nothing unless the runner drains with the reader’s work waiting', () => {
    expect(runnerDrainBanner(runner({ drainWaiting: undefined }), 'studio-mac')).toBeNull();
    expect(runnerDrainBanner(runner({ drainWaiting: null }), 'studio-mac')).toBeNull();
    expect(runnerDrainBanner(runner({ drainWaiting: { sessions: 0, messages: 0 } }), 'studio-mac')).toBeNull();
    expect(runnerDrainBanner(runner({ selfUpdate: null, drainWaiting: undefined }), 'studio-mac')).toBeNull();
  });
});

beforeAll(() => {
  // Bare stubs: the banner draws Base UI menus and buttons that ask for these in jsdom.
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
    <QueryClientProvider client={qc}><MemoryRouter><RunnerDrainBanner runner={r} machine="studio-mac" /></MemoryRouter></QueryClientProvider>,
  ));
}
function mount(r: Runner) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  render(r);
}
const banner = () => host!.querySelector<HTMLElement>('.runner-drain-banner');

describe('the banner at the top of the conversation pane', () => {
  it('shows the sentence with Later ▾, Update Now… and × while the runner drains with work waiting', () => {
    mount(runner());
    expect(banner()?.querySelector('.runner-drain-banner-text')?.textContent)
      .toBe('studio-mac is updating to 0.1.254 — 1 session and 1 message are waiting for 2 turns to finish.');
    const buttons = [...banner()!.querySelectorAll('button')].map((b) => b.textContent?.trim() || b.getAttribute('aria-label'));
    expect(buttons).toEqual(['Later', 'Update Now…', 'Dismiss']);
  });

  it('is hidden while the runner drains with nothing waiting, and when it does not drain', () => {
    mount(runner({ drainWaiting: undefined }));
    expect(banner()).toBeNull();
    render(runner({ selfUpdate: { state: 'waitingForIdle', phase: 'available', targetVersion: '0.1.254' }, drainWaiting: undefined }));
    expect(banner()).toBeNull();
    render(runner());
    expect(banner()).not.toBeNull();
  });

  it('× hides it for this drain only: it stays hidden while this drain lasts, and the next drain shows it again', () => {
    mount(runner());
    act(() => banner()!.querySelector<HTMLButtonElement>('.runner-drain-banner-close')!.click());
    expect(banner()).toBeNull();
    // The same drain: more work waits, still hidden.
    render(runner({ drainWaiting: { sessions: 2, messages: 1 } }));
    expect(banner()).toBeNull();
    // The drain ends (Later, or the update), then a new one starts with work waiting.
    render(runner({ selfUpdate: { state: 'enabled' }, drainWaiting: undefined }));
    expect(banner()).toBeNull();
    render(runner({ selfUpdate: { ...DRAINING, drainingSince: '2026-11-12T13:00:00.000Z' } }));
    expect(banner()?.querySelector('.runner-drain-banner-text')?.textContent)
      .toBe('studio-mac is updating to 0.1.254 — 1 session and 1 message are waiting for 2 turns to finish.');
  });

  it('says the runner is stopping, with only ×, when it drains to stop rather than to update (docs/mocks/runner-stopping)', () => {
    // A release may be waiting too (phase available): the drain is still the stop's, so nothing to postpone or install now.
    mount(runner({
      selfUpdate: { state: 'waitingForIdle', phase: 'available', targetVersion: '0.1.257' },
      updateTurns: [{ id: 's1', title: 'A', startedAt: null }, { id: 's2', title: 'B', startedAt: null }],
      drainWaiting: { sessions: 0, messages: 1, stopping: true },
    }));
    expect(banner()?.querySelector('.runner-drain-banner-text')?.textContent)
      .toBe('studio-mac is stopping — 1 message is waiting for 2 turns to finish.');
    const buttons = [...banner()!.querySelectorAll('button')].map((b) => b.textContent?.trim() || b.getAttribute('aria-label'));
    expect(buttons).toEqual(['Dismiss']);
    expect(runnerDrainBannerText('HPC', null, { sessions: 1, messages: 0, stopping: true }, 0))
      .toBe('HPC is stopping — 1 session is waiting for it to come back.');
  });

  it('offers no Update Now… on a runner too old to take it', () => {
    mount(runner({ capabilities: [] }));
    const buttons = [...banner()!.querySelectorAll('button')].map((b) => b.textContent?.trim() || b.getAttribute('aria-label'));
    expect(buttons).toEqual(['Later', 'Dismiss']);
  });
});
