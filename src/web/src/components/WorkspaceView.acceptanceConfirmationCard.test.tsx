// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';
import type { PendingCriteriaDecisionQueue } from './CriteriaDecisionCard';
import {
  acceptanceConfirmationKey,
  type StandardSetConfirmationStanding,
} from '../lib/acceptanceConfirmation';
import { pendingCriteriaDecisionsQuery } from '../lib/queries';

/**
 * The settlement confirmation card where the owner meets it: the real WorkspaceView, on a
 * coordinator conversation that stays open while the conversation moves on and the card's reads
 * come round again — and on a conversation that coordinates nothing.
 *
 * The component's own spec settles WHEN the card is drawn. What only the view can show is where
 * the card's project comes from (`selectedSession.projectId` at the mount) and that the card lives
 * beside the other cards Orbit draws into the pane without costing any of them its identity: the
 * pane re-renders on every event, and a sibling sharing a key is how a card was once left behind as
 * copies nobody re-derived (`WorkspaceView.criteriaDecisionCard.test.tsx`).
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

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000051';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000052');
const COORDINATOR_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000053');
const PROJECT_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000054');
const ORDINARY_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000055');
const INTENT = '2SXZNKDyOUtFL540SQ0oz3';
const SEAL = `4fc57753a6ec${'0'.repeat(52)}`;

const RUNNER = {
  id: RUNNER_ID,
  name: 'mac-01',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

function conversation(id: string, projectId: string | null, title: string) {
  return {
    id,
    workspaceId: WORKSPACE_PUBLIC,
    runnerId: RUNNER_ID,
    projectId,
    title,
    status: 'RUNNING',
    runStatus: 'RUNNING',
    runState: 'RUNNING',
    engineTurnActive: true,
    provider: 'claude',
    createdAt: '2026-09-11T03:00:00Z',
    updatedAt: '2026-09-11T03:10:00Z',
  };
}

/** The project's coordinator conversation, and a conversation that coordinates nothing. */
const COORDINATOR = conversation(COORDINATOR_PUBLIC, PROJECT_PUBLIC, 'coordinating the criteria seal');
const ORDINARY = conversation(ORDINARY_PUBLIC, null, 'an ordinary conversation');
const NOTE: Record<string, string> = {
  [COORDINATOR_PUBLIC]: 'coordinator note',
  [ORDINARY_PUBLIC]: 'ordinary note',
};

/** Settlement held on the owner: both criteria met, and nobody has confirmed the set. */
const STANDING: StandardSetConfirmationStanding = {
  state: 'UNCONFIRMED',
  confirmed: false,
  currentVersion: {
    digest: SEAL,
    material: [1, 2].map((n) => ({ definitionId: `c${n}`, revision: 1, contentHash: `h${n}` })),
  },
  confirmation: null,
};
const CRITERIA = [1, 2].map((n) => ({ id: `c${n}`, ordinal: n, text: `condition ${n} holds`, satisfied: true }));

/** A weakening held against the same project, so the criteria card shares the pane. */
const PROPOSALS: PendingCriteriaDecisionQueue = (() => {
  const wording = { text: 'the pg spec may be skipped', verificationMethod: 'EXECUTABLE', completionCriterionOverrideReason: null };
  return {
    readAt: '2026-09-11T03:10:00.000Z',
    projectId: PROJECT_PUBLIC,
    count: 1,
    oldestAgeSeconds: 60,
    decidableCount: 1,
    pending: [
      {
        intentId: INTENT,
        projectId: PROJECT_PUBLIC,
        commitToken: `token-${INTENT}`,
        actionDigest: 'a'.repeat(64),
        filedAt: '2026-09-11T03:09:00.000Z',
        ageSeconds: 60,
        baselineSeal: SEAL,
        currentSeal: SEAL,
        proposed: [{ id: null, ordinal: 3, ...wording }],
        diff: {
          entries: [{ change: 'NEW', definitionId: null, ordinal: 3, proposed: wording, onRecord: null, changed: [], rewrites: [] }],
          sameCount: 2,
          changedCount: 0,
          newCount: 1,
          removedCount: 0,
        },
        supersededIntentId: null,
        decidability: { decidable: true, refusal: null, requiredAction: null },
      },
    ],
  };
})();

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

/** Every path the page asked the api for, in order. */
const requested: string[] = [];
const unstubbed: string[] = [];
let confirmationReads = 0;
let criteriaReads = 0;
let navigateTo: NavigateFunction | null = null;
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};
const count = (selector: string): number => mounted().querySelectorAll(selector).length;

const waitForUi = async (assertion: () => void): Promise<void> => {
  await act(async () => {
    await vi.waitFor(assertion, { timeout: 8_000, interval: 20 });
  });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  FakeEventSource.open = [];
  requested.length = 0;
  unstubbed.length = 0;
  confirmationReads = 0;
  criteriaReads = 0;
  navigateTo = null;
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  apiMock.mockReset();
  vi.mocked(getSessionEventPage).mockReset();
  vi.mocked(getSessionEventPage).mockImplementation(async (id: string) => ({
    events: [{ seq: 1, type: 'assistant', payload: { text: `${NOTE[id]}, opening` }, turnId: 'turn-1', ts: '2026-09-11T03:10:00Z' }],
    hasMore: false,
  }));
  vi.mocked(listApprovals).mockReset();
  vi.mocked(listApprovals).mockImplementation(async () => []);
  apiMock.mockImplementation(((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    requested.push(path);
    if (path === `/projects/${PROJECT_PUBLIC}/acceptance/confirmation`) {
      confirmationReads += 1;
      return reply(STANDING);
    }
    if (path === `/projects/${PROJECT_PUBLIC}`) return reply({ id: PROJECT_PUBLIC, acceptanceCriteriaItems: CRITERIA });
    if (path === `/projects/${PROJECT_PUBLIC}/acceptance/criteria-decisions/pending`) {
      criteriaReads += 1;
      return reply(PROPOSALS);
    }
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
    for (const session of [COORDINATOR, ORDINARY]) {
      if (path.startsWith(`/sessions/${session.id}`)) {
        if (path.includes('/turns')) return reply([]);
        if (path.includes('/approvals')) return reply([]);
        if (path.includes('/background')) return reply([]);
        if (path.includes('/diff')) return reply({ files: [] });
        return reply(session);
      }
    }
    if (path.startsWith('/sessions')) return reply([COORDINATOR, ORDINARY]);
    if (path.startsWith('/tasks/evidence-decisions/pending')) {
      return reply({ decidingSessionId: COORDINATOR_PUBLIC, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
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

/** Hands the test the router's own navigate, so opening another conversation is a real route change. */
function NavigationProbe(): null {
  navigateTo = useNavigate();
  return null;
}

async function mount(path: string): Promise<void> {
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
        <MemoryRouter initialEntries={[path]}>
          <AntApp>
            <WorkspaceView runner={RUNNER} />
            <NavigationProbe />
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

/** Events on one conversation's stream, which opens behind WorkspaceView's switch debounce. */
async function publish(sessionId: string, events: ReadonlyArray<Record<string, unknown>>): Promise<void> {
  let stream: FakeEventSource | undefined;
  await waitForUi(() => {
    stream = FakeEventSource.open.find((es) => !es.closed && es.url.startsWith(`/api/sessions/${sessionId}/events`));
    expect(stream, 'the conversation opened no event stream').toBeTruthy();
  });
  await act(async () => {
    for (const event of events) stream!.onmessage?.({ data: JSON.stringify(event) });
  });
}

/** One of the cards' reads coming round again, as its poll brings it. */
async function reread(queryKey: readonly unknown[], reads: () => number): Promise<void> {
  const before = reads();
  await act(async () => {
    await client!.invalidateQueries({ queryKey });
  });
  await waitForUi(() => {
    expect(reads()).toBeGreaterThan(before);
  });
}

/** Moves one conversation on by a note, and waits until the pane has drawn it. */
async function note(sessionId: string, round: number): Promise<void> {
  const text = `${NOTE[sessionId]}, round ${round}`;
  await publish(sessionId, [
    { seq: 1 + round, type: 'assistant', payload: { text }, turnId: 'turn-1', ts: '2026-09-11T03:11:00Z' },
  ]);
  await waitForUi(() => {
    expect(mounted().textContent).toContain(text);
  });
}

describe('the settlement confirmation card in WorkspaceView', { timeout: 60_000 }, () => {
  it('is drawn once in a coordinator conversation, beside the criteria card, through every re-read', async () => {
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    await waitForUi(() => {
      expect(count('.settlement-card')).toBeGreaterThan(0);
      expect(count('.criteria-decision')).toBeGreaterThan(0);
    });
    expect([...new Set(unstubbed)], 'every endpoint the page reads is stubbed').toEqual([]);

    for (const round of [1, 2, 3]) {
      await note(COORDINATOR_PUBLIC, round);
      await reread(acceptanceConfirmationKey(PROJECT_PUBLIC), () => confirmationReads);
      await reread(pendingCriteriaDecisionsQuery(PROJECT_PUBLIC).queryKey, () => criteriaReads);
    }
    expect(
      { settlement: count('.settlement-card'), criteria: count('.criteria-decision') },
      'a card in the pane is drawn more than once',
    ).toEqual({ settlement: 1, criteria: 1 });
  });

  it('is drawn in no conversation that coordinates no project, which reads nothing for one', async () => {
    await mount(`/sessions/${ORDINARY_PUBLIC}`);
    await waitForUi(() => {
      expect(mounted().textContent).toContain(`${NOTE[ORDINARY_PUBLIC]}, opening`);
    });
    for (const round of [1, 2]) await note(ORDINARY_PUBLIC, round);

    expect(count('.settlement-card'), 'a conversation with no project was drawn the card').toBe(0);
    expect(
      requested.filter((path) => path.startsWith('/projects/')),
      'a conversation with no project read one',
    ).toEqual([]);

    // The same view on the same stubs, opening the conversation that does coordinate the project.
    await act(async () => {
      navigateTo!(`/sessions/${COORDINATOR_PUBLIC}`);
    });
    await waitForUi(() => {
      expect(count('.settlement-card')).toBe(1);
    });
  });
});

describe('where the card is mounted', () => {
  /** Both spellings, because the web suite runs from `src/web` and a runner may start at the root. */
  const workspaceView = (): string => {
    const found = ['src/components/WorkspaceView.tsx', 'src/web/src/components/WorkspaceView.tsx']
      .map((each) => resolve(process.cwd(), each))
      .find(existsSync);
    if (!found) throw new Error(`WorkspaceView.tsx is not under ${process.cwd()}`);
    return readFileSync(found, 'utf8');
  };

  it('is mounted once, after the evidence card, keyed by the session under a key neither sibling carries', () => {
    const source = workspaceView();
    const at = source.indexOf('<SessionAcceptanceConfirmationCard');
    expect(at, 'the card is not mounted at all').toBeGreaterThan(-1);
    expect(source.split('<SessionAcceptanceConfirmationCard').length - 1).toBe(1);
    expect(at).toBeGreaterThan(source.indexOf('<SessionEvidenceDecisionCard'));
    const element = source.slice(at, source.indexOf('/>', at));
    // Not `selectedId` (the criteria card's) and not `evidence:…` (the evidence card's): see
    // WorkspaceView.criteriaDecisionCard.test.tsx for what two siblings sharing a key cost.
    expect(element).toContain('key={`confirmation:${selectedId}`}');
    expect(element).toContain('projectId={selectedSession?.projectId ?? null}');
  });
});
