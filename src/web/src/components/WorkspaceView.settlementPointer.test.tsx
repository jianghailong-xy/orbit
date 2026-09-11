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
  CRITERIA_ROW_LABEL,
  SETTLEMENT_ROW_LABEL,
  needsDecisionCount,
  type PendingDecisionQueue,
} from './DecisionRail';
import { ACCEPTANCE_CONFIRM_LABEL, ACCEPTANCE_NOT_YET_LABEL } from './AcceptanceConfirmationCard';
import {
  acceptanceConfirmationKey,
  type StandardSetConfirmationStanding,
} from '../lib/acceptanceConfirmation';

/**
 * The settlement question in the pinned strip, where the owner meets it: the real WorkspaceView, a
 * coordinator conversation whose settlement card is drawn, the ways that card stops being a question
 * — confirmed at another end, put down, never drawn — and the pages that never draw one.
 *
 * The strip is told whether the card is on screen and still a question, and the card is what tells
 * it (`SessionAcceptanceConfirmationCard`'s `onOpenQuestion`, kept by the page). That wiring is the
 * claim, so nothing here hands the strip that answer: every case mounts the page and lets the card
 * report. Every "no row" is asserted on a strip that is drawn and open, beside a row it does carry or
 * after the row it carried, so an empty strip is never a strip that was not going to say anything.
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

/** A weakening held against the same project: a question the strip already lists, so the settlement
 *  row is measured as one MORE row rather than as the strip appearing at all. */
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
 *  file. No card is drawn for it anywhere, and the strip lists it regardless — so the strip is
 *  there, with something in it for the settlement row to be absent beside. */
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
const rows = (): HTMLElement[] => [...(strip()?.querySelectorAll<HTMLElement>('.decision-rail-row') ?? [])];
/** The strip's rows, each as the kind of question it is, so the list can be compared whole. */
const rowKinds = (): string[] =>
  rows().map((row) => {
    const text = row.textContent ?? '';
    if (text.includes(SETTLEMENT_ROW_LABEL)) return 'settlement';
    if (text.includes(CRITERIA_ROW_LABEL)) return 'weakening';
    if (text.includes(ORDINARY_ROW_TITLE)) return 'evidence';
    return `unrecognised: ${text}`;
  });
const settlementRows = (): HTMLElement[] =>
  rows().filter((row) => (row.textContent ?? '').includes(SETTLEMENT_ROW_LABEL));
const settlementCards = (): HTMLElement[] => [...mounted().querySelectorAll<HTMLElement>('.settlement-card')];

/** Opens the strip once it is drawn. On a desktop the rows are behind the fold, and opening it is a
 *  deliberate act; the strip keeps it open across conversations, so this presses only if it is shut. */
async function unfold(): Promise<void> {
  await waitForUi(() => {
    expect(strip()?.querySelector('.decision-strip-line'), 'the strip was never drawn').toBeTruthy();
  });
  const line = strip()!.querySelector<HTMLButtonElement>('.decision-strip-line')!;
  if (line.getAttribute('aria-expanded') !== 'true') {
    await act(async () => {
      line.click();
    });
  }
}

/** A coordinator conversation whose settlement card has been drawn and pointed at, strip open.
 *  Asserts only what the cases below stand on, so each of them fails on its own claim. */
async function coordinatorWithTheCard(): Promise<void> {
  await mount(`/sessions/${COORDINATOR_PUBLIC}`);
  await waitForUi(() => {
    expect(settlementCards()).toHaveLength(1);
  });
  await unfold();
  await waitForUi(() => {
    expect(rowKinds()).toEqual(['weakening', 'settlement']);
  });
  expect([...new Set(unstubbed)], 'every endpoint the page reads is stubbed').toEqual([]);
}

describe('the settlement question in the pinned strip', { timeout: 60_000 }, () => {
  it('is one more row, pointing at the card, while the card is on screen and still a question', async () => {
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    await waitForUi(() => {
      expect(settlementCards()).toHaveLength(1);
    });
    await unfold();
    // Beside the weakening the strip already listed: exactly one row more, and it is this one.
    await waitForUi(() => {
      expect(rowKinds()).toEqual(['weakening', 'settlement']);
    });
    expect(strip()!.querySelector('.decision-strip-count')?.textContent).toBe(needsDecisionCount(2));
    expect(settlementRows()[0]!.querySelector('button.decision-rail-pointer'), 'the row is not a pointer').toBeTruthy();
  });

  it('stops pointing once the set is confirmed at another end, while the card stays where it was', async () => {
    await coordinatorWithTheCard();
    server.standing = standingOf('CONFIRMED');
    await reread(acceptanceConfirmationKey(PROJECT_PUBLIC), () => confirmationReads);
    // The confirmation has reached the card: still on the page, and saying it was answered.
    await waitForUi(() => {
      expect(settlementCards()[0]?.querySelector('.settlement-card-stale')?.textContent ?? '').toContain('Already confirmed');
    });
    await waitForUi(() => {
      expect(rowKinds(), 'a set confirmed at another end is still pointed at as a question').toEqual(['weakening']);
    });
    expect(settlementCards()).toHaveLength(1);
  });

  it('points at nothing while the card has not been drawn, and at the card once it is', async () => {
    server.criteria = criteriaOf(true, false);
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    await unfold();
    // Drawn, open, listing what it does list, and both of the card's reads answered.
    await waitForUi(() => {
      expect(rowKinds()).toContain('weakening');
      expect(confirmationReads).toBeGreaterThan(0);
      expect(documentReads).toBeGreaterThan(0);
    });
    await settle();
    expect(rowKinds(), 'the strip pointed at a card that was never drawn').toEqual(['weakening']);
    expect(settlementCards()).toEqual([]);

    // The one fact under test changes, and the same page draws the card and points at it.
    server.criteria = criteriaOf(true, true);
    await reread(['project', PROJECT_PUBLIC], () => documentReads);
    await waitForUi(() => {
      expect(rowKinds()).toEqual(['weakening', 'settlement']);
    });
    expect(settlementCards()).toHaveLength(1);
  });

  it('points at nothing in a conversation that coordinates no project, straight after one that did', async () => {
    await coordinatorWithTheCard();
    await go(`/sessions/${ORDINARY_PUBLIC}`);
    await unfold();
    await waitForUi(() => {
      expect(mounted().textContent).toContain(`${NOTE[ORDINARY_PUBLIC]}, opening`);
      expect(rowKinds()).toContain('evidence');
    });
    await settle();
    expect(rowKinds(), 'a conversation with no project was pointed at a settlement card').toEqual(['evidence']);
    expect(settlementCards()).toEqual([]);
  });

  it('leaves no pointer on New session, and points at the card again on the way back', async () => {
    await coordinatorWithTheCard();
    await go(NEW_SESSION_PATH);
    // New session really is what is on screen, so a missing strip is not a view still loading.
    await waitForUi(() => {
      expect(mounted().querySelector('.workspace-sessions.workspace-draft')).toBeTruthy();
    });
    await settle();
    expect(mounted().textContent, 'New session was left a pointer to a settlement card').not.toContain(SETTLEMENT_ROW_LABEL);
    expect(strip(), 'New session was left the strip').toBeNull();
    expect(settlementCards()).toEqual([]);

    await go(`/sessions/${COORDINATOR_PUBLIC}`);
    await unfold();
    await waitForUi(() => {
      expect(rowKinds()).toEqual(['weakening', 'settlement']);
    });
  });

  it('stops pointing once the card is put down with Not yet', async () => {
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
      expect(rowKinds(), 'a card put down is still pointed at').toEqual(['weakening']);
    });
  });

  it('takes the reader to the card when pressed, and asks the server nothing', async () => {
    await coordinatorWithTheCard();
    const card = settlementCards()[0]!;
    const pointer = settlementRows()[0]!.querySelector<HTMLButtonElement>('button')!;
    const scrolledBefore = scrolled.length;
    const requestedBefore = requested.length;
    await act(async () => {
      pointer.click();
    });
    const arrived = scrolled.slice(scrolledBefore);
    expect(arrived, 'the press scrolled nothing, or more than the card').toHaveLength(1);
    expect(arrived[0], 'the press did not take the reader to the settlement card').toBe(card);
    expect(requested.slice(requestedBefore), 'a press on the pointer asked the server for something').toEqual([]);
  });

  it('offers no answer to the settlement question on the strip, only the way to its card', async () => {
    await coordinatorWithTheCard();
    // Every control the strip has moves the reader somewhere: the fold, and a row that points at a card.
    const ways = ['decision-strip-line', 'decision-rail-criteria-summary', 'decision-rail-pointer'];
    const stray = [...strip()!.querySelectorAll<HTMLButtonElement>('button')]
      .filter((button) => !ways.some((cls) => button.classList.contains(cls)));
    expect(stray.map((button) => button.outerHTML), 'the strip grew a control that goes nowhere').toEqual([]);
    expect(strip()!.textContent).not.toContain(ACCEPTANCE_CONFIRM_LABEL);
    expect(strip()!.textContent).not.toContain(ACCEPTANCE_NOT_YET_LABEL);
    // The answer is still where it lives: on the card.
    expect([...settlementCards()[0]!.querySelectorAll('button')].map((button) => button.textContent))
      .toContain(ACCEPTANCE_CONFIRM_LABEL);
  });
});

describe('the settlement question in the pinned strip on a phone', { timeout: 60_000 }, () => {
  it('is one line that never opens into a list, and the line itself takes the reader to the card', async () => {
    viewport = 393;
    server.proposals = [];
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    await waitForUi(() => {
      expect(settlementCards()).toHaveLength(1);
      expect(strip()?.querySelector('.decision-strip-count')?.textContent).toBe(needsDecisionCount(1));
    });
    const controls = [...strip()!.querySelectorAll<HTMLButtonElement>('button')];
    expect(controls.map((button) => button.className), 'the phone strip is not one line').toEqual(['decision-strip-line']);
    expect(controls[0]!.hasAttribute('aria-expanded'), 'the phone line is a fold').toBe(false);

    const card = settlementCards()[0]!;
    const scrolledBefore = scrolled.length;
    const requestedBefore = requested.length;
    await act(async () => {
      controls[0]!.click();
    });
    expect(requested.slice(requestedBefore), 'the phone line asked the server for something').toEqual([]);
    const arrived = scrolled.slice(scrolledBefore);
    expect(arrived, 'the phone line scrolled nothing, or more than the card').toHaveLength(1);
    expect(arrived[0], 'the phone line did not take the reader to the settlement card').toBe(card);
    expect(strip()!.querySelectorAll('.decision-strip-body, .decision-rail-row'), 'a list opened under the phone line')
      .toHaveLength(0);
  });
});
