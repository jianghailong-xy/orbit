// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { accountIsPaused, pauseResumeTime } from '../lib/accountPause';
import { encodeId } from '../lib/idCodec';
import { availableCount, type ProviderPool } from '../lib/providerPools';
import { sharedPoolAsProviderPool, type SharedPool } from '../lib/sharedPools';
import { AccountPauseActions } from './AccountPause';
import { PoolMembers } from './AccountPools';
import { RunnerEngines } from './RunnerEngines';
import { clickRunnerMenuItem, dialogName, openRunnerCards } from './RunnerEngines.test-helpers';
import type { Runner } from './TasksSidePanel';

vi.mock('../api', () => ({ api: vi.fn() }));
vi.mock('../lib/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
const apiMock = vi.mocked(api);
const id = (n: number) => encodeId(`0195c0de-0000-7000-8000-${String(n).padStart(12, '0')}`);
const until = () => new Date(Date.now() + 120 * 60_000).toISOString();
let root: Root;
let host: HTMLDivElement;
let qc: QueryClient;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(window, 'matchMedia', { writable: true, value: vi.fn().mockImplementation(() => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} })) });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  apiMock.mockResolvedValue({});
});
afterEach(() => {
  act(() => root.unmount());
  qc.clear();
  host.remove();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  apiMock.mockReset();
});
const render = (node: ReactNode) => act(() => root.render(<MemoryRouter><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>));
const button = (text: string, scope: ParentNode = document) => {
  const result = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === text);
  if (!result) throw new Error(`No ${text} button`);
  return result;
};
const click = async (element: HTMLElement) => { await act(async () => element.click()); };
/** The open dialog's name, as assistive technology reads it. */
const dialogTitle = () => {
  const dialog = document.querySelector('[role="dialog"]');
  return dialog ? dialogName(dialog) : undefined;
};
const duration = async (value: string) => click(document.querySelector<HTMLInputElement>(`.account-pause-durations input[value="${value}"]`)!);
const changeHours = async (value: string) => {
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Pause hours"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

describe('timed pause controls', () => {
  it('defaults to two hours and explains pool-wide scope before saving', async () => {
    render(<AccountPauseActions pool shared name="Work" endpoint="/pause" />);
    await click(button('Pause…'));
    expect(document.body.textContent).toContain('everyone in this pool');
    expect(document.body.textContent).toContain('The current turn finishes normally');
    expect(document.querySelector<HTMLInputElement>('.account-pause-durations input[value="2"]')!.checked).toBe(true);
    await click(button('Pause Account'));
    expect(apiMock).toHaveBeenCalledWith('/pause', { method: 'POST', body: { durationMinutes: 120 } });
  });

  it('sends a selected preset, and offers resume with a null duration', async () => {
    render(<AccountPauseActions name="Work" endpoint="/pause" />);
    await click(button('Pause…'));
    await duration('8');
    await click(button('Pause Account'));
    expect(apiMock).toHaveBeenLastCalledWith('/pause', { method: 'POST', body: { durationMinutes: 480 } });
    render(<AccountPauseActions name="Work" endpoint="/pause" until={until()} />);
    await click(button('Resume Now'));
    expect(apiMock).toHaveBeenLastCalledWith('/pause', { method: 'POST', body: { durationMinutes: null } });
  });

  it('validates custom hours and turns fractional hours into integer minutes', async () => {
    render(<AccountPauseActions name="Work" endpoint="/pause" />);
    await click(button('Pause…'));
    await duration('custom');
    await changeHours('');
    expect(button('Pause Account').disabled).toBe(true);
    await changeHours('0.01');
    expect(button('Pause Account').disabled).toBe(true);
    await changeHours('169');
    expect(button('Pause Account').disabled).toBe(true);
    await changeHours('1.5');
    expect(button('Pause Account').disabled).toBe(false);
    await click(button('Pause Account'));
    expect(apiMock).toHaveBeenLastCalledWith('/pause', { method: 'POST', body: { durationMinutes: 90 } });
  });

  it('keeps the duration dialog open when saving fails', async () => {
    apiMock.mockRejectedValue(new Error('Forbidden'));
    render(<AccountPauseActions name="Work" endpoint="/pause" until={until()} />);
    await click(button('Change Duration'));
    await click(button('Update Pause'));
    expect(dialogTitle()).toBe('Change pause duration');
  });

  it('changes expired controls back to Pause and refreshes server choices without a reload', async () => {
    vi.useFakeTimers();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    render(<AccountPauseActions name="Work" endpoint="/pause" until={new Date(Date.now() + 1000).toISOString()} />);
    expect(button('Resume Now')).toBeDefined();
    await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
    expect(button('Pause…')).toBeDefined();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['providers'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['runners'] });
  });

  it('shows the local date when a short pause crosses midnight', () => {
    const start = new Date(2026, 9, 4, 23, 30).getTime();
    const end = new Date(2026, 9, 5, 1, 30).toISOString();
    expect(pauseResumeTime(end, start)).toBe('Oct 5, 01:30');
    expect(accountIsPaused(end, Date.parse(end))).toBe(false);
  });
});

const sharedPool = (admin: boolean): SharedPool => ({
  id: id(10), slug: 'team', label: 'Team', engine: 'codex', shared: true,
  viewerRole: admin ? 'ADMIN' : 'MEMBER', ownKeyFirst: false, membersCanAdd: true, membersCanAddAccounts: true,
  window: { start: '2026-10-01', end: '2026-11-01' },
  people: [
    { userId: id(1), name: 'Me', role: admin ? 'ADMIN' : 'MEMBER', creator: admin, you: true, keys: 0, sessions: 0, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } },
    { userId: id(2), name: 'Owner', role: 'ADMIN', creator: !admin, you: false, keys: 0, sessions: 0, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 } },
  ],
  logins: [
    { userId: id(2), state: 'ACTIVE', email: 'work@example.com', plan: 'pro', fingerprint: '…AB12', lastError: null, expiresAt: until(), linkedAt: '', usage: null, usageUnavailable: null, next: false, pausedUntil: until() },
  ],
  keys: [],
});

describe('account pause on real account rows', () => {
  it('shows shared pause state to all members but actions only to the contributor or admin', async () => {
    const pool = sharedPoolAsProviderPool(sharedPool(false));
    render(<PoolMembers pool={pool} refusals={new Map()} />);
    expect(host.textContent).toContain('Paused until');
    expect(host.textContent).toContain('Signed in');
    expect(host.textContent).not.toContain('Resume Now');
    expect(availableCount(pool, new Map())).toBe(0);
    render(<PoolMembers pool={sharedPoolAsProviderPool(sharedPool(true))} refusals={new Map()} />);
    await click(button('Resume Now'));
    expect(apiMock).toHaveBeenLastCalledWith(`/providers/pools/${id(10)}/members/login%3A%E2%80%A6AB12/pause`, { method: 'POST', body: { durationMinutes: null } });
  });

  it('removes the paused state at expiry for viewers who cannot manage the account', async () => {
    vi.useFakeTimers();
    const access = sharedPool(false);
    access.logins[0].pausedUntil = new Date(Date.now() + 1000).toISOString();
    render(<PoolMembers pool={sharedPoolAsProviderPool(access)} refusals={new Map()} />);
    expect(host.textContent).toContain('Paused until');
    expect(host.textContent).not.toContain('Resume Now');
    await act(async () => { await vi.advanceTimersByTimeAsync(1001); });
    expect(host.textContent).not.toContain('Paused until');
    expect(host.querySelector('.account-paused')).toBeNull();
    expect(host.textContent).toContain('Available');
  });

  it('pauses and resumes personal runner slots while retaining sign-in and quota', async () => {
    const runner: Runner = {
      id: id(20), name: 'Runner', online: true,
      engines: [{ engine: 'codex', installed: true, auth: 'yes', version: '0.160.0', accounts: [
        { id: 'default', name: 'Personal', home: '~/.codex', auth: 'yes', pausedUntil: until() },
        { id: 'abcd1234', name: 'Work', home: '~/.orbit/codex-accounts/abcd1234', auth: 'yes' },
      ] }],
      planUsage: { provider: 'codex', primary: { utilization: 60, windowDurationMins: 10080 } },
    };
    openRunnerCards([runner]);
    qc.setQueryData(['runners'], [runner]);
    apiMock.mockImplementation(async (path) => path === '/runners' ? [runner] : {});
    render(<RunnerEngines />);
    expect(host.querySelector('.account-paused')?.textContent).toContain('60%');
    expect(host.querySelector('.account-paused')?.textContent).toContain('Signed in');
    expect(host.textContent).toContain('1 of 2 accounts available');
    const rows = host.querySelectorAll('.re-acct');
    expect([...rows].map((row) => row.querySelectorAll('.re-act button').length)).toEqual([1, 1]);
    expect(host.textContent).not.toContain('Pause…');
    expect(host.textContent).not.toContain('Resume now');
    await clickRunnerMenuItem(rows[1], 'Pause account…');
    expect(dialogTitle()).toBe('Pause account');
    await duration('4');
    await click(button('Pause Account'));
    expect(apiMock).toHaveBeenCalledWith(`/runners/${runner.id}/accounts/codex/abcd1234/pause`, { method: 'POST', body: { durationMinutes: 240 } });
    await clickRunnerMenuItem(rows[0], 'Change pause duration…');
    expect(dialogTitle()).toBe('Change pause duration');
    await click(button('Update Pause'));
    expect(apiMock).toHaveBeenCalledWith(`/runners/${runner.id}/accounts/codex/default/pause`, { method: 'POST', body: { durationMinutes: 120 } });
    await clickRunnerMenuItem(rows[0], 'Resume now');
    expect(apiMock).toHaveBeenCalledWith(`/runners/${runner.id}/accounts/codex/default/pause`, { method: 'POST', body: { durationMinutes: null } });
  });
});
