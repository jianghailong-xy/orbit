import { describe, expect, it } from 'vitest';
import { waitElapsedLabel, waitingNoticeFor, waitingNoticeScope } from './runnerSlots';

// The clocks and the reveal scope of the waiting notice. The defect they pin was measured on
// production on 2026-09-10: Claude Code re-sends `status: compacting` every 30s, each re-send
// carries the turn id and so moves lastTurnAt, and the web's 5s detail poll carried the moved value
// into the notice — whose timer went back to zero and whose reveal started over, every half minute.

const claimedAt = '2026-09-10T12:38:12.588Z';
const compactingSince = '2026-09-10T12:38:12.729Z';
const afterKeepalive = '2026-09-10T12:38:42.730Z';

describe('what the waiting notice counts from', () => {
  it('keeps the starting clock and scope when lastTurnAt moves under it', () => {
    const before = { runState: 'RUNNING', engineStartedAt: null, runClaimedAt: claimedAt, lastTurnAt: claimedAt };
    const after = { ...before, lastTurnAt: afterKeepalive };
    expect(waitingNoticeFor(before)).toEqual({ kind: 'starting', since: claimedAt });
    expect(waitingNoticeFor(after)).toEqual({ kind: 'starting', since: claimedAt });
    expect(waitingNoticeScope('s1', after)).toBe(waitingNoticeScope('s1', before));
  });

  // The production case: init had already stamped engineStartedAt, the compaction began after it,
  // and a keepalive then moved lastTurnAt. Neither the clock nor the scope may follow it.
  it('times a compaction from its own start, through a keepalive', () => {
    const before = {
      runState: 'RUNNING', engineStartedAt: '2026-09-10T12:38:12.700Z', enginePhase: 'compacting',
      enginePhaseSince: compactingSince, runClaimedAt: claimedAt, lastTurnAt: compactingSince,
    };
    const after = { ...before, lastTurnAt: afterKeepalive };
    expect(waitingNoticeFor(after)).toEqual({ kind: 'compacting', since: compactingSince });
    expect(waitingNoticeScope('s1', after)).toBe(waitingNoticeScope('s1', before));
    // Four minutes into the compaction the notice says four minutes, not three and a half.
    const fourMinutesIn = Date.parse(compactingSince) + 240_000;
    expect(waitElapsedLabel(waitingNoticeFor(after)!.since, fourMinutesIn)).toBe('4m 00s');
  });

  // A compaction two hours into a turn is not two hours of compacting.
  it('does not count a mid-turn compaction from the claim', () => {
    const midTurn = {
      runState: 'RUNNING', engineStartedAt: '2026-09-10T10:00:01.000Z', enginePhase: 'compacting',
      enginePhaseSince: '2026-09-10T12:10:00.000Z', runClaimedAt: '2026-09-10T10:00:00.000Z',
    };
    expect(waitingNoticeFor(midTurn)?.since).toBe('2026-09-10T12:10:00.000Z');
  });

  // A notice already earned while starting must not hide for another ten seconds just because the
  // wait turned out to be a compaction; the scope is the run, and only the clock changes.
  it('keeps the reveal scope when a wait turns from starting into compacting', () => {
    const starting = { runState: 'RUNNING', engineStartedAt: null, runClaimedAt: claimedAt, lastTurnAt: claimedAt };
    const compacting = { ...starting, enginePhase: 'compacting', enginePhaseSince: compactingSince, lastTurnAt: compactingSince };
    expect(waitingNoticeScope('s1', compacting)).toBe(waitingNoticeScope('s1', starting));
    expect(waitingNoticeFor(starting)?.since).toBe(claimedAt);
    expect(waitingNoticeFor(compacting)?.since).toBe(compactingSince);
  });

  it('gives a new claim a new scope and a new clock, so the next message gets its own quiet period', () => {
    const first = { runState: 'RUNNING', engineStartedAt: null, runClaimedAt: claimedAt, lastTurnAt: claimedAt };
    const next = { ...first, runClaimedAt: '2026-09-10T12:45:00.000Z', lastTurnAt: '2026-09-10T12:45:00.000Z' };
    expect(waitingNoticeScope('s1', next)).not.toBe(waitingNoticeScope('s1', first));
    expect(waitingNoticeFor(next)?.since).toBe('2026-09-10T12:45:00.000Z');
  });

  it('falls back to lastTurnAt for a control plane that sends neither clock', () => {
    const older = { runState: 'RUNNING', engineStartedAt: null, lastTurnAt: claimedAt };
    expect(waitingNoticeFor(older)).toEqual({ kind: 'starting', since: claimedAt });
    expect(waitingNoticeScope('s1', older)).toBe(`s1:${claimedAt}`);
    const olderCompacting = { runState: 'RUNNING', engineStartedAt: claimedAt, enginePhase: 'compacting', lastTurnAt: afterKeepalive };
    expect(waitingNoticeFor(olderCompacting)?.since).toBe(afterKeepalive);
  });

  it('is not a wait once the engine is up and names no phase, or when nothing is running', () => {
    expect(waitingNoticeFor({ runState: 'RUNNING', engineStartedAt: claimedAt, enginePhase: null })).toBeNull();
    expect(waitingNoticeFor({ runState: 'AWAITING_INPUT', engineStartedAt: null, enginePhase: 'compacting' })).toBeNull();
    expect(waitingNoticeFor(null)).toBeNull();
    expect(waitingNoticeScope(null, { runClaimedAt: claimedAt })).toBeNull();
  });
});
