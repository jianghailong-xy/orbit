// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';
import {
  APPROVE_LABEL,
  CRITERIA_DECISION_ALREADY_SETTLED,
  CRITERIA_DECISION_HEADING,
  CRITERIA_DECISION_STALE_HEADING,
  REFUSE_LABEL,
  type PendingCriteriaDecisionQueue,
  type PendingCriteriaDecisionRow,
} from './CriteriaDecisionCard';
import { pendingCriteriaDecisionsQuery } from '../lib/queries';

/**
 * One held proposal, in the real WorkspaceView, for as long as a coordinator conversation stays open.
 *
 * The card keeps the proposal's address and re-derives everything else from the pending read, so a
 * proposal answered at another end goes stale IN PLACE. That only holds for a card React is still
 * rendering. The pane the card is mounted in re-renders on every event the conversation receives,
 * and a sibling that shares the card's key is enough for React to lose track of the card's old
 * instance on each of those renders without ever removing its DOM: the page fills with copies that
 * never re-derive, keep offering `Approve & re-seal` after the answer, send those presses to the
 * door, and stay in the pane when New session reuses it.
 *
 * So this mounts the view on a coordinator conversation, lets the conversation move on while the
 * card's read comes round again, answers the proposal elsewhere, and only then looks at the page —
 * the order the owner met it in. A render of the card on its own could never draw a second copy.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  // Both call the module-local `api`, so replacing the exported one alone would not reach them.
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn(), listApprovals: vi.fn() };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSessionEventPage, listApprovals } = await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000031';
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000033');
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000032');
const PROJECT_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000034');
const SESSION_PATH = `/sessions/${SESSION_PUBLIC}`;
/** New session: no session selected, so no project and no card. */
const NEW_SESSION_PATH = `/workspaces/${WORKSPACE_PUBLIC}/new`;
const INTENT = '2SXZNKDyOUtFL540SQ0oz2';
const SEAL = '6b1d02e4c8a1f3d5b7e9a2c4f6081a3c5e7f9b1d3a5c7e9f1b3d5a7c9e1f3b5d';

const RUNNER = {
  id: RUNNER_ID,
  name: 'mac-01',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

/** The project's coordinator conversation, mid-turn. */
const COORDINATOR = {
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  projectId: PROJECT_PUBLIC,
  title: 'coordinating the criteria seal',
  status: 'RUNNING',
  runStatus: 'RUNNING',
  runState: 'RUNNING',
  engineTurnActive: true,
  provider: 'claude',
  createdAt: '2026-09-10T16:40:00Z',
  updatedAt: '2026-09-10T16:47:00Z',
};

function held(): PendingCriteriaDecisionRow {
  const wording = {
    text: 'the merge boundary may be called green without running it',
    verificationMethod: 'EXECUTABLE',
    completionCriterionOverrideReason: null,
  };
  return {
    intentId: INTENT,
    projectId: PROJECT_PUBLIC,
    commitToken: `token-${INTENT}`,
    actionDigest: 'a'.repeat(64),
    filedAt: '2026-09-10T16:47:00.000Z',
    ageSeconds: 60,
    baselineSeal: SEAL,
    currentSeal: SEAL,
    proposed: [{ id: null, ordinal: 1, ...wording }],
    diff: {
      entries: [
        { change: 'NEW', definitionId: null, ordinal: 1, proposed: wording, onRecord: null, changed: [], rewrites: [] },
      ],
      sameCount: 0,
      changedCount: 0,
      newCount: 1,
      removedCount: 0,
    },
    supersededIntentId: null,
    decidability: { decidable: true, refusal: null, requiredAction: null },
  };
}

function queue(rows: PendingCriteriaDecisionRow[]): PendingCriteriaDecisionQueue {
  return {
    readAt: '2026-09-10T16:48:00.000Z',
    projectId: PROJECT_PUBLIC,
    count: rows.length,
    oldestAgeSeconds: rows[0]?.ageSeconds ?? null,
    decidableCount: rows.filter((row) => row.decidability.decidable).length,
    pending: rows,
  };
}

class FakeEventSource {
  static open: FakeEventSource[] = [];
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.open.push(this);
  }
  close() {
    this.closed = true;
  }
}

let criteriaRead: PendingCriteriaDecisionQueue = queue([held()]);
let criteriaReads = 0;
/** Every request that reached the decision door, as `METHOD path`. */
const doorRequests: string[] = [];
const unstubbed: string[] = [];
let navigateTo: NavigateFunction | null = null;
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};

const waitForUi = async (assertion: () => void): Promise<void> => {
  await act(async () => {
    await vi.waitFor(assertion, { timeout: 8_000, interval: 20 });
  });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  FakeEventSource.open = [];
  criteriaRead = queue([held()]);
  criteriaReads = 0;
  doorRequests.length = 0;
  unstubbed.length = 0;
  navigateTo = null;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  apiMock.mockReset();
  vi.mocked(getSessionEventPage).mockReset();
  vi.mocked(getSessionEventPage).mockImplementation(async () => ({
    events: [{ seq: 1, type: 'assistant', payload: { text: 'coordinator note, opening' }, turnId: 'turn-1', ts: '2026-09-10T16:47:00Z' }],
    hasMore: false,
  }));
  vi.mocked(listApprovals).mockReset();
  vi.mocked(listApprovals).mockImplementation(async () => []);
  apiMock.mockImplementation(((path: string, init?: { method?: string }) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (path === `/projects/${PROJECT_PUBLIC}/acceptance/criteria-decisions/pending`) {
      criteriaReads += 1;
      return reply(criteriaRead);
    }
    if (path.includes('/acceptance/criteria-decisions/')) {
      // The door answers a settled proposal the way the owner's two late presses were answered.
      doorRequests.push(`${init?.method ?? 'GET'} ${path}`);
      return Promise.reject(new Error(CRITERIA_DECISION_ALREADY_SETTLED));
    }
    // The settlement card's two reads, which a coordinator conversation makes too: a project that
    // states no criteria, so that card stays off this page.
    if (path === `/projects/${PROJECT_PUBLIC}/acceptance/confirmation`) {
      return reply({ state: 'UNCONFIRMED', confirmed: false, currentVersion: { digest: SEAL, material: [] }, confirmation: null });
    }
    if (path === `/projects/${PROJECT_PUBLIC}`) return reply({ id: PROJECT_PUBLIC, acceptanceCriteriaItems: [] });
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
    if (path.startsWith(`/sessions/${SESSION_PUBLIC}`)) {
      if (path.includes('/turns')) return reply([]);
      if (path.includes('/approvals')) return reply([]);
      if (path.includes('/background')) return reply([]);
      if (path.includes('/diff')) return reply({ files: [] });
      return reply(COORDINATOR);
    }
    if (path.startsWith('/sessions')) return reply([COORDINATOR]);
    if (path.startsWith('/tasks/evidence-decisions/pending')) {
      return reply({ decidingSessionId: SESSION_PUBLIC, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
    }
    if (path.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
    if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
    if (path === '/providers' || path === '/session-tags' || path === '/task-lists' || path === '/runners') return reply([]);
    unstubbed.push(path);
    return reply([]);
  }) as unknown as typeof api);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
});

afterEach(async () => {
  const mountedRoot = root;
  const mountedClient = client;
  const node = container;
  root = null;
  client = null;
  container = null;
  try {
    if (mountedRoot) await act(async () => mountedRoot.unmount());
  } finally {
    if (mountedClient) {
      await mountedClient.cancelQueries();
      mountedClient.clear();
    }
    node?.remove();
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

/** Hands the test the router's own navigate, so leaving the conversation is a real route change. */
function NavigationProbe(): null {
  navigateTo = useNavigate();
  return null;
}

async function mount(): Promise<void> {
  const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  const nextContainer = document.createElement('div');
  const nextRoot = createRoot(nextContainer);
  client = nextClient;
  container = nextContainer;
  root = nextRoot;
  document.body.appendChild(nextContainer);
  await act(async () => {
    nextRoot.render(
      <QueryClientProvider client={nextClient}>
        <MemoryRouter initialEntries={[SESSION_PATH]}>
          <AntApp>
            <WorkspaceView runner={RUNNER} />
            <NavigationProbe />
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

/** Events on the session stream, which opens behind WorkspaceView's switch debounce — so wait for it. */
async function publish(events: ReadonlyArray<Record<string, unknown>>): Promise<void> {
  let stream: FakeEventSource | undefined;
  await waitForUi(() => {
    stream = FakeEventSource.open.find((es) => !es.closed && es.url.startsWith(`/api/sessions/${SESSION_PUBLIC}/events`));
    expect(stream, 'the session opened no event stream').toBeTruthy();
  });
  await act(async () => {
    for (const event of events) stream!.onmessage?.({ data: JSON.stringify(event) });
  });
}

/** The card's read coming round again, as its poll or a realtime nudge brings it. */
async function rereadCriteria(): Promise<void> {
  const before = criteriaReads;
  await act(async () => {
    await client!.invalidateQueries({ queryKey: pendingCriteriaDecisionsQuery(PROJECT_PUBLIC).queryKey });
  });
  await waitForUi(() => {
    expect(criteriaReads).toBeGreaterThan(before);
  });
}

const cardsOnPage = (): HTMLElement[] => [...mounted().querySelectorAll<HTMLElement>('.criteria-decision')];
const headingOf = (card: HTMLElement): string =>
  card.querySelector('.criteria-decision-heading')?.textContent ?? '';
const actionsOf = (card: HTMLElement): HTMLButtonElement[] => [
  ...card.querySelectorAll<HTMLButtonElement>('.criteria-decision-actions button'),
];

/**
 * The owner's nine minutes: the card arrives answerable, the conversation moves on around it while
 * its read comes round again, and the proposal is answered at another end.
 *
 * Asserts only what every case below stands on — that the card really was drawn and pressable, and
 * that the answer really reached this page — so each case fails on its own claim.
 */
async function answeredElsewhereAfterRereads(): Promise<void> {
  await mount();
  await waitForUi(() => {
    expect(cardsOnPage().map(headingOf)).toContain(CRITERIA_DECISION_HEADING);
  });
  const arrived = cardsOnPage().find((card) => headingOf(card) === CRITERIA_DECISION_HEADING)!;
  expect(arrived.id).toBe(`criteria-decision-${INTENT}`);
  // Pressable before anything happens, so a disabled action later is the answer being noticed.
  expect(actionsOf(arrived).map((button) => button.disabled)).toEqual([false, false]);
  expect([...new Set(unstubbed)], 'every endpoint the page reads is stubbed').toEqual([]);

  for (const round of [1, 2, 3]) {
    await publish([
      { seq: 1 + round, type: 'assistant', payload: { text: `coordinator note, round ${round}` }, turnId: 'turn-1', ts: '2026-09-10T16:50:00Z' },
    ]);
    await waitForUi(() => {
      expect(mounted().textContent).toContain(`coordinator note, round ${round}`);
    });
    await rereadCriteria();
  }

  // Answered at another end: the proposal leaves the pending read and nothing displaced it.
  criteriaRead = queue([]);
  await rereadCriteria();
  await waitForUi(() => {
    expect(cardsOnPage().map(headingOf)).toContain(CRITERIA_DECISION_STALE_HEADING);
  });
}

describe('the criteria decision card in an open coordinator conversation', { timeout: 30_000 }, () => {
  it('is on the page once for its intent, through every re-read and after the answer elsewhere', async () => {
    await answeredElsewhereAfterRereads();
    expect(
      cardsOnPage().map((card) => `${card.id} · ${headingOf(card)}`),
      'the same intent is drawn more than once',
    ).toEqual([`criteria-decision-${INTENT} · ${CRITERIA_DECISION_STALE_HEADING}`]);
  });

  it('offers no answer once settled — from any card on the page — and sends nothing to the door', async () => {
    await answeredElsewhereAfterRereads();
    const cards = cardsOnPage();
    const settled = cards.find((card) => headingOf(card) === CRITERIA_DECISION_STALE_HEADING)!;
    expect(actionsOf(settled).map((button) => button.textContent)).toEqual([APPROVE_LABEL, REFUSE_LABEL]);
    expect(actionsOf(settled).map((button) => button.disabled)).toEqual([true, true]);

    // What the owner did next: press what was still lit.
    const offered = cards.flatMap((card) =>
      actionsOf(card)
        .filter((button) => !button.disabled)
        .map((button) => `${button.textContent} under "${headingOf(card)}"`),
    );
    await act(async () => {
      for (const button of cards.flatMap(actionsOf)) button.click();
    });
    expect(offered, 'a card of the settled intent still offers an answer').toEqual([]);
    expect(doorRequests, 'a press on the settled intent reached the decision door').toEqual([]);
  });

  it('leaves no card behind on New session, which has no project', async () => {
    await answeredElsewhereAfterRereads();
    await act(async () => {
      navigateTo!(NEW_SESSION_PATH);
    });
    // New session really is what is on screen, so an empty page is not a view still loading.
    await waitForUi(() => {
      expect(mounted().querySelector('.workspace-sessions.workspace-draft')).toBeTruthy();
    });
    expect(
      cardsOnPage().map((card) => `${card.id} · ${headingOf(card)}`),
      'a card is left on the New session page',
    ).toEqual([]);
  });
});
