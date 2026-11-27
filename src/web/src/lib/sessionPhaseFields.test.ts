import { describe, expect, it } from 'vitest';
import { sessionSendDispositionOf } from './sessionCapabilities';
import { shouldPollSessionDetail } from './sessionDetailPolling';
import { runWorkspaceMove } from './sessionFolders';
import {
  isSessionLive,
  isSessionQueued,
  isSessionTerminal,
  isSessionWorking,
  sessionLastTurnOutcomeOf,
  sessionPhaseOf,
  sessionReleasedOf,
  sessionWaitingOnOf,
} from './sessionState';
import { followDelay, WORKING_POLL_MS } from '../pages/SharedSessionPage';
import { held, olderServer, resumable, SITUATIONS, type Payload } from './sessionPhaseFields.fixture';

/**
 * Plan step 5.2 (docs/session-three-state-plan.md §8): the web decides send versus resume, the wait after End
 * and its polling stops from `released` and `phase` (contracts/session-state.contract.json), and from the legacy
 * fields exactly as before when an older control plane sends neither. Every situation below is the payload a
 * current server sends (legacy fields unchanged, beside the four new ones), and the same payload without them.
 */

describe('the new-field readers', () => {
  it('read the server fields as sent', () => {
    const s = SITUATIONS['waiting on an approval'];
    expect(sessionPhaseOf(s)).toBe('RUNNING');
    expect(sessionWaitingOnOf(s)).toBe('PERSON');
    expect(sessionReleasedOf(SITUATIONS['released by End'])).toBe(true);
    expect(sessionLastTurnOutcomeOf(SITUATIONS['released by a failed turn'])).toBe('FAILED');
  });

  it('read a value this client does not know as absent', () => {
    const s: Payload = { id: 's', runState: 'RUNNING', phase: 'SLEEPING', waitingOn: 'MOON', lastTurnOutcome: 'MAYBE' };
    expect(sessionPhaseOf(s)).toBeNull();
    expect(sessionWaitingOnOf(s)).toBeNull();
    expect(sessionLastTurnOutcomeOf(s)).toBeNull();
  });

  it('read nothing from an older control plane, and decide released from the old run state', () => {
    for (const [name, payload] of Object.entries(SITUATIONS)) {
      const old = olderServer(payload);
      expect(sessionPhaseOf(old), name).toBeNull();
      expect(sessionWaitingOnOf(old), name).toBeNull();
      expect(sessionLastTurnOutcomeOf(old), name).toBeNull();
    }
    expect(sessionReleasedOf(olderServer(SITUATIONS['held idle']))).toBe(false);
    expect(sessionReleasedOf(olderServer(SITUATIONS['released by End']))).toBe(true);
  });
});

describe('send versus resume', () => {
  // [situation, with the new fields, with them absent]. The older-server column is today's decision unchanged.
  const cases: [string, string, string][] = [
    ['held idle', 'SEND', 'SEND'],
    ['released by a failed turn', 'RESUME', 'RESUME'],
    ['released by End', 'RESUME', 'RESUME'],
    ['a task run that finished', 'RESUME', 'RESUME'],
    ['running a job with no turn', 'SEND', 'SEND'],
    ['waiting on an approval', 'SEND', 'SEND'],
    ['on hold', 'SEND', 'SEND'],
    ['will wake', 'SEND', 'SEND'],
    ['released with a retry armed', 'RESUME', 'RESUME'],
    ['ended, runner never confirmed', 'RESUME', 'RESUME'],
    ['old plain row stored SUCCEEDED', 'RESUME', 'RESUME'],
    // Still held: the message waits for the End to settle instead of opening a new session beside it. An older
    // server's run state called it ended and fell through to a new session.
    ['ending after an interrupted turn', 'BLOCK', 'CREATE'],
    ['a running turn', 'SEND', 'SEND'],
    ['a queued turn', 'SEND', 'SEND'],
    ['parked with the engine\'s own turn', 'SEND', 'SEND'],
    ['parked with a sub-agent running', 'SEND', 'SEND'],
    ['interrupted', 'SEND', 'SEND'],
  ];
  for (const [name, withFields, without] of cases) {
    it(`${name}: ${withFields} with the new fields, ${without} without them`, () => {
      expect(sessionSendDispositionOf(SITUATIONS[name], true)).toBe(withFields);
      expect(sessionSendDispositionOf(olderServer(SITUATIONS[name]), true)).toBe(without);
    });
  }

  it('reads released before a contradicting run state', () => {
    const releasedButSaysRunning: Payload = { id: 's', runState: 'RUNNING', released: true, capabilities: resumable };
    expect(isSessionLive(releasedButSaysRunning)).toBe(false);
    expect(sessionSendDispositionOf(releasedButSaysRunning, true)).toBe('RESUME');
  });

  it('a released session the server cannot resume starts a new one, with or without the new fields', () => {
    const s: Payload = { ...SITUATIONS['released by End'], capabilities: { canSend: false, canResume: false, resumeBlockedReason: 'MISSING_CONTEXT' } };
    expect(sessionSendDispositionOf(s, true)).toBe('CREATE');
    expect(sessionSendDispositionOf(olderServer(s), true)).toBe('CREATE');
  });
});

describe('the wait after End', () => {
  const noSleep = async () => {};
  /** The move flow of SessionMoveModal and CoordinatorChange: End, then poll the detail until isSessionTerminal. */
  const moveAfterEnd = async (snapshots: Payload[]) => {
    const calls: string[] = [];
    let read = 0;
    const out = await runWorkspaceMove({
      endingFirst: true,
      end: async () => calls.push('end'),
      ended: async () => {
        const snapshot = snapshots[Math.min(read, snapshots.length - 1)];
        read += 1;
        return isSessionTerminal(snapshot);
      },
      move: async () => calls.push('move'),
      sleep: noSleep,
      intervalMs: 1,
      timeoutMs: 100,
    });
    return { out, calls, reads: read };
  };

  const endingRunning: Payload = {
    id: 's', status: 'RUNNING', runStatus: 'RUNNING', runState: 'RUNNING', endReason: 'ended', activity: 'TURN',
    phase: 'RUNNING', released: false, lastTurnOutcome: null, waitingOn: null,
  };

  it('waits until the session is released, then moves', async () => {
    const r = await moveAfterEnd([endingRunning, endingRunning, SITUATIONS['released by End']]);
    expect(r.out).toBeNull();
    expect(r.calls).toEqual(['end', 'move']);
    expect(r.reads).toBe(3);
  });

  it('waits the same way from an older control plane', async () => {
    const r = await moveAfterEnd([olderServer(endingRunning), olderServer(endingRunning), olderServer(SITUATIONS['released by End'])]);
    expect(r.out).toBeNull();
    expect(r.reads).toBe(3);
  });

  it('an interrupted session being ended is not moved before its runner lets go', async () => {
    const r = await moveAfterEnd([SITUATIONS['ending after an interrupted turn'], SITUATIONS['released by End']]);
    expect(r.reads).toBe(2);
    expect(r.calls).toEqual(['end', 'move']);
  });

  it('an older control plane keeps its old reading: an interrupted session with an end reason reads ended', async () => {
    const r = await moveAfterEnd([olderServer(SITUATIONS['ending after an interrupted turn'])]);
    expect(r.reads).toBe(1);
    expect(r.calls).toEqual(['end', 'move']);
  });

  it('a session that is never released times out instead of moving', async () => {
    const r = await moveAfterEnd([endingRunning]);
    expect(r.calls).toEqual(['end']);
    expect(r.out).not.toBeNull();
  });
});

describe('polling stops', () => {
  // [situation, the open detail polls, the shared page's next look (ms, or null once it stops)], with the new
  // fields; then the same without them.
  const WAITING = 30_000;
  const cases: [string, boolean, number | null, boolean, number | null][] = [
    ['held idle', true, WAITING, true, WAITING],
    ['released by a failed turn', false, null, false, null],
    ['released by End', false, null, false, null],
    ['a task run that finished', false, null, false, null],
    // D8: a job running for the session is work in progress, followed as closely as a turn. An older server
    // said only that it was parked, which is followed at the waiting pace.
    ['running a job with no turn', true, WORKING_POLL_MS, true, WAITING],
    ['waiting on an approval', true, WORKING_POLL_MS, true, WORKING_POLL_MS],
    ['on hold', true, WORKING_POLL_MS, true, WORKING_POLL_MS],
    ['will wake', true, WAITING, true, WAITING],
    ['released with a retry armed', false, null, false, null],
    ['ended, runner never confirmed', false, null, false, null],
    ['old plain row stored SUCCEEDED', false, null, false, null],
    // Held until the release lands, so it is still followed; the older reading stopped at once.
    ['ending after an interrupted turn', true, WAITING, false, null],
  ];
  for (const [name, polls, follow, oldPolls, oldFollow] of cases) {
    it(`${name}: detail ${polls ? 'polls' : 'stops'}, shared page ${follow ?? 'stops'}; without the new fields ${oldPolls ? 'polls' : 'stops'}, ${oldFollow ?? 'stops'}`, () => {
      const s = SITUATIONS[name];
      const old = olderServer(s);
      expect(shouldPollSessionDetail('s', s, null)).toBe(polls);
      expect(followDelay(s, false)).toBe(follow);
      expect(shouldPollSessionDetail('s', old, null)).toBe(oldPolls);
      expect(followDelay(old, false)).toBe(oldFollow);
    });
  }

  it('the help chat counts a held turn as working, with or without the new fields', () => {
    expect(isSessionQueued(SITUATIONS['on hold'])).toBe(true);
    expect(isSessionQueued(olderServer(SITUATIONS['on hold']))).toBe(true);
    expect(isSessionQueued(SITUATIONS['held idle'])).toBe(false);
    expect(isSessionQueued(olderServer(SITUATIONS['held idle']))).toBe(false);
  });

  it('a job running reads as working only from the new field', () => {
    expect(isSessionWorking(SITUATIONS['running a job with no turn'])).toBe(true);
    expect(isSessionWorking(olderServer(SITUATIONS['running a job with no turn']))).toBe(false);
  });
});
