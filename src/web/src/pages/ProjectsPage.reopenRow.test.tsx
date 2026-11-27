// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeId } from '../lib/idCodec';
import { ProjectDetailPage } from './ProjectsPage';

/**
 * The project page's reopen row (docs/project-reopen-request-design.md §6.2, board 2 frame ③), on the real detail page.
 *
 * Writing a project's own status from the web — the one write the product reserves to the account
 * owner and, until now, gave them no door onto.
 *
 * `fetch` is stubbed rather than the `api` module, so what these assert is the REQUEST that leaves
 * the client: the method, the path and the JSON body. A mocked `api` would let this file pass
 * against an argument list rather than against a PATCH.
 *
 * Every predicate below is over RENDERED OUTPUT — `container.textContent`, the portal a dialog is
 * drawn in, the `disabled` property of the button a reader would press. None of it reads a prop or
 * a mutation object: a confirmation that holds the right numbers in state and draws none of them
 * is the exact defect this entry exists to avoid.
 */
vi.mock('../components/ProjectDependencyGraph', async () => {
  const { createElement } = await import('react');
  return {
    ProjectDependencyGraph: () =>
      createElement('div', { 'data-testid': 'project-dependency-graph' }),
  };
});
// Toasts need their viewport, which this page is mounted without.
const toast = { success: vi.fn(), info: vi.fn(), warning: vi.fn(), error: vi.fn() };
vi.mock('../lib/toast', () => ({ useToast: () => toast }));

const P1 = '0195c0de-0000-7000-8000-000000000001';
/** The spelling the route carries and every URL below is built from. */
const PROJECT = encodeId(P1);
const TITLE = 'Website Revamp';

/**
 * The criteria the DONE confirmation has to account for, in the shape `GET /projects/:id` serves:
 * every one of them settled, and one of them with no receipt proving the work landed.
 *
 * That combination is not hypothetical — it is what project 34IUpy9PJxnqgJ6TGHP24 read on
 * 2026-09-05, and it is the case a confirmation showing `satisfied` alone would present as an
 * unbroken green.
 */
const CRITERIA = [
  {
    id: 'crit-1',
    ordinal: 1,
    text: 'The owner can write the project status from the project page',
    revision: 1,
    satisfied: true,
    landing: 'UNKNOWN' as const,
  },
  {
    id: 'crit-2',
    ordinal: 2,
    text: 'The confirmation states what the server can and cannot say',
    revision: 1,
    satisfied: true,
    landing: 'LANDED' as const,
  },
  {
    id: 'crit-3',
    ordinal: 3,
    text: 'Reopening a project asks once and asks for nothing',
    revision: 1,
    satisfied: true,
    landing: 'LANDED' as const,
  },
];

/** OPEN + IN_PROGRESS + FAILED = four tasks that have not ended, beside four that have. A FAILED
 *  task is a run's own report that it stopped short, so it is outstanding work by the only reading
 *  that matters to somebody abandoning the goal above it. */
const TASKS_BY_STATUS = { OPEN: 2, IN_PROGRESS: 1, FAILED: 1, DONE: 3, CANCELLED: 1 };
const UNFINISHED = 4;

const detail = (over: Record<string, unknown> = {}) => ({
  id: P1,
  title: TITLE,
  status: 'OPEN',
  goal: 'Ship the new marketing site',
  instructions: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  _count: { tasks: 8 },
  tasksByStatus: TASKS_BY_STATUS,
  acceptanceCriteriaItems: CRITERIA,
  ...over,
});

const P2 = '0195c0de-0000-7000-8000-000000000002';

/** A row of GET /projects, in the shape that endpoint always sends: seven buckets and a last
 *  activity even for a project with no tasks. Seeded so the list draws rows — a negative control
 *  over an empty list would pass whatever a row contains. */
const listRow = (id: string, title: string) => ({
  id,
  title,
  status: 'OPEN',
  goal: `The goal of ${title}`,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-02T00:00:00Z',
  _count: { tasks: 2 },
  buckets: {
    running: 0,
    ready: 1,
    blocked: 0,
    awaitingVerification: 0,
    done: 1,
    failed: 0,
    cancelled: 0,
  },
  lastActivityAt: '2026-01-02T00:00:00Z',
  attention: {
    userBlockers: 0,
    coordinatorBlockers: 0,
    systemBlockers: 0,
    maxSeverity: null,
    attentionSinceAt: null,
    nextCheckAt: null,
  },
});

const okJson = (body: unknown) =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as Response;
const failJson = (status: number, body: unknown) =>
  ({ ok: false, status, statusText: 'Error', json: async () => body }) as unknown as Response;

let fetchMock: ReturnType<typeof vi.fn>;
const REQUEST = '35aaReopenReq0001';
let ownerRequests: Array<Record<string, unknown>> = [];
const reopenRequest = (projectId: string) => ({
  id: REQUEST,
  kind: 'PROJECT_REOPEN',
  state: 'PENDING',
  title: `Reopen project “${TITLE}”?`,
  why: 'the release checklist found a gap.',
  blocksTaskIds: [],
  payload: { projectId, statusAtAsk: 'DONE', settledAt: '2026-11-18T12:00:00.000Z', plannedWork: 'Add one task.', askers: [] },
  askedBySessionId: 's1',
  askedBySessionTitle: 'Release checklist 0.1.262',
  askers: [
    { sessionId: 's1', askedAt: '2026-11-24T09:00:00Z', title: 'Release checklist 0.1.262' },
    { sessionId: 's2', askedAt: '2026-11-24T09:01:00Z', title: 'Android share fix' },
  ],
  createdAt: '2026-11-24T09:00:00Z',
});

/** The project document, and its own PATCH. Every other card on this page reads its own endpoint
 *  and gets a 500 — the state the panorama suite pins, where each card carries its own failure and
 *  the page stands. */
function serve(document: Record<string, unknown>) {
  fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    if (url === `/api/projects/${PROJECT}`) {
      return method === 'PATCH'
        ? okJson({ id: P1, ...(JSON.parse(String(init.body)) as object) })
        : okJson(document);
    }
    if (url.startsWith('/api/owner-requests?')) return okJson({ requests: ownerRequests });
    if (url === `/api/owner-requests/${REQUEST}/reopen-project`) {
      return okJson({ ...ownerRequests[0], state: 'DONE', resolvedAt: '2026-11-24T10:00:00Z' });
    }
    return failJson(500, { message: `unstubbed endpoint: ${method} ${url}` });
  });
  vi.stubGlobal('fetch', fetchMock);
}

/** Every request the page put on the wire: method, url, and the parsed body where it sent one. */
const wire = (): Array<{ method: string; url: string; body: unknown }> =>
  fetchMock.mock.calls.map(([url, init]) => {
    const options = init as RequestInit | undefined;
    return {
      method: options?.method ?? 'GET',
      url: String(url),
      body: options?.body === undefined ? undefined : JSON.parse(String(options.body)),
    };
  });

/** Only the writes — a read of the project document is not a status change. */
const writes = () => wire().filter((call) => call.method !== 'GET');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  toast.success.mockReset();
  // The page's breakpoint reads subscribe on mount and jsdom ships no matchMedia; "no breakpoint
  // matches" is the desktop reading, and layout is not this file's subject.
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
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
  // `api()` reads the bearer token off `localStorage` before every request it makes, and Node 24+
  // ships a `localStorage` global of its own that is undefined unless the process was started with
  // `--localstorage-file`. It SHADOWS jsdom's, so without this the page's first read throws and the
  // whole file asserts against the "Project could not be loaded" branch rather than against the
  // affordance under test. Nothing is signed in here — `serve` stubs the wire, and no assertion
  // in this file reads a request header.
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

async function tick(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mount(node: ReactElement): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  });
  // React Query delivers an answered query on a macrotask, and the cards below the project
  // document only mount once IT has landed.
  for (let i = 0; i < 3; i += 1) await tick();
}

const page = (): ReactElement => (
  <MemoryRouter initialEntries={[`/projects/${PROJECT}`]}>
    <Routes>
      <Route path="/projects/:id" element={<ProjectDetailPage />} />
      <Route path="/projects" element={<div>Projects</div>} />
    </Routes>
  </MemoryRouter>
);

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** A status entry on the page itself, found by the accessible name a reader's assistive technology
 *  announces rather than by the class the button happens to carry. */
const entry = (label: RegExp): HTMLButtonElement | undefined =>
  [...container.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find((button) =>
    label.test(button.getAttribute('aria-label') ?? ''),
  );

/** The open confirmation, by its role, in the portal it is drawn in — never `container`. */
const dialog = (): HTMLElement | null => document.body.querySelector('[role="dialog"]');
const dialogText = (): string => dialog()?.textContent ?? '';

/** The confirmation's own confirm, matched on the words the reader reads on it. */
const confirmButton = (label: RegExp): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) =>
    label.test((button.textContent ?? '').trim()),
  );

/** Open one of the page's status confirmations and hand back what it drew. */
async function open(label: RegExp): Promise<string> {
  const press = entry(label);
  expect(press, `the project page offers no ${label} entry`).toBeTruthy();
  await click(press!);
  return dialogText();
}

describe('ProjectDetailPage — the reopen request row', () => {
  it('draws one row above the DONE header with the asker line, and Review opens the card, whose Reopen calls the route', async () => {
    ownerRequests = [reopenRequest(P1)];
    serve(detail({ status: 'DONE', doneAt: '2026-11-18T12:00:00Z' }));
    await mount(page());

    const rows = container.querySelectorAll('.project-reopen-row');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.textContent).toContain('An agent asked to reopen this project');
    expect(row.textContent).toContain('Asked by “Release checklist 0.1.262” · Also asked by “Android share fix”');
    const header = container.querySelector('[data-project-block="header"]')!;
    expect(row.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING, 'the row is not above the header').toBeTruthy();
    expect(header.textContent).toContain('Completed');
    // The card is not drawn until Review is pressed, and then once.
    expect(document.body.querySelector('.approval-card')).toBeNull();
    const review = [...row.querySelectorAll('button')].find((b) => b.textContent === 'Review')!;
    await click(review);
    expect(document.body.querySelectorAll('.approval-card')).toHaveLength(1);
    expect(dialogText()).toContain(`Reopen project “${TITLE}”?`);
    expect(dialogText()).toContain('Planned work');
    const reopen = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => (b.textContent ?? '').startsWith('Reopen'))!;
    await click(reopen);
    await tick();
    expect(writes().map((w) => `${w.method} ${w.url}`)).toEqual([`POST /api/owner-requests/${REQUEST}/reopen-project`]);
  });

  it('draws no row for an OPEN project, or when no request names this one', async () => {
    ownerRequests = [reopenRequest('0195c0de-0000-7000-8000-0000000000ff')];
    serve(detail({ status: 'DONE', doneAt: '2026-11-18T12:00:00Z' }));
    await mount(page());
    expect(container.querySelector('.project-reopen-row')).toBeNull();
    await act(async () => root.unmount());
    container.remove();
    ownerRequests = [reopenRequest(P1)];
    serve(detail());
    await mount(page());
    expect(container.querySelector('.project-reopen-row')).toBeNull();
  });
});
