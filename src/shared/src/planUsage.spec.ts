import { describe, expect, it } from 'vitest';
import type { PlanUsage } from './dto';
import { planUsageBlockedUntil } from './planUsage';

const NOW = new Date('2026-08-03T13:00:00Z');
const LATER = '2026-08-09T05:26:43Z';
const EARLIER = '2026-08-04T01:00:00Z';

/** Shape of the snapshot a Codex runner actually reports with its weekly limit spent. */
const codexExhausted: PlanUsage = {
  provider: 'codex',
  limitId: 'codex',
  planType: 'pro',
  rateLimitReachedType: 'rate_limit_reached',
  primary: { label: 'Weekly limit', utilization: 100, resetsAt: LATER, windowDurationMins: 10080 },
  rateLimits: [
    { limitId: 'codex', primary: { label: 'Weekly limit', utilization: 100, resetsAt: LATER } },
  ],
  fetchedAt: '2026-08-03T12:22:23Z',
};

describe('planUsageBlockedUntil', () => {
  it('reports the reset time of an exhausted window', () => {
    expect(planUsageBlockedUntil(codexExhausted, 'codex', NOW)).toEqual(new Date(LATER));
  });

  it('is null while the window still has room', () => {
    const usage: PlanUsage = { provider: 'codex', primary: { utilization: 99.9, resetsAt: LATER } };
    expect(planUsageBlockedUntil(usage, 'codex', NOW)).toBeNull();
  });

  it('waits for the last of several exhausted windows to clear', () => {
    const usage: PlanUsage = {
      provider: 'claude',
      fiveHour: { utilization: 100, resetsAt: EARLIER },
      sevenDay: { utilization: 100, resetsAt: LATER },
    };
    expect(planUsageBlockedUntil(usage, 'claude', NOW)).toEqual(new Date(LATER));
  });

  it('ignores an exhausted window whose reset has already passed', () => {
    const usage: PlanUsage = {
      provider: 'codex',
      primary: { utilization: 100, resetsAt: '2026-08-03T12:00:00Z' },
    };
    expect(planUsageBlockedUntil(usage, 'codex', NOW)).toBeNull();
  });

  it('does not block when the provider reported no reset time', () => {
    // Nothing defensible to wait for — the caller's failure backoff handles this instead.
    const usage: PlanUsage = { provider: 'codex', primary: { utilization: 100 } };
    expect(planUsageBlockedUntil(usage, 'codex', NOW)).toBeNull();
  });

  it('reads the per-provider snapshot a multi-runtime runner nests', () => {
    const usage: PlanUsage = {
      claude: { fiveHour: { utilization: 12, resetsAt: LATER } },
      codex: { primary: { utilization: 100, resetsAt: LATER } },
    };
    expect(planUsageBlockedUntil(usage, 'codex', NOW)).toEqual(new Date(LATER));
    expect(planUsageBlockedUntil(usage, 'claude', NOW)).toBeNull();
  });

  it('never charges one provider with another provider quota', () => {
    // A BYOK slug borrows a built-in runtime but bills its own key, so a spent codex
    // subscription must not hold it back.
    expect(planUsageBlockedUntil(codexExhausted, 'claude', NOW)).toBeNull();
    expect(planUsageBlockedUntil(codexExhausted, 'deepseek', NOW)).toBeNull();
  });

  it('handles a runner that reports no usage at all', () => {
    expect(planUsageBlockedUntil(null, 'codex', NOW)).toBeNull();
    expect(planUsageBlockedUntil({}, 'codex', NOW)).toBeNull();
  });
});
