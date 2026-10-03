// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
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
import { ACCEPTANCE_PLAN_CHANGE_PREFIX } from './AcceptanceConfirmationCard';
import { ENTER_HINT } from './CardHotkey';
import { OWNER_SEND_BACK_ACTION } from './OwnerConfirmationCard';
import { SETTLEMENT_DELEGATE_ACTION } from './ProjectSettlementCard';
import type { ProjectOpenItemRow } from '@orbit/shared';
import {
  CRITERIA_CHANGE_TITLE,
  READY_TO_START,
  START_CHAT_PLACEHOLDER,
  START_PROJECT_ACTION,
  criteriaChangeConfirmLabel,
} from '../lib/projectStart';

/**
 * The settlement card where the owner meets it: the real WorkspaceView, on a coordinator
 * conversation that stays open while the conversation moves on and the card's reads come round
 * again — and on a conversation that coordinates nothing. The project here has not been started and
 * its coordinator has asked to start it, so the card the conversation draws is "Start this project?".
 *
 * The components' own specs settle WHEN each card is drawn. What only the view can show is where
 * the card's project comes from (`selectedSession.projectId` at the mount), that the card lives
 * beside the other cards Orbit draws into the pane without costing any of them its identity — the
 * pane re-renders on every event, and a sibling sharing a key is how a card was once left behind as
 * copies nobody re-derived (`WorkspaceView.criteriaDecisionCard.test.tsx`) — and that a press
 * leaves its record in the conversation, and the row and the pinned line say what is waiting.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  // All four call the module-local `api`, so replacing the exported one alone would not reach
  // them. `sendTurn` is the one write these cases can make: stubbed at its own seam, because what
  // a send SENDS is the claim, and the transport under it is the real `api`'s business.
  return {
    ...actual,
    api: vi.fn(),
    getSessionEventPage: vi.fn(),
    listApprovals: vi.fn(),
    sendTurn: vi.fn(),
  };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSessionEventPage, listApprovals, sendTurn } = await import('../api');
const apiMock = vi.mocked(api);
const sendTurnMock = vi.mocked(sendTurn);
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

/** The project is waiting to be started: it states criteria, and nobody has confirmed them. */
const STANDING: StandardSetConfirmationStanding = {
  state: 'UNCONFIRMED',
  confirmed: false,
  currentVersion: {
    digest: SEAL,
    material: [1, 2].map((n) => ({ definitionId: `c${n}`, revision: 1, contentHash: `h${n}` })),
  },
  confirmation: null,
};
const CRITERIA = [1, 2].map((n) => ({ id: `c${n}`, ordinal: n, text: `condition ${n} holds`, satisfied: false }));

/** The coordinator's request to start it, as the open items serve it beside the rest. */
const START_ROW: ProjectOpenItemRow = {
  itemId: '2SXZNKDyOUtFL540SQ0oz9',
  kind: 'START_REQUEST',
  title: 'Start this project?',
  detailLine: 'project/x · Automatic on · 3 tasks at a time · no merge check',
  assignee: 'OWNER',
  assigneeReason: 'DEFAULT',
  waitingSince: '2026-09-11T03:09:00.000Z',
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
  startRequest: {
    settings: { line: 'PROJECT_BRANCH', automatic: true, maxConcurrentTasks: 3, mergeCheckCommand: 'npm test' },
    why: 'B builds on A, so one branch checks them together',
    criteriaDigest: SEAL,
    planDigest: 'p'.repeat(64),
    repository: 'https://github.com/example/orbit.git',
    warnings: [],
  },
};

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
/** Whether the coordinating conversation's project document carries a projection that is STILL
 *  withholding — the fourth read the settlement card turns on, and the state its second press is
 *  drawn in. Off by default: the card is not what most cases here are about. */
let settlementHeld = false;
/** The standing the confirmation door serves: `UNCONFIRMED` for most cases, and a case that is
 *  about the RECORD sets one with a confirmation on it. Reset per case like every other stub. */
let confirmationStanding: StandardSetConfirmationStanding = STANDING;
/** When the project was started, or null while it is waiting to be — and the request that is
 *  waiting, while one is. A start moves both. */
let projectStartedAt: string | null = null;
let startRow: ProjectOpenItemRow | null = START_ROW;
/** Whether a weakening is held against the project, which the pinned line names ahead of the rest. */
let proposalsHeld = true;
/** Every start the page pressed, as its body. */
const starts: Array<Record<string, unknown>> = [];
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
  // The act environment is off while the window is waited out, as RTL's own asyncWrapper does it:
  // React queues every render scheduled inside an in-flight act callback and flushes none of them
  // until that callback settles, so a page that answers inside the window can never draw what the
  // window exists to see — instrumented, the answer arrived 203ms into an 8s window and the DOM
  // never moved (e85b63ee9's second full run: `.decision-strip-title` missing while the card was
  // drawn; retryAttachments and accounts:267 red the same way on the merge check).
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await vi.waitFor(assertion, { timeout: 8_000, interval: 20 });
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
  // And one act to close the window: the last commit the wait saw leaves its passive effects
  // scheduled, and what they carry — React Query's mutation options among it — is what the test's
  // next press runs on. The old act-wrapped wait flushed them on its way out; this keeps that,
  // without the freeze that made the wait itself blind.
  await act(async () => {});
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  FakeEventSource.open = [];
  requested.length = 0;
  settlementHeld = false;
  unstubbed.length = 0;
  confirmationStanding = STANDING;
  projectStartedAt = null;
  startRow = START_ROW;
  proposalsHeld = true;
  starts.length = 0;
  confirmationReads = 0;
  criteriaReads = 0;
  navigateTo = null;
  // What a case measures is a WALL-CLOCK window: it presses a control, then waits for the page to
  // draw what the press did. The page keeps two interval polls armed while no push stream is up
  // (jsdom connects none): the session list's 4s — `sessionsQ`'s, gated on the control-plane stream
  // — and the open conversation's 5s. Under load a window outlasting one of those is ordinary, and
  // the re-read then lands inside it: a request nobody pressed for, failing an assertion about the
  // press. React Query skips an interval's fetch while the tab is not focused, so the tab is
  // declared unfocused — the state of any tab nobody is looking at, and what these polls are
  // already written to stand down in. The reads this file is about are driven by `reread()` and by
  // the stream, so nothing it asserts is weakened: what the press asked for is still all its
  // window can hold.
  focusManager.setFocused(false);
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
  // A session at rest: the send goes out live, which is the branch this card's press is on.
  sendTurnMock.mockReset();
  sendTurnMock.mockImplementation(async () => ({
    turnId: 'turn-sent',
    seq: 2,
    kind: 'message',
    placement: 'accepted',
  }));
  apiMock.mockImplementation(((path: string, init?: { method?: string; body?: Record<string, unknown> }) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    requested.push(path);
    // The start door: it confirms the set, starts the project and answers the request, and the
    // reads say so from then on — which is what the conversation draws the record from.
    if (init?.method === 'POST' && path === `/projects/${PROJECT_PUBLIC}/start`) {
      const body = init.body ?? {};
      starts.push(body);
      const at = '2026-09-11T03:10:30.000Z';
      const settings = {
        line: body.line,
        projectBranchName: `refs/heads/project/${PROJECT_PUBLIC}`,
        automatic: body.automatic,
        maxConcurrentTasks: body.maxConcurrentTasks,
        mergeCheckCommand: body.mergeCheckCommand,
      };
      projectStartedAt = at;
      startRow = null;
      confirmationStanding = {
        state: 'CONFIRMED',
        confirmed: true,
        currentVersion: STANDING.currentVersion,
        confirmation: {
          criteriaDigest: SEAL,
          criteriaMaterial: STANDING.currentVersion.material,
          confirmedAt: at,
          confirmedById: 'user-1',
          startedWith: { settings: settings as never, differsFromRequest: ['maxConcurrentTasks'] },
        },
      };
      return reply({ projectId: PROJECT_PUBLIC, startedAt: at, criteriaDigest: SEAL, criteriaCount: 2, lineLocked: false, settings, differsFromRequest: ['maxConcurrentTasks'] });
    }
    // The confirmation door, pressed from the change card: it confirms the version named, and the
    // read says so from then on.
    if (init?.method === 'POST' && path === `/projects/${PROJECT_PUBLIC}/acceptance/confirmation`) {
      confirmationStanding = {
        state: 'CONFIRMED',
        confirmed: true,
        currentVersion: confirmationStanding.currentVersion,
        confirmation: {
          criteriaDigest: confirmationStanding.currentVersion.digest,
          criteriaMaterial: confirmationStanding.currentVersion.material,
          confirmedAt: '2026-09-11T03:10:40.000Z',
          confirmedById: 'user-1',
          startedWith: null,
        },
        changesSinceConfirmed: { added: [], stricter: [], revised: [], removed: [], unchanged: [1, 2] },
        changesSinceConfirmedAbsentReason: null,
      };
      return reply(confirmationStanding);
    }
    if (path === `/projects/${PROJECT_PUBLIC}/acceptance/confirmation`) {
      confirmationReads += 1;
      return reply(confirmationStanding);
    }
    if (path === `/projects/${PROJECT_PUBLIC}`) {
      // `_count` is the fourth fact the card's condition turns on — a project with nothing filed
      // under it is not one anybody can start, which is the state `project_create` returns in.
      return reply({
        id: PROJECT_PUBLIC,
        title: 'the criteria seal',
        status: 'OPEN',
        coordinatorEnabled: false,
        // Not started until the start door says so: the start card is this project's question.
        startedAt: projectStartedAt,
        _count: { tasks: 1 },
        acceptanceCriteriaItems: CRITERIA,
        // A project LOOKING finished while the derivation still withholds: every criterion met,
        // none with a merge receipt, and a set the owner has stood behind. Drawn only for the case
        // that is about that card — the projection is the fourth read it turns on.
        ...(settlementHeld
          ? {
              derivedDone: {
                status: 'OPEN',
                done: false,
                withheld: ['CRITERION_UNLANDED'],
                criteria: [{
                  definitionId: 'c1',
                  satisfied: true,
                  landing: 'UNKNOWN',
                  independence: 'INDEPENDENT',
                  conflicts: [],
                  remedy: null,
                  withheld: ['CRITERION_UNLANDED'],
                }],
                confirmation: 'CONFIRMED',
              },
            }
          : {}),
      });
    }
    // The open items the coordinator question card reads (§5.2): no question is open in any of these
    // cases, and the start request the start card is drawn from is served beside them.
    if (path === `/projects/${PROJECT_PUBLIC}/open-items`) {
      return reply({ needsYou: [], withCoordinator: [], startRequest: startRow });
    }
    // The plan the start card sums up in a line: two tasks, the second after the first.
    if (path === `/projects/${PROJECT_PUBLIC}/dependency-graph`) {
      return reply({
        marks: [
          { kind: 'TASK', id: 'task-a', taskId: 'task-a', title: 'A · the seal', status: 'OPEN', parentTaskId: null },
          { kind: 'TASK', id: 'task-b', taskId: 'task-b', title: 'B · the card', status: 'OPEN', parentTaskId: null },
        ],
        edges: [{ sourceMarkId: 'task-a', targetMarkId: 'task-b' }],
        taskCount: 2,
        folded: false,
        truncated: false,
        limits: { maxTasks: 500, maxMarks: 500 },
      });
    }
    // Nothing is waiting to be merged into main either: the promotion card reads this door
    // wherever a conversation coordinates a project, and null is the ordinary answer —
    // no candidate, no card (contract §3.6).
    if (path === `/projects/${PROJECT_PUBLIC}/promotions/current`) {
      return reply(null);
    }
    // Nor has it merged anything, so the conversation draws no record of a merge: the receipts it
    // holds are the ones this file is about (contract §3.6's `merged`).
    if (path === `/projects/${PROJECT_PUBLIC}/promotions/merged`) {
      return reply([]);
    }
    if (path === `/projects/${PROJECT_PUBLIC}/acceptance/criteria-decisions/pending`) {
      criteriaReads += 1;
      return reply(proposalsHeld ? PROPOSALS : { ...PROPOSALS, count: 0, oldestAgeSeconds: null, decidableCount: 0, pending: [] });
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
        if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
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
    if (path === '/providers' || path === '/providers/pools' || path === '/providers/shared-pools' || path === '/session-tags' || path === '/task-lists' || path === '/runners' || path === '/watches' || path === '/watches?state=ACTIVE' || path === '/watches?state=PAUSED' || path === '/watches?needsAttention=true') return reply([]);
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
    // Back to the environment's own focus detection, which is what the next suite should get.
    focusManager.setFocused(undefined);
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
  const nextClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
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

describe('the start card in WorkspaceView', { timeout: 60_000 }, () => {
  it('is drawn once in a coordinator conversation, beside the criteria card, through every re-read', async () => {
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    await waitForUi(() => {
      expect(count('.settlement-card.start-card')).toBeGreaterThan(0);
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

  it('is drawn on the coordinator’s request only: a plan with work and no request draws nothing', async () => {
    startRow = null;
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    await waitForUi(() => {
      expect(count('.criteria-decision')).toBeGreaterThan(0);
    });
    await reread(['project', PROJECT_PUBLIC, 'open-items'], () => requested.filter((path) => path.endsWith('/open-items')).length);
    expect(count('.settlement-card'), 'a card was inferred from the project holding a task').toBe(0);

    startRow = START_ROW;
    await reread(['project', PROJECT_PUBLIC, 'open-items'], () => requested.filter((path) => path.endsWith('/open-items')).length);
    await waitForUi(() => {
      expect(count('.settlement-card.start-card')).toBe(1);
    });
  });

  /** What the row and the header say, and what the pinned line names the card by: "Ready to start",
   *  the start card's own status word, rather than an approval nobody is asking for. */
  it('is named Ready to start on the pinned line', async () => {
    proposalsHeld = false;
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    await waitForUi(() => {
      expect(count('.settlement-card.start-card')).toBe(1);
      expect(mounted().querySelector('.decision-strip-title')?.textContent).toBe(READY_TO_START);
    });
  });

  it('starts the project with the settings on the card, and leaves the record — with them — where it happened', async () => {
    proposalsHeld = false;
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    await waitForUi(() => {
      expect(count('.settlement-card.start-card')).toBe(1);
    });
    const card = (): HTMLElement => mounted().querySelector<HTMLElement>('.start-card')!;
    // The plan in one line, off the dependency graph.
    expect(card().querySelector('.start-card-plan')?.textContent).toContain('A starts now · B after A');
    // One setting changed on the card before the press: at most 5 tasks, not the suggested 3.
    const count5 = card().querySelector<HTMLInputElement>('.start-card-count input')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(count5, '5');
      count5.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await waitForUi(() => {
      expect(card().querySelector<HTMLInputElement>('.start-card-count input')?.value).toBe('5');
    });
    const start = [...card().querySelectorAll<HTMLButtonElement>('.settlement-card-actions button')]
      .find((button) => labelOf(button) === START_PROJECT_ACTION)!;
    await act(async () => {
      start.click();
    });
    await waitForUi(() => {
      expect(starts).toHaveLength(1);
    });
    expect(starts[0]).toMatchObject({
      criteriaDigest: SEAL,
      line: 'PROJECT_BRANCH',
      automatic: true,
      maxConcurrentTasks: 5,
      mergeCheckCommand: 'npm test',
      requestId: START_ROW.itemId,
    });
    // The question is answered: the card goes, and the record of the start is drawn in the
    // conversation — "You started", and what it was started with.
    await waitForUi(() => {
      expect(count('.settlement-card')).toBe(0);
      expect(count('.settlement-receipt')).toBe(1);
    });
    const receipt = mounted().querySelector<HTMLElement>('.settlement-receipt')!;
    expect(receipt.querySelector('.settlement-receipt-line')?.textContent)
      .toBe('You started the project on 2 criteria at seal 4fc57753a6ec');
    expect(receipt.querySelector('.settlement-receipt-settings')?.textContent)
      .toContain('Automatic on');
    expect(receipt.querySelector('.run-settings-changed')?.textContent).toContain('5 tasks at a time');
  });
});

/**
 * A started project whose criteria moved: the change card, not the start card and not the older
 * confirmation card — and the record of the press says "You confirmed", with what the confirmed
 * version changed, which only the card that pressed it knew.
 */
describe('the change card in WorkspaceView', { timeout: 60_000 }, () => {
  it('confirms the new criteria, and the record says what the confirmation changed', async () => {
    projectStartedAt = '2026-09-11T03:00:00.000Z';
    startRow = null;
    proposalsHeld = false;
    const [first] = STANDING.currentVersion.material;
    confirmationStanding = {
      state: 'STALE',
      confirmed: false,
      currentVersion: STANDING.currentVersion,
      confirmation: {
        criteriaDigest: `0ld${'0'.repeat(61)}`,
        criteriaMaterial: [first!],
        confirmedAt: '2026-09-11T03:00:00.000Z',
        confirmedById: 'user-1',
        startedWith: null,
      },
      changesSinceConfirmed: {
        added: [{ key: 'k2', ordinal: 2, text: 'condition 2 holds' }],
        stricter: [],
        revised: [],
        removed: [],
        unchanged: [1],
      },
      changesSinceConfirmedAbsentReason: null,
    };
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    await waitForUi(() => {
      expect(count('.criteria-change-card')).toBe(1);
      expect(mounted().querySelector('.decision-strip-title')?.textContent).toBe(CRITERIA_CHANGE_TITLE);
    });
    expect(count('.settlement-card'), 'the moved set was asked about by two cards').toBe(1);

    const confirm = [...mounted().querySelectorAll<HTMLButtonElement>('.criteria-change-card .settlement-card-actions button')]
      .find((button) => labelOf(button) === criteriaChangeConfirmLabel(2))!;
    await act(async () => {
      confirm.click();
    });
    await waitForUi(() => {
      expect(count('.settlement-card')).toBe(0);
      expect(mounted().querySelector('.settlement-receipt .settlement-receipt-line')?.textContent)
        .toBe('You confirmed 2 criteria at seal 4fc57753a6ec — 1 new');
    });
    // A confirmation that started nothing carries no settings.
    expect(count('.settlement-receipt-settings')).toBe(0);
  });
});

describe('what a session row and its header say while the start card waits', () => {
  it('says Ready to start, not Waiting for approval', async () => {
    const { sessionLine, statusLabel } = await import('./WorkspaceView');
    const waiting = { ...COORDINATOR, status: 'AWAITING_INPUT', runStatus: 'AWAITING_INPUT', runState: 'AWAITING_INPUT', engineTurnActive: false, pendingApprovals: 1, waitingKind: 'START_REQUEST' };
    expect(sessionLine(waiting, true)).toEqual({ text: READY_TO_START, tone: 'approval' });
    expect(statusLabel(waiting)).toBe(READY_TO_START);
    // The same count with no kind of its own keeps the approval wording.
    expect(sessionLine({ ...waiting, waitingKind: null }, true).text).toBe('Waiting for approval');
  });
});

/**
 * THE RECORD WHERE IT HAPPENED, AND NOT AT THE TAIL OF THE PANE.
 *
 * The QUESTION is drawn at the bottom of the conversation and belongs there: it is true now, and
 * the pinned strip points down at it. The record of the answer is not that — it is a fact about a
 * moment — and held by the card it sat under every later message for the life of the project, in
 * conversations started long afterwards and after the project was done. Only the view can hold
 * this: it is a fact about where a row lands in a transcript that moves, off the same read the
 * card asks its question from (`acceptanceConfirmationQuery`).
 */
describe('the record a confirmation leaves, in the conversation it was made in', { timeout: 60_000 }, () => {
  const OPENING_AT = '2026-09-11T03:10:00Z';
  /** After the opening event and before every later one, so where the record belongs is a fact
   *  about the transcript rather than about which poll happened to land first. */
  const SIGNED_AT = '2026-09-11T03:10:30Z';

  /** The set somebody signed, at `at`. */
  const signed = (at = SIGNED_AT): StandardSetConfirmationStanding => ({
    state: 'CONFIRMED',
    confirmed: true,
    currentVersion: STANDING.currentVersion,
    confirmation: {
      criteriaDigest: SEAL,
      criteriaMaterial: STANDING.currentVersion.material,
      confirmedAt: at,
      confirmedById: 'user-1',
    },
  });

  beforeEach(() => {
    // A signed set belongs to a project that has been started, which has no request left open.
    projectStartedAt = SIGNED_AT;
    startRow = null;
  });

  it('is drawn among the events, above what came after it, and not at the pane’s tail', async () => {
    confirmationStanding = signed();
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    await waitForUi(() => {
      expect(count('.settlement-receipt')).toBe(1);
    });
    // A signed set is not a question, so no card is drawn beside the record.
    expect(count('.settlement-card')).toBe(0);

    await note(COORDINATOR_PUBLIC, 2);
    const receipt = mounted().querySelector<HTMLElement>('.settlement-receipt')!;
    const later = mounted().querySelector<HTMLElement>('[data-seq="3"]');
    expect(later, 'the message published after the signing is not in the conversation').toBeTruthy();
    expect(
      receipt.compareDocumentPosition(later!) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the record is drawn below a message that came after it — a tail, not the moment it happened',
    ).toBeTruthy();
    // And it is IN the flow: the next thing after it is an event, which no tail card can be.
    expect(receipt.nextElementSibling?.hasAttribute('data-seq')).toBe(true);
    // Nothing pressable on a record, wherever it is drawn.
    expect(receipt.querySelectorAll('button'), 'a record is not a question').toHaveLength(0);
  });

  it('is drawn once, through every re-read of the read it comes from', async () => {
    confirmationStanding = signed();
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    await waitForUi(() => {
      expect(count('.settlement-receipt')).toBe(1);
    });
    for (const round of [1, 2]) {
      await note(COORDINATOR_PUBLIC, round);
      await reread(acceptanceConfirmationKey(PROJECT_PUBLIC), () => confirmationReads);
    }
    expect(count('.settlement-receipt'), 'a re-read drew a second copy of one record').toBe(1);
  });

  /**
   * A record older than every event this device holds — a coordinator conversation opened a month
   * after the set was signed — leads at the HEAD of the window, above the conversation's first row.
   * Dropping it (what this used to do, and what the native clients did) left the owner with no way
   * to find the record at all; drawing it at the tail is what put the day-one receipt under the
   * newest message in every conversation the project ever had.
   */
  it('leads at the head of a conversation whose window begins after it was signed', async () => {
    confirmationStanding = signed(OPENING_AT.replace('03:10:00', '02:00:00'));
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    await waitForUi(() => {
      expect(mounted().textContent).toContain(`${NOTE[COORDINATOR_PUBLIC]}, opening`);
    });
    await note(COORDINATOR_PUBLIC, 1);
    const receipt = document.querySelector<HTMLElement>('.settlement-receipt');
    expect(receipt, 'the record older than this window was not drawn at all').toBeTruthy();
    const first = mounted().querySelector<HTMLElement>('[data-seq]');
    expect(first, 'the conversation drew no event to compare against').toBeTruthy();
    expect(
      receipt!.compareDocumentPosition(first!) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the record is not ahead of the first loaded event',
    ).toBeTruthy();
  });

  it('is drawn in no conversation that coordinates no project, which reads nothing for one', async () => {
    confirmationStanding = signed();
    await mount(`/sessions/${ORDINARY_PUBLIC}`);
    await waitForUi(() => {
      expect(mounted().textContent).toContain(`${NOTE[ORDINARY_PUBLIC]}, opening`);
    });
    expect(count('.settlement-receipt')).toBe(0);
    expect(
      requested.filter((path) => path.endsWith('/acceptance/confirmation')),
      'a conversation with no project read the confirmation door',
    ).toEqual([]);
  });
});

/**
 * The second action's whole job: it arms the ONE composer at the bottom of the page and presses
 * nothing. Only the view can hold this — the card is handed a callback, and whether that callback
 * reaches the composer, leaves the card up and leaves starting the project live is a fact about the
 * page the two live on.
 */
/** The words ON a button. A card that holds the keyboard draws its key inside the button it
 *  presses (`CardHotkey.ts`), as a span of its own: what the control does is the label, and what
 *  presses it is not. */
const labelOf = (button: HTMLButtonElement): string => {
  const hint = button.querySelector<HTMLElement>('.approval-kbd');
  const text = button.textContent ?? '';
  return (hint?.textContent ? text.replace(hint.textContent, '') : text).trim();
};

describe('Chat about this on the start card', { timeout: 60_000 }, () => {
  it('arms the composer with this plan, keeps the card up with Start the project live, and reaches no door', async () => {
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    await waitForUi(() => {
      expect(count('.settlement-card')).toBe(1);
    });
    const card = (): HTMLElement => mounted().querySelector<HTMLElement>('.settlement-card')!;
    const actions = (): HTMLButtonElement[] => [
      ...card().querySelectorAll<HTMLButtonElement>('.settlement-card-actions button'),
    ];
    // Exactly two, and it is the second one that hands the reply over.
    expect(actions().map(labelOf)).toEqual([START_PROJECT_ACTION, OWNER_SEND_BACK_ACTION]);
    expect(count('.composer-replyto'), 'the composer was already armed').toBe(0);
    const requestedBefore = requested.length;

    await act(async () => {
      actions()[1]!.click();
    });

    // replyTo is set: the bar names this plan, and the composer asks for what should change.
    await waitForUi(() => {
      expect(count('.composer-replyto')).toBe(1);
    });
    expect(mounted().querySelector('.composer-replyto-text')?.textContent)
      .toBe(`${ACCEPTANCE_PLAN_CHANGE_PREFIX}the criteria seal`);
    expect(
      [...mounted().querySelectorAll('textarea')].map((box) => box.getAttribute('placeholder')),
      'the armed composer does not ask what should change before it starts',
    ).toContain(START_CHAT_PLACEHOLDER);

    // The card is still there and its own way out is still live.
    expect(count('.settlement-card'), 'the card went away when it handed the reply over').toBe(1);
    expect(actions()[0]!.disabled, 'Start the project went dead with the handoff').toBe(false);
    // No text box grew inside the card — the sentence is typed in the one composer at the bottom —
    // and nothing was written anywhere.
    expect(card().querySelectorAll('textarea')).toHaveLength(0);
    expect(requested.slice(requestedBefore), 'arming the composer asked the server for something')
      .toEqual([]);
  });

  /**
   * 2026-10-03: the owner pressed Chat about this, typed a question and pressed Enter, and the
   * project started 68 ms after the message was sent. The send empties the composer before the key
   * reaches the window, where the card answers Enter on a focused field with no text in it
   * (`CardHotkey.ts`), so one press did both. A browser commits the emptied composer in the
   * microtask it runs between the page's listener and the window's; jsdom runs none there, so the
   * document listener below commits it at that same point.
   */
  it('sends what was typed on Enter without starting the project, and Enter on the emptied box starts it', async () => {
    // The start card alone is asking, so it holds Enter — as it did on the owner's screen.
    proposalsHeld = false;
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    await waitForUi(() => {
      expect(count('.settlement-card')).toBe(1);
    });
    const card = (): HTMLElement => mounted().querySelector<HTMLElement>('.settlement-card')!;
    const actions = (): HTMLButtonElement[] => [
      ...card().querySelectorAll<HTMLButtonElement>('.settlement-card-actions button'),
    ];
    await waitForUi(() => {
      expect(actions()[0]!.querySelector('.approval-kbd')?.textContent, 'Start the project holds no key')
        .toBe(ENTER_HINT);
    });

    await act(async () => {
      actions()[1]!.click();
    });
    await waitForUi(() => {
      expect(count('.composer-replyto')).toBe(1);
    });
    const box = mounted().querySelector<HTMLTextAreaElement>('.composer-box textarea')!;
    expect(box.placeholder).toBe(START_CHAT_PLACEHOLDER);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, 'move it to orbit-develop first?');
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
    box.focus();

    const commitBeforeTheWindow = (): void => flushSync(() => {});
    document.addEventListener('keydown', commitBeforeTheWindow);
    try {
      await act(async () => {
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      });
    } finally {
      document.removeEventListener('keydown', commitBeforeTheWindow);
    }

    await waitForUi(() => {
      expect(sendTurnMock).toHaveBeenCalledTimes(1);
    });
    expect(sendTurnMock.mock.calls[0]![1]).toContain('move it to orbit-develop first?');
    expect(starts, 'the Enter that sent the message also pressed Start the project').toEqual([]);
    expect(count('.settlement-card'), 'the card went away').toBe(1);

    // With nothing left to send, Enter is the card's again.
    expect(box.value).toBe('');
    await act(async () => {
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    await waitForUi(() => {
      expect(starts, 'Enter on the empty composer no longer reaches the card').toHaveLength(1);
    });
    expect(sendTurnMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * The OTHER settlement card's second press — the project's, not the criteria set's. It is the one
 * press on that card that is not a decision: the agent that owns the project is this conversation,
 * so the hand-over is a turn in it, and whether that turn is actually sent (rather than arming a
 * composer and waiting for a sentence) is a fact about the page the two live on.
 */
describe('Ask the coordinator to handle it, on the project settlement card', { timeout: 60_000 }, () => {
  it('sends the card’s own facts as a turn, and leaves the card where it stands', async () => {
    settlementHeld = true;
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    await waitForUi(() => {
      expect(count('.project-settlement')).toBe(1);
    });
    const card = (): HTMLElement => mounted().querySelector<HTMLElement>('.project-settlement')!;
    const actions = (): HTMLButtonElement[] => [
      ...card().querySelectorAll<HTMLButtonElement>('.project-settlement-actions button'),
    ];
    // One press and it is not a question: this project's set is confirmed, so the only thing on the
    // card that can move is the work, and the work is this conversation's.
    expect(actions().map(labelOf)).toEqual([SETTLEMENT_DELEGATE_ACTION]);
    expect(sendTurnMock, 'the page sent something before the press').not.toHaveBeenCalled();

    await act(async () => {
      actions()[0]!.click();
    });

    await waitForUi(() => {
      expect(sendTurnMock).toHaveBeenCalledTimes(1);
    });
    const [session, content] = sendTurnMock.mock.calls[0]!;
    // To this conversation, which is the one that coordinates the project the card is about.
    expect(session).toBe(COORDINATOR_PUBLIC);
    // The facts ARE the message: they name what is withheld and what would clear it, so the agent
    // reads the card's own account of the project rather than a sentence about it.
    expect(content).toContain('Orbit has not recorded it done');
    expect(content).toContain('land the branch, or record the merge with merge_receipt');
    // The card is not an answer to anything, so it stays where it was.
    expect(count('.project-settlement'), 'the card went away when it handed the work over').toBe(1);
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
    expect(element, 'the card has nothing to hand its reply to').toContain('onChatAbout=');
  });

  /**
   * Where the armed send goes, which no render in jsdom reaches: `sendTurn` is the real module here
   * and a turn is not started against a stub. So the branch is read out of the source, as the
   * mount above is — the same thing `ComposerHandoffWiringTests.swift` does at the other end.
   *
   * What is pinned is the one way this target differs from the other three: it starts an ORDINARY
   * turn. The other three each name a door (`decide`, `ownerDecision.mutate`); a send through this
   * branch that grew one would have this card answering a call that nobody made. The project
   * settlement card's press was the other kind on this branch until 2026-09-25; it now sends its
   * own turn from its own handler, with no armed reply and nothing typed, so this branch is the
   * plan change's alone.
   */
  it('sends a plan change as an ordinary turn carrying the plan, through no door', () => {
    const source = workspaceView();
    // The whole line: the disarm effect above carries the same kind and ends in `return;`, and this
    // is the branch that sends.
    const at = source.indexOf("if (replyTo.target.kind === 'planChange') {");
    expect(at, 'nothing in onSend handles an armed plan change').toBeGreaterThan(-1);
    // To the end of the branch: the `return` that leaves onSend's replyTo block.
    const branch = source.slice(at, source.indexOf('\n      }', at));
    expect(branch, 'the send does not start an ordinary turn').toContain('send.mutate({');
    expect(branch, 'the typed message does not carry the plan in front of it').toContain('carried');
    for (const door of ['decide(', 'ownerDecision.mutate', 'confirmAcceptanceCriteria']) {
      expect(branch, `a plan change was routed through ${door}`).not.toContain(door);
    }
    // And the plan it carries is built once, by the card that owns those words.
    expect(source).toContain('context: acceptancePlanChangeContext(plan)');
  });
});
