// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ConfirmationReturnCard,
  ConfirmationReviewRequestCard,
  OpenItemDeliveryCard,
  OwnerAnswerCard,
  ProjectStartedCard,
  SessionMessageCard,
  SessionReplyCard,
  TaskStartCard,
} from '@orbit/shared';
import type { ActiveSessionTurn, TurnCards } from '../api';
import type { Runner } from './TasksSidePanel';

/**
 * A turn waiting on the queue is drawn by the transcript's own dispatch (NodeView), from the event its
 * echo will be (`queuedTurnEvent`): the same card component the echo is drawn as, with the queue's
 * line (QueuedTurnMeta) in the slot that card keeps for it, and nothing else different. Each card
 * kind is drawn both ways here and the two are compared, so a card the transcript learns to draw is
 * on the queue too — and a card field nobody drew a queued row for fails the completeness check below.
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

const { api, getSessionEventPage, listQueuedTurns } = await import('../api');
const apiMock = vi.mocked(api);
const { AttachmentResolverContext, QueuedUserTurn, Transcript } = await import('./Transcript');
const { QueuedTurnMeta, WorkspaceView, queuedTurnFromActiveSnapshot } = await import('./WorkspaceView');
const { acceptedUserTurnEvent, queuedTurnEvent, turnCardsOf, TURN_CARD_FIELDS } = await import('../lib/acceptedUserTurn');
const { isQueuedWatchWake } = await import('../lib/queuedTurnRestore');
const { encodeId } = await import('../lib/idCodec');

type QueuedTurn = NonNullable<ReturnType<typeof queuedTurnFromActiveSnapshot>>;

const TS = '2026-10-06T05:40:00.000Z';

// ── one turn of each kind, as the queue lists it and as ingest stores its echo ────────────────────

const ITEM: OpenItemDeliveryCard = {
  itemId: '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6d',
  kind: 'INTEGRATION_CONFLICT',
  title: 'Merge conflict: 回填历史 user 事件的 controlPlaneNote',
  task: {
    id: '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6e',
    title: '回填历史 user 事件的 controlPlaneNote',
    sessionId: '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a6f',
  },
  files: ['src/web/src/components/Transcript.tsx', 'src/apiserver/src/projects/project-open-item.ts'],
  targetRef: 'refs/heads/project/34ODoUKJGEsfbgcJDGS4q',
  check: null,
  errorCode: null,
  failure: null,
  actions: ['OPEN_COORDINATOR', 'OPEN_TASK_SESSION', 'RETRY', 'CANCEL_TASK'],
  landing: { receipts: 0, state: 'NOT_KNOWN', upstream: 'main', integration: 'main' },
};
const ITEM_TOLD = '【例外待办】Merge conflict: 回填历史 user 事件的 controlPlaneNote\n\n合并时冲突，请处理。';

const ANSWER: OwnerAnswerCard = {
  itemId: '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a70',
  kind: 'COORDINATOR_QUESTION',
  sessionId: '0198f0e2-1c4a-7b31-9a5e-0d2f3c4b5a71',
  deliveredAt: '2026-10-06T05:39:58.000Z',
};
const ANSWER_TOLD = 'From Orbit · owner answer: you asked "Merge now, or wait for the review?". '
  + 'The owner answered: Wait for the review (2026-10-06T05:39:57.512Z).';

const TASK: TaskStartCard = {
  taskId: '01a0cca7-8609-70ed-a0e2-d4b55b832b60',
  title: 'web：排队行经 Transcript 的同一渲染器画出',
  description: '队尾每一行像 accepted 占位那样转成 user 事件，交给 NodeView 渲染。',
  acceptanceCriteria: '排队行与已投递事件画出同一卡片组件。',
  completionCriterion: 'EVIDENCE_JUDGMENT',
  acceptanceCommand: null,
  acceptanceExpectedExitCode: null,
  listInstructions: null,
  project: { id: '01a0cca0-aeaa-7618-bd5a-caccc089108c', title: '统一排队与已投递消息的卡片渲染' },
  auto: true,
};
const BRIEF = '请开始执行任务「web：排队行经 Transcript 的同一渲染器画出」。\n\n任务描述：队尾每一行转成 user 事件。';

const STARTED: ProjectStartedCard = {
  by: 'CONFIRMATION',
  projectId: '01a0cca0-aeaa-7618-bd5a-caccc089108c',
  projectTitle: '统一排队与已投递消息的卡片渲染',
  criteriaCount: 4,
  held: [{ id: '01a0cca7-84ec-75cf-9b65-b94a4ce3bf70', title: '服务端：ingest 与 listQueuedTurns 共用一个 readTurnCards' }],
  heldCount: 1,
};
const STARTED_TOLD = 'The owner started this project. 1 task was waiting for it.';

const REVIEW_REQUEST: ConfirmationReviewRequestCard = {
  requestId: '01a0cca7-0000-7000-8000-0000000000a1',
  reviewId: '01a0cca7-0000-7000-8000-0000000000a2',
  taskId: '01a0cca7-0000-7000-8000-0000000000a3',
  title: '会话间请求与回复：修复 P1 审查发现的问题',
  runSessionId: '01a0cca7-0000-7000-8000-0000000000a4',
  branch: 'orbit/p1-1c207b',
  sha: '59d98153ef85c565646fede291f66f61940573c7',
  dueAt: '2026-10-06T06:10:00.000Z',
};
/** A review's words are rendered at delivery: the queue lists the block it will be delivered with. */
const REVIEW_BLOCK = '<orbit-confirmation-review request-id="r1">\nReview the report of the task above.\n</orbit-confirmation-review>';

const RETURNED: ConfirmationReturnCard = {
  requestId: '01a0cca7-0000-7000-8000-0000000000a1',
  recordId: '01a0cca7-0000-7000-8000-0000000000b1',
  reviewerSessionId: '01a0cca7-0000-7000-8000-0000000000b2',
  reviewerTitle: '会话间消息参数与回复设计',
  reason: 'Two of the six findings are not fixed on the branch.',
  problems: [{ key: 'p1', text: 'P1-3 still sends the reply twice' }],
};
const RETURN_BLOCK = '<orbit-confirmation-return request-id="r1">\nSent back: two findings remain.\n</orbit-confirmation-return>';

const FROM: SessionMessageCard = {
  fromSessionId: '01a0cca7-8609-70ed-a0e2-d4b55b832b61',
  fromTitle: 'Worker: migration review',
  fromAgentName: 'orbit',
};
const SENT = 'please review the migration before I merge it';

const REPLY: SessionReplyCard = {
  requestId: 'req1',
  outcome: 'REPLIED',
  fromSessionId: '00000000-0000-4000-8000-000000000001',
  fromTitle: '分析 session 列表页性能',
  requestPreview: '再跑一组只读探针',
  replyText: '全部只读执行',
};
const REPLY_BLOCK = '<orbit-session-reply request-id="req1" outcome="REPLIED">\n你问的是：再跑一组只读探针\n</orbit-session-reply>';

const WATCH = '0195c0de-0000-7000-8000-0000000000c3';
// Built the way watch-delivery.service.ts `watchTurnContent` builds it (lib/watches.test.ts).
const WAKE = [
  `Orbit Watch ${WATCH} matched at generation 1: ALL TASK_DONE 2/2`,
  '',
  'This turn was queued by the watch, not typed by a person. What the watch recorded when its condition held:',
  '',
  '```json',
  JSON.stringify(
    {
      watchId: WATCH,
      generation: 1,
      matchedAt: TS,
      reason: 'ALL TASK_DONE 2/2',
      changedTargets: [{ kind: 'TASK', id: '0195c0de-0000-7000-8000-0000000000d4', state: 'SATISFIED', observed: { status: 'DONE' } }],
      latestSnapshot: { evaluatedAt: TS, targets: [] },
    },
    null,
    2,
  ),
  '```',
].join('\n');

// Built the way runner-api/background-job-wake.ts `buildBackgroundWakeBlock` builds it.
const BG_WAKE = [
  '<background-job-wake>',
  '  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:',
  '    bgj_10bca948d369｜job｜bash scripts/run-pg-spec.sh src/apiserver/src/tasks/task-dispatch-priority.pg.spec.ts｜land gate',
  '      ended｜completed｜exit code 0',
  '      output /root/.orbit/runs/01a0d619/bgj_10bca948d369.output｜this covers bytes 0–821',
  '  The control plane recorded this for you; the user did not say it. Read the full output with mcp__orbit__bg_output by id; pass sinceOffset to read only what is new.',
  '</background-job-wake>',
].join('\n');

const TYPED = 'and check the dark theme too';

interface Case {
  name: string;
  /** The card field the turn is drawn from; none for a wake or a message, read off their words. */
  field?: keyof TurnCards;
  /** The row as `GET /sessions/:id/turns?view=active` lists it, less where it is placed. */
  row: Omit<ActiveSessionTurn, 'placement' | 'kind'>;
  /** Its echo's payload, as ingest stores it: a turn whose words are rendered at delivery has all of
   *  them recorded as the control plane's note. */
  echo: Record<string, unknown>;
  /** The card component's own root, the element that says it is queued, and the slot its line sits in. */
  root: string;
  queuedMark: string;
  slot: string;
  /** The actions the queue offers on it while it waits for its turn. */
  actions: string[];
  /** Whether the row can also be the accepted head: a turn listed with its block never is. */
  acceptable: boolean;
  /** The reader's own message: the one row drawn as their bubble. */
  bubble?: true;
}

const CASES: Case[] = [
  {
    name: 'an exception item’s delivery',
    field: 'openItemDelivery',
    row: { turnId: 'turn-item', content: ITEM_TOLD, createdAt: TS, openItemDelivery: ITEM, authoredByOrbit: true },
    echo: { text: ITEM_TOLD, openItemDelivery: ITEM },
    root: '.oic-wrap',
    queuedMark: '.oic.is-queued',
    slot: '.oic-queued',
    actions: ['Cancel'],
    acceptable: true,
  },
  {
    name: 'the owner’s answer handed to the coordinator',
    field: 'ownerAnswer',
    row: { turnId: 'turn-answer', content: ANSWER_TOLD, createdAt: TS, ownerAnswer: ANSWER, authoredByOrbit: true },
    echo: { text: ANSWER_TOLD, ownerAnswer: ANSWER },
    root: '.owner-answer',
    queuedMark: '.owner-answer.is-queued',
    slot: '.owner-answer-queued',
    actions: ['Cancel'],
    acceptable: true,
  },
  {
    name: 'a resumed run’s brief',
    field: 'taskStart',
    row: { turnId: 'turn-brief', content: BRIEF, createdAt: TS, taskStart: TASK, authoredByOrbit: true },
    echo: { text: BRIEF, taskStart: TASK },
    root: '.tsc-wrap',
    queuedMark: '.tsc.is-queued',
    slot: '.tsc-queued',
    actions: ['Cancel'],
    acceptable: true,
  },
  {
    name: 'a project’s start',
    field: 'projectStarted',
    row: { turnId: 'turn-started', content: STARTED_TOLD, createdAt: TS, projectStarted: STARTED, authoredByOrbit: true },
    echo: { text: STARTED_TOLD, projectStarted: STARTED },
    root: '.psc-wrap',
    queuedMark: '.psc.is-queued',
    slot: '.psc-queued',
    actions: ['Cancel'],
    acceptable: true,
  },
  {
    name: 'a confirmation request handed to its reviewer',
    field: 'confirmationReviewRequest',
    row: { turnId: 'turn-review', content: REVIEW_BLOCK, createdAt: TS, confirmationReviewRequest: REVIEW_REQUEST, authoredByOrbit: true },
    echo: { text: REVIEW_BLOCK, controlPlaneNote: REVIEW_BLOCK, confirmationReviewRequest: REVIEW_REQUEST },
    root: '.crc-wrap',
    queuedMark: '.crc.is-queued:not(.is-returned)',
    slot: '.crc-queued',
    actions: ['Cancel'],
    acceptable: false,
  },
  {
    name: 'a reviewer’s return handed to the run',
    field: 'confirmationReturn',
    row: { turnId: 'turn-return', content: RETURN_BLOCK, createdAt: TS, confirmationReturn: RETURNED, authoredByOrbit: true },
    echo: { text: RETURN_BLOCK, controlPlaneNote: RETURN_BLOCK, confirmationReturn: RETURNED },
    root: '.crc-wrap',
    queuedMark: '.crc.is-returned.is-queued',
    slot: '.crc-queued',
    actions: ['Cancel'],
    acceptable: false,
  },
  {
    name: 'another session’s message',
    field: 'sessionMessage',
    row: { turnId: 'turn-sent', content: SENT, createdAt: TS, sessionMessage: FROM },
    echo: { text: SENT, sessionMessage: FROM },
    root: '.smc-wrap',
    queuedMark: '.smc.is-queued',
    slot: '.smc-queued',
    actions: ['Cancel'],
    acceptable: true,
  },
  {
    name: 'the outcomes of this session’s requests, handed back',
    field: 'sessionReplies',
    row: { turnId: 'turn-reply', content: REPLY_BLOCK, createdAt: TS, sessionReplies: [REPLY], authoredByOrbit: true },
    echo: { text: REPLY_BLOCK, controlPlaneNote: REPLY_BLOCK, sessionReplies: [REPLY] },
    root: '.src-wrap',
    // The reply cards keep no queued mark of their own: the line rides in what they carry.
    queuedMark: '.src-wrap > .chat-queued-meta',
    slot: '.src-wrap > .chat-queued-meta',
    actions: ['Cancel'],
    acceptable: false,
  },
  {
    name: 'a wake a watch queued',
    row: { turnId: 'turn-watch', content: WAKE, createdAt: TS, authoredByOrbit: true },
    echo: { text: WAKE },
    // The background line's classes (`.bgwake-row`, `.bgwake-queued`…) under a root of the watch's own.
    root: '.watch-wake',
    queuedMark: '.watch-wake.is-queued',
    slot: '.bgwake-queued',
    // A wake's Cancel: withdrawing it is for good, so it says so (WorkspaceView.queuedTurnWake).
    actions: ['Withdraw wake'],
    acceptable: true,
  },
  {
    name: 'a background job’s wake',
    row: { turnId: 'turn-bg', content: BG_WAKE, createdAt: TS, authoredByOrbit: true },
    echo: { text: BG_WAKE, controlPlaneNote: BG_WAKE },
    root: '.bgwake',
    queuedMark: '.bgwake.is-queued',
    slot: '.bgwake-queued',
    actions: ['Cancel'],
    acceptable: false,
  },
  {
    name: 'a message the reader typed',
    row: { turnId: 'turn-typed', content: TYPED, createdAt: TS },
    echo: { text: TYPED },
    root: '.chat-user-wrap',
    queuedMark: '.chat-msg.chat-user.chat-queued',
    slot: '.chat-queued-meta',
    actions: ['Cancel'],
    acceptable: true,
    bubble: true,
  },
];

// ── drawing ───────────────────────────────────────────────────────────────────────────────────

const mounted: { root: Root; el: HTMLDivElement }[] = [];
let client: QueryClient;

/** Something drawn the way the console draws it: under a router and a query client. */
async function draw(node: ReactNode): Promise<HTMLDivElement> {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  mounted.push({ root, el });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          {node}
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  return el;
}

/** The queue's line as WorkspaceView builds it for this row. */
function queueLine(turn: QueuedTurn, more: { onPutBack?: () => void } = {}): ReactNode {
  const wake = isQueuedWatchWake(turn);
  return (
    <QueuedTurnMeta
      placement={turn.placement}
      delivery={turn.delivery}
      deliveryCode={turn.deliveryCode}
      deliveryReason={turn.deliveryReason}
      wake={wake}
      onCancel={() => {}}
      onPutBack={more.onPutBack}
    />
  );
}

/** The row on the queue, through the path the console takes: snapshot row → queued turn → event. */
function queuedTurnOf(c: Case, placement: 'queued' | 'steer'): QueuedTurn {
  const row: ActiveSessionTurn = { ...c.row, kind: placement === 'steer' ? 'steer' : 'message', placement };
  const turn = queuedTurnFromActiveSnapshot(row);
  if (!turn) throw new Error(`${c.name}: the snapshot row became no queued turn`);
  return turn;
}

const drawQueued = (c: Case, placement: 'queued' | 'steer') => {
  const turn = queuedTurnOf(c, placement);
  return draw(<QueuedUserTurn event={queuedTurnEvent(turn)} queued={queueLine(turn)} />);
};

const drawDelivered = (c: Case) =>
  draw(<Transcript events={[{ seq: 7, type: 'user', turnId: c.row.turnId, ts: TS, payload: c.echo }]} />);

/** The one root of the card component in what was drawn. */
function only(el: HTMLElement, selector: string, what: string): Element {
  const found = el.querySelectorAll(selector);
  expect(found, `${what}: expected one ${selector}:\n${el.innerHTML}`).toHaveLength(1);
  return found[0];
}

/**
 * The card as a reader sees it, less what only the queue says — its line, the queued marks, and the
 * seq only an event has. Two renderings are the same card exactly when these are equal.
 */
function cardShape(card: Element, slot: string): string {
  const copy = card.cloneNode(true) as Element;
  copy.querySelectorAll(slot).forEach((el) => el.remove());
  for (const el of [copy, ...copy.querySelectorAll('*')]) {
    el.removeAttribute('data-seq');
    el.classList.remove('is-queued', 'chat-queued');
  }
  return copy.outerHTML;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});

async function unmountAll(): Promise<void> {
  for (const { root, el } of mounted.splice(0)) {
    await act(async () => root.unmount());
    el.remove();
  }
  await client.cancelQueries();
  client.clear();
}

afterEach(async () => {
  await unmountAll();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

// ── each card, queued and delivered ───────────────────────────────────────────────────────────

describe('a turn on the queue is drawn as the card its echo is', () => {
  it('has a case for every card field a turn can carry', () => {
    // A card added to `TurnCards` is a field the queue and the placeholder carry from then on; it
    // needs its case here, which is where its queued row is shown to be drawn as its card.
    expect(CASES.flatMap((c) => (c.field ? [c.field] : [])).sort()).toEqual(Object.keys(TURN_CARD_FIELDS).sort());
  });

  describe.each(CASES)('$name', (c) => {
    it('waiting for its turn: the same card, with Queued and the way out at its foot', async () => {
      const delivered = await drawDelivered(c);
      const queued = await drawQueued(c, 'queued');

      const echoCard = only(delivered, c.root, 'the echo');
      const queuedCard = only(queued, c.root, 'the queued row');
      if (!c.bubble) {
        // Nobody's message, waiting or delivered: no part of it is the reader's bubble.
        expect(delivered.querySelector('.chat-user'), 'the echo drew a bubble').toBeNull();
        expect(queued.querySelector('.chat-user'), 'the queued row drew a bubble').toBeNull();
      }
      expect(queued.querySelector(c.queuedMark), 'drawn as still queued').not.toBeNull();
      expect(queued.querySelector('[data-seq]'), 'a queued turn is no event for ⌘F to land on').toBeNull();

      const line = queuedCard.querySelector('.chat-queued-meta');
      expect(line, 'the queue’s line is in the card').not.toBeNull();
      expect(line!.matches(c.slot) || line!.closest(c.slot) !== null, `in the card’s own slot, ${c.slot}`).toBe(true);
      expect(line!.querySelector('.chat-queued-tag')?.textContent).toBe('Queued for next turn');
      expect([...line!.querySelectorAll('a')].map((a) => a.textContent)).toEqual(c.actions);
      // Said once: the card draws no state of its own beside the queue's.
      expect(queued.querySelectorAll('.chat-queued-meta')).toHaveLength(1);

      expect(cardShape(queuedCard, c.slot), 'taking the turn changes the card').toBe(cardShape(echoCard, c.slot));
    });

    it('written into the running turn: the same card, Sending… and nothing to cancel', async () => {
      const delivered = await drawDelivered(c);
      const queued = await drawQueued(c, 'steer');

      const queuedCard = only(queued, c.root, 'the steer');
      expect(queued.querySelector(c.queuedMark), 'drawn as not yet an event').not.toBeNull();
      const line = queuedCard.querySelector('.chat-queued-meta')!;
      expect(line.querySelector('.chat-queued-tag')?.textContent).toBe('Sending…');
      expect(line.querySelectorAll('a'), 'a steer cannot be taken back').toHaveLength(0);
      expect(line.textContent).not.toContain('Cancel');
      expect(line.textContent).not.toContain('Withdraw');
      // How far it has got is the line's to say, once — never a second steer state in the card.
      expect(queued.textContent?.split('Sending…')).toHaveLength(2);

      expect(cardShape(queuedCard, c.slot)).toBe(cardShape(only(delivered, c.root, 'the echo'), c.slot));
    });

    if (c.acceptable) {
      it('taken by the runner before its echo: the same card again, as the placeholder', async () => {
        // The accepted head is drawn from the placeholder (acceptedUserTurnEvent), built from the same
        // row the way WorkspaceView builds it: every card the snapshot carried.
        const row = { ...c.row, kind: 'message' as const, placement: 'accepted' as const };
        const placeholder = acceptedUserTurnEvent(
          {
            key: row.turnId,
            sessionId: 'session-1',
            source: 'activeSnapshot',
            turnId: row.turnId,
            text: row.content,
            acceptedAt: row.createdAt,
            attachments: [],
            ...turnCardsOf(row),
          },
          0.5,
        );
        const delivered = await drawDelivered(c);
        const accepted = await draw(<Transcript events={[{ ...placeholder, ts: TS }]} />);

        const card = only(accepted, c.root, 'the placeholder');
        expect(accepted.querySelector('.chat-queued-meta'), 'the runner has it: it waits for nothing').toBeNull();
        expect(cardShape(card, c.slot)).toBe(cardShape(only(delivered, c.root, 'the echo'), c.slot));
      });
    }
  });

  it('asks who sent a message before reading its words for a wake, as the transcript does', async () => {
    // Another session's words are that session's to choose, and can take a wake's shape: queued, it
    // is still that session's message, and leaves by Cancel like one (`isQueuedWatchWake`).
    for (const words of [WAKE, BG_WAKE]) {
      const turn = queuedTurnFromActiveSnapshot({
        turnId: 'turn-sent',
        kind: 'message',
        placement: 'queued',
        content: words,
        createdAt: TS,
        sessionMessage: FROM,
      })!;
      const el = await draw(<QueuedUserTurn event={queuedTurnEvent(turn)} queued={queueLine(turn)} />);
      const card = only(el, '.smc-wrap', 'the message');
      expect(card.querySelector('.smc-body'), 'its words are on the card').not.toBeNull();
      expect(el.querySelector('.watch-wake, .bgwake'), 'drawn as a wake').toBeNull();
      expect([...card.querySelectorAll('.chat-queued-meta a')].map((a) => a.textContent)).toEqual(['Cancel']);
    }
  });

  it('carries every card the snapshot carried onto the placeholder, not a hand-copied few', () => {
    const cards: Required<TurnCards> = {
      openItemDelivery: ITEM,
      ownerAnswer: ANSWER,
      taskStart: TASK,
      projectStarted: STARTED,
      confirmationReviewRequest: REVIEW_REQUEST,
      confirmationReturn: RETURNED,
      sessionMessage: FROM,
      sessionReplies: [REPLY],
    };
    const event = acceptedUserTurnEvent(
      { key: 'k', sessionId: 's', source: 'activeSnapshot', turnId: 't', text: 'x', acceptedAt: TS, attachments: [], ...cards },
      1,
    );
    expect(event.payload).toEqual({ text: 'x', ...cards });
    // And only the cards: nothing else of a row rides into the payload as if the echo carried it.
    expect(turnCardsOf({ ...cards, ...{ content: 'x', delivery: 'failed', placement: 'steer' } } as TurnCards)).toEqual(cards);
  });
});

// ── the reader's own message, waiting ──────────────────────────────────────────────────────────

describe('a message the reader typed, waiting on the queue', () => {
  const row = (more: Partial<ActiveSessionTurn> = {}): QueuedTurn =>
    queuedTurnFromActiveSnapshot({
      turnId: 'turn-typed',
      kind: 'message',
      placement: 'queued',
      content: TYPED,
      createdAt: TS,
      ...more,
    })!;
  const drawRow = (turn: QueuedTurn, extra: { turnImages?: Record<string, { url: string; mime: string }[]>; onPutBack?: () => void } = {}) =>
    draw(
      <AttachmentResolverContext.Provider value={async (id) => `blob:server/${id}`}>
        <QueuedUserTurn
          event={queuedTurnEvent(turn)}
          turnImages={extra.turnImages}
          queued={queueLine(turn, { onPutBack: extra.onPutBack })}
        />
      </AttachmentResolverContext.Provider>,
    );

  it('shows the images just sent from their local previews, before any reload', async () => {
    const el = await drawRow(row({ attachments: [{ id: 'att-1', mimeType: 'image/png' }] }), {
      turnImages: { 'turn-typed': [{ url: 'blob:local/preview-1', mime: 'image/png' }] },
    });
    const bubble = only(el, '.chat-queued', 'the bubble');
    expect([...bubble.querySelectorAll('.chat-images img')].map((img) => img.getAttribute('src'))).toEqual([
      'blob:local/preview-1',
    ]);
  });

  it('shows the images the server holds once the local previews are gone', async () => {
    const el = await drawRow(row({ content: '', attachments: [{ id: 'att-1', mimeType: 'image/png' }] }));
    await act(async () => {});
    const bubble = only(el, '.chat-queued', 'the image-only bubble');
    expect([...bubble.querySelectorAll('.chat-images img')].map((img) => img.getAttribute('src'))).toEqual([
      'blob:server/att-1',
    ]);
    expect(bubble.querySelector('.chat-queued-meta a')?.textContent).toBe('Cancel');
  });

  it('shows a `!cmd` as the command it will run, verbatim', async () => {
    const el = await drawRow(row({ kind: 'shell', content: 'npm test -w @orbit/web' }));
    const bubble = only(el, '.chat-queued', 'the shell bubble');
    expect(bubble.className).toBe('chat-msg chat-user chat-queued');
    expect(bubble.querySelector('.chat-queued-cmd')?.textContent).toBe('!npm test -w @orbit/web');
    expect(bubble.querySelector('.md'), 'not read as Markdown').toBeNull();
  });

  it('undelivered, says so once and offers to put it back in the composer', async () => {
    const putBack = vi.fn();
    const el = await drawRow(
      row({
        kind: 'steer',
        placement: 'steer',
        delivery: 'failed',
        deliveryCode: 'CURRENT_WORK_TARGET_COMPLETED',
        deliveryReason: 'The target turn completed before the engine acknowledged this message.',
      }),
      { onPutBack: putBack },
    );
    const bubble = only(el, '.chat-queued', 'the undelivered bubble');
    const line = bubble.querySelector('.chat-queued-meta')!;
    expect(line.querySelector('.chat-queued-tag')?.textContent).toBe('Not delivered');
    expect([...line.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Put back in the composer']);
    expect(el.querySelector('.chat-undelivered'), 'the bubble’s own mark would say it twice').toBeNull();
    await act(async () => {
      line.querySelector('a')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(putBack).toHaveBeenCalledTimes(1);
  });
});

// ── the queued tail itself ────────────────────────────────────────────────────────────────────

const RUNNER_ID = '0195c0de-0000-7000-8000-000000000031';
const WORKSPACE_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000032');
const SESSION_PUBLIC = encodeId('0195c0de-0000-7000-8000-000000000033');

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
  title: 'Coordinator: card rendering',
  status: 'RUNNING',
  provider: 'claude',
  createdAt: '2026-10-06T05:00:00Z',
  updatedAt: '2026-10-06T05:40:00Z',
};

class FakeEventSource {
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close() {}
}

describe('the console’s queued tail', { timeout: 60_000 }, () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    vi.stubGlobal('EventSource', FakeEventSource);
    const queue: ActiveSessionTurn[] = [
      ...CASES.map((c): ActiveSessionTurn => ({ ...c.row, kind: 'message', placement: 'queued' })),
      { turnId: 'turn-shell', kind: 'shell', placement: 'queued', content: 'npm test -w @orbit/web', createdAt: TS },
    ];
    apiMock.mockReset();
    vi.mocked(listQueuedTurns).mockImplementation(async () => queue);
    vi.mocked(getSessionEventPage).mockResolvedValue({ events: [], hasMore: false } as never);
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
    await unmountAll();
    delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    vi.unstubAllGlobals();
  });

  it('draws every row by the transcript’s dispatch: each card as its card, queued, with its line', async () => {
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
    // The act environment is off while the window is waited out (WorkspaceView.queuedTurnWake's
    // `waitForUi`): renders scheduled inside an act callback would not flush until it settles.
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    env.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      await vi.waitFor(
        () => expect(el.querySelectorAll('.chat-queued-meta')).toHaveLength(CASES.length + 1),
        { timeout: 20_000, interval: 20 },
      );
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = true;
    }
    await act(async () => {});

    for (const c of CASES.filter((each) => !each.bubble)) {
      expect(el.querySelectorAll(c.queuedMark), `${c.name} is drawn as its card, queued`).toHaveLength(1);
      const card = el.querySelector(c.queuedMark)!.closest(c.root)!;
      expect(card.querySelector('[data-seq]'), `${c.name} carries no seq`).toBeNull();
      const line = card.querySelector('.chat-queued-meta')!;
      expect(line.querySelector('.chat-queued-tag')?.textContent, c.name).toBe('Queued for next turn');
      expect([...line.querySelectorAll('a')].map((a) => a.textContent), c.name).toEqual(c.actions);
    }
    // The two the reader typed are their own bubbles, exactly as the queue always drew them.
    const bubbles = [...el.querySelectorAll<HTMLElement>('.chat-queued')];
    expect(bubbles.map((b) => b.className)).toEqual(['chat-msg chat-user chat-queued', 'chat-msg chat-user chat-queued']);
    expect(bubbles[0].querySelector('.md')?.textContent?.trim()).toBe(TYPED);
    expect(bubbles[1].querySelector('.chat-queued-cmd')?.textContent).toBe('!npm test -w @orbit/web');
    // And nothing anybody else wrote is drawn as the reader's message.
    expect(el.querySelectorAll('.chat-user')).toHaveLength(2);
  });
});
