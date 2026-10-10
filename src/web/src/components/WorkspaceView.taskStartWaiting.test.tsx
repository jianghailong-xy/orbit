// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ConfirmationReturnCard,
  ConfirmationReviewRequestCard,
  OpenItemDeliveryCard,
  ProjectStartedCard,
  SessionMessageCard,
  SessionReplyCard,
  TaskStartCard,
} from '@orbit/shared';
import type { ActiveSessionTurn, TurnCards } from '../api';
import type { Runner } from './TasksSidePanel';
import type { RunEvent } from './Transcript';

/**
 * A run resumed on a session it already has is handed its brief as a turn of that session, and the
 * console draws that turn as the task it was built from — a TaskStartCard — never as the brief, the
 * protocol written for the agent, in the reader's own bubble. That has to hold for as long as the
 * brief waits: queued behind the turn its run is still working on, and then as the accepted head that
 * a busy or absent runner has not taken yet.
 *
 * The rows are what `GET /sessions/:id/turns?view=active` lists in each of those states (the
 * apiserver's task-run-resume-card.pg.spec.ts walks a real press through them), and they go through
 * the console itself: a queued row into its queued tail, an accepted one into the placeholder the
 * transcript draws until the echo lands (`acceptedUserTurnEvent`). That placeholder used to copy three
 * of the cards a row can carry by hand, so the last cases hand it every card there is.
 */

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>();
  // These live in api.ts and call its module-local `api`, so replacing the exported `api` alone
  // would never intercept them.
  return { ...actual, api: vi.fn(), getSessionEventPage: vi.fn(), listQueuedTurns: vi.fn() };
});
// jsdom has no IndexedDB, and a cached transcript would seed the window instead of the stub.
vi.mock('../lib/transcriptStore', () => ({
  loadTranscript: async () => null,
  saveTranscript: async () => {},
}));
// The placeholder's event, as the console builds it for the transcript: watched, not replaced.
vi.mock('../lib/acceptedUserTurn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/acceptedUserTurn')>();
  return { ...actual, acceptedUserTurnEvent: vi.fn(actual.acceptedUserTurnEvent) };
});

const { api, getSessionEventPage, listQueuedTurns } = await import('../api');
const apiMock = vi.mocked(api);
const { WorkspaceView } = await import('./WorkspaceView');
const { acceptedUserTurnEvent, turnCardsOf, TURN_CARD_FIELDS } = await import('../lib/acceptedUserTurn');
const placeholderEvent = vi.mocked(acceptedUserTurnEvent);
const { encodeId } = await import('../lib/idCodec');

const TS = '2026-10-06T06:40:00.000Z';

// ── the resumed run ───────────────────────────────────────────────────────────────────────────

const TASK: TaskStartCard = {
  taskId: '01a0cca7-8609-70ed-a0e2-d4b55b832b70',
  title: 'task-run 恢复 brief 排队时画成 TaskStart 卡',
  description: '在已有会话上恢复运行的任务，brief 排队时也画成 TaskStart 卡。',
  acceptanceCriteria: 'the pg spec passes on an isolated database',
  completionCriterion: 'EVIDENCE_JUDGMENT',
  acceptanceCommand: null,
  acceptanceExpectedExitCode: null,
  listInstructions: 'New tests go in new files.',
  project: { id: '01a0cca0-aeaa-7618-bd5a-caccc089108c', title: '统一排队与已投递消息的卡片渲染' },
  auto: false,
};
/** The brief the run is handed, as the apiserver writes it (tasks/task-execution-prompt.ts). */
const BRIEF = [
  `请开始执行任务「${TASK.title}」。`,
  '',
  `任务描述：\n${TASK.description}`,
  '',
  `验收标准（判定本任务是否完成的依据）：\n${TASK.acceptanceCriteria}`,
  '',
  `作业指导（本任务列表通用）：\n${TASK.listInstructions}`,
  '',
  '请按以下步骤进行：',
  '1. 先用 task_get 查看该任务的完整信息与历史评论。',
  '2. 执行任务。',
  '3. 完成后，用 task_evidence_submit 提交完成证据信封。',
  '4. 如果执行失败或未能完成，先用 task_comment 说明原因，再用 task_update 将状态（status）置为 FAILED。',
].join('\n');

const briefRow = (placement: 'queued' | 'accepted'): ActiveSessionTurn => ({
  turnId: 'turn-brief',
  kind: 'message',
  placement,
  content: BRIEF,
  createdAt: TS,
  attachments: [],
  taskStart: TASK,
  authoredByOrbit: true,
});

/** The owner's message the run is working on when the brief arrives, and what the run said to it. */
const OWNER_WORDS = 'first, rebase onto main';
const OWNER_TURN: RunEvent = { seq: 11, type: 'user', turnId: 'turn-owner', ts: TS, payload: { text: OWNER_WORDS } };
const RUN_REPLY: RunEvent = { seq: 12, type: 'assistant', turnId: 'turn-owner', ts: TS, payload: { text: 'Rebased.' } };

// ── one card of each kind ─────────────────────────────────────────────────────────────────────

const ITEM: OpenItemDeliveryCard = {
  itemId: '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6d',
  kind: 'INTEGRATION_CONFLICT',
  title: 'Merge conflict: 回填历史 user 事件的 controlPlaneNote',
  task: {
    id: '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6e',
    title: '回填历史 user 事件的 controlPlaneNote',
    sessionId: '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6f',
  },
  files: ['src/web/src/components/Transcript.tsx'],
  targetRef: 'refs/heads/project/34ODoUKJGEsfbgcJDGS4q',
  check: null,
  errorCode: null,
  failure: null,
  actions: ['OPEN_COORDINATOR', 'OPEN_TASK_SESSION', 'RETRY', 'CANCEL_TASK'],
  landing: { receipts: 0, state: 'NOT_KNOWN', upstream: 'main', integration: 'main' },
};
const STARTED: ProjectStartedCard = {
  by: 'CONFIRMATION',
  projectId: '01a0cca0-aeaa-7618-bd5a-caccc089108c',
  projectTitle: '统一排队与已投递消息的卡片渲染',
  criteriaCount: 4,
  held: [{ id: '01a0cca7-84ec-75cf-9b65-b94a4ce3bf70', title: '服务端：ingest 与 listQueuedTurns 共用一个 readTurnCards' }],
  heldCount: 1,
};
const REVIEW_REQUEST: ConfirmationReviewRequestCard = {
  requestId: '01a0cca7-0000-7000-8000-0000000000a1',
  reviewId: '01a0cca7-0000-7000-8000-0000000000a2',
  taskId: '01a0cca7-0000-7000-8000-0000000000a3',
  title: '会话间请求与回复：修复 P1 审查发现的问题',
  runSessionId: '01a0cca7-0000-7000-8000-0000000000a4',
  branch: 'orbit/p1-1c207b',
  sha: '59d98153ef85c565646fede291f66f61940573c7',
  dueAt: '2026-10-06T07:10:00.000Z',
};
const RETURNED: ConfirmationReturnCard = {
  requestId: '01a0cca7-0000-7000-8000-0000000000a1',
  recordId: '01a0cca7-0000-7000-8000-0000000000b1',
  reviewerSessionId: '01a0cca7-0000-7000-8000-0000000000b2',
  reviewerTitle: '会话间消息参数与回复设计',
  reason: 'Two of the six findings are not fixed on the branch.',
  problems: [{ key: 'p1', text: 'P1-3 still sends the reply twice' }],
};
const FROM: SessionMessageCard = {
  fromSessionId: '01a0cca7-8609-70ed-a0e2-d4b55b832b61',
  fromTitle: 'Worker: migration review',
  fromAgentName: 'orbit',
};
const REPLY: SessionReplyCard = {
  requestId: 'req1',
  outcome: 'REPLIED',
  fromSessionId: '00000000-0000-4000-8000-000000000001',
  fromTitle: '分析 session 列表页性能',
  requestPreview: '再跑一组只读探针',
  replyText: '全部只读执行',
};

/** Every card a turn can carry. `Required` holds it to `TurnCards`: a card added there does not
 *  compile here until it is given a value. */
const EVERY_CARD: Required<TurnCards> = {
  openItemDelivery: ITEM,
  taskStart: TASK,
  projectStarted: STARTED,
  confirmationReviewRequest: REVIEW_REQUEST,
  confirmationReturn: RETURNED,
  sessionMessage: FROM,
  sessionReplies: [REPLY],
};

/** Each card as the accepted row that carries it alone, with the element it is drawn as. Outcomes held
 *  for a session ride on the owner's next message, so the reply cards come with the owner's words. */
const ACCEPTED_ONE_CARD_EACH: { field: keyof TurnCards; content: string; drawnAs: string }[] = [
  { field: 'openItemDelivery', content: '【例外待办】合并时冲突，请处理。', drawnAs: '.oic' },
  { field: 'taskStart', content: BRIEF, drawnAs: '.tsc' },
  { field: 'projectStarted', content: 'The owner started this project.', drawnAs: '.psc' },
  { field: 'confirmationReviewRequest', content: '<orbit-confirmation-review/>', drawnAs: '.crc:not(.is-returned)' },
  { field: 'confirmationReturn', content: '<orbit-confirmation-return/>', drawnAs: '.crc.is-returned' },
  { field: 'sessionMessage', content: 'please review the migration before I merge it', drawnAs: '.smc' },
  { field: 'sessionReplies', content: 'what did the coordinator say?', drawnAs: '.src-wrap' },
];

// ── the console ───────────────────────────────────────────────────────────────────────────────

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000041';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000042');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000043');

const RUNNER = {
  id: RUNNER_ID,
  name: 'mac-01',
  online: true,
  maxConcurrent: 2,
  activeSessions: 1,
  engines: [{ engine: 'claude', installed: true, auth: 'yes' }],
} satisfies Runner;

const SESSION = {
  id: SESSION_PUBLIC,
  workspaceId: WORKSPACE_PUBLIC,
  runnerId: RUNNER_ID,
  title: `执行任务：${TASK.title}`,
  status: 'RUNNING',
  provider: 'claude',
  createdAt: '2026-10-06T05:00:00Z',
  updatedAt: TS,
};

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

const mounted: { root: Root; el: HTMLDivElement }[] = [];
let client: QueryClient;

/** The console open on the run, its transcript holding `events` and its queue listing `rows`. */
async function openConsole(rows: ActiveSessionTurn[], events: RunEvent[]): Promise<HTMLDivElement> {
  vi.mocked(listQueuedTurns).mockImplementation(async () => rows);
  vi.mocked(getSessionEventPage).mockResolvedValue({ events, hasMore: false } as never);
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/sessions/${SESSION_PUBLIC}`]}>
          <WorkspaceView runner={RUNNER} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return el;
}

/** Wait for the console to draw what `check` asserts. The act environment is off meanwhile
 *  (WorkspaceView.queuedTurnWake's `waitForUi`): renders scheduled inside an act callback would not
 *  flush until it settles. */
async function drawn(check: () => void): Promise<void> {
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  env.IS_REACT_ACT_ENVIRONMENT = false;
  try {
    await vi.waitFor(check, { timeout: 20_000, interval: 20 });
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = true;
  }
  await act(async () => {});
}

/** No bubble in the reader's name holds the brief: it is on the card, one disclosure away
 *  ("What the agent was told"), and nowhere else. */
function expectNoBubbleOfTheBrief(el: HTMLElement): void {
  for (const bubble of el.querySelectorAll('.chat-user')) {
    expect(bubble.textContent, 'the brief is drawn as the reader’s own message').not.toContain('请开始执行任务');
  }
  const told = [...el.querySelectorAll('pre')].filter((pre) => pre.textContent === BRIEF);
  expect(told, 'the brief is not kept verbatim on its card').toHaveLength(1);
  expect(told[0].closest('.tsc-raw')).not.toBeNull();
}

/** The reader's own bubbles, by what they say. */
const bubbles = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('.chat-user .md')].map((md) => md.textContent?.trim() ?? '');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  placeholderEvent.mockClear();
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  vi.stubGlobal('EventSource', FakeEventSource);
  apiMock.mockReset();
  apiMock.mockImplementation((path: string) => {
    const reply = (value: unknown) => Promise.resolve(value) as Promise<never>;
    if (path === '/users/me') {
      return reply({ id: 'user-1', email: 'reader@example.com', name: 'Reader', createdAt: '2026-01-01T00:00:00Z', preferences: {} });
    }
    if (path === '/workspaces') {
      return reply([{ id: WORKSPACE_PUBLIC, name: 'orbit', runnerId: RUNNER_ID, createdAt: '2026-01-01T00:00:00Z', lastProvider: 'claude' }]);
    }
    if (path.startsWith(`/sessions/${SESSION_PUBLIC}`)) {
      if (path.includes('/events/page')) return reply({ events: [], hasMore: false });
      if (path.includes('/diff')) return reply({ files: [] });
      if (path.includes('/turns') || path.includes('/approvals') || path.includes('/background')) return reply([]);
      if (path.includes('/created-tasks')) return reply({ total: 0, running: 0, failed: 0, done: 0, items: [], projects: [] });
      return reply(SESSION);
    }
    if (path.startsWith('/sessions')) return reply([SESSION]);
    if (path.startsWith('/tasks/evidence-decisions/pending')) {
      return reply({ decidingSessionId: null, count: 0, oldestAgeSeconds: null, pending: [], waitingOnYou: [] });
    }
    if (path.startsWith('/tasks/page')) return reply({ items: [], nextCursor: null });
    if (path.startsWith('/tasks')) return reply({ items: [], total: 0, counts: {} });
    return reply([]);
  });
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
  // Taken down while the globals it was mounted with are still the stubs.
  for (const { root, el } of mounted.splice(0)) {
    await act(async () => root.unmount());
    el.remove();
  }
  await client.cancelQueries();
  client.clear();
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  vi.unstubAllGlobals();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

// ── the brief, waiting ────────────────────────────────────────────────────────────────────────

describe('a resumed run’s brief, while it waits, is drawn as its TaskStartCard', { timeout: 60_000 }, () => {
  it('queued behind the turn its run is working on: the card, with the queue’s line at its foot', async () => {
    const el = await openConsole([briefRow('queued')], [OWNER_TURN]);
    await drawn(() => expect(el.querySelectorAll('.tsc-wrap')).toHaveLength(1));

    const card = el.querySelector('.tsc-wrap')!;
    expect(card.querySelector('.tsc.is-queued'), 'drawn as still queued').not.toBeNull();
    expect(card.querySelector('.tsc-title')?.textContent).toBe(TASK.title);
    expect(card.querySelector('[data-seq]'), 'a queued turn is no event for ⌘F to land on').toBeNull();
    const line = card.querySelector('.tsc-queued > .chat-queued-meta');
    expect(line, 'the queue’s line is not in the card’s own slot').not.toBeNull();
    expect(line!.querySelector('.chat-queued-tag')?.textContent).toBe('Queued for next turn');
    expect([...line!.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Cancel']);

    expectNoBubbleOfTheBrief(el);
    // The one bubble is the owner's own message, the turn the run is working on.
    expect(bubbles(el)).toEqual([OWNER_WORDS]);
  });

  it('the accepted head no runner has taken yet: the card, drawn from the placeholder', async () => {
    const el = await openConsole([briefRow('accepted')], [OWNER_TURN, RUN_REPLY]);
    await drawn(() => expect(el.querySelectorAll('.tsc-wrap')).toHaveLength(1));

    // Drawn by the transcript from the placeholder the console built off the snapshot row.
    const built = placeholderEvent.mock.calls.filter(([turn]) => turn.turnId === 'turn-brief');
    expect(built.length, 'the accepted head was drawn from no placeholder').toBeGreaterThan(0);
    expect(built.at(-1)![0].taskStart).toEqual(TASK);

    const card = el.querySelector('.tsc-wrap')!;
    expect(card.querySelector('.tsc-title')?.textContent).toBe(TASK.title);
    // Accepted: the queue has handed it on, so it carries no queued mark and no line of its own.
    expect(card.querySelector('.tsc.is-queued')).toBeNull();
    expect(el.querySelector('.chat-queued-meta')).toBeNull();

    expectNoBubbleOfTheBrief(el);
    expect(bubbles(el)).toEqual([OWNER_WORDS]);
  });
});

// ── the placeholder carries every card ────────────────────────────────────────────────────────

describe('the accepted placeholder carries every card the snapshot carried', { timeout: 60_000 }, () => {
  it('names every card a turn can carry', () => {
    expect(Object.keys(EVERY_CARD).sort()).toEqual(Object.keys(TURN_CARD_FIELDS).sort());
    expect(ACCEPTED_ONE_CARD_EACH.map((c) => c.field).sort()).toEqual(Object.keys(TURN_CARD_FIELDS).sort());
  });

  it('a row carrying all of them: the placeholder and its event carry all of them, not a hand-copied few', async () => {
    const row: ActiveSessionTurn = {
      turnId: 'turn-all', kind: 'message', placement: 'accepted', content: OWNER_WORDS, createdAt: TS, ...EVERY_CARD,
    };
    await openConsole([row], []);
    await drawn(() => expect(placeholderEvent.mock.calls.some(([turn]) => turn.turnId === 'turn-all')).toBe(true));

    const index = placeholderEvent.mock.calls.map(([turn]) => turn.turnId).lastIndexOf('turn-all');
    const [placeholder] = placeholderEvent.mock.calls[index];
    expect(turnCardsOf(placeholder)).toEqual(EVERY_CARD);
    const event = placeholderEvent.mock.results[index].value as { payload: unknown };
    expect(event.payload).toEqual({ text: OWNER_WORDS, ...EVERY_CARD });
  });

  it('a row carrying one each: the transcript draws each as its card', async () => {
    const rows = ACCEPTED_ONE_CARD_EACH.map((c): ActiveSessionTurn => ({
      turnId: `turn-${c.field}`, kind: 'message', placement: 'accepted', content: c.content, createdAt: TS,
      [c.field]: EVERY_CARD[c.field],
    }));
    const el = await openConsole(rows, []);
    const marks = ACCEPTED_ONE_CARD_EACH.map((c) => c.drawnAs).join(', ');
    await drawn(() => expect(el.querySelectorAll(marks)).toHaveLength(ACCEPTED_ONE_CARD_EACH.length));

    for (const c of ACCEPTED_ONE_CARD_EACH) {
      expect(el.querySelectorAll(c.drawnAs), `${c.field} is not drawn as its card`).toHaveLength(1);
    }
    expect(el.querySelector('.is-queued, .chat-queued-meta'), 'an accepted turn drawn as queued').toBeNull();
    // Only the owner's own words are a bubble: the message the outcomes rode in on.
    expect(bubbles(el)).toEqual(['what did the coordinator say?']);
  });
});
