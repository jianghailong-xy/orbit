import { describe, expect, it } from 'vitest';
import { waitElapsedLabel, waitingNoticeFor, waitingNoticeScope } from './runnerSlots';

// A turn a runner restart or the owner's Update Now cut while its engine was still starting waits
// for the runner to come back. When the server hands it out again it moves the run's
// `runClaimedAt` to that re-delivery (dequeueTurn, task 34wNtnf94bNWNz0bmcieV), so the Starting
// notice counts from there: the runner's downtime is not a start that took eleven minutes. An
// ordinary start still counts from its claim, however long it has been.
describe('the Starting notice across a runner restart', () => {
  const now = Date.parse('2026-11-12T12:20:00.000Z');
  const SESSION = 'session-1';

  it('counts a cut-then-resumed start from its re-delivery, not from the first claim', () => {
    const resumed = {
      status: 'RUNNING',
      engineStartedAt: null,
      // The first claim, 20 minutes ago, before the runner stopped for its update…
      lastTurnAt: '2026-11-12T12:00:05.000Z',
      // …and the re-delivery the updated runner took 30 seconds ago, which the server stamped here.
      runClaimedAt: '2026-11-12T12:19:30.000Z',
    };
    const notice = waitingNoticeFor(resumed);
    expect(notice).toEqual({ kind: 'starting', since: '2026-11-12T12:19:30.000Z' });
    expect(waitElapsedLabel(notice!.since, now)).toBe('30s');
    // A new run for the reveal too, so the resumed start gets the same quiet ten seconds as any start.
    expect(waitingNoticeScope(SESSION, resumed)).not.toBe(
      waitingNoticeScope(SESSION, { ...resumed, runClaimedAt: '2026-11-12T12:00:00.000Z' }),
    );
  });

  it('still counts an ordinary start that is taking long from its claim', () => {
    const slow = {
      status: 'RUNNING',
      engineStartedAt: null,
      lastTurnAt: '2026-11-12T12:19:50.000Z',
      runClaimedAt: '2026-11-12T12:00:00.000Z',
    };
    const notice = waitingNoticeFor(slow);
    expect(notice).toEqual({ kind: 'starting', since: '2026-11-12T12:00:00.000Z' });
    expect(waitElapsedLabel(notice!.since, now)).toBe('20m 00s');
  });
});
