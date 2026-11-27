// @vitest-environment jsdom
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSnoozesForTest, type OwnerRequest } from '../lib/ownerRequests';
import { OwnerRequestCard, OwnerRequestResolved } from './OwnerRequestCard';
import { ProjectReopenRow } from './ProjectReopenCard';

/**
 * The PROJECT_REOPEN card (docs/project-reopen-request-design.md §6; board docs/mocks/project-reopen-request): its
 * body in the asking transcript and outside it (Needs-you style, with the askers), Reopen calling `reopen-project`,
 * Chat about this declining with the reason typed, the two one-line folds, and the project page's row with Review.
 */

vi.mock('../api', () => ({ api: vi.fn() }));
const { api } = await import('../api');
const apiMock = vi.mocked(api);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const NOW = Date.parse('2026-11-24T09:00:00.000Z');
const REQUEST_ID = '35aaReopenReq0001';
const PROJECT_ID = '35aaProject0000001';
const ASKER = '34uOqHiF7f3VmoARfQg6y';

function reopenRequest(over: Partial<OwnerRequest> & Record<string, unknown> = {}): OwnerRequest {
  return {
    id: REQUEST_ID,
    kind: 'PROJECT_REOPEN',
    state: 'PENDING',
    title: 'Reopen project “Share to Orbit”?',
    why: 'the release checklist found that the Android share sheet still opens the old screen.',
    blocksTaskIds: [],
    ifUnanswered: null,
    options: null,
    recommendedOption: null,
    steps: null,
    secretSpec: null,
    secretGrant: null,
    verifyHint: null,
    payload: {
      projectId: PROJECT_ID,
      statusAtAsk: 'DONE',
      settledAt: '2026-11-18T12:00:00.000Z',
      plannedWork: 'Add a criterion for the Android share target, and one task to fix it.',
      askers: [],
    },
    askedBySessionTitle: 'Release checklist 0.1.262',
    askers: [
      { sessionId: ASKER, askedAt: new Date(NOW - 60_000).toISOString(), title: 'Release checklist 0.1.262' },
      { sessionId: 'other1', askedAt: new Date(NOW - 30_000).toISOString(), title: 'Android share fix' },
    ],
    expiresAt: null,
    askedBySessionId: ASKER,
    projectId: null,
    resolvedAt: null,
    resolvedByUserId: null,
    resolvedBySessionId: null,
    resolutionNote: null,
    answer: null,
    createdAt: new Date(NOW - 60_000).toISOString(),
    ...over,
  } as OwnerRequest;
}

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)); });
};

let root: Root | null = null;
let host: HTMLElement;
let writes: Array<{ path: string; method: string; body: unknown }> = [];
let open: OwnerRequest[] = [];

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

const words = (node: Element | null | undefined): string => {
  if (!node) return '';
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let text = walker.nextNode(); text; text = walker.nextNode()) parts.push(text.textContent ?? '');
  return parts.join(' ').replace(/\s+/g, ' ').trim();
};
const button = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll('button')].find((b) => words(b) === name || words(b).startsWith(`${name} `));
  if (!found) throw new Error(`no button named ${name}: ${document.body.textContent}`);
  return found;
};
async function press(target: HTMLElement) {
  await act(async () => { target.click(); });
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  resetSnoozesForTest();
  writes = [];
  open = [];
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string, init?: { method?: string; body?: unknown }) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') writes.push({ path, method, body: init?.body });
    if (path.endsWith('/reopen-project')) return reopenRequest({ state: 'DONE', resolvedAt: new Date(NOW).toISOString() });
    if (path.endsWith('/decline')) {
      return reopenRequest({ state: 'DECLINED', resolutionNote: (init?.body as { reason: string }).reason });
    }
    return { requests: open };
  });
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    root = null;
    await act(async () => mounted.unmount());
  }
  host?.remove();
});

describe('PROJECT_REOPEN card', () => {
  it('draws title, DONE since with a project link, the reason, the planned work and both buttons — in the asking transcript', async () => {
    await mount(<OwnerRequestCard request={reopenRequest()} now={NOW} viewedFromSessionId={ASKER} />);
    const text = words(host);
    expect(text).toContain('↺ Reopen project “Share to Orbit”?');
    expect(text).toContain('DONE since Nov 18');
    expect(text).toContain('The agent says: the release checklist found');
    expect(text).toContain('Planned work');
    expect(text).toContain('Add a criterion for the Android share target');
    expect(host.querySelector('a')?.getAttribute('href')).toContain('/projects/');
    expect(words(host.querySelector('a'))).toBe('Open project');
    expect(text).not.toContain('Asked by');
    expect(text).toContain('Also asked by “Android share fix”');
    expect(words(button('Reopen'))).toContain('Reopen');
    expect(words(button('💬 Chat about this'))).toBe('💬 Chat about this');
    expect(text).not.toContain('Always allow');
  });

  it('names the askers outside the asking session and says Cancelled since for a cancelled project', async () => {
    const request = reopenRequest({
      payload: { projectId: PROJECT_ID, statusAtAsk: 'CANCELLED', settledAt: '2026-11-18T12:00:00.000Z', plannedWork: 'x', askers: [] },
    });
    await mount(<OwnerRequestCard request={request} now={NOW} />);
    const text = words(host);
    expect(text).toContain('Cancelled since Nov 18');
    expect(text).toContain('Asked by “Release checklist 0.1.262” · Also asked by “Android share fix”');
  });

  it('Reopen calls POST /owner-requests/:id/reopen-project and folds to one line', async () => {
    await mount(<OwnerRequestCard request={reopenRequest()} now={NOW} />);
    await press(button('Reopen'));
    expect(writes).toEqual([{ path: `/owner-requests/${REQUEST_ID}/reopen-project`, method: 'POST', body: undefined }]);
    expect(host.querySelector('.settings-change-folded')).not.toBeNull();
    expect(words(host)).toMatch(/^↺ Reopened “Share to Orbit” · /);
    expect(host.querySelector('button')).toBeNull();
  });

  it('Chat about this declines with the reason typed next', async () => {
    await mount(<OwnerRequestCard request={reopenRequest()} now={NOW} />);
    await press(button('💬 Chat about this'));
    const box = host.querySelector('textarea') as HTMLTextAreaElement;
    expect(button('Decline').disabled).toBe(true);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'Put it in a new project.');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await press(button('Decline'));
    expect(writes).toEqual([{ path: `/owner-requests/${REQUEST_ID}/decline`, method: 'POST', body: { reason: 'Put it in a new project.' } }]);
    expect(words(host)).toBe('Declined: Put it in a new project.');
  });

  it('an answered request in the transcript is one line', async () => {
    await mount(
      <OwnerRequestResolved request={reopenRequest({ state: 'DONE', resolvedAt: new Date(NOW).toISOString() })} now={NOW} />,
    );
    expect(words(host)).toMatch(/^↺ Reopened “Share to Orbit” · /);
    await act(async () => root!.unmount());
    root = null;
    host.remove();
    await mount(<OwnerRequestResolved request={reopenRequest({ state: 'DECLINED', resolutionNote: 'No.' })} now={NOW} />);
    expect(words(host)).toBe('Declined: No.');
  });
});

describe('project page row', () => {
  it('draws one row with the asker line and Review opens the same card', async () => {
    open = [reopenRequest(), reopenRequest({ id: 'other', payload: { projectId: 'someone-else', statusAtAsk: 'DONE', settledAt: '2026-11-18T12:00:00.000Z', plannedWork: 'y', askers: [] } })];
    await mount(<ProjectReopenRow projectId={PROJECT_ID} />);
    expect(host.querySelectorAll('.project-reopen-row')).toHaveLength(1);
    expect(words(host)).toContain('An agent asked to reopen this project');
    expect(words(host)).toContain('Asked by “Release checklist 0.1.262” · Also asked by “Android share fix”');
    expect(document.querySelector('.approval-card')).toBeNull();
    await press(button('Review'));
    expect(document.querySelectorAll('.approval-card')).toHaveLength(1);
    expect(document.body.textContent).toContain('Reopen project “Share to Orbit”?');
    await press(button('Reopen'));
    expect(writes.map((w) => w.path)).toEqual([`/owner-requests/${REQUEST_ID}/reopen-project`]);
  });

  it('draws nothing when no request waits for this project', async () => {
    await mount(<ProjectReopenRow projectId={PROJECT_ID} />);
    expect(host.querySelector('.project-reopen-row')).toBeNull();
  });
});
