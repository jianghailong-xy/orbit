// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectPromotionView } from '@orbit/shared';
import type { Runner } from './TasksSidePanel';
import { MERGED_HEADING } from './ProjectPromotionCard';

/**
 * THE RECORD A MERGE LEAVES, IN THE CONVERSATION IT HAPPENED IN.
 *
 * "✓ Merged into main" was drawn by the pane's card strip, from `/promotions/current`, and that
 * strip is where the cards that ask something NOW live. So the receipt for a merge was pinned to
 * the bottom of the conversation for as long as nothing superseded it — under every later message,
 * in a conversation started afterwards, days after the merge — and when the next candidate appeared
 * the SAME strip drew a different merge in the same place. The owner's report, 2026-09-21: the card
 * "is fixed at the bottom of the conversation" and belongs where the merge happened.
 *
 * Where it happened is a moment, and a promotion that reached MERGED is a record of one: the row is
 * terminal and guarded (`project_promotion_terminal_guard`), it carries its own `merged_sha` and
 * `merged_at`, and the conversation draws it with `decisionReceiptAnchor` — the same rule the
 * criteria, evidence, owner and settlement receipts beside it are drawn by. Only the view can hold
 * this: it is a fact about where a row lands in a transcript that moves, off a read that is not the
 * one the live candidate comes from.
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
const PROMOTION_ID = '3fFMHLbE7JTsr3vHFOzIDM';
const NEXT_PROMOTION_ID = '3fFMHLbE7JTsr3vHFOzIDN';
/** The commit the merge put on main, and the one a later candidate would put there instead. */
const MERGED_SHA = 'd0bae85bc5c687634550ae95bb5a0e4f749f3560';
const NEXT_SOURCE_SHA = 'a286c7a060e3a836ac2b6159cf138b54f584093b';
/** The opening event is at 03:10:00 and the merge at :30 past it, so where the record belongs is a
 *  fact about the transcript rather than about which poll happened to land first. */
const OPENING_AT = '2026-09-11T03:10:00Z';
const MERGED_AT = '2026-09-11T03:10:30Z';
const LATER_AT = '2026-09-11T03:12:00Z';

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
const COORDINATOR = conversation(COORDINATOR_PUBLIC, PROJECT_PUBLIC, 'coordinating the merge');
const ORDINARY = conversation(ORDINARY_PUBLIC, null, 'an ordinary conversation');
const NOTE: Record<string, string> = {
  [COORDINATOR_PUBLIC]: 'coordinator note',
  [ORDINARY_PUBLIC]: 'ordinary note',
};

/** A merge that happened at `at`, as `/promotions/merged` serves one: terminal, and its own. */
function merged(over: Partial<ProjectPromotionView> = {}): ProjectPromotionView {
  return {
    promotionId: PROMOTION_ID,
    state: 'MERGED',
    sourceKind: 'PROJECT_BRANCH',
    sourceRef: 'project/34ODoUKJGEsfbgcJDGS4q',
    sourceSha: 'c9bb07c5d58ca13c1ac116b3b567cf12af6712ae',
    upstreamRef: 'main',
    commitsAhead: 3,
    filesChanged: 12,
    tasks: [{ taskId: '34OEE9DwfWYjo3aRFuBgo', title: 'the exception card’s action row' }],
    taskIds: ['34OEE9DwfWYjo3aRFuBgo'],
    checks: [],
    conflicts: [],
    upstreamShaChecked: '9a1b2c3d4e5f60718293a4b5c6d7e8f901234567',
    upstream: { syncedAt: null, conflicts: false },
    landsTreeSha: null,
    landsAs: 'MERGE_COMMIT',
    askedAt: '2026-09-11T03:00:00Z',
    recheckedAt: null,
    recheck: null,
    merged: { sha: MERGED_SHA, byUserId: 'user-1', at: MERGED_AT },
    ...over,
  };
}

/** The next candidate: state A, asking, and about a different commit than the one that landed. */
function candidate(over: Partial<ProjectPromotionView> = {}): ProjectPromotionView {
  return merged({
    promotionId: NEXT_PROMOTION_ID,
    state: 'READY',
    sourceSha: NEXT_SOURCE_SHA,
    commitsAhead: 7,
    askedAt: '2026-09-11T03:20:00Z',
    merged: null,
    ...over,
  });
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

/** Every path the page asked the api for, in order, and the ones nothing answered for. */
const requested: string[] = [];
const unstubbed: string[] = [];
/** What the two promotion doors serve. Reset per case like every other stub. */
let currentPromotion: ProjectPromotionView | null = null;
let mergesOnRecord: ProjectPromotionView[] = [];
let mergedReads = 0;
let currentReads = 0;
let container: HTMLDivElement | null = null;
let root: Root | null = null;
let client: QueryClient | null = null;

const mounted = (): HTMLDivElement => {
  if (!container) throw new Error('WorkspaceView is not mounted');
  return container;
};
const count = (selector: string): number => mounted().querySelectorAll(selector).length;
const record = (): HTMLElement | null =>
  mounted().querySelector<HTMLElement>('.project-promotion-receipt');
/** Every promotion card drawn anywhere, by state: the strip's question and the transcript's record. */
const cardsOfState = (state: string): number =>
  mounted().querySelectorAll(`.project-promotion[data-state="${state}"]`).length;

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
  currentPromotion = null;
  mergesOnRecord = [];
  mergedReads = 0;
  currentReads = 0;
  container = null;
  root = null;
  client = null;
  // The page keeps interval polls armed while no push stream is up (jsdom connects none): the
  // session list's 4s and the open conversation's 5s. React Query skips an interval's fetch while
  // the tab is not focused, so the tab is declared unfocused — what these cases drive is the
  // stream and `reread()`, and a poll landing inside a case would be a request nobody pressed for.
  focusManager.setFocused(false);
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  apiMock.mockReset();
  vi.mocked(getSessionEventPage).mockReset();
  vi.mocked(getSessionEventPage).mockImplementation(async (id: string) => ({
    events: [{ seq: 1, type: 'assistant', payload: { text: `${NOTE[id]}, opening` }, turnId: 'turn-1', ts: OPENING_AT }],
    hasMore: false,
  }));
  vi.mocked(listApprovals).mockReset();
  vi.mocked(listApprovals).mockImplementation(async () => []);
  apiMock.mockImplementation(((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    requested.push(path);
    if (path === `/projects/${PROJECT_PUBLIC}/promotions/current`) {
      currentReads += 1;
      return reply(currentPromotion);
    }
    // The merges this project has already made — the read the record is drawn from.
    if (path === `/projects/${PROJECT_PUBLIC}/promotions/merged`) {
      mergedReads += 1;
      return reply(mergesOnRecord);
    }
    if (path === `/projects/${PROJECT_PUBLIC}/acceptance/confirmation`) {
      return reply({ state: 'UNCONFIRMED', confirmed: false, currentVersion: { digest: 'd'.repeat(64), material: [] }, confirmation: null });
    }
    if (path === `/projects/${PROJECT_PUBLIC}`) {
      return reply({ id: PROJECT_PUBLIC, title: 'the merge card', status: 'OPEN', coordinatorEnabled: true, _count: { tasks: 1 }, acceptanceCriteriaItems: [], tasksByStatus: {} });
    }
    if (path === `/projects/${PROJECT_PUBLIC}/open-items`) {
      return reply({ needsYou: [], withCoordinator: [] });
    }
    if (path === `/projects/${PROJECT_PUBLIC}/acceptance/criteria-decisions/pending`) {
      return reply({ readAt: OPENING_AT, projectId: PROJECT_PUBLIC, count: 0, oldestAgeSeconds: null, decidableCount: 0, pending: [], settled: [] });
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
    focusManager.setFocused(undefined);
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

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

/** One of the reads coming round again, as its poll brings it: the whole project's, because the
 *  candidate and the merges already made are two doors onto one project's line. */
async function rereadProject(reads: ReadonlyArray<() => number>): Promise<void> {
  const before = reads.map((read) => read());
  await act(async () => {
    await client!.invalidateQueries({ queryKey: ['project', PROJECT_PUBLIC] });
  });
  await waitForUi(() => {
    reads.forEach((read, index) => {
      expect(read()).toBeGreaterThan(before[index]!);
    });
  });
}

/** Moves the conversation on by a note, and waits until the pane has drawn it. */
async function note(sessionId: string, round: number, at = LATER_AT): Promise<void> {
  const text = `${NOTE[sessionId]}, round ${round}`;
  await publish(sessionId, [
    { seq: 1 + round, type: 'assistant', payload: { text }, turnId: 'turn-1', ts: at },
  ]);
  await waitForUi(() => {
    expect(mounted().textContent).toContain(text);
  });
}

describe('the record a merge leaves, in the conversation it happened in', { timeout: 60_000 }, () => {
  it('is drawn among the events, at the moment it happened, and not in the pane’s card strip', async () => {
    mergesOnRecord = [merged()];
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    await waitForUi(() => {
      expect(count('.project-promotion-receipt')).toBe(1);
    });
    // A merge is not a question, so the strip that holds the questions draws nothing for it.
    expect(count('.project-promotion-actions'), 'the receipt was drawn with the merge button').toBe(0);

    await note(COORDINATOR_PUBLIC, 2);
    const receipt = record()!;
    expect(receipt.textContent, 'the record is not the merge that happened').toContain(MERGED_HEADING);
    expect(receipt.textContent, 'the record does not name the commit it put on main').toContain(MERGED_SHA.slice(0, 7));

    // It is IN the flow: the thing after it is an event of the conversation, not the strip.
    expect(receipt.nextElementSibling?.hasAttribute('data-seq')).toBe(true);
    const later = mounted().querySelector<HTMLElement>('[data-seq="3"]');
    expect(later, 'the message published after the merge is not in the conversation').toBeTruthy();
    expect(
      receipt.compareDocumentPosition(later!) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the record is drawn below a message that came after the merge — a tail, not its moment',
    ).toBeTruthy();
  });

  it('still says its own merge once the project has moved on to the next candidate', async () => {
    mergesOnRecord = [merged()];
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    await waitForUi(() => {
      expect(count('.project-promotion-receipt')).toBe(1);
    });

    // The next candidate is offered: `/promotions/current` moves on to a different commit, which is
    // exactly the moment the old card used to start describing a merge that had not happened.
    currentPromotion = candidate();
    await rereadProject([() => currentReads, () => mergedReads]);

    await waitForUi(() => {
      expect(cardsOfState('READY'), 'the next candidate is not being asked about').toBe(1);
    });
    expect(count('.project-promotion-receipt'), 'the merge stopped being drawn at all').toBe(1);
    const receipt = record()!;
    expect(receipt.getAttribute('data-state'), 'the record followed the new candidate').toBe('MERGED');
    expect(receipt.textContent, 'the record now names a commit that never landed').toContain(MERGED_SHA.slice(0, 7));
    expect(receipt.textContent, 'the record took the next candidate’s commit').not.toContain(NEXT_SOURCE_SHA.slice(0, 7));
    // One record and one question: the merge is not redrawn as the thing being asked about.
    expect(count('.project-promotion-receipt')).toBe(1);
  });

  it('leads at the head of a conversation whose window begins after the merge', async () => {
    mergesOnRecord = [merged({ merged: { sha: MERGED_SHA, byUserId: 'user-1', at: '2026-09-11T02:00:00Z' } })];
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    await waitForUi(() => {
      expect(mounted().textContent).toContain(`${NOTE[COORDINATOR_PUBLIC]}, opening`);
    });
    // Older than every loaded event: drawn ABOVE the conversation's first row, not dropped and not
    // at the tail (see `decisionReceiptAnchor`) — a record that disappears on a long conversation
    // is a record the owner cannot find, and one under everything after it says it happened now.
    const receipt = record()!;
    const first = mounted().querySelector<HTMLElement>('[data-seq]');
    expect(first, 'the conversation drew no event to compare against').toBeTruthy();
    expect(
      receipt.compareDocumentPosition(first!) & Node.DOCUMENT_POSITION_FOLLOWING,
      'the record is not ahead of the first loaded event',
    ).toBeTruthy();
  });

  it('is drawn in no conversation that coordinates no project, which reads nothing for one', async () => {
    mergesOnRecord = [merged()];
    await mount(`/sessions/${ORDINARY_PUBLIC}`);
    await waitForUi(() => {
      expect(mounted().textContent).toContain(`${NOTE[ORDINARY_PUBLIC]}, opening`);
    });
    expect(count('.project-promotion-receipt')).toBe(0);
    expect(
      requested.filter((path) => path.endsWith('/promotions/merged')),
      'a conversation with no project read the merges of one',
    ).toEqual([]);
  });
});

/**
 * The negative control: nothing that is not a merge is drawn as one. The events carry no promotion
 * payload — an event that merely TALKS about merging is a message, and it stays one.
 */
describe('what is not a record', { timeout: 60_000 }, () => {
  it('draws no card, and leaves the events as themselves, when nothing has merged', async () => {
    currentPromotion = candidate();
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    await waitForUi(() => {
      expect(cardsOfState('READY'), 'no candidate is being asked about').toBe(1);
    });
    expect(count('.project-promotion-receipt'), 'a receipt was drawn for a project that merged nothing').toBe(0);
  });

  it('draws a message about merging as a message, not as a card made out of it', async () => {
    mergesOnRecord = [merged()];
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    await waitForUi(() => {
      expect(count('.project-promotion-receipt')).toBe(1);
    });
    // An event that mentions the merge in its text and carries junk shaped like a promotion
    // payload: read off its own fields it is an ordinary reply, and drawing it as a card would be
    // inventing a second record for a merge that already has one.
    const text = 'the merge into main landed at 15:28';
    await publish(COORDINATOR_PUBLIC, [
      {
        seq: 4,
        type: 'assistant',
        payload: { text, promotion: { sha: MERGED_SHA, state: 'MERGED' } },
        turnId: 'turn-2',
        ts: LATER_AT,
      },
    ]);
    await waitForUi(() => {
      expect(mounted().textContent).toContain(text);
    });
    expect(count('.project-promotion-receipt'), 'an event with a promotion-shaped payload became a card').toBe(1);
    expect(cardsOfState('MERGED'), 'the merge was drawn twice').toBe(1);
  });
});

describe('the card strip', { timeout: 60_000 }, () => {
  it('does not keep a card of its own for a promotion that has already merged', async () => {
    currentPromotion = merged();
    mergesOnRecord = [merged()];
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    await waitForUi(() => {
      expect(count('.project-promotion-receipt')).toBe(1);
    });
    expect(
      cardsOfState('MERGED'),
      'the merged promotion is drawn twice: the strip keeps a card for a merge that already happened',
    ).toBe(1);
    expect(count('.project-promotion-actions')).toBe(0);
  });
});

describe('where the record comes from', () => {
  /** Both spellings, because the web suite runs from `src/web` and a runner may start at the root. */
  const source = (): string => {
    const found = ['src/components/WorkspaceView.tsx', 'src/web/src/components/WorkspaceView.tsx']
      .map((each) => resolve(process.cwd(), each))
      .find(existsSync);
    if (!found) throw new Error(`WorkspaceView.tsx is not under ${process.cwd()}`);
    return readFileSync(found, 'utf8');
  };

  it('reads the merges already made, and places each one where it happened', () => {
    const view = source();
    expect(view, 'the pane never reads the merges this project has made').toContain(
      'projectMergedPromotionsQuery',
    );
    expect(view, 'the record is not anchored to the moment it happened').toContain(
      'decisionReceiptAnchor(transcriptEvents,',
    );
    expect(view, 'the strip was not told that the record is drawn in the transcript').toContain(
      'drawMergedRecord={false}',
    );
  });
});
