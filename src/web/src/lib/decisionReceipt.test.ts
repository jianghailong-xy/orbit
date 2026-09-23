import { describe, expect, it } from 'vitest';
import {
  criteriaDecisionReceiptRows,
  decisionReceiptAnchor,
} from './decisionReceipt';
import type {
  CriteriaDecisionReply,
  PendingCriteriaDecisionQueue,
  SettledCriteriaDecision,
} from '../components/CriteriaDecisionCard';

/**
 * Where a decision leaves its receipt in a conversation, and which answers this one draws.
 *
 * The card remembered an answer only for as long as the page did, so a reload took a decided
 * proposal out of the conversation it was decided in — the account owner's report, 2026-09-16. What
 * survives a reload is the answer on the read, and this is the half that says where each one goes:
 * the moment it happened, and the replies only a press in this window can know.
 */

const SEAL = '6b1d02e4c8a1f3d5b7e9a2c4f6081a3c5e7f9b1d3a5c7e9f1b3d5a7c9e1f3b5d';
const DECIDED_AT = '2026-09-13T13:09:34.230Z';

/** The conversation: a receipt for a decision made in it lands after the event before that moment. */
const EVENTS = [
  { seq: 1, ts: '2026-09-13T12:50:00.000Z' },
  { seq: 2, ts: '2026-09-13T12:53:55.000Z' },
  { seq: 3 },
  { seq: 4, ts: '2026-09-13T13:20:00.000Z' },
];

function settled(over: Partial<SettledCriteriaDecision> = {}): SettledCriteriaDecision {
  return {
    intentId: '2SXZNKDyOUtFL540SQ0oz2',
    decision: 'APPROVE',
    decidedAt: DECIDED_AT,
    baseSeal: SEAL,
    resultingSeal: 'f'.repeat(64),
    ...over,
  };
}

function queue(rows: SettledCriteriaDecision[]): PendingCriteriaDecisionQueue {
  return {
    readAt: '2026-09-13T13:20:00.000Z',
    projectId: '34MPiBgZ80YpSKt0lmTQA',
    count: 0,
    oldestAgeSeconds: null,
    decidableCount: 0,
    pending: [],
    settled: rows,
  };
}

const REPLY: CriteriaDecisionReply = {
  channel: 'SESSION',
  sessionId: '4loVMXEZpNVNZAWLb9Wq4D',
  sessionTitle: '执行任务：改写项目硬约束 1、3 与判据 2',
  turnId: '2kQ7xVb9LmN3pR5sT8wYz',
  sentAt: '2026-09-13T13:09:35.000Z',
};

describe('where a receipt goes', () => {
  it('follows the last event recorded at or before the decision', () => {
    expect(decisionReceiptAnchor(EVENTS, DECIDED_AT)).toBe(2);
    expect(decisionReceiptAnchor(EVENTS, '2026-09-13T12:53:55.000Z')).toBe(2);
    expect(decisionReceiptAnchor(EVENTS, '2026-09-13T14:00:00.000Z')).toBe(4);
  });

  it('answers head when every loaded event is later — not "no place"', () => {
    // It is drawn at the head of the window (above the first row and the load-earlier control),
    // because a record whose moment is above everything loaded is still a record: the alternative
    // was dropping it, and the owner's report of 2026-09-22 is what dropping it costs.
    expect(decisionReceiptAnchor(EVENTS, '2026-09-13T12:00:00.000Z')).toBe('head');
  });

  it('draws nothing for a stamp nothing can parse', () => {
    // The head claims "older than everything here", which is a claim about a moment — and this is
    // not one. A record nobody can place is not drawn in the wrong place.
    expect(decisionReceiptAnchor(EVENTS, 'not a stamp')).toBeNull();
  });
});

describe('the criteria receipts an open conversation draws', () => {
  it('draws one per answered proposal the read publishes, at the moment it was decided', () => {
    expect(criteriaDecisionReceiptRows(queue([settled()]), EVENTS)).toEqual([
      { settled: settled(), reply: null, placement: 2 },
    ]);
    // Newest first, as the read publishes them, each at its own moment rather than in a stack.
    const older = settled({ intentId: 'older', decidedAt: '2026-09-13T12:52:00.000Z' });
    expect(criteriaDecisionReceiptRows(queue([settled(), older]), EVENTS)
      .map((row) => row.placement)).toEqual([2, 1]);
  });

  it('carries where the answer went for a press made in this window, and nothing otherwise', () => {
    const published = queue([settled()]);
    // The positive control: the same row, with the door's own reply beside it.
    expect(criteriaDecisionReceiptRows(published, EVENTS, { [settled().intentId]: REPLY })
      .map((row) => row.reply)).toEqual([REPLY]);
    // A press in another window or on another device was handed no reply, and says nothing about
    // where the answer went rather than claiming it went nowhere.
    expect(criteriaDecisionReceiptRows(published, EVENTS).map((row) => row.reply)).toEqual([null]);
    expect(criteriaDecisionReceiptRows(published, EVENTS, {}).map((row) => row.reply))
      .toEqual([null]);
  });

  it('draws an answer older than the events loaded so far at the head', () => {
    const before = settled({ decidedAt: '2026-09-13T12:00:00.000Z' });
    expect(criteriaDecisionReceiptRows(queue([before]), EVENTS).map((row) => row.placement))
      .toEqual(['head']);
    // And with one event before it, it sits where it happened rather than at the head — the same
    // row, two windows, two honest answers.
    expect(criteriaDecisionReceiptRows(queue([before]), [
      { seq: 0, ts: '2026-09-13T11:00:00.000Z' },
      ...EVENTS,
    ]).map((row) => row.placement)).toEqual([0]);
  });

  it('draws nothing at all for a read with no answers on it', () => {
    expect(criteriaDecisionReceiptRows(queue([]), EVENTS)).toEqual([]);
    expect(criteriaDecisionReceiptRows(undefined, EVENTS)).toEqual([]);
  });
});
