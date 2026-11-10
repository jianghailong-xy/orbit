// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WaitingOnYouPage } from './WaitingOnYouPage';
import { resetSnoozesForTest, snoozeRequest, type OwnerRequest } from '../lib/ownerRequests';

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function request(over: Partial<OwnerRequest>): OwnerRequest {
  return {
    id: 'r', kind: 'CONFIRM', state: 'PENDING', title: 'T', why: 'W', blocksTaskIds: [], ifUnanswered: null,
    options: null, recommendedOption: null, steps: null, secretSpec: null, verifyHint: null, expiresAt: null,
    askedBySessionId: 's', projectId: null, resolvedAt: null, resolvedByUserId: null, resolvedBySessionId: null,
    resolutionNote: null, answer: null, createdAt: ago(2 * MINUTE), ...over,
  };
}

const OPEN = [
  request({ id: 'secret', kind: 'SECRET', title: 'Provide a DeepSeek API key', projectId: 'p1', blocksTaskIds: ['t1'],
    secretSpec: { name: 'key', runnerId: 'run1', envVar: 'K' } }),
  request({ id: 'steps', kind: 'MANUAL_STEP', title: 'Reboot the GPU node', projectId: 'p1', blocksTaskIds: ['t1', 't2'],
    steps: [{ text: 'a' }, { text: 'b' }, { text: 'c' }], createdAt: ago(DAY + HOUR) }),
];

const QUESTION = {
  itemId: 'q1', kind: 'COORDINATOR_QUESTION', title: 't', detailLine: null, assignee: 'OWNER', assigneeReason: 'DEFAULT',
  escalateAt: null, escalatedAt: null, taskId: null, sessionId: null, promotionId: null, fuseEpisodeId: null,
  delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null }, actions: [], facts: null, waitingSince: ago(3 * HOUR),
  question: { question: 'Which branch lands first?', options: [{ label: 'auth' }, { label: 'billing' }], recommendedOption: 0, blocksTaskIds: [], ifUnanswered: null },
};

const PROJECTS = [
  { id: 'p1', title: 'M0 follow-up', attention: { ownerItems: [] } },
  { id: 'p2', title: 'Payments', attention: { ownerItems: [{ kind: 'COORDINATOR_QUESTION', count: 1, oldestWaitingSince: ago(3 * HOUR) }] } },
];

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
const flush = async () => {
  for (let i = 0; i < 6; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

let root: Root | null = null;
let host: HTMLElement;

async function open(url = '/waiting') {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={qc}><MemoryRouter initialEntries={[url]}><WaitingOnYouPage /></MemoryRouter></QueryClientProvider>,
    );
  });
  await flush();
}

const titles = () => [...host.querySelectorAll('.owner-inbox-title')].map((t) => t.textContent);
const tab = (name: string) => [...host.querySelectorAll<HTMLElement>('[role=tab]')].find((t) => t.textContent === name)!;
const settle = async (target: HTMLElement) => {
  await act(async () => { target.click(); });
  await flush();
};

beforeEach(() => {
  localStorage.clear();
  resetSnoozesForTest();
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string) => {
    if (path === '/projects/sidebar') return PROJECTS as never;
    if (path === '/projects/p2/open-items') return { needsYou: [QUESTION], withCoordinator: [] } as never;
    if (path === '/owner-requests?state=open') return { requests: OPEN } as never;
    if (path === '/owner-requests?state=done') {
      return { requests: [request({ id: 'd', state: 'DONE', title: 'Finished thing', resolvedByUserId: 'me', resolvedAt: ago(MINUTE) })] } as never;
    }
    if (path === '/owner-requests?state=declined') {
      return { requests: [request({ id: 'x', state: 'DECLINED', title: 'Refused thing', resolutionNote: 'no', resolvedByUserId: 'me', resolvedAt: ago(MINUTE) })] } as never;
    }
    if (path === '/runners') return [] as never;
    if (path.startsWith('/tasks/')) return { title: 'A task' } as never;
    throw new Error(`unexpected ${path}`);
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
});

describe('the Waiting on you inbox', () => {
  it('Open lists owner requests and coordinator questions together, newest first, under one count', async () => {
    await open();
    expect(titles()).toEqual(['Provide a DeepSeek API key', 'Which branch lands first?', 'Reboot the GPU node']);
    expect(host.querySelector('.owner-inbox-count')?.textContent).toBe('3');
    expect(tab('Open').getAttribute('aria-selected')).toBe('true');
  });

  it('each row says where it is from and what it holds, with the action its kind calls for', async () => {
    await open();
    const rows = [...host.querySelectorAll('.owner-inbox-row')];
    expect(rows[0].textContent).toContain('M0 follow-up · holds 1 task');
    expect(rows[0].querySelector('.owner-inbox-action')?.textContent).toBe('Provide');
    expect(rows[1].textContent).toContain('Payments · decision · recommended: auth');
    expect(rows[1].querySelector('.owner-inbox-action')?.textContent).toBe('Answer');
    expect(rows[2].textContent).toContain('3 steps');
    expect(rows[2].querySelector('strong')?.textContent).toMatch(/^holds 2 tasks for 1d/);
    expect(rows[2].querySelector('.owner-inbox-action')?.textContent).toBe('Open steps');
  });

  it('the action opens the whole card in place', async () => {
    await open();
    await settle(host.querySelectorAll<HTMLElement>('.owner-inbox-action')[2]);
    expect(host.querySelector('.owner-request-card')?.textContent).toContain('Mark done');
    await settle(host.querySelectorAll<HTMLElement>('.owner-inbox-action')[1]);
    expect(host.querySelector('.coordinator-question')?.textContent).toContain('Which branch lands first?');
  });

  it('Done and Declined list what ended that way, as summaries', async () => {
    await open();
    await settle(tab('Done'));
    expect(tab('Done').getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('.owner-request-resolved')?.textContent).toContain('Finished thing');
    expect(titles()).toEqual([]);
    await settle(tab('Declined'));
    expect(host.querySelector('.owner-request-resolved')?.textContent).toContain('Declined: “no”');
  });

  it('?tab= opens that tab', async () => {
    await open('/waiting?tab=declined');
    expect(tab('Declined').getAttribute('aria-selected')).toBe('true');
    expect(host.textContent).toContain('Refused thing');
  });

  it('a request put off stays listed but out of the count', async () => {
    snoozeRequest('steps', Date.now() + HOUR);
    await open();
    expect(host.querySelector('.owner-inbox-count')?.textContent).toBe('2');
    expect(titles()).toContain('Reboot the GPU node');
    expect(host.textContent).toContain('Reminder');
  });

  it('says so when nothing is waiting', async () => {
    apiMock.mockImplementation(async (path: string) =>
      (path === '/projects/sidebar' ? [] : { requests: [] }) as never);
    await open();
    expect(host.textContent).toContain('Nothing is waiting on you.');
    expect(host.querySelector('.owner-inbox-count')).toBeNull();
  });
});
