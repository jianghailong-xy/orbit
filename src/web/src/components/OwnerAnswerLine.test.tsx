// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OwnerAnswerCard, SessionReplyCard } from '@orbit/shared';
import { answeredItemKey, answersHandedOver, parseOwnerAnswer } from '../lib/ownerAnswer';
import { encodeId } from '../lib/idCodec';
import { QUEUED_FOR_COORDINATOR, type ProjectClosedQuestion } from './CoordinatorQuestionCard';
import {
  EVIDENCE_DECISION_SENT_TO_COORDINATOR,
  decisionReceiptTime,
  sentToCoordinatorLine,
} from './EvidenceDecisionCard';
import { AnsweredQuestionsCtx, OWNER_ANSWER_TOLD } from './OwnerAnswerLine';
import { QueuedUserTurn, Transcript, type RunEvent } from './Transcript';

/**
 * The owner's answer handed to the coordinator is drawn from the card the control plane recorded
 * beside the turn — one line, `Sent to the coordinator · 08:29`, opening to the words the agent read —
 * and NOT as the owner's bubble replaying the question (design: docs/mocks/coordinator-question-answered,
 * step 4). Held in place the way every turn card is: with the payload the line is drawn; without one —
 * the same words, the same session — the turn is the bubble it always was.
 */

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

/** What `ownerAnswerMessage` writes — the agent's reading, kept verbatim behind the line. */
const TOLD = 'From Orbit · owner answer: you asked "灰度回退之后的收尾都做完了：新版本部署之后，维护任务恢复了，'
  + '第一轮成功跑完，把所有锚点重新检查了一遍。请批准重开灰度。". The owner answered: 现在重开，接受这个代价（推荐） '
  + '(2026-10-09T00:29:36.828Z).';

const CARD: OwnerAnswerCard = {
  itemId: '01a0d6a9-d763-70e1-b4cf-8793e971b511',
  kind: 'COORDINATOR_QUESTION',
  sessionId: '01a0d6a9-d763-70e1-b4cf-8793e971b512',
  deliveredAt: '2026-10-09T00:29:37.104Z',
};

/** A `user` event as ingest stores one: the echo, and the card when there was one. */
function told(card?: unknown, extra: Record<string, unknown> = {}): RunEvent {
  return {
    seq: 7,
    type: 'user',
    turnId: 'turn-answer',
    ts: '2026-10-09T00:29:38.000Z',
    payload: { text: TOLD, ...(card === undefined ? {} : { ownerAnswer: card }), ...extra },
  };
}

async function mount(events: RunEvent[]) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Transcript events={events} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
}

async function remount(events: RunEvent[]) {
  await act(async () => root.unmount());
  root = createRoot(container);
  await mount(events);
}

const line = (): HTMLElement | null => container.querySelector('.owner-answer-line');
const fold = (): HTMLDetailsElement => container.querySelector<HTMLDetailsElement>('details.owner-answer-fold')!;

describe('the owner’s answer handed to the coordinator', () => {
  it('is one line — Sent to the coordinator · its clock — and no bubble in the reader’s name', async () => {
    await mount([told(CARD)]);

    expect(line(), `no line was drawn:\n${container.innerHTML}`).not.toBeNull();
    expect(container.querySelector('.owner-answer-text')?.textContent).toBe(sentToCoordinatorLine(CARD.deliveredAt));
    expect(container.querySelector('.owner-answer-chev')?.textContent).toBe('›');
    expect(container.querySelector('.chat-user'), 'drawn as the owner’s bubble').toBeNull();
    // A line in the conversation, not the head of a round: the sticky bar keeps the question above it.
    expect(container.querySelector('[data-sticky-label]')).toBeNull();
    expect(container.querySelector('.owner-answer')?.getAttribute('data-seq')).toBe('7');
  });

  it('says it in the words and on the clock of the line a version handed to the coordinator leaves', async () => {
    // Today: the clock alone. Another day: the date as well (`decisionReceiptTime`).
    const today = { ...CARD, deliveredAt: new Date().toISOString() };
    await mount([told(today)]);
    expect(container.querySelector('.owner-answer-text')?.textContent)
      .toBe(`${EVIDENCE_DECISION_SENT_TO_COORDINATOR} · ${decisionReceiptTime(today.deliveredAt)}`);
    expect(decisionReceiptTime(today.deliveredAt)).not.toMatch(/\//);
    await remount([told(CARD)]);
    expect(container.querySelector('.owner-answer-text')?.textContent)
      .toBe(`${EVIDENCE_DECISION_SENT_TO_COORDINATOR} · ${decisionReceiptTime(CARD.deliveredAt)}`);
    expect(container.querySelector('.owner-answer-text')?.textContent)
      .toContain(new Date(CARD.deliveredAt).toLocaleDateString([], { month: 'numeric', day: 'numeric' }));
  });

  it('opens to the words the coordinator was handed, verbatim', async () => {
    await mount([told(CARD)]);
    expect(fold().open, 'the words are behind the line until it is pressed').toBe(false);

    await act(async () => line()!.click());

    expect(fold().open).toBe(true);
    expect(container.querySelector('.owner-answer-told-head')?.textContent).toBe(OWNER_ANSWER_TOLD);
    expect(container.querySelector('.owner-answer-told pre')?.textContent).toBe(TOLD);
  });

  it('draws the owner’s Not yet… to a request to record the project done as the same line', async () => {
    await mount([told({ ...CARD, kind: 'DONE_REQUEST' })]);
    expect(container.querySelector('.owner-answer-text')?.textContent).toBe(sentToCoordinatorLine(CARD.deliveredAt));
    expect(container.querySelector('.chat-user')).toBeNull();
  });

  it('keeps what delivery appended inside the line’s fold, as Orbit’s — never in a bubble', async () => {
    const role = '<orbit_project_coordinator_context>\nYou coordinate this project.\n</orbit_project_coordinator_context>';
    await mount([told(CARD, { text: `${TOLD}\n\n${role}`, controlPlaneNote: `\n\n${role}` })]);
    await act(async () => line()!.click());

    expect(container.querySelector('.owner-answer-told pre')?.textContent).toBe(TOLD);
    expect(container.querySelector('.owner-answer-told .chat-injected'), 'the appended block is not folded in').not.toBeNull();
    expect(container.querySelector('.chat-user')).toBeNull();
  });

  it('is still the line when the outcomes of the coordinator’s own requests ride on the same turn', async () => {
    const reply: SessionReplyCard = {
      requestId: 'req1',
      outcome: 'REPLIED',
      fromSessionId: '00000000-0000-4000-8000-000000000001',
      fromTitle: 'Worker: migration review',
      requestPreview: 'is the migration ready?',
      replyText: 'yes',
    };
    const block = '<orbit-session-reply request-id="req1" outcome="REPLIED">\nyes\n</orbit-session-reply>';
    await mount([told(CARD, { text: `${TOLD}\n\n${block}`, controlPlaneNote: `\n\n${block}`, sessionReplies: [reply] })]);

    expect(container.querySelector('.owner-answer-text')?.textContent).toBe(sentToCoordinatorLine(CARD.deliveredAt));
    expect(container.querySelector('.src-wrap'), 'the reply card is gone').not.toBeNull();
    expect(container.querySelector('.chat-user'), 'the answer’s words became a bubble').toBeNull();
  });

  // The negative control: the same conversation and the same words, with nothing recorded beside them.
  it('leaves a turn with no card as the bubble it always was', async () => {
    await mount([told(undefined)]);
    expect(line()).toBeNull();
    expect(container.querySelector('.chat-user .md')?.textContent).toContain('From Orbit · owner answer: you asked');
  });

  it('draws a payload that is not a card as the bubble too, never as half a line', async () => {
    const bad: unknown[] = [
      { ...CARD, itemId: '' },
      { ...CARD, kind: 'TASK_FAILED' },
      { ...CARD, sessionId: 42 },
      { ...CARD, deliveredAt: 'yesterday' },
      { itemId: CARD.itemId, kind: CARD.kind, sessionId: CARD.sessionId },
      'Sent to the coordinator',
      null,
    ];
    for (const payload of bad) {
      expect(parseOwnerAnswer({ text: TOLD, ownerAnswer: payload }), JSON.stringify(payload)).toBeNull();
      await remount([told(payload)]);
      expect(line(), `drew a line from ${JSON.stringify(payload)}`).toBeNull();
      expect(container.querySelector('.chat-user')).not.toBeNull();
    }
    expect(parseOwnerAnswer({ text: TOLD, ownerAnswer: CARD })).toEqual(CARD);
  });

  it('says when the session has not confirmed it received the answer', async () => {
    await mount([told(CARD, { delivery: 'failed' })]);
    expect(container.querySelector('.owner-answer-undelivered')?.textContent)
      .toBe('The session has not confirmed it received this.');
  });
});

/**
 * Where the conversation can draw the question the answer is to — the open-items read's ended
 * questions, handed down as `AnsweredQuestionsCtx` — the turn is that question's card and nothing
 * else (docs/mocks/owner-answer-sent-card/merged.html): the owner reads Answered as "the agent has my
 * answer", so a second card, or a line under it, said it twice.
 */
describe('the owner’s answer, where the conversation can draw its question', () => {
  const RECORD: ProjectClosedQuestion = {
    itemId: CARD.itemId,
    question: {
      question: '灰度回退之后的收尾都做完了：新版本部署之后，维护任务恢复了。请批准重开灰度。',
      options: [{ label: '现在重开，接受这个代价' }, { label: '先不重开' }],
      recommendedOption: 0,
      blocksTaskIds: [],
      ifUnanswered: null,
    },
    askedAt: '2026-10-09T00:10:00.000Z',
    resolution: 'ANSWERED',
    resolvedBy: 'USER',
    resolvedAt: '2026-10-09T00:29:36.828Z',
    answer: { option: 0, text: null },
    delivery: { sessionId: CARD.sessionId, at: CARD.deliveredAt },
    withdrawReason: null,
  };
  const RECORDS = new Map([[answeredItemKey(CARD.itemId), RECORD]]);

  async function drawn(node: ReactElement, records: ReadonlyMap<string, ProjectClosedQuestion> = RECORDS) {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <MemoryRouter>
            <AnsweredQuestionsCtx.Provider value={records}>{node}</AnsweredQuestionsCtx.Provider>
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
  }

  const card = (): HTMLElement | null => container.querySelector('.owner-answer-card .answered-question-card');
  /** The review is mounted behind the card (`ReviewCard` keeps it), wherever its dialog is. */
  const review = (): Element | null => document.querySelector(`[data-question-record="${CARD.itemId}"]`);

  it('is the question’s own card, Answered, where the turn stands — and no line, no bubble', async () => {
    await drawn(<Transcript events={[told(CARD)]} />);

    expect(card(), `no card was drawn:\n${container.innerHTML}`).not.toBeNull();
    expect(line(), 'the line is drawn as well').toBeNull();
    expect(container.querySelector('.chat-user')).toBeNull();
    expect(container.querySelector('.owner-answer-card')?.getAttribute('data-seq')).toBe('7');
    expect(container.querySelector('.answered-question-answer')?.textContent).toBe('现在重开，接受这个代价');
    expect(container.querySelector('.answered-question-waiting'), 'a delivered answer says nothing more').toBeNull();
  });

  it('keeps the words the coordinator was told at the foot of the card’s review, verbatim', async () => {
    await drawn(<Transcript events={[told(CARD)]} />);
    expect(review()?.querySelector('.answered-question-told summary')?.textContent).toBe(OWNER_ANSWER_TOLD);
    expect(review()?.querySelector('.answered-question-told pre')?.textContent).toBe(TOLD);
  });

  it('says on the card when the session has not confirmed it received the answer', async () => {
    await drawn(<Transcript events={[told(CARD, { delivery: 'failed' })]} />);
    expect(container.querySelector('.answered-question-waiting')?.textContent)
      .toBe('The session has not confirmed it received this.');
    expect(container.querySelector('.owner-answer-undelivered')).toBeNull();
  });

  it('says on the card, dashed, while the answer waits on the queue — with no way to cancel it', async () => {
    const queue = <span className="chat-queued-meta">Queued for next turn <a>Cancel</a></span>;
    await drawn(<QueuedUserTurn event={told(CARD)} queued={queue} />);

    expect(container.querySelector('.answered-question-card.is-queued')).not.toBeNull();
    expect(container.querySelector('.answered-question-waiting')?.textContent).toContain(QUEUED_FOR_COORDINATOR);
    expect(container.textContent, 'the queue’s Cancel would leave the coordinator never told').not.toContain('Cancel');
    expect(container.querySelector('.owner-answer-card')?.hasAttribute('data-seq')).toBe(false);
  });

  it('is still the line for a Not yet…, which has no card, and for a question it cannot draw', async () => {
    await drawn(<Transcript events={[told({ ...CARD, kind: 'DONE_REQUEST' })]} />);
    expect(card()).toBeNull();
    expect(container.querySelector('.owner-answer-text')?.textContent).toBe(sentToCoordinatorLine(CARD.deliveredAt));

    await act(async () => root.unmount());
    root = createRoot(container);
    await drawn(<Transcript events={[told(CARD)]} />, new Map());
    expect(card()).toBeNull();
    expect(container.querySelector('.owner-answer-text')?.textContent).toBe(sentToCoordinatorLine(CARD.deliveredAt));
  });

  it('finds the question whichever spelling of the item each read was served', async () => {
    // The open-items read names the item by its public id; the turn's card may carry the UUID.
    const records = new Map([[answeredItemKey(encodeId(CARD.itemId)), { ...RECORD, itemId: encodeId(CARD.itemId) }]]);
    await drawn(<Transcript events={[told(CARD)]} />, records);
    expect(card(), 'the card was not found across spellings').not.toBeNull();
    expect(line()).toBeNull();
    expect(answersHandedOver([told(CARD)], []).has(answeredItemKey(encodeId(CARD.itemId)))).toBe(true);
  });

  it('names the questions its turns hand over, so the conversation does not draw their cards twice', () => {
    const queuedCard = { ...CARD, itemId: '01a0d6a9-d763-70e1-b4cf-8793e971b5aa' };
    const notYet = { ...CARD, itemId: '01a0d6a9-d763-70e1-b4cf-8793e971b5bb', kind: 'DONE_REQUEST' as const };
    const handed = answersHandedOver(
      [
        told(CARD),
        told(notYet),
        { seq: 9, type: 'assistant', payload: { text: TOLD, ownerAnswer: { ...CARD, itemId: 'not-a-turn' } } },
      ],
      [{ ownerAnswer: queuedCard }, {}],
    );
    expect([...handed].sort()).toEqual([answeredItemKey(CARD.itemId), answeredItemKey(queuedCard.itemId)].sort());
  });
});
