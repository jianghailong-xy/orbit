import { describe, expect, it } from 'vitest';
import {
  acceptedUserTurnEvent,
  acceptedUserTurnLanded,
  queuedTurnsOutsideTranscript,
  reconcileQueuedTurnSnapshot,
  type AcceptedUserTurn,
} from './acceptedUserTurn';

const accepted = (over: Partial<AcceptedUserTurn> = {}): AcceptedUserTurn => ({
  key: 'turn-local',
  sessionId: 'session-a',
  turnId: 'turn-a',
  text: 'ship it',
  acceptedAt: '2026-08-26T16:00:00.000Z',
  attachments: [],
  ...over,
});

describe('an accepted user turn before its transcript event arrives', () => {
  it('keeps a continued-session message until the matching turn lands', () => {
    const turn = accepted();
    expect(acceptedUserTurnLanded(turn, 'session-a', [])).toBe(false);
    expect(
      acceptedUserTurnLanded(turn, 'session-a', [
        { seq: 1, type: 'user', payload: { text: 'older' }, turnId: 'turn-older' },
      ]),
    ).toBe(false);
    expect(
      acceptedUserTurnLanded(turn, 'session-a', [
        { seq: 2, type: 'user', payload: { text: 'ship it' }, turnId: 'turn-a' },
      ]),
    ).toBe(true);
  });

  it('replaces a new session prompt with that session’s first user event', () => {
    const opening = accepted({ key: 'initial:session-a', turnId: undefined });
    expect(
      acceptedUserTurnLanded(opening, 'session-a', [
        { seq: 1, type: 'system', payload: {} },
      ]),
    ).toBe(false);
    expect(
      acceptedUserTurnLanded(opening, 'session-a', [
        { seq: 2, type: 'user', payload: { text: 'ship it' } },
      ]),
    ).toBe(true);
  });

  it('does not mistake the previous session’s user event for a new session prompt', () => {
    const opening = accepted({ key: 'initial:session-a', turnId: undefined });
    expect(
      acceptedUserTurnLanded(opening, 'session-before-navigation', [
        { seq: 9, type: 'user', payload: { text: 'previous prompt' } },
      ]),
    ).toBe(false);
  });

  it('keeps an id-backed accepted turn scoped while switching away, then lands it on return', () => {
    const turn = accepted();
    expect(
      acceptedUserTurnLanded(turn, 'session-b', [
        { seq: 3, type: 'user', turnId: 'turn-a', payload: { text: 'another session' } },
      ]),
    ).toBe(false);
    expect(
      acceptedUserTurnLanded(turn, 'session-a', [
        { seq: 4, type: 'user', turnId: 'turn-a', payload: { text: 'ship it' } },
      ]),
    ).toBe(true);
  });

  it('builds the same user event shape Transcript receives from the server', () => {
    const event = acceptedUserTurnEvent(
      accepted({
        attachments: [{ id: 'attachment-a', mime: 'image/png', name: 'proof.png' }],
      }),
      4.5,
    );

    expect(event).toEqual({
      seq: 4.5,
      type: 'user',
      turnId: 'turn-a',
      ts: '2026-08-26T16:00:00.000Z',
      payload: {
        text: 'ship it',
        attachments: [{ id: 'attachment-a', mime: 'image/png', name: 'proof.png' }],
      },
    });
  });

  it('renders one copy when queued REST overlaps an accepted or durable user event', () => {
    const rows = [
      { turnId: 'turn-a', content: 'ship it' },
      { turnId: 'turn-b', content: 'follow up' },
    ];
    expect(
      queuedTurnsOutsideTranscript(rows, [acceptedUserTurnEvent(accepted(), 4.5)]),
    ).toEqual([{ turnId: 'turn-b', content: 'follow up' }]);
    expect(
      queuedTurnsOutsideTranscript(rows, [
        { seq: 5, type: 'user', turnId: 'turn-a', payload: { text: 'ship it' } },
      ]),
    ).toEqual([{ turnId: 'turn-b', content: 'follow up' }]);
  });

  it('does not let a stale REST snapshot erase a turn added after the fetch began', () => {
    const stale = { turnId: 'turn-stale', content: 'old' };
    const late = { turnId: 'turn-late', content: 'new' };
    expect(
      reconcileQueuedTurnSnapshot([], [stale, late], new Set(['turn-stale'])),
    ).toEqual([late]);
  });

  it('lets any server representation supersede a late local queued copy', () => {
    const local = { turnId: 'turn-a', content: 'local' };
    const server = { turnId: 'turn-a', content: 'server' };
    expect(reconcileQueuedTurnSnapshot([server], [local], new Set())).toEqual([server]);
    expect(
      reconcileQueuedTurnSnapshot([], [local], new Set(), new Set(['turn-a'])),
    ).toEqual([]);
  });

  it('keeps a steer through the REST-empty gap until its durable user event lands', () => {
    const steer = { turnId: 'turn-steer', content: 'adjust this', steer: true };

    expect(
      reconcileQueuedTurnSnapshot([], [steer], new Set(['turn-steer'])),
    ).toEqual([steer]);
    expect(
      queuedTurnsOutsideTranscript([steer], [
        {
          seq: 7,
          type: 'user',
          turnId: 'turn-steer',
          payload: { text: 'adjust this', steer: true },
        },
      ]),
    ).toEqual([]);
  });
});
