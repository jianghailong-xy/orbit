import { describe, expect, it } from 'vitest';
import {
  planUsageRows,
  planUsageSnapshotForProvider,
  planUsageSnapshots,
  sessionPlanUsage,
} from './planUsage';

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

describe('sessionPlanUsage', () => {
  const runner = { claude: { fiveHour: { utilization: 100 } }, codex: { primary: { utilization: 4 } } };

  it('shows a built-in engine the quota of the login the runner reported', () => {
    expect(sessionPlanUsage('claude', runner)?.fiveHour?.utilization).toBe(100);
    expect(sessionPlanUsage('codex', runner)?.primary?.utilization).toBe(4);
  });

  it('shows a configured provider the quota of its own credential', () => {
    const configured = [
      { slug: 'anthropic', label: 'Anthropic', runtime: 'claude', models: [], planUsage: { fiveHour: { utilization: 12 } } },
    ];
    expect(sessionPlanUsage('anthropic', runner, configured)?.fiveHour?.utilization).toBe(12);
  });

  it('never lets a configured provider inherit the runner login it does not bill', () => {
    const configured = [{ slug: 'anthropic', label: 'Anthropic', runtime: 'claude', models: [] }];
    expect(sessionPlanUsage('anthropic', runner, configured)).toBeNull();
    // Unknown slug (a row since deleted) resolves the same way, not to the runner's numbers.
    expect(sessionPlanUsage('anthropic', runner, [])).toBeNull();
  });

  it('keeps a row that shadows a built-in slug out of the way of the engine it shadows', () => {
    const shadow = [
      { slug: 'claude', label: 'Claude', runtime: 'claude', models: [], planUsage: { fiveHour: { utilization: 1 } } },
    ];
    // isBuiltinProvider wins at dispatch, so the runner's login is the credential being spent.
    expect(sessionPlanUsage('claude', runner, shadow)?.fiveHour?.utilization).toBe(100);
  });
});
