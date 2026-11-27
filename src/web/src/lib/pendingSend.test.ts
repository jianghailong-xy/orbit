import { describe, expect, it } from 'vitest';
import { acceptedUserTurnEvent, acceptedUserTurnLanded, reconcileAcceptedUserTurnSnapshot, type AcceptedUserTurn } from './acceptedUserTurn';
import { answerDeadline, dropPendingSend, isSendNotAnswered, markNotSent, SendNotAnsweredError, withPendingSend } from './pendingSend';

const pending = (state: 'sending' | 'notSent' = 'sending'): AcceptedUserTurn => ({
  key: 'pending:k1',
  sessionId: 's1',
  source: 'local',
  text: 'check the load',
  acceptedAt: '2026-11-27T10:00:00Z',
  attachments: [],
  pending: { state, afterSeq: 5 },
});

describe('a pending send', () => {
  it('is drawn with its state, and its reason, as the bubble reads them', () => {
    expect((acceptedUserTurnEvent(pending(), 6).payload as { delivery: string }).delivery).toBe('sending');
    const notSent = markNotSent([pending()], 'pending:k1', 'Session is busy')[0];
    expect(acceptedUserTurnEvent(notSent, 6).payload).toMatchObject({ delivery: 'not_sent', deliveryReason: 'Session is busy' });
  });

  it('lands on the first user event after the press with the same words — not on an older one, nor on other words', () => {
    const user = (seq: number, text: string) => ({ seq, type: 'user', turnId: `t${seq}`, payload: { text } });
    expect(acceptedUserTurnLanded(pending(), 's1', [user(4, 'check the load')])).toBe(false);
    expect(acceptedUserTurnLanded(pending(), 's1', [user(6, 'something else')])).toBe(false);
    expect(acceptedUserTurnLanded(pending('notSent'), 's1', [user(6, 'check the load')])).toBe(true);
    // Translated on the way: the echo carries the English, and what was typed as the original.
    expect(acceptedUserTurnLanded(pending(), 's1', [
      { seq: 7, type: 'user', turnId: 't7', payload: { text: 'translated', translation: { original: 'check the load' } } },
    ])).toBe(true);
  });

  it('is not taken for the opening prompt when a snapshot lists one', () => {
    const opening: AcceptedUserTurn = { key: 'open', sessionId: 's1', source: 'activeSnapshot', turnId: 't1', opening: true, text: 'hi', acceptedAt: '', attachments: [] };
    const next = reconcileAcceptedUserTurnSnapshot([opening], [pending()], 's1', new Set());
    expect(next.map((t) => t.key)).toEqual(['open', 'pending:k1']);
  });

  it('is added once, marked, and dropped by its key', () => {
    const list = withPendingSend(withPendingSend([], pending()), pending());
    expect(list).toHaveLength(1);
    expect(markNotSent(list, 'other', 'x')).toBe(list);
    expect(dropPendingSend(list, 'pending:k1')).toEqual([]);
  });

  it('ends its request when the answer is late, with the reason the bubble shows', async () => {
    const { signal } = answerDeadline(10);
    await new Promise((r) => setTimeout(r, 30));
    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBeInstanceOf(SendNotAnsweredError);
    expect(isSendNotAnswered(signal.reason)).toBe(true);
    const settled = answerDeadline(10);
    settled.done();
    await new Promise((r) => setTimeout(r, 30));
    expect(settled.signal.aborted).toBe(false);
  });
});
