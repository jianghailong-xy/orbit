import { describe, expect, it } from 'vitest';
import { planUsageRows } from './planUsage';

describe('planUsageRows', () => {
  it('matches Codex TUI items while retaining Orbit utilization semantics', () => {
    const rows = planUsageRows({
      provider: 'codex',
      rateLimits: [
        {
          limitId: 'codex',
          primary: { utilization: 22, windowDurationMins: 300 },
          secondary: { utilization: 35, windowDurationMins: 10080 },
        },
        {
          limitId: 'codex-other',
          primary: { utilization: 90, windowDurationMins: 60 },
        },
      ],
    });

    expect(rows.map(({ label, groupLabel, percent }) => ({ label, groupLabel, percent }))).toEqual([
      { label: '5h limit', groupLabel: undefined, percent: 22 },
      { label: 'Weekly limit', groupLabel: undefined, percent: 35 },
      { label: 'codex-other Usage limit', groupLabel: undefined, percent: 90 },
    ]);
    expect(rows[2].nearLimit).toBe(true);
  });

  it('keeps Claude utilization semantics unchanged', () => {
    expect(planUsageRows({ provider: 'claude', fiveHour: { utilization: 18 } })[0]).toMatchObject({
      label: '5-hour limit',
      percent: 18,
    });
  });
});
