// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import { READY_TO_CLOSE } from '../lib/projectDone';
import { ProjectDetailPage } from './ProjectsPage';

/**
 * The project page's header says "Ready to close" only while the open-items read model carries a
 * live DONE_REQUEST — the coordinator asking — and never merely because the document carries the
 * unified `derivedDone` read, which every OPEN project on a current server does.
 */
vi.mock('../components/ProjectDependencyGraph', async () => {
  const { createElement } = await import('react');
  return { ProjectDependencyGraph: () => createElement('div') };
});
const toast = { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));

const P1 = '0195c0de-0000-7000-8000-0000000000c1';
const PROJECT = encodeId(P1);

const document = {
  id: P1,
  title: 'Closeout',
  status: 'OPEN',
  goal: 'Close it out',
  instructions: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  startedAt: '2026-01-01T00:00:00Z',
  _count: { tasks: 2 },
  tasksByStatus: { DONE: 1, OPEN: 1 },
  acceptanceCriteriaItems: [{ id: 'c1', ordinal: 1, text: 'It ships' }],
  derivedDone: {
    status: 'OPEN',
    done: false,
    withheld: ['CRITERION_UNSATISFIED'],
    confirmation: 'CONFIRMED',
    criteria: [{ definitionId: 'c1', satisfied: false, landing: 'UNKNOWN', landingReason: null }],
    counts: {
      criteria: 1,
      met: 0,
      landed: 0,
      onMain: 0,
      byReason: { IN_FLIGHT: 0, ON_PROJECT_BRANCH: 0, NOTHING_TO_LAND: 0, NO_RECEIPT: 0, CODELESS: 0 },
    },
  },
};

const doneRequestRow = {
  itemId: 'item-done',
  kind: 'DONE_REQUEST',
  title: 'Is this project done?',
  detailLine: 'The coordinator asked',
  assignee: 'OWNER',
  assigneeReason: 'OWNER_DECISION',
  waitingSince: '2026-01-02T00:00:00Z',
  escalateAt: null,
  escalatedAt: null,
  taskId: null,
  sessionId: null,
  promotionId: null,
  fuseEpisodeId: null,
  delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
  actions: [],
  question: null,
  facts: null,
  doneRequest: { criteriaDigest: 'd', judgment: 'Done.', gaps: [] },
};

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as Response;
const failJson = (status: number, body: unknown) =>
  ({ ok: false, status, statusText: 'Error', json: async () => body }) as unknown as Response;

function serve(openItems: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === `/api/projects/${PROJECT}`) return okJson(document);
    if (url === `/api/projects/${PROJECT}/open-items`) return okJson(openItems);
    return failJson(500, { message: `unstubbed endpoint: ${url}` });
  }));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
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
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function mount(node: ReactElement): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  container = window.document.createElement('div');
  window.document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const page = (): ReactElement => (
  <MemoryRouter initialEntries={[`/projects/${PROJECT}`]}>
    <Routes>
      <Route path="/projects/:id" element={<ProjectDetailPage />} />
    </Routes>
  </MemoryRouter>
);

const header = (): string =>
  container.querySelector('[data-project-block="header"]')?.textContent ?? '';

describe('the project header’s Ready to close', () => {
  it('is drawn while the open-items read carries a DONE_REQUEST', async () => {
    serve({ needsYou: [], withCoordinator: [], doneRequest: doneRequestRow });
    await mount(page());
    expect(header()).toContain('Closeout');
    expect(header()).toContain(READY_TO_CLOSE);
  });

  it('is not drawn on an ordinary OPEN project nobody asked to close', async () => {
    serve({ needsYou: [], withCoordinator: [], doneRequest: null });
    await mount(page());
    expect(header()).toContain('Closeout');
    expect(header()).not.toContain(READY_TO_CLOSE);
  });
});
