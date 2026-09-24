// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
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
import {
  ACCEPTANCE_PLAN_CHANGE_PLACEHOLDER,
  ACCEPTANCE_PLAN_CHANGE_PREFIX,
  ACCEPTANCE_START_LABEL,
} from './AcceptanceConfirmationCard';
import { OWNER_SEND_BACK_ACTION } from './OwnerConfirmationCard';

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
/** The standing the confirmation door serves: `UNCONFIRMED` for most cases, and a case that is
 *  about the RECORD sets one with a confirmation on it. Reset per case like every other stub. */
let confirmationStanding: StandardSetConfirmationStanding = STANDING;
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
  confirmationStanding = STANDING;
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
  apiMock.mockImplementation(((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    requested.push(path);
    if (path === `/projects/${PROJECT_PUBLIC}/acceptance/confirmation`) {
      confirmationReads += 1;
      return reply(confirmationStanding);
    }
    if (path === `/projects/${PROJECT_PUBLIC}`) {
      // `_count` is the fourth fact the card's condition turns on — a project with nothing filed
      // under it is not one anybody can start, which is the state `project_create` returns in.
      return reply({ id: PROJECT_PUBLIC, title: 'the criteria seal', status: 'OPEN', coordinatorEnabled: false, _count: { tasks: 1 }, acceptanceCriteriaItems: CRITERIA });
    }
    // The open items the coordinator question card reads (§5.2). Empty: no question is open in any
    // of these cases, and the card draws nothing — what is asserted here is the strip and the cards
    // beside it, which an unstubbed read would break by being unstubbed rather than by being wrong.
    if (path === `/projects/${PROJECT_PUBLIC}/open-items`) {
      return reply({ needsYou: [], withCoordinator: [] });
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
    if (path === '/providers' || path === '/session-tags' || path === '/task-lists' || path === '/runners' || path === '/watches' || path === '/watches?state=ACTIVE' || path === '/watches?state=PAUSED' || path === '/watches?needsAttention=true') return reply([]);
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

describe('Chat about this on the settlement card', { timeout: 60_000 }, () => {
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
    expect(actions().map(labelOf)).toEqual([ACCEPTANCE_START_LABEL, OWNER_SEND_BACK_ACTION]);
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
      'the armed composer does not ask for what should change',
    ).toContain(ACCEPTANCE_PLAN_CHANGE_PLACEHOLDER);

    // The card is still there and its own way out is still live.
    expect(count('.settlement-card'), 'the card went away when it handed the reply over').toBe(1);
    expect(actions()[0]!.disabled, 'Start the project went dead with the handoff').toBe(false);
    // No box grew inside the card, and nothing was written anywhere.
    expect(card().querySelectorAll('textarea, input')).toHaveLength(0);
    expect(requested.slice(requestedBefore), 'arming the composer asked the server for something')
      .toEqual([]);
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
   * branch that grew one would have this card answering a call that nobody made. The branch is
   * shared with the project settlement card's "Chat about this", which is the same kind of send.
   */
  it('sends a plan change as an ordinary turn carrying the plan, through no door', () => {
    const source = workspaceView();
    // The whole line: the disarm effect carries the same two kinds and ends in `return;`, and this
    // is the branch that sends.
    const at = source.indexOf(
      "if (replyTo.target.kind === 'planChange' || replyTo.target.kind === 'projectSettlement') {",
    );
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
