import { describe, expect, it } from 'vitest';
import { planUsageRows, planUsageSnapshotForProvider, planUsageSnapshots } from './planUsage';

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

  it('surfaces nested and legacy-flat Kimi quota as Kimi usage', () => {
    const nested = planUsageSnapshots({
      claude: { fiveHour: { utilization: 18 } },
      kimi: { provider: 'kimi', fiveHour: { utilization: 42 } },
    });
    expect(nested.map(({ key, title }) => ({ key, title }))).toEqual([
      { key: 'claude', title: 'Claude usage' },
      { key: 'kimi', title: 'Kimi usage' },
    ]);
    expect(planUsageRows(nested[1].usage)[0]).toMatchObject({ percent: 42 });

    expect(planUsageSnapshots({ provider: 'kimi', sevenDay: { utilization: 7 } })[0]).toMatchObject({
      key: 'kimi',
      title: 'Kimi usage',
    });
  });

  it('selects Kimi quota without leaking a flat Kimi snapshot into Claude', () => {
    const nested = {
      claude: { provider: 'claude', fiveHour: { utilization: 18 } },
      kimi: { provider: 'kimi', sevenDay: { utilization: 7 } },
    };
    expect(planUsageSnapshotForProvider(nested, 'kimi')).toBe(nested.kimi);
    expect(planUsageSnapshotForProvider(nested, 'claude')).toBe(nested.claude);

    const flatKimi = { provider: 'kimi', sevenDay: { utilization: 9 } } as const;
    expect(planUsageSnapshotForProvider(flatKimi, 'kimi')).toBe(flatKimi);
    expect(planUsageSnapshotForProvider(flatKimi, 'claude')).toBeNull();
    expect(planUsageSnapshotForProvider(flatKimi, 'codex')).toBeNull();
  });
});
