// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenItemChat, ProjectOpenItemRow, ProjectPromotionView } from '@orbit/shared';
import type { Runner } from './TasksSidePanel';
import {
  CHAT_ABOUT_INTENT,
  CHAT_ABOUT_THIS,
  CHAT_FACTS_AS_ARMED,
  CHAT_SUBJECT_GONE,
  COORDINATOR_CHAT_PLACEHOLDER,
  EXCEPTION_CHAT_PREFIX,
  MERGE_CHAT_PREFIX,
} from '../lib/coordinatorChat';
import { IT_IS_YOURS } from './ProjectPromotionCard';

/**
 * "Chat about this" where the owner meets it: the real WorkspaceView, on the project's coordinator
 * conversation, drawing an exception that became the owner's — a task's (task-scoped) — and a merge
 * into main a check blocked, whose item names no task (promotion-scoped), both escalated: the card
 * that used to say "It is yours · waiting" and offer nothing.
 *
 * What only the view can show: that the press arms THIS conversation's composer, that what is typed
 * goes out as an ordinary turn with the card's facts — the project, the item, what failed, where it
 * stands — in front of it, that arming and sending press no door (no hand-back, no rerun, no merge),
 * and that a press made outside the conversation (`?intent=chat-about`) arrives armed the same way.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  return {
    ...actual,
    api: vi.fn(),
    getSessionEventPage: vi.fn(),
    listApprovals: vi.fn(),
    sendTurn: vi.fn(),
    uploadAttachment: vi.fn(),
  };
});
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));

const { api, getSessionEventPage, listApprovals, sendTurn, uploadAttachment } = await import('../api');
const apiMock = vi.mocked(api);
const sendTurnMock = vi.mocked(sendTurn);
const { WorkspaceView } = await import('./WorkspaceView');
const { encodeId } = await import('../lib/idCodec');

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000061';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000062');
const COORDINATOR_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000063');
const PROJECT_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000064');
const TASK_ITEM = encodeId('0195c0de-0000-7000-8000-000000000065');
const PROMOTION_ITEM = encodeId('0195c0de-0000-7000-8000-000000000066');
const PROMOTION_ID = encodeId('0195c0de-0000-7000-8000-000000000067');
const TASK_ID = encodeId('0195c0de-0000-7000-8000-000000000068');
const PROJECT_TITLE = 'the merge seal';

const RUNNER = {
  id: RUNNER_ID,
  name: 'mac-01',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

const COORDINATOR = {
  id: COORDINATOR_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  projectId: PROJECT_PUBLIC,
  projectTitle: PROJECT_TITLE,
  title: 'coordinating the merge seal',
  status: 'AWAITING_INPUT',
  runStatus: 'AWAITING_INPUT',
  runState: 'AWAITING_INPUT',
  provider: 'claude',
  createdAt: '2026-09-11T03:00:00Z',
  updatedAt: '2026-09-11T03:10:00Z',
};

const CHAT: OpenItemChat = { sessionId: COORDINATOR_PUBLIC, stage: 'WITH_OWNER', refusal: null };

/** Task-scoped: a task's third failure, which the clock handed to the owner. */
const TASK_ROW: ProjectOpenItemRow = {
  itemId: TASK_ITEM,
  kind: 'TASK_FAILED',
  title: 'Task failed: P5.1 实现游戏 Route Handlers',
  detailLine: 'the acceptance command exited 1 where 0 was declared',
  assignee: 'OWNER',
  assigneeReason: 'ESCALATED',
  waitingSince: '2026-09-11T01:00:00.000Z',
  escalateAt: null,
  escalatedAt: '2026-09-11T03:00:00.000Z',
  taskId: TASK_ID,
  sessionId: null,
  promotionId: null,
  fuseEpisodeId: null,
  delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
  actions: ['ASK_COORDINATOR_AGAIN', 'OPEN_TASK_SESSION', 'CANCEL_TASK'],
  question: null,
  facts: null,
  handling: null,
  outcome: null,
  chat: CHAT,
};

/** Promotion-scoped: the merge of the project branch into main its MERGE_CHECK blocked. */
const PROMOTION_ROW: ProjectOpenItemRow = {
  ...TASK_ROW,
  itemId: PROMOTION_ITEM,
  kind: 'INTEGRATION_CHECK_FAILED',
  title: 'Checks failed on the combined tree: merging the project branch into main',
  detailLine: 'MERGE_CHECK exited 1 on the combined tree; main did not move',
  taskId: null,
  promotionId: PROMOTION_ID,
  // What the server lists for an escalated merge failure while there is a coordinator to ask: the
  // way back to it, and the merge card (§4.7).
  actions: ['ASK_COORDINATOR_AGAIN', 'REVIEW'],
};

const BLOCKED: ProjectPromotionView = {
  promotionId: PROMOTION_ID,
  state: 'BLOCKED',
  sourceKind: 'PROJECT_BRANCH',
  sourceRef: 'project/merge-seal',
  sourceSha: 'd'.repeat(40),
  upstreamRef: 'main',
  commitsAhead: 2,
  filesChanged: 4,
  taskIds: [TASK_ID],
  tasks: [{ taskId: TASK_ID, title: 'P5.1 实现游戏 Route Handlers' }],
  checks: [{
    name: 'MERGE_CHECK',
    command: 'npm test',
    expectedExitCode: 0,
    exitCode: 1,
    timedOut: false,
    durationMs: 90_000,
    outputTail: 'FAIL\n',
  }],
  conflicts: [],
  upstreamShaChecked: 'f'.repeat(40),
  upstream: { syncedAt: null, conflicts: false },
  landsTreeSha: null,
  landsAs: 'MERGE_COMMIT',
  askedAt: null,
  recheckedAt: null,
  recheck: null,
  decidedAt: '2026-09-11T01:00:00.000Z',
  merged: null,
};

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

/** Every request the page made, as `METHOD path`. */
const requested: string[] = [];
let openItems: { needsYou: ProjectOpenItemRow[]; withCoordinator: ProjectOpenItemRow[]; settled: ProjectOpenItemRow[] };
let promotion: ProjectPromotionView | null = BLOCKED;
/** Every element `scrollIntoView` was called on, in order — jsdom has no `scrollIntoView` of its own. */
let scrolledTo: Element[] = [];
let search = '';
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

/** The doors a chat must never knock on: the hand-back, a rerun, a cancel, a close, the merge. */
function doorsPressed(): string[] {
  return requested.filter((request) =>
    request.startsWith('POST') || request.startsWith('PATCH') || request.startsWith('PUT'));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  FakeEventSource.open = [];
  requested.length = 0;
  search = '';
  openItems = { needsYou: [TASK_ROW, PROMOTION_ROW], withCoordinator: [], settled: [] };
  promotion = BLOCKED;
  scrolledTo = [];
  focusManager.setFocused(false);
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  apiMock.mockReset();
  vi.mocked(getSessionEventPage).mockReset();
  vi.mocked(getSessionEventPage).mockImplementation(async () => ({
    events: [{ seq: 1, type: 'assistant', payload: { text: 'coordinating, opening' }, turnId: 'turn-1', ts: '2026-09-11T03:10:00Z' }],
    hasMore: false,
  }));
  vi.mocked(listApprovals).mockReset();
  vi.mocked(listApprovals).mockImplementation(async () => []);
  sendTurnMock.mockReset();
  sendTurnMock.mockImplementation(async () => ({
    turnId: 'turn-sent',
    seq: 2,
    kind: 'message',
    placement: 'accepted',
  }));
  apiMock.mockImplementation(((path: string, init?: { method?: string }) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    requested.push(`${init?.method ?? 'GET'} ${path}`);
    if (path === `/projects/${PROJECT_PUBLIC}`) {
      return reply({
        id: PROJECT_PUBLIC,
        title: PROJECT_TITLE,
        status: 'OPEN',
        coordinatorEnabled: true,
        coordinatorSessionId: COORDINATOR_PUBLIC,
        startedAt: '2026-09-10T00:00:00.000Z',
        _count: { tasks: 1 },
        acceptanceCriteriaItems: [],
      });
    }
    if (path === `/projects/${PROJECT_PUBLIC}/open-items`) return reply(openItems);
    if (path === `/projects/${PROJECT_PUBLIC}/promotions/current`) return reply(promotion);
    if (path === `/projects/${PROJECT_PUBLIC}/promotions/merged`) return reply([]);
    if (path === `/projects/${PROJECT_PUBLIC}/acceptance/confirmation`) return reply(null);
    if (path === `/projects/${PROJECT_PUBLIC}/acceptance/criteria-decisions/pending`) {
      return reply({ readAt: '2026-09-11T03:10:00.000Z', projectId: PROJECT_PUBLIC, count: 0, oldestAgeSeconds: null, decidableCount: 0, pending: [] });
    }
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
    if (path.startsWith(`/sessions/${COORDINATOR_PUBLIC}`)) {
      if (path.includes('/turns')) return reply([]);
      if (path.includes('/approvals')) return reply([]);
      if (path.includes('/background')) return reply([]);
      if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      if (path.includes('/diff')) return reply({ files: [] });
      return reply(COORDINATOR);
    }
    if (path.startsWith('/sessions')) return reply([COORDINATOR]);
    if (path.startsWith('/tasks/evidence-decisions/pending')) {
      return reply({ decidingSessionId: COORDINATOR_PUBLIC, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
    }
    if (path.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
    if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
    return reply([]);
  }) as unknown as typeof api);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: () => {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value(this: Element) {
      scrolledTo.push(this);
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
    delete (URL as { createObjectURL?: unknown }).createObjectURL;
    delete (URL as { revokeObjectURL?: unknown }).revokeObjectURL;
    focusManager.setFocused(undefined);
    vi.unstubAllGlobals();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  }
});

/** Where the router is, read where a case can see it. */
function LocationProbe(): null {
  search = useLocation().search;
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
            <LocationProbe />
          </AntApp>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

function armedBar(): string | null {
  return mounted().querySelector('.composer-replyto-text')?.textContent ?? null;
}

/** Types into the one composer and sends it with Enter, as the owner does. */
async function typeAndSend(words: string): Promise<void> {
  const box = mounted().querySelector<HTMLTextAreaElement>('.composer-box textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, words);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  box.focus();
  await act(async () => {
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
  await waitForUi(() => {
    expect(sendTurnMock).toHaveBeenCalledTimes(1);
  });
}

/** Pastes one screenshot into the composer, as from the clipboard. */
async function pasteImage(): Promise<void> {
  const box = mounted().querySelector<HTMLTextAreaElement>('.composer-box textarea')!;
  const png = new File([new Uint8Array([137, 80, 78, 71])], 'failure.png', { type: 'image/png' });
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', {
    value: { items: [{ kind: 'file', getAsFile: () => png }] },
  });
  await act(async () => {
    box.dispatchEvent(paste);
  });
}

/** Presses Enter in the composer with nothing typed. */
async function sendAsIs(): Promise<void> {
  const box = mounted().querySelector<HTMLTextAreaElement>('.composer-box textarea')!;
  box.focus();
  await act(async () => {
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  });
}

/** The task card's press, made and armed. */
async function armOnTheTaskCard(): Promise<void> {
  await mount(`/sessions/${COORDINATOR_PUBLIC}`);
  const card = (): Element | null => mounted().querySelector(`[data-open-item="${TASK_ITEM}"]`);
  await waitForUi(() => {
    expect(card(), 'the escalated card is not drawn').not.toBeNull();
  });
  await act(async () => chatPressOn(card()!).click());
  await waitForUi(() => {
    expect(armedBar()).toBe(`${EXCEPTION_CHAT_PREFIX}${TASK_ROW.title}`);
  });
}

/** The project's items read again, as its 20-second poll would. */
async function itemsMove(next: typeof openItems): Promise<void> {
  openItems = next;
  await act(async () => {
    await client!.invalidateQueries({ queryKey: ['project', PROJECT_PUBLIC, 'open-items'] });
  });
}

function chatPressOn(card: Element): HTMLButtonElement {
  const press = [...card.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent?.trim() === CHAT_ABOUT_THIS);
  if (!press) throw new Error('no Chat about this on the card');
  return press;
}

describe('Chat about this in the coordinator conversation', { timeout: 60_000 }, () => {
  it('task-scoped, escalated: arms this composer with the item, and sends it as an ordinary turn carrying the project, the item, what failed and where it stands — through no door', async () => {
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    const card = (): Element | null => mounted().querySelector(`[data-open-item="${TASK_ITEM}"]`);
    await waitForUi(() => {
      expect(card(), 'the escalated card is not drawn').not.toBeNull();
    });
    expect(armedBar()).toBeNull();
    const before = requested.length;

    await act(async () => chatPressOn(card()!).click());
    await waitForUi(() => {
      expect(armedBar()).toBe(`${EXCEPTION_CHAT_PREFIX}${TASK_ROW.title}`);
    });
    expect(
      [...mounted().querySelectorAll('textarea')].map((box) => box.getAttribute('placeholder')),
    ).toContain(COORDINATOR_CHAT_PLACEHOLDER);
    expect(requested.slice(before), 'arming the composer asked the server for something').toEqual([]);

    await typeAndSend('what would it take to land this today?');
    const [sessionId, content] = sendTurnMock.mock.calls[0]!;
    expect(sessionId).toBe(COORDINATOR_PUBLIC);
    expect(content).toContain(`About the exception in “${PROJECT_TITLE}”:`);
    expect(content).toContain(TASK_ROW.title);
    expect(content).toContain(TASK_ROW.detailLine);
    expect(content).toContain('Where it stands: the owner’s now — no one acted on it for 2h');
    expect(content).toContain(`project ${PROJECT_PUBLIC} · open item ${TASK_ITEM} · task ${TASK_ID}`);
    expect(String(content).endsWith('\n\nwhat would it take to land this today?')).toBe(true);
    expect(doorsPressed(), 'the chat pressed a door').toEqual([]);
    expect(armedBar(), 'the bar stayed armed after the send').toBeNull();
  });

  it('promotion-scoped, “It is yours · waiting”: the blocked merge card offers the chat beside its press, and the send carries the candidate', async () => {
    await mount(`/sessions/${COORDINATOR_PUBLIC}`);
    const preview = (): Element | null => mounted().querySelector(`#promotion-${PROMOTION_ID}`);
    await waitForUi(() => {
      expect(preview(), 'the blocked merge card is not drawn').not.toBeNull();
    });
    // The candidate is a compact preview in the transcript; its presses are in the review it opens.
    await act(async () => preview()!.querySelector<HTMLButtonElement>('.review-card-preview')!.click());
    const card = (): Element | null =>
      document.querySelector('.review-card-dialog[data-open] .project-promotion[data-state="BLOCKED"]');
    await waitForUi(() => {
      expect(card(), 'the preview did not open the blocked candidate').not.toBeNull();
    });
    const waiting = [...card()!.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent?.startsWith(IT_IS_YOURS));
    expect(waiting?.disabled, 'the merge became pressable').toBe(true);
    expect(chatPressOn(card()!).disabled).toBe(false);

    await act(async () => chatPressOn(card()!).click());
    await waitForUi(() => {
      expect(armedBar()).toBe(`${MERGE_CHAT_PREFIX}project/merge-seal can’t merge into main yet`);
      // The review gives way to the composer it armed, as the other cards' Chat about this does.
      expect(card(), 'the review stayed open over the armed composer').toBeNull();
    });
    await typeAndSend('is the red the baseline or the work?');
    const content = String(sendTurnMock.mock.calls[0]![1]);
    expect(content).toContain(`About the merge of project/merge-seal into main in “${PROJECT_TITLE}”`);
    expect(content).toContain('Why: checks failed on the combined tree: npm test · exit 1');
    expect(content).toContain(`Exception: ${PROMOTION_ROW.title}`);
    expect(content).toContain('Where it stands: the owner’s now — no one acted on it for 2h');
    expect(content).toContain(`promotion ${PROMOTION_ID} · open item ${PROMOTION_ITEM}`);
    expect(doorsPressed(), 'the chat pressed a door').toEqual([]);
  });
});

describe('what the send carries is read at the send', { timeout: 60_000 }, () => {
  it('handed back to the coordinator after the press: says where the item stands now', async () => {
    await armOnTheTaskCard();
    // "Ask the coordinator again", pressed on the card — or anywhere else — before the sentence goes.
    await itemsMove({
      needsYou: [PROMOTION_ROW],
      withCoordinator: [{
        ...TASK_ROW,
        assignee: 'COORDINATOR',
        assigneeReason: 'DEFAULT',
        waitingSince: new Date(Date.now() - 60_000).toISOString(),
        escalateAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
        escalatedAt: null,
        actions: ['OPEN_COORDINATOR', 'OPEN_TASK_SESSION', 'RETRY', 'CANCEL_TASK'],
        chat: { ...CHAT, stage: 'WITH_COORDINATOR' },
      }],
      settled: [],
    });
    expect(armedBar(), 'the chat stays armed while its item moves').toBe(
      `${EXCEPTION_CHAT_PREFIX}${TASK_ROW.title}`,
    );

    await typeAndSend('can you take it from here?');
    const content = String(sendTurnMock.mock.calls[0]![1]);
    expect(content).toContain('Where it stands: waiting on the coordinator for');
    expect(content).not.toContain('the owner’s now');
    expect(content).not.toContain(CHAT_FACTS_AS_ARMED);
    expect(content.endsWith('\n\ncan you take it from here?')).toBe(true);
    expect(doorsPressed()).toEqual([]);
  });

  it('gone from the reads since the press: goes as the card read then, and says so', async () => {
    await armOnTheTaskCard();
    await itemsMove({ needsYou: [PROMOTION_ROW], withCoordinator: [], settled: [] });

    await typeAndSend('what happened to it?');
    const content = String(sendTurnMock.mock.calls[0]![1]);
    expect(content.startsWith(`${CHAT_FACTS_AS_ARMED}\n\nAbout the exception in “${PROJECT_TITLE}”:`)).toBe(true);
    expect(content).toContain('Where it stands: the owner’s now — no one acted on it for 2h');
    expect(content.endsWith('\n\nwhat happened to it?')).toBe(true);
  });

  it('an image alone goes too, behind the card’s facts — no door waits on a note', async () => {
    vi.mocked(uploadAttachment).mockReset();
    vi.mocked(uploadAttachment).mockResolvedValue({ id: 'att-failure' } as never);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => 'blob:failure' });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => {} });
    await armOnTheTaskCard();

    await pasteImage();
    await waitForUi(() => {
      expect(uploadAttachment).toHaveBeenCalledTimes(1);
    });
    await act(async () => {});
    await sendAsIs();
    await waitForUi(() => {
      expect(sendTurnMock).toHaveBeenCalledTimes(1);
    });
    const [sessionId, content, attachmentIds] = sendTurnMock.mock.calls[0]!;
    expect(sessionId).toBe(COORDINATOR_PUBLIC);
    expect(String(content).startsWith(`About the exception in “${PROJECT_TITLE}”:`)).toBe(true);
    expect(String(content)).toContain(`open item ${TASK_ITEM}`);
    expect(attachmentIds).toEqual(['att-failure']);
    expect(armedBar(), 'the bar stayed armed after the send').toBeNull();
    expect(doorsPressed().filter((request) => !request.includes('/attachments'))).toEqual([]);
  });
});

describe('arriving from a Chat about this pressed elsewhere', { timeout: 60_000 }, () => {
  it('an item: the composer arrives armed for it, and the intent goes', async () => {
    await mount(`/sessions/${COORDINATOR_PUBLIC}?intent=${CHAT_ABOUT_INTENT}&item=${TASK_ITEM}`);
    await waitForUi(() => {
      expect(armedBar()).toBe(`${EXCEPTION_CHAT_PREFIX}${TASK_ROW.title}`);
    });
    await waitForUi(() => {
      expect(search, 'the intent stayed in the URL').toBe('');
    });
    expect(doorsPressed()).toEqual([]);
  });

  it('a blocked merge: the composer arrives armed for the candidate', async () => {
    await mount(`/sessions/${COORDINATOR_PUBLIC}?intent=${CHAT_ABOUT_INTENT}&promotion=${PROMOTION_ID}`);
    await waitForUi(() => {
      expect(armedBar()).toBe(`${MERGE_CHAT_PREFIX}project/merge-seal can’t merge into main yet`);
    });
    await waitForUi(() => {
      expect(search).toBe('');
    });
  });

  it('brings the card it is about into view once the transcript under it has landed', async () => {
    await mount(`/sessions/${COORDINATOR_PUBLIC}?intent=${CHAT_ABOUT_INTENT}&item=${TASK_ITEM}`);
    await waitForUi(() => {
      expect(armedBar()).toBe(`${EXCEPTION_CHAT_PREFIX}${TASK_ROW.title}`);
    });
    await waitForUi(() => {
      expect(scrolledTo.map((element) => element.getAttribute('data-open-item'))).toContain(TASK_ITEM);
    });
  });

  it('brings the blocked merge card into view, for a press made on it elsewhere', async () => {
    await mount(`/sessions/${COORDINATOR_PUBLIC}?intent=${CHAT_ABOUT_INTENT}&promotion=${PROMOTION_ID}`);
    await waitForUi(() => {
      expect(scrolledTo.map((element) => element.id)).toContain(`promotion-${PROMOTION_ID}`);
    });
  });

  it('a merge no longer blocked: nothing is armed about why it could not happen, and it says so', async () => {
    // The coordinator's re-check passed between the press and the arrival: the same candidate now
    // asks to be merged, with its approval item beside it.
    promotion = {
      ...BLOCKED,
      state: 'READY',
      checks: BLOCKED.checks.map((check) => ({ ...check, exitCode: 0, outputTail: '' })),
      askedAt: '2026-09-11T03:05:00.000Z',
      decidedAt: null,
    };
    openItems = {
      needsYou: [TASK_ROW, {
        ...PROMOTION_ROW,
        kind: 'PROMOTION_APPROVAL',
        title: 'Merge 2 tasks into main?',
        detailLine: '',
        assigneeReason: 'DEFAULT',
        escalatedAt: null,
        actions: ['REVIEW'],
      }],
      withCoordinator: [],
      settled: [],
    };
    await mount(`/sessions/${COORDINATOR_PUBLIC}?intent=${CHAT_ABOUT_INTENT}&promotion=${PROMOTION_ID}`);
    await waitForUi(() => {
      expect(search).toBe('');
    });
    await waitForUi(() => {
      expect(document.body.textContent).toContain(CHAT_SUBJECT_GONE);
    });
    expect(armedBar()).toBeNull();
  });

  it('something that has moved on since: nothing is armed, and it says so', async () => {
    openItems = { needsYou: [PROMOTION_ROW], withCoordinator: [], settled: [] };
    await mount(`/sessions/${COORDINATOR_PUBLIC}?intent=${CHAT_ABOUT_INTENT}&item=${TASK_ITEM}`);
    await waitForUi(() => {
      expect(search).toBe('');
    });
    await waitForUi(() => {
      expect(document.body.textContent).toContain(CHAT_SUBJECT_GONE);
    });
    expect(armedBar()).toBeNull();
  });
});
