// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANGE_COPY, resetSnoozesForTest, type OwnerRequest } from '../lib/ownerRequests';
import { OwnerRequestCard, OwnerRequestResolved } from './OwnerRequestCard';

/** The CHANGE card (docs/design/owner-request-change.md §3): live value, editable number, Apply, the ended line. */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const NOW = Date.parse('2026-11-24T09:00:00.000Z');
const RUNNER = '0196e300-0000-7000-8000-0000000000e1';
let live = 12;

function change(requested: number, before: number, over: Partial<OwnerRequest> = {}): OwnerRequest {
  return {
    id: 'req-change', kind: 'CHANGE', state: 'PENDING',
    title: 'Lower wikova to 6 concurrent sessions', why: 'wikova has run at 12/12 for 40 minutes.',
    blocksTaskIds: [], ifUnanswered: null, options: null, recommendedOption: null, steps: null, secretSpec: null,
    secretGrant: null, verifyHint: null, expiresAt: null, askedBySessionId: 's1', projectId: null, resolvedAt: null,
    resolvedByUserId: null, resolvedBySessionId: null, resolutionNote: null, answer: null,
    createdAt: new Date(NOW - 60_000).toISOString(),
    changeSpec: { runnerId: RUNNER, field: 'maxConcurrent', requested, before },
    ...over,
  };
}

let root: Root | null = null;
let host: HTMLElement;
let writes: Array<{ path: string; body: unknown }> = [];

async function flush() {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
}
async function mount(node: JSX.Element) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () => {
    root!.render(<QueryClientProvider client={qc}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
  });
  await flush();
}
const text = () => host.textContent!.replace(/\s+/g, ' ');
const button = (name: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)!;
const input = () => host.querySelector('input[type=number]') as HTMLInputElement;
async function type(value: string) {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    set.call(input(), value);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  live = 12;
  writes = [];
  localStorage.clear();
  resetSnoozesForTest();
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    if (init?.method === 'POST') { writes.push({ path, body: init.body }); return change(6, 12, { state: 'DONE' }) as never; }
    if (path === '/runners') return [{ id: RUNNER, name: 'wikova', online: true, maxConcurrent: live, activeSessions: 8 }] as never;
    if (path.startsWith('/owner-requests?')) return { requests: [] } as never;
    throw new Error(`unexpected ${path}`);
  });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  document.body.innerHTML = '';
});

describe('the CHANGE card', () => {
  it('lowering: live value, prefilled number, running count, consequence, Apply', async () => {
    await mount(<OwnerRequestCard now={NOW} request={change(6, 12)} />);
    expect(text()).toContain('SETTING');
    expect(text()).toContain('wikova · Max Concurrent');
    expect(text()).toContain('12→');
    expect(input().value).toBe('6');
    expect(text()).toContain('8 running now');
    expect(text()).toContain('Nothing running stops. New sessions wait until fewer than 6 run.');
    expect(text()).not.toContain('when asked');
    expect(button('Apply')).toBeTruthy();
    expect(button('Decline…')).toBeTruthy();
    expect(button('Remind me later')).toBeTruthy();
  });

  it('raising says how many can run', async () => {
    live = 4;
    await mount(<OwnerRequestCard now={NOW} request={change(10, 4, { title: 'Raise wikova to 10' })} />);
    expect(text()).toContain('Up to 10 sessions can run at once on this machine.');
    expect(text()).not.toContain('Nothing running stops');
  });

  it('an edited number drives the consequence line and the apply body', async () => {
    await mount(<OwnerRequestCard now={NOW} request={change(6, 12)} />);
    await type('15');
    expect(text()).toContain('Up to 15 sessions can run at once on this machine.');
    await type('8');
    expect(text()).toContain('fewer than 8 run.');
    await act(async () => { button('Apply').click(); });
    await flush();
    expect(writes).toEqual([{ path: '/owner-requests/req-change/apply', body: { maxConcurrent: 8 } }]);
  });

  it('refuses a number that is not an integer of at least 1', async () => {
    await mount(<OwnerRequestCard now={NOW} request={change(6, 12)} />);
    for (const bad of ['0', '', '2.5']) {
      await type(bad);
      expect(button('Apply').disabled).toBe(true);
    }
  });

  it('says what the value was when asked once the live value moved', async () => {
    live = 9;
    await mount(<OwnerRequestCard now={NOW} request={change(6, 12)} />);
    expect(text()).toContain('9→');
    expect(text()).toContain('Was 12 when asked.');
  });
});

describe('the ended CHANGE line', () => {
  const ended = (applied: number) => change(6, 12, {
    state: 'DONE', resolvedAt: new Date(NOW).toISOString(), resolvedByUserId: 'me', answer: { applied, actualBefore: 12 },
  });
  it('names the applied value', async () => {
    await mount(<OwnerRequestResolved now={NOW} request={ended(6)} />);
    expect(text()).toContain('Applied: wikova Max Concurrent 12 → 6');
    expect(text()).not.toContain('asked for');
  });
  it('adds (asked for N) when the owner changed the number', async () => {
    await mount(<OwnerRequestResolved now={NOW} request={ended(8)} />);
    expect(text()).toContain('Applied: wikova Max Concurrent 12 → 8 (asked for 6)');
  });
  it('is the shared constant', () => {
    expect(CHANGE_COPY.applied('wikova', 12, 6, 6)).toBe('Applied: wikova Max Concurrent 12 → 6');
  });
});
