import { describe, expect, it } from 'vitest';
import type { ProjectOpenItemRow, ProjectOpenItemsView, ProjectPromotionView } from '@orbit/shared';
import { CHAT_ABOUT_INTENT, chatAboutOf, chatIntentOf, chatSubjectIn, coordinatorChatPath } from './coordinatorChat';
import { encodeId } from './idCodec';

/**
 * `chatSubjectIn`: what a chat is about, read again from the reads in front of the conversation — at
 * an arrival from a press made elsewhere, and at the send. An item is found wherever the list holds
 * it; a candidate only while it is still the blocked one, with the item that holds it and never the
 * approval its next state asks.
 */

const ITEM = '0195c0de-0000-7000-8000-0000000000c1';
const PROMOTION = '0195c0de-0000-7000-8000-0000000000c2';

function row(over: Partial<ProjectOpenItemRow>): ProjectOpenItemRow {
  return {
    itemId: ITEM,
    kind: 'TASK_FAILED',
    title: 'Task failed: P5.1',
    detailLine: '',
    assignee: 'OWNER',
    assigneeReason: 'ESCALATED',
    waitingSince: '2026-09-11T01:00:00.000Z',
    escalateAt: null,
    escalatedAt: '2026-09-11T03:00:00.000Z',
    taskId: '0195c0de-0000-7000-8000-0000000000c3',
    sessionId: null,
    promotionId: null,
    fuseEpisodeId: null,
    delivery: { state: 'NOT_REQUIRED', sessionId: null, at: null },
    actions: [],
    question: null,
    facts: null,
    ...over,
  };
}

const CHECK_FAILED = row({
  itemId: '0195c0de-0000-7000-8000-0000000000c4',
  kind: 'INTEGRATION_CHECK_FAILED',
  taskId: null,
  promotionId: PROMOTION,
});
const APPROVAL = row({
  itemId: '0195c0de-0000-7000-8000-0000000000c5',
  kind: 'PROMOTION_APPROVAL',
  assigneeReason: 'DEFAULT',
  taskId: null,
  promotionId: PROMOTION,
});

function items(over: Partial<ProjectOpenItemsView> = {}): ProjectOpenItemsView {
  return { needsYou: [], withCoordinator: [], settled: [], ...over };
}

function candidate(state: ProjectPromotionView['state']): ProjectPromotionView {
  return { promotionId: PROMOTION, state } as ProjectPromotionView;
}

describe('chatSubjectIn', () => {
  it('finds an item in whichever group holds it now, however its id is spelled', () => {
    const settled = row({ assignee: 'COORDINATOR' });
    expect(chatSubjectIn({ itemId: encodeId(ITEM) }, items({ settled: [settled] }), null))
      .toEqual({ kind: 'item', row: settled });
    expect(chatSubjectIn({ itemId: ITEM }, items({ withCoordinator: [settled] }), undefined))
      .toEqual({ kind: 'item', row: settled });
    expect(chatSubjectIn({ itemId: ITEM }, items(), null)).toBeNull();
    expect(chatSubjectIn({ itemId: ITEM }, undefined, null), 'a read on its way').toBeNull();
  });

  it('takes a candidate only while it is blocked, with the item holding it — not its approval', () => {
    const read = items({ needsYou: [APPROVAL, CHECK_FAILED] });
    expect(chatSubjectIn({ promotionId: PROMOTION }, read, candidate('BLOCKED'))).toEqual({
      kind: 'promotion',
      promotion: candidate('BLOCKED'),
      item: CHECK_FAILED,
    });
    expect(chatSubjectIn({ promotionId: PROMOTION }, items({ needsYou: [APPROVAL] }), candidate('BLOCKED')))
      .toEqual({ kind: 'promotion', promotion: candidate('BLOCKED'), item: null });
    for (const state of ['READY', 'CHECKING', 'CONFIRMED', 'MERGED'] as const) {
      expect(chatSubjectIn({ promotionId: PROMOTION }, read, candidate(state)), state).toBeNull();
    }
    expect(chatSubjectIn({ promotionId: encodeId('0195c0de-0000-7000-8000-0000000000c9') }, read,
      candidate('BLOCKED')), 'another candidate').toBeNull();
    expect(chatSubjectIn({ promotionId: PROMOTION }, read, null)).toBeNull();
  });

  it('names a subject by the ids it was armed with', () => {
    expect(chatAboutOf({ kind: 'item', row: CHECK_FAILED })).toEqual({ itemId: CHECK_FAILED.itemId });
    expect(chatAboutOf({ kind: 'promotion', promotion: candidate('BLOCKED'), item: null }))
      .toEqual({ promotionId: PROMOTION });
  });
});

describe('coordinatorChatPath', () => {
  const SESSION = '0195c0de-0000-7000-8000-0000000000c6';

  it('opens the conversation at the subject alone — nothing of the page the press was made on rides along', () => {
    const item = coordinatorChatPath(SESSION, { kind: 'item', row: CHECK_FAILED });
    expect(item.startsWith(`/sessions/${encodeId(SESSION)}?`), 'a path relative to the page the press was made on').toBe(true);
    const itemParams = new URLSearchParams(item.slice(item.indexOf('?')));
    expect([...itemParams]).toEqual([['intent', CHAT_ABOUT_INTENT], ['item', encodeId(CHECK_FAILED.itemId)]]);
    expect(chatIntentOf(itemParams)).toEqual({ itemId: encodeId(CHECK_FAILED.itemId) });

    const merge = coordinatorChatPath(SESSION, { kind: 'promotion', promotion: candidate('BLOCKED'), item: CHECK_FAILED });
    const mergeParams = new URLSearchParams(merge.slice(merge.indexOf('?')));
    expect([...mergeParams]).toEqual([['intent', CHAT_ABOUT_INTENT], ['promotion', encodeId(PROMOTION)]]);
    expect(chatIntentOf(mergeParams)).toEqual({ promotionId: encodeId(PROMOTION) });
  });

  it('reads an arrival only from its own intent: an item or a candidate in the URL without it is not one', () => {
    expect(chatIntentOf(new URLSearchParams(`item=${encodeId(ITEM)}`))).toBeNull();
    expect(chatIntentOf(new URLSearchParams(`intent=project&promotion=${encodeId(PROMOTION)}`))).toBeNull();
    expect(chatIntentOf(new URLSearchParams(`intent=${CHAT_ABOUT_INTENT}`))).toBeNull();
  });
});
