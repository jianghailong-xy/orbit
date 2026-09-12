// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter, useNavigate, type NavigateFunction } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runner } from './TasksSidePanel';
import type { PendingCriteriaDecisionQueue, PendingCriteriaDecisionRow } from './CriteriaDecisionCard';
import {
  needsDecisionCount,
  waitingOnYouCount,
  wayPosition,
  type PendingDecisionQueue,
} from './DecisionRail';
import { ACCEPTANCE_CONFIRM_LABEL, ACCEPTANCE_NOT_YET_LABEL } from './AcceptanceConfirmationCard';
import {
  acceptanceConfirmationKey,
  type StandardSetConfirmationStanding,
} from '../lib/acceptanceConfirmation';

/**
 * The settlement question on the pinned line, where the owner meets it: the real WorkspaceView, a
 * coordinator conversation whose settlement card is drawn, the ways that card stops being a question
 * — confirmed at another end, put down, never drawn — and the pages that never draw one.
 *
 * The strip is told whether the card is on screen and still a question, and the card is what tells
 * it (`SessionAcceptanceConfirmationCard`'s `onOpenQuestion`, kept by the page). That wiring is the
 * claim, so nothing here hands the strip that answer: every case mounts the page and lets the card
 * report. Every "not counted" is asserted on a line that is drawn, beside a question it does count or
 * after the count it carried, so an empty strip is never a strip that was not going to say anything.
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

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000071';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000072');
const COORDINATOR_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000073');
const PROJECT_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000074');
const ORDINARY_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000075');
/** New session: no conversation selected, so no strip and no card. */
const NEW_SESSION_PATH = `/workspaces/${WORKSPACE_PUBLIC}/new`;
const INTENT = '2SXZNKDyOUtFL540SQ0oz5';
const TASK = '34LMiluvx0jK63cj8arWn';
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

function standingOf(state: StandardSetConfirmationStanding['state']): StandardSetConfirmationStanding {
  const material = [1, 2].map((n) => ({ definitionId: `c${n}`, revision: 1, contentHash: `h${n}` }));
  return {
    state,
    confirmed: state === 'CONFIRMED',
    currentVersion: { digest: SEAL, material },
    confirmation:
      state === 'CONFIRMED'
        ? { criteriaDigest: SEAL, criteriaMaterial: material, confirmedAt: '2026-09-11T03:05:00.000Z', confirmedById: 'owner' }
        : null,
  };
}

/** The project's stated criteria, each met by its work or not. */
const criteriaOf = (...met: boolean[]) =>
  met.map((satisfied, index) => ({ id: `c${index + 1}`, ordinal: index + 1, text: `condition ${index + 1} holds`, satisfied }));

/** A weakening held against the same project: a question the line already counts, so the settlement
 *  question is measured as one MORE rather than as the strip appearing at all. */
function held(): PendingCriteriaDecisionRow {
  const wording = { text: 'the pg spec may be skipped', verificationMethod: 'EXECUTABLE', completionCriterionOverrideReason: null };
  return {
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
  };
}

const proposalsOf = (rows: PendingCriteriaDecisionRow[]): PendingCriteriaDecisionQueue => ({
  readAt: '2026-09-11T03:10:00.000Z',
  projectId: PROJECT_PUBLIC,
  count: rows.length,
  oldestAgeSeconds: rows[0]?.ageSeconds ?? null,
  decidableCount: rows.length,
  pending: rows,
});

const ORDINARY_ROW_TITLE = 'evidence this conversation filed and must resubmit';
/** What the ordinary conversation is shown: its own submission, waiting on a revision only it can
 *  file. No card is drawn for it anywhere, and the strip shows it regardless, on a line of its own —
 *  so the strip is there, with something in it for the settlement question to be absent beside. */
const ORDINARY_QUEUE: PendingDecisionQueue = {
  decidingSessionId: ORDINARY_PUBLIC,
  count: 0,
  oldestAgeSeconds: null,
  pending: [],
  waitingOnYou: [
    {
      taskId: TASK,
      title: ORDINARY_ROW_TITLE,
      projectId: PROJECT_PUBLIC,
      criterion: null,
      evidenceRevision: '1',
      ageSeconds: 600,
      claim: '',
      gaps: [],
      citations: [],
      decidability: {
        decidable: false,
        refusal: 'this evidence quotes no project criterion',
        requiredAction: 'ASK_FOR_EVIDENCE_AGAINST_THE_CURRENT_CRITERION',
      },
      independence: {
        independent: false,
        disqualification: 'this session is a run of the task it is deciding',
        requiredAction: 'DECIDE_FROM_A_SESSION_THAT_DID_NOT_DO_THIS_WORK',
      },
    },
  ],
};

/** What the stubbed server answers right now. Each case starts from settlement held on the owner:
 *  both criteria met, the set unconfirmed, and one weakening waiting beside it. */
const server: {
  standing: StandardSetConfirmationStanding;
  criteria: ReturnType<typeof criteriaOf>;
  proposals: PendingCriteriaDecisionRow[];
} = { standing: standingOf('UNCONFIRMED'), criteria: criteriaOf(true, true), proposals: [held()] };

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

/** Every request the page made, as `METHOD path`, in order. */
const requested: string[] = [];
const unstubbed: string[] = [];
/** Every element `scrollIntoView` was called on, in order. jsdom has no `scrollIntoView` at all, so
 *  this is the whole implementation rather than a spy over one. */
const scrolled: Element[] = [];
let confirmationReads = 0;
let documentReads = 0;
/** The viewport's width as `matchMedia` answers for it: a desktop, unless a case says a phone. */
let viewport = 1280;
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

/** A few macrotask turns, so whatever a read or a report set in motion has been drawn before an
 *  absence is asserted. */
async function settle(): Promise<void> {
  for (let n = 0; n < 5; n += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  FakeEventSource.open = [];
  requested.length = 0;
  unstubbed.length = 0;
  scrolled.length = 0;
  confirmationReads = 0;
  documentReads = 0;
  viewport = 1280;
  navigateTo = null;
  server.standing = standingOf('UNCONFIRMED');
  server.criteria = criteriaOf(true, true);
  server.proposals = [held()];
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
  apiMock.mockImplementation(((path: string, init?: { method?: string }) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    requested.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === `/projects/${PROJECT_PUBLIC}/acceptance/confirmation`) {
      confirmationReads += 1;
      return reply(server.standing);
    }
    if (path === `/projects/${PROJECT_PUBLIC}`) {
      documentReads += 1;
      return reply({ id: PROJECT_PUBLIC, acceptanceCriteriaItems: server.criteria });
    }
    if (path === `/projects/${PROJECT_PUBLIC}/acceptance/criteria-decisions/pending`) {
      return reply(proposalsOf(server.proposals));
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
      return reply(
        path.includes(ORDINARY_PUBLIC)
          ? ORDINARY_QUEUE
          : { decidingSessionId: COORDINATOR_PUBLIC, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] },
      );
    }
    if (path.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
    if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
    if (path === '/providers' || path === '/session-tags' || path === '/task-lists' || path === '/runners') return reply([]);
    unstubbed.push(path);
    return reply([]);
  }) as unknown as typeof api);
  // A viewport `viewport` pixels wide, as far as any `max-width` query can tell.
  vi.stubGlobal('matchMedia', (query: string) => {
    const bound = /max-width:\s*(\d+)px/u.exec(query);
    return {
      matches: bound !== null && viewport <= Number(bound[1]),
      media: query, onchange: null,
      addListener: () => {}, removeListener: () => {},
      addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    };
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value(this: Element): void {
      scrolled.push(this);
    },
  });
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

/** Hands the test the router's own navigate, so leaving a conversation is a real route change. */
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

async function go(path: string): Promise<void> {
  await act(async () => {
    navigateTo!(path);
  });
}

/** One of the card's reads coming round again, as its poll brings it. */
async function reread(queryKey: readonly unknown[], reads: () => number): Promise<void> {
  const before = reads();
  await act(async () => {
    await client!.invalidateQueries({ queryKey, exact: true });
  });
  await waitForUi(() => {
    expect(reads()).toBeGreaterThan(before);
  });
}

const strip = (): HTMLElement | null => mounted().querySelector<HTMLElement>('.decision-strip');
/** The line that counts the questions and goes to their cards: the one line on the strip that is
 *  not a fold. */
const questionLine = (): HTMLButtonElement | null =>
  [...(strip()?.querySelectorAll<HTMLButtonElement>('.decision-strip-line') ?? [])]
    .find((line) => !line.hasAttribute('aria-expanded')) ?? null;
/** What that line counts, as it says it to a screen reader, or null when no such line is drawn. */
const counted = (): string | null =>
  questionLine()?.getAttribute('aria-label')?.split(': ')[0] ?? null;
const settlementCards = (): HTMLElement[] => [...mounted().querySelectorAll<HTMLElement>('.settlement-card')];

/** Presses the line, and returns every element that press scrolled to. */
async function pressLine(): Promise<Element[]> {
  const line = questionLine();
  if (!line) throw new Error('there is no line to press');
  const before = scrolled.length;
  await act(async () => {
    line.click();
  });
  return scrolled.slice(before);
}

/** A coordinator conversation whose settlement card has been drawn beside the held weakening.
 *  Asserts only what the cases below stand on, so each of them fails on its own claim. */
async function coordinatorWithTheCard(): Promise<void> {
  await mount(`/sessions/${COORDINATOR_PUBLIC}`);
  await waitForUi(() => {
    expect(settlementCards()).toHaveLength(1);
    expect(counted()).toBe(needsDecisionCount(2));
  });
  expect([...new Set(unstubbed)], 'every endpoint the page reads is stubbed').toEqual([]);
}

describe('the settlement question on the pinned line', { timeout: 60_000 }, () => {
  it('is one more in the count while the card is on screen and still a question, and opens no list', async () => {
    await coordinatorWithTheCard();
    expect(questionLine()!.hasAttribute('aria-expanded'), 'the line is a fold').toBe(false);
    expect(strip()!.querySelectorAll('.decision-strip-body, .decision-rail-row'), 'a list is drawn under the line')
      .toHaveLength(0);
  });

  it('stops counting it once the set is confirmed at another end, while the card stays where it was', async () => {
    await coordinatorWithTheCard();
    server.standing = standingOf('CONFIRMED');
    await reread(acceptanceConfirmationKey(PROJECT_PUBLIC), () => confirmationReads);
    // The confirmation has reached the card: still on the page, and saying it was answered.
    await waitForUi(() => {
      expect(settlementCards()[0]?.querySelector('.settlement-card-stale')?.textContent ?? '').toContain('Already confirmed');
    });
    await waitForUi(() => {
      expect(counted(), 'a set confirmed at another end is still counted as a question').toBe(needsDecisionCount(1));
    });
    expect(settlementCards()).toHaveLength(1);
  });

  it('counts nothing for the card while it has not been drawn, and counts it once it is', async () => {
    server.criteria = criteriaOf(true, false);
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    // Drawn, counting what it does count, and both of the card's reads answered.
    await waitForUi(() => {
      expect(counted()).toBe(needsDecisionCount(1));
      expect(confirmationReads).toBeGreaterThan(0);
      expect(documentReads).toBeGreaterThan(0);
    });
    await settle();
    expect(counted(), 'the line counted a card that was never drawn').toBe(needsDecisionCount(1));
    expect(settlementCards()).toEqual([]);

    // The one fact under test changes, and the same page draws the card and counts it.
    server.criteria = criteriaOf(true, true);
    await reread(['project', PROJECT_PUBLIC], () => documentReads);
    await waitForUi(() => {
      expect(counted()).toBe(needsDecisionCount(2));
    });
    expect(settlementCards()).toHaveLength(1);
  });

  it('counts nothing for it in a conversation that coordinates no project, straight after one that did', async () => {
    await coordinatorWithTheCard();
    await go(`/sessions/${ORDINARY_PUBLIC}`);
    await waitForUi(() => {
      expect(mounted().textContent).toContain(`${NOTE[ORDINARY_PUBLIC]}, opening`);
      expect(strip()?.textContent ?? '').toContain(waitingOnYouCount(1));
    });
    await settle();
    expect(questionLine(), 'a conversation with no project was given a line to a settlement card').toBeNull();
    expect(settlementCards()).toEqual([]);
  });

  it('leaves no line on New session, and counts the card again on the way back', async () => {
    await coordinatorWithTheCard();
    await go(NEW_SESSION_PATH);
    // New session really is what is on screen, so a missing strip is not a view still loading.
    await waitForUi(() => {
      expect(mounted().querySelector('.workspace-sessions.workspace-draft')).toBeTruthy();
    });
    await settle();
    expect(strip(), 'New session was left the strip').toBeNull();
    expect(settlementCards()).toEqual([]);

    await go(`/sessions/${COORDINATOR_PUBLIC}`);
    await waitForUi(() => {
      expect(counted()).toBe(needsDecisionCount(2));
    });
  });

  it('stops counting it once the card is put down with Not yet', async () => {
    await coordinatorWithTheCard();
    const notYet = [...settlementCards()[0]!.querySelectorAll<HTMLButtonElement>('.settlement-card-actions button')]
      .find((button) => button.textContent === ACCEPTANCE_NOT_YET_LABEL)!;
    await act(async () => {
      notYet.click();
    });
    await waitForUi(() => {
      expect(settlementCards()).toEqual([]);
    });
    await waitForUi(() => {
      expect(counted(), 'a card put down is still counted').toBe(needsDecisionCount(1));
    });
  });

  it('takes the reader to the card with one press when it is the only question, and asks the server nothing', async () => {
    server.proposals = [];
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    await waitForUi(() => {
      expect(settlementCards()).toHaveLength(1);
      expect(counted()).toBe(needsDecisionCount(1));
    });
    const card = settlementCards()[0]!;
    const requestedBefore = requested.length;

    const arrived = await pressLine();

    expect(arrived, 'the press scrolled nothing, or more than the card').toEqual([card]);
    expect(requested.slice(requestedBefore), 'a press on the line asked the server for something').toEqual([]);
    expect(strip()!.querySelectorAll('.decision-strip-body, .decision-rail-row'), 'a list opened under the line')
      .toHaveLength(0);
  });

  it('reaches the card after the weakening drawn above it, one press each, and says which it went to', async () => {
    await coordinatorWithTheCard();
    const card = settlementCards()[0]!;
    const requestedBefore = requested.length;

    const weakening = mounted().querySelector<HTMLElement>('.criteria-decision');
    expect(weakening, 'the weakening card was not drawn').toBeTruthy();
    const first = await pressLine();
    expect(first, 'the first press did not go to the weakening drawn above the settlement card').toEqual([weakening]);
    expect(questionLine()!.textContent).toContain(wayPosition(1, 2));

    const second = await pressLine();
    expect(second, 'the second press did not take the reader to the settlement card').toEqual([card]);
    expect(questionLine()!.textContent).toContain(wayPosition(2, 2));
    expect(requested.slice(requestedBefore), 'a press on the line asked the server for something').toEqual([]);
  });

  it('offers no answer to the settlement question on the strip, only the way to its card', async () => {
    await coordinatorWithTheCard();
    // Every control the strip has moves the reader somewhere: a line, and nothing else.
    const stray = [...strip()!.querySelectorAll<HTMLButtonElement>('button')]
      .filter((button) => !button.classList.contains('decision-strip-line'));
    expect(stray.map((button) => button.outerHTML), 'the strip grew a control that goes nowhere').toEqual([]);
    expect(strip()!.textContent).not.toContain(ACCEPTANCE_CONFIRM_LABEL);
    expect(strip()!.textContent).not.toContain(ACCEPTANCE_NOT_YET_LABEL);
    // The answer is still where it lives: on the card.
    expect([...settlementCards()[0]!.querySelectorAll('button')].map((button) => button.textContent))
      .toContain(ACCEPTANCE_CONFIRM_LABEL);
  });
});

describe('the settlement question on the pinned line on a phone', { timeout: 60_000 }, () => {
  it('is the same one line, and the line itself takes the reader to the card', async () => {
    viewport = 393;
    server.proposals = [];
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    await waitForUi(() => {
      expect(settlementCards()).toHaveLength(1);
      expect(counted()).toBe(needsDecisionCount(1));
    });
    const controls = [...strip()!.querySelectorAll<HTMLButtonElement>('button')];
    expect(controls.map((button) => button.className), 'the phone strip is not one line').toEqual(['decision-strip-line']);
    expect(controls[0]!.hasAttribute('aria-expanded'), 'the phone line is a fold').toBe(false);

    const card = settlementCards()[0]!;
    const requestedBefore = requested.length;
    const arrived = await pressLine();
    expect(requested.slice(requestedBefore), 'the phone line asked the server for something').toEqual([]);
    expect(arrived, 'the phone line scrolled nothing, or more than the card').toEqual([card]);
    expect(strip()!.querySelectorAll('.decision-strip-body, .decision-rail-row'), 'a list opened under the phone line')
      .toHaveLength(0);
  });
});
