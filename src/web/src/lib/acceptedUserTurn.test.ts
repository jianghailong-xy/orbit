import { describe, expect, it } from 'vitest';
import {
  acceptedUserTurnEvent,
  acceptedUserTurnLanded,
  clearAcceptedUserTurnsForSession,
  clearAcceptedUserTurnsForTurn,
  queuedTurnsOutsideTranscript,
  reconcileAcceptedUserTurnSnapshot,
  reconcileQueuedTurnSnapshot,
  transcriptEventsWithDurableDeliveryReceipts,
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
      { turnId: 'turn-a', content: 'ship it', placement: 'queued' as const },
      { turnId: 'turn-b', content: 'follow up', placement: 'queued' as const },
    ];
    expect(
      queuedTurnsOutsideTranscript(rows, [acceptedUserTurnEvent(accepted(), 4.5)]),
    ).toEqual([{ turnId: 'turn-b', content: 'follow up', placement: 'queued' }]);
    expect(
      queuedTurnsOutsideTranscript(rows, [
        { seq: 5, type: 'user', turnId: 'turn-a', payload: { text: 'ship it' } },
      ]),
    ).toEqual([{ turnId: 'turn-b', content: 'follow up', placement: 'queued' }]);
  });

  it('does not let a stale REST snapshot erase a turn added after the fetch began', () => {
    const stale = { turnId: 'turn-stale', content: 'old', placement: 'queued' as const };
    const late = { turnId: 'turn-late', content: 'new', placement: 'queued' as const };
    expect(
      reconcileQueuedTurnSnapshot([], [stale, late], new Set(['turn-stale'])),
    ).toEqual([late]);
  });

  it('lets any server representation supersede a late local queued copy', () => {
    const local = { turnId: 'turn-a', content: 'local', placement: 'queued' as const };
    const server = { turnId: 'turn-a', content: 'server', placement: 'queued' as const };
    expect(reconcileQueuedTurnSnapshot([server], [local], new Set())).toEqual([server]);
    expect(
      reconcileQueuedTurnSnapshot([], [local], new Set(), new Set(['turn-a'])),
    ).toEqual([]);
  });

  it('authoritative REST absence prunes a known steer so terminal failures cannot ghost', () => {
    const steer = {
      turnId: 'turn-steer',
      targetTurnId: 'turn-running',
      content: 'adjust this',
      placement: 'steer' as const,
    };

    expect(
      reconcileQueuedTurnSnapshot([], [steer], new Set(['turn-steer'])),
    ).toEqual([]);
  });

  it('matches a steer only by its own authored turn id, never by its target', () => {
    const steer = {
      turnId: 'turn-steer',
      targetTurnId: 'turn-running',
      content: 'adjust this',
      placement: 'steer' as const,
    };
    const targetEvent = {
      seq: 6,
      type: 'user',
      turnId: 'turn-running',
      payload: { text: 'opening' },
    };

    expect(queuedTurnsOutsideTranscript([steer], [targetEvent])).toEqual([steer]);
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

  it('merges server-only failure into the matching USER bubble at its original position', () => {
    const failed = {
      turnId: 'turn-current-work',
      targetTurnId: 'turn-running',
      content: 'adjust this',
      placement: 'steer' as const,
      delivery: 'failed' as const,
    };
    const transcript = [
      {
        seq: 7,
        type: 'user',
        turnId: 'turn-current-work',
        payload: { text: 'adjust this', delivery: 'written' },
      },
      { seq: 8, type: 'user', turnId: 'turn-b', payload: { text: 'newer B' } },
      { seq: 9, type: 'user', turnId: 'turn-c', payload: { text: 'newer C' } },
    ];
    const merged = transcriptEventsWithDurableDeliveryReceipts(transcript, [{
      ...failed,
      deliveryReason: 'target ended',
    }]);

    expect(merged.slice(0, 3)).toEqual(transcript);
    expect(merged[3]).toMatchObject({
      type: 'user_delivery',
      payload: {
        turnId: 'turn-current-work',
        delivery: 'failed',
        reason: 'target ended',
      },
    });
    expect(queuedTurnsOutsideTranscript([failed], merged)).toEqual([]);
    expect(queuedTurnsOutsideTranscript([failed], [])).toEqual([failed]);
  });

  it('does not duplicate a runner-authored USER_DELIVERY failure', () => {
    const failed = {
      turnId: 'turn-current-work',
      targetTurnId: 'turn-running',
      content: 'adjust this',
      placement: 'steer' as const,
      delivery: 'failed' as const,
    };
    const optimisticOnly = [{
      seq: 7,
      type: 'user',
      turnId: 'turn-current-work',
      payload: { text: 'adjust this', delivery: 'written' },
    }];

    const runnerFailed = [
      ...optimisticOnly,
      {
        seq: 8,
        type: 'user_delivery',
        turnId: 'turn-running',
        payload: {
          turnId: 'turn-current-work',
          delivery: 'failed',
          reason: 'target ended',
        },
      },
    ];
    expect(transcriptEventsWithDurableDeliveryReceipts(runnerFailed, [failed])).toEqual(runnerFailed);
    expect(queuedTurnsOutsideTranscript([failed], runnerFailed)).toEqual([]);
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
