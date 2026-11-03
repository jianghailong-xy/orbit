// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COORDINATOR_DELIVERY_KINDS,
  type CoordinatorDeliveryCard,
  type CoordinatorDeliveryKind,
  type SessionReplyCard,
} from '@orbit/shared';
import {
  COORDINATOR_DELIVERY_ITS_TASK,
  COORDINATOR_DELIVERY_SENTENCES,
  COORDINATOR_DELIVERY_SENT_TO_SESSION,
  COORDINATOR_DELIVERY_SESSION_TOLD,
  COORDINATOR_DELIVERY_STICKY_LABEL,
  coordinatorDeliverySentence,
  parseCoordinatorDelivery,
} from '../lib/coordinatorDelivery';
import { encodeId } from '../lib/idCodec';
import { decisionReceiptTime, sentToCoordinatorLine } from './EvidenceDecisionCard';
import { OWNER_ANSWER_TOLD } from './OwnerAnswerLine';
import { Transcript, UndeliveredCtx, type RunEvent } from './Transcript';

/**
 * A turn Orbit wrote to tell a session about a committed fact is drawn from the card the control plane
 * recorded beside it — one line, `Evidence revision 1 submitted: <task> · Sent to the coordinator ·
 * 07:30 PM`, opening to the words the agent read — and NOT as the owner's bubble full of protocol
 * (design: docs/mocks/coordinator-delivery-line/, approved 2026-10-31). Held in place the way every turn
 * card is: with the payload the line is drawn; without one — the same words — the turn is the bubble
 * it always was.
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

const TASK_ID = '01a0d6a9-d763-70e1-b4cf-8793e971b511';
const TITLE = 'Wiki model queue: one claim can take more requests than the concurrency room';

/** The head and a paragraph of what `buildCoordinatorDeliveryMessage` writes — the agent's reading. */
const TOLD = 'From Orbit · project “Runner link v1” has a revision of completion evidence for you to decide\n\n'
  + `Task “${TITLE}” (34nmQgDgyywHNIUtjb9TD) submitted revision 1 of its completion evidence.\n\n`
  + 'This project has Automatic on: whether a task is done is yours to decide from its evidence.';

const CARD: CoordinatorDeliveryCard = {
  kind: 'EVIDENCE_SUBMITTED',
  task: { id: TASK_ID, title: TITLE },
  revision: 1,
  count: null,
  deliveredAt: '2026-10-31T11:30:00.000Z',
  toCoordinator: true,
};

/** A `user` event as ingest stores one: the echo, and the card when there was one. */
function told(card?: unknown, extra: Record<string, unknown> = {}): RunEvent {
  return {
    seq: 7,
    type: 'user',
    turnId: 'turn-delivery',
    ts: '2026-10-31T11:30:01.000Z',
    payload: { text: TOLD, ...(card === undefined ? {} : { coordinatorDelivery: card }), ...extra },
  };
}

async function mount(events: RunEvent[], putBack?: (text: string) => void) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <UndeliveredCtx.Provider value={putBack ?? null}>
            <Transcript events={events} />
          </UndeliveredCtx.Provider>
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

const line = (): HTMLElement | null => container.querySelector('.coordinator-delivery .owner-answer-line');
const fold = (): HTMLDetailsElement => container.querySelector<HTMLDetailsElement>('.coordinator-delivery details.owner-answer-fold')!;
const said = (): string | null | undefined => container.querySelector('.coordinator-delivery-sentence')?.textContent;

/** One card of each kind, with what its line has to say. */
const EVERY_KIND: Array<{ card: CoordinatorDeliveryCard; says: string }> = [
  { card: CARD, says: `Evidence revision 1 submitted: ${TITLE}` },
  { card: { ...CARD, kind: 'EVIDENCE_MOVED_IN', revision: 3 }, says: `Evidence revision 3 moved in: ${TITLE}` },
  { card: { ...CARD, kind: 'DEPENDENT_READY', revision: null }, says: `Can start now: ${TITLE}` },
  { card: { ...CARD, kind: 'TASK_DISPATCH_REFUSED', revision: null }, says: `Could not start: ${TITLE}` },
  { card: { ...CARD, kind: 'PROJECT_BLOCKER_RAISED', revision: null }, says: `Blocker raised: ${TITLE}` },
  { card: { ...CARD, kind: 'TASK_RUN_STOPPED', revision: null }, says: `Run stopped: ${TITLE}` },
  { card: { ...CARD, kind: 'CRITERION_UNLANDED', task: null, revision: null, count: 3 }, says: 'Work not on main yet: 3 tasks' },
  { card: { ...CARD, kind: 'ACCEPTANCE_LANDED', task: null, revision: null, count: 9 }, says: 'All 9 criteria landed' },
  {
    card: { ...CARD, kind: 'ACCEPTANCE_LANDED_HELD', task: null, revision: null, count: 9 },
    says: 'All 9 criteria landed, Done held back',
  },
  {
    card: { ...CARD, kind: 'ACCEPTANCE_LANDED_DONE', task: null, revision: null, count: 9 },
    says: 'All 9 criteria landed, recorded Done',
  },
  { card: { ...CARD, kind: 'LOOKS_FINISHED', task: null, revision: null }, says: 'Looks finished, not recorded Done' },
  {
    card: { ...CARD, kind: 'SETTLED_UNMERGED', task: null, revision: null, count: 2 },
    says: 'Settled with work not on main: 2 commits',
  },
  { card: { ...CARD, kind: 'CRITERIA_APPROVED', task: null, revision: null }, says: 'Criteria proposal approved' },
  { card: { ...CARD, kind: 'CRITERIA_REJECTED', task: null, revision: null }, says: 'Criteria proposal rejected' },
];

describe('a fact told to this session', () => {
  it('is one line — what happened, then Sent to the coordinator · its clock — and no bubble in the reader’s name', async () => {
    await mount([told(CARD)]);

    expect(line(), `no line was drawn:\n${container.innerHTML}`).not.toBeNull();
    expect(said()).toBe(`Evidence revision 1 submitted: ${TITLE}`);
    expect(container.querySelector('.coordinator-delivery-sent')?.textContent).toBe(sentToCoordinatorLine(CARD.deliveredAt));
    expect(container.querySelector('.coordinator-delivery .owner-answer-chev')?.textContent).toBe('›');
    expect(container.querySelector('.chat-user'), 'drawn as the owner’s bubble').toBeNull();
    expect(container.querySelector('.coordinator-delivery')?.getAttribute('data-seq')).toBe('7');
  });

  it('gives way in the sentence, never in when it was sent', async () => {
    // The pill's own text truncates (`.owner-answer-text`); the time is a separate run that does not.
    await mount([told(CARD)]);
    expect(container.querySelector('.coordinator-delivery-sentence')?.classList.contains('owner-answer-text')).toBe(true);
    expect(container.querySelector('.coordinator-delivery-sent')?.classList.contains('owner-answer-text')).toBe(false);
  });

  it('is the anchor the sticky bar names once it is scrolled past: From Orbit, and its sentence', async () => {
    await mount([told(CARD)]);
    const anchor = container.querySelector<HTMLElement>('[data-sticky-label]');
    expect(anchor, 'no sticky anchor').not.toBeNull();
    expect(anchor!.getAttribute('data-sticky-label')).toBe(COORDINATOR_DELIVERY_STICKY_LABEL);
    expect(COORDINATOR_DELIVERY_STICKY_LABEL).toBe('From Orbit');
    expect(anchor!.getAttribute('data-sticky-text')).toBe(`Evidence revision 1 submitted: ${TITLE}`);
    expect(anchor!.getAttribute('data-seq')).toBe('7');
    expect(anchor!.classList.contains('is-queued')).toBe(false);
  });

  it('opens to the words the coordinator was handed, verbatim, and the task the fact names', async () => {
    await mount([told(CARD)]);
    expect(fold().open, 'the words are behind the line until it is pressed').toBe(false);

    await act(async () => line()!.click());

    expect(fold().open).toBe(true);
    expect(container.querySelector('.coordinator-delivery .owner-answer-told-head')?.textContent).toBe(OWNER_ANSWER_TOLD);
    expect(OWNER_ANSWER_TOLD).toBe('What the coordinator was told');
    expect(container.querySelector('.coordinator-delivery .owner-answer-told pre')?.textContent).toBe(TOLD);
    const task = container.querySelector<HTMLAnchorElement>('a.coordinator-delivery-task');
    expect(task?.textContent).toBe(COORDINATOR_DELIVERY_ITS_TASK);
    expect(COORDINATOR_DELIVERY_ITS_TASK).toBe('Its task ↗');
    expect(task?.getAttribute('href')).toBe(`/tasks/${encodeId(TASK_ID)}`);
  });

  it('says each fact in its own words, and names no task where the fact names none', async () => {
    expect(EVERY_KIND.map(({ card }) => card.kind)).toEqual([...COORDINATOR_DELIVERY_KINDS]);
    for (const { card, says } of EVERY_KIND) {
      expect(coordinatorDeliverySentence(card), card.kind).toBe(says);
      expect(parseCoordinatorDelivery({ coordinatorDelivery: card }), card.kind).toEqual(card);
      await remount([told(card)]);
      expect(said(), card.kind).toBe(says);
      expect(container.querySelector('[data-sticky-text]')?.getAttribute('data-sticky-text'), card.kind).toBe(says);
      expect(container.querySelector('.chat-user'), card.kind).toBeNull();
      expect(container.querySelector('a.coordinator-delivery-task') !== null, `${card.kind}: Its task`).toBe(card.task !== null);
    }
  });

  it('says one in the singular', () => {
    const one = (kind: CoordinatorDeliveryKind) => coordinatorDeliverySentence({ ...CARD, kind, task: null, revision: null, count: 1 });
    expect(one('CRITERION_UNLANDED')).toBe('Work not on main yet: 1 task');
    expect(one('ACCEPTANCE_LANDED')).toBe('The only criterion landed');
    expect(one('ACCEPTANCE_LANDED_HELD')).toBe('The only criterion landed, Done held back');
    expect(one('ACCEPTANCE_LANDED_DONE')).toBe('The only criterion landed, recorded Done');
    expect(one('SETTLED_UNMERGED')).toBe('Settled with work not on main: 1 commit');
  });

  it('writes a title as the words it is, never as a pattern', () => {
    for (const title of ['Use $& and $1 in the replacement', 'A {count} and a {revision} in the title']) {
      expect(coordinatorDeliverySentence({ ...CARD, task: { id: TASK_ID, title } })).toBe(`Evidence revision 1 submitted: ${title}`);
    }
  });

  it('keeps what delivery appended inside the line’s fold, as Orbit’s — never in a bubble', async () => {
    const role = '<orbit_project_coordinator_context>\nYou coordinate this project.\n</orbit_project_coordinator_context>';
    await mount([told(CARD, { text: `${TOLD}\n\n${role}`, controlPlaneNote: `\n\n${role}` })]);
    await act(async () => line()!.click());

    expect(container.querySelector('.coordinator-delivery .owner-answer-told pre')?.textContent).toBe(TOLD);
    expect(container.querySelector('.coordinator-delivery .owner-answer-told .chat-injected'), 'the appended block is not folded in').not.toBeNull();
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

    expect(said()).toBe(`Evidence revision 1 submitted: ${TITLE}`);
    expect(container.querySelector('.src-wrap'), 'the reply card is gone').not.toBeNull();
    expect(container.querySelector('.chat-user'), 'the delivery’s words became a bubble').toBeNull();
  });

  it('says when the session has not confirmed it received it, and offers nothing to put back in the composer', async () => {
    const putBack = vi.fn();
    for (const delivery of ['failed', 'unconfirmed']) {
      await act(async () => root.unmount());
      root = createRoot(container);
      await mount([told(CARD, { delivery })], putBack);
      expect(container.querySelector('.coordinator-delivery .owner-answer-undelivered')?.textContent, delivery)
        .toBe('The session has not confirmed it received this.');
      expect(container.textContent, delivery).not.toContain('Put back in the composer');
      expect(container.querySelector('.chat-undelivered-retry'), delivery).toBeNull();
    }
    expect(putBack).not.toHaveBeenCalled();
  });

  describe('the answer to a criteria proposal', () => {
    /** What `criteriaDecisionReplyMessage` writes to the session that filed the proposal. */
    const REPLY = 'From Orbit · criteria decision\n\nYour criteria proposal 34pX0YF3mJmoTBvNxc8Kt on project “Runner link v1” '
      + '(34nmPkyh9pd8tVm1fCv2Q) was refused by the account owner at 2026-10-31T11:30:00.000Z. Nothing was applied: '
      + 'criterion 2 stays at revision 1.';
    const REJECTED: CoordinatorDeliveryCard = { ...CARD, kind: 'CRITERIA_REJECTED', task: null, revision: null };
    const replied = (card: unknown): RunEvent => ({ ...told(card), payload: { text: REPLY, coordinatorDelivery: card } });

    it('told to a task’s run, says it was sent to this session — and opens to what this session was told', async () => {
      const run = { ...REJECTED, toCoordinator: false };
      await mount([replied(run)]);

      expect(said()).toBe('Criteria proposal rejected');
      const sent = container.querySelector('.coordinator-delivery-sent')?.textContent;
      expect(sent).toBe(`${COORDINATOR_DELIVERY_SENT_TO_SESSION} · ${decisionReceiptTime(run.deliveredAt)}`);
      expect(COORDINATOR_DELIVERY_SENT_TO_SESSION).toBe('Sent to this session');
      expect(container.textContent).not.toContain('Sent to the coordinator');

      await act(async () => line()!.click());
      expect(container.querySelector('.coordinator-delivery .owner-answer-told-head')?.textContent).toBe(COORDINATOR_DELIVERY_SESSION_TOLD);
      expect(COORDINATOR_DELIVERY_SESSION_TOLD).toBe('What this session was told');
      expect(container.textContent).not.toContain('What the coordinator was told');
      expect(container.querySelector('.coordinator-delivery .owner-answer-told pre')?.textContent).toBe(REPLY);
      // The sticky bar, the words and the rest of the line are what they were.
      const anchor = container.querySelector<HTMLElement>('[data-sticky-label]');
      expect(anchor?.getAttribute('data-sticky-label')).toBe('From Orbit');
      expect(anchor?.getAttribute('data-sticky-text')).toBe('Criteria proposal rejected');
      expect(container.querySelector('.chat-user'), 'drawn as the owner’s bubble').toBeNull();
    });

    it('told to the project’s coordinator, says what it said before', async () => {
      await mount([replied(REJECTED)]);
      expect(container.querySelector('.coordinator-delivery-sent')?.textContent).toBe(sentToCoordinatorLine(REJECTED.deliveredAt));
      await act(async () => line()!.click());
      expect(container.querySelector('.coordinator-delivery .owner-answer-told-head')?.textContent).toBe(OWNER_ANSWER_TOLD);
      expect(container.textContent).not.toContain(COORDINATOR_DELIVERY_SENT_TO_SESSION);
      expect(container.textContent).not.toContain(COORDINATOR_DELIVERY_SESSION_TOLD);
    });

    it('reads a card stored before the field as the coordinator’s, and only the server’s false as not', () => {
      const { toCoordinator: _, ...stored } = REJECTED;
      expect(parseCoordinatorDelivery({ coordinatorDelivery: stored })).toEqual(REJECTED);
      expect(parseCoordinatorDelivery({ coordinatorDelivery: { ...REJECTED, toCoordinator: false } })?.toCoordinator).toBe(false);
      for (const odd of ['false', 0, null, 'no']) {
        expect(parseCoordinatorDelivery({ coordinatorDelivery: { ...REJECTED, toCoordinator: odd } })?.toCoordinator, String(odd)).toBe(true);
      }
    });
  });

  // The negative control: the same conversation and the same words, with nothing recorded beside them.
  it('leaves a turn with no card as the bubble it always was', async () => {
    await mount([told(undefined, { delivery: 'failed' })], vi.fn());
    expect(line()).toBeNull();
    expect(container.querySelector('.chat-user .md')?.textContent).toContain('has a revision of completion evidence for you to decide');
    // Which is exactly what this change takes away from a delivery that carries its card.
    expect(container.textContent).toContain('Put back in the composer');
  });

  it('draws a payload that is not a card as the bubble too, never as half a line', async () => {
    const bad: unknown[] = [
      { ...CARD, kind: 'OWNER_ANSWER' },
      { ...CARD, deliveredAt: 'yesterday' },
      { ...CARD, deliveredAt: undefined },
      { ...CARD, task: null },
      { ...CARD, task: { id: '', title: TITLE } },
      { ...CARD, task: { id: TASK_ID, title: '  ' } },
      { ...CARD, revision: null },
      { ...CARD, revision: 0 },
      { ...CARD, revision: 1.5 },
      { ...CARD, kind: 'CRITERION_UNLANDED', task: null, revision: null, count: null },
      { ...CARD, kind: 'SETTLED_UNMERGED', task: null, revision: null, count: '2' },
      'Evidence revision 1 submitted',
      null,
    ];
    for (const payload of bad) {
      expect(parseCoordinatorDelivery({ text: TOLD, coordinatorDelivery: payload }), JSON.stringify(payload)).toBeNull();
      await remount([told(payload)]);
      expect(line(), `drew a line from ${JSON.stringify(payload)}`).toBeNull();
      expect(container.querySelector('.chat-user')).not.toBeNull();
    }
  });

  it('keeps only the fields the sentence names', () => {
    // A field the kind's sentence does not name is left off, so two readings of one fact are one card.
    expect(parseCoordinatorDelivery({
      coordinatorDelivery: { ...CARD, kind: 'LOOKS_FINISHED', count: 4, revision: 2 },
    })).toEqual({ ...CARD, kind: 'LOOKS_FINISHED', task: null, revision: null, count: null });
    for (const kind of COORDINATOR_DELIVERY_KINDS) {
      expect(COORDINATOR_DELIVERY_SENTENCES[kind], kind).toBeTruthy();
    }
  });
});
