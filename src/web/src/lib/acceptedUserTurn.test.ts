import { describe, expect, it } from 'vitest';
import {
  acceptedUserTurnEvent,
  acceptedUserTurnLanded,
  clearAcceptedUserTurnsForSession,
  clearAcceptedUserTurnsForTurn,
  queuedTurnsOutsideTranscript,
  reconcileAcceptedUserTurnSnapshot,
  reconcileQueuedTurnSnapshot,
  type AcceptedUserTurn,
} from './acceptedUserTurn';

const accepted = (over: Partial<AcceptedUserTurn> = {}): AcceptedUserTurn => ({
  key: 'turn-local',
  sessionId: 'session-a',
  source: 'local',
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

  it('does not let a same-turn non-user event retire the optimistic user bubble', () => {
    const turn = accepted();

    expect(
      acceptedUserTurnLanded(turn, 'session-a', [
        { seq: 900, type: 'background', turnId: 'turn-a', payload: { text: 'still running' } },
      ]),
    ).toBe(false);
    expect(
      acceptedUserTurnLanded(turn, 'session-a', [
        { seq: 901, type: 'user', turnId: 'turn-a', payload: { text: 'ship it' } },
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

describe('accepted active-snapshot reconciliation', () => {
  const recovered = (over: Partial<AcceptedUserTurn> = {}): AcceptedUserTurn =>
    accepted({
      key: 'turn-recovered',
      turnId: 'turn-recovered',
      source: 'activeSnapshot',
      text: 'old active head',
      ...over,
    });

  it('prunes a recovered accepted row once the authoritative active snapshot becomes empty', () => {
    const ghost = recovered();

    expect(
      reconcileAcceptedUserTurnSnapshot([], [ghost], 'session-a', new Set([ghost.key])),
    ).toEqual([]);
  });

  it('does not let an old empty response erase a local POST accepted after the request began', () => {
    const old = recovered({ key: 'turn-old', turnId: 'turn-old' });
    const late = accepted({ key: 'turn-late', turnId: 'turn-late', text: 'new local send' });

    expect(
      reconcileAcceptedUserTurnSnapshot(
        [],
        [old, late],
        'session-a',
        new Set([old.key]),
      ),
    ).toEqual([late]);
  });

  it('keeps a local acknowledgement when REST sees the user event before this tab does', () => {
    const local = accepted();

    expect(
      reconcileAcceptedUserTurnSnapshot([], [local], 'session-a', new Set([local.key])),
    ).toEqual([local]);
  });

  it('keeps the local copy when the same turn is also present in the server snapshot', () => {
    const local = accepted({ text: 'local body' });
    const server = recovered({ key: local.key, turnId: local.turnId, text: 'server body' });

    expect(
      reconcileAcceptedUserTurnSnapshot([server], [local], 'session-a', new Set([local.key])),
    ).toEqual([local]);
  });

  it('preserves an initial opening prompt because active snapshots deliberately omit it', () => {
    const opening = accepted({
      key: 'initial:session-a',
      turnId: undefined,
      text: 'start the session',
    });

    expect(
      reconcileAcceptedUserTurnSnapshot([], [opening], 'session-a', new Set([opening.key])),
    ).toEqual([opening]);
  });

  it('reconciles only the selected session', () => {
    const other = recovered({
      key: 'turn-other-session',
      turnId: 'turn-other-session',
      sessionId: 'session-b',
    });
    const selected = recovered();

    expect(
      reconcileAcceptedUserTurnSnapshot(
        [],
        [other, selected],
        'session-a',
        new Set([selected.key]),
      ),
    ).toEqual([other]);
  });
});

describe('accepted terminal cleanup', () => {
  it('turn_end removes only the matching turn in the matching session', () => {
    const ended = accepted();
    const successor = accepted({ key: 'turn-next', turnId: 'turn-next' });
    const other = accepted({ key: 'turn-other', turnId: 'turn-a', sessionId: 'session-b' });

    expect(
      clearAcceptedUserTurnsForTurn([ended, successor, other], 'session-a', 'turn-a'),
    ).toEqual([successor, other]);
  });

  it('final removes every accepted placeholder for that session and no other session', () => {
    const opening = accepted({ key: 'initial:session-a', turnId: undefined });
    const continued = accepted();
    const other = accepted({ key: 'turn-other', sessionId: 'session-b' });

    expect(
      clearAcceptedUserTurnsForSession([opening, continued, other], 'session-a'),
    ).toEqual([other]);
  });
});
