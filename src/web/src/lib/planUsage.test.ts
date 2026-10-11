import { describe, expect, it } from 'vitest';
import {
  bindingPlanUsageRow,
  currentPlanUsageRows,
  kimiNoQuotaLimit,
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

  it("names Kimi Code's windows as its own /usage panel does: one monthly bar, the total", () => {
    const rows = planUsageRows({
      provider: 'kimi',
      fiveHour: { utilization: 12 },
      sevenDay: { utilization: 34 },
      month: { utilization: 91.4 },
      monthCode: { utilization: 30 },
    });
    expect(rows.map(({ key, label, percent, nearLimit }) => ({ key, label, percent, nearLimit }))).toEqual([
      { key: 'fiveHour', label: '5h limit', percent: 12, nearLimit: false },
      { key: 'sevenDay', label: 'Weekly limit', percent: 34, nearLimit: false },
      { key: 'month', label: 'Monthly limit', percent: 91, nearLimit: true },
    ]);
    // What stops the login is its month, though its 5-hour window has room.
    expect(bindingPlanUsageRow(rows)?.key).toBe('month');
    // A window the runner did not read is not drawn.
    expect(planUsageRows({ provider: 'kimi', sevenDay: { utilization: 7 } }).map((row) => row.label)).toEqual(['Weekly limit']);
  });

  it("never draws Kimi's coding share of the month, nor names it as what stops the login", () => {
    // A share above its month cannot come from Kimi — it is part of the month — and stands here so
    // that a reader still weighing it would name it.
    const rows = currentPlanUsageRows({
      provider: 'kimi',
      fiveHour: { utilization: 12 },
      sevenDay: { utilization: 34 },
      month: { utilization: 41 },
      monthCode: { utilization: 97 },
    });
    expect(rows.map((row) => row.label)).toEqual(['5h limit', 'Weekly limit', 'Monthly limit']);
    expect(rows.map((row) => row.label)).not.toContain('Monthly · code');
    expect(bindingPlanUsageRow(rows)).toMatchObject({ key: 'month', percent: 41 });
    // A coding share alone is nothing to draw.
    expect(planUsageRows({ provider: 'kimi', monthCode: { utilization: 30 } })).toEqual([]);
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

  it('knows a Kimi login with no quota limit from one never read or one whose read failed', () => {
    // Read, and the answer held no window: a plan with no quota limit.
    expect(kimiNoQuotaLimit({ provider: 'kimi', fetchedAt: '2026-10-09T00:00:00Z' })).toBe(true);
    // The month's coding share counts though it is never drawn: a plan reporting it has a limit.
    expect(kimiNoQuotaLimit({ provider: 'kimi', monthCode: { utilization: 30 } })).toBe(false);
    expect(kimiNoQuotaLimit({ provider: 'kimi', fiveHour: { utilization: 0 } })).toBe(false);
    // Never read at all, or a windowless read of another engine's — both "No quota reported".
    expect(kimiNoQuotaLimit(null)).toBe(false);
    expect(kimiNoQuotaLimit({ provider: 'claude' })).toBe(false);
  });
});

describe('sessionPlanUsage', () => {
  const runner = { claude: { fiveHour: { utilization: 100 } }, codex: { primary: { utilization: 4 } } };

  it('shows an engine’s own sign-in the quota of the login the runner reported', () => {
    expect(sessionPlanUsage('claude', 'claude', runner)?.fiveHour?.utilization).toBe(100);
    expect(sessionPlanUsage('codex', 'codex', runner)?.primary?.utilization).toBe(4);
  });

  it('shows a key the quota of its own credential, on whichever engine runs it', () => {
    const configured = [
      { slug: 'anthropic', label: 'Anthropic', runtime: 'claude', models: [], planUsage: { fiveHour: { utilization: 12 } } },
    ];
    expect(sessionPlanUsage('claude', 'anthropic', runner, configured)?.fiveHour?.utilization).toBe(12);
  });

  it('never lets a key inherit the runner login it does not bill', () => {
    const configured = [{ slug: 'anthropic', label: 'Anthropic', runtime: 'claude', models: [] }];
    expect(sessionPlanUsage('claude', 'anthropic', runner, configured)).toBeNull();
    // Unknown slug (a row since deleted) resolves the same way, not to the runner's numbers.
    expect(sessionPlanUsage('claude', 'anthropic', runner, [])).toBeNull();
    // A DeepSeek key on DeepSeek Harness or OpenCode is no sign-in either; nor is OpenCode's own config.
    expect(sessionPlanUsage('dsh', 'deepseek', runner, [])).toBeNull();
    expect(sessionPlanUsage('opencode', 'opencode', runner)).toBeNull();
  });

  it('keeps a row that shadows a built-in slug out of the way of the engine it shadows', () => {
    const shadow = [
      { slug: 'claude', label: 'Claude', runtime: 'claude', models: [], planUsage: { fiveHour: { utilization: 1 } } },
    ];
    // isBuiltinProvider wins at dispatch, so the runner's login is the credential being spent.
    expect(sessionPlanUsage('claude', 'claude', runner, shadow)?.fiveHour?.utilization).toBe(100);
  });
});

describe('a login read at a moment', () => {
  const NOW = Date.parse('2026-10-02T16:56:18Z');
  const at = (hours: number) => new Date(NOW + hours * 3600_000).toISOString();
  // jianghailong.rd on wikova at NOW: its 5-hour reading is from before that window rolled over, and
  // its weekly one is spent until Monday.
  const rd = {
    provider: 'claude',
    fiveHour: { utilization: 6, resetsAt: at(-5.5) },
    sevenDay: { utilization: 100, resetsAt: at(66) },
  } as const;

  it('reads a window past its reset as the fresh window it now is', () => {
    expect(
      currentPlanUsageRows(rd, NOW).map(({ label, percent, nearLimit, window }) => ({
        label,
        percent,
        nearLimit,
        resetsAt: window.resetsAt,
      })),
    ).toEqual([
      { label: '5-hour limit', percent: 0, nearLimit: false, resetsAt: undefined },
      { label: 'Weekly · all models', percent: 100, nearLimit: true, resetsAt: at(66) },
    ]);
    // Until that reset, the reading stands as it was.
    expect(currentPlanUsageRows(rd, Date.parse(at(-6))).map((row) => row.percent)).toEqual([6, 100]);
  });

  it('names the window that stops a login, not the first one it has', () => {
    const binding = (usage: Parameters<typeof currentPlanUsageRows>[0]) =>
      bindingPlanUsageRow(currentPlanUsageRows(usage, NOW))?.label;
    // A spent week outranks a 5-hour window with room, whichever comes first.
    expect(binding(rd)).toBe('Weekly · all models');
    // Two spent: the login is back when the later one resets, so that is the one that stops it.
    expect(
      binding({
        provider: 'claude',
        fiveHour: { utilization: 100, resetsAt: at(0.5) },
        sevenDay: { utilization: 100, resetsAt: at(66) },
      }),
    ).toBe('Weekly · all models');
    // A spent window with no reset named holds the login for as long as anyone can tell.
    expect(
      binding({ provider: 'claude', fiveHour: { utilization: 100, resetsAt: at(0.5) }, sevenDay: { utilization: 100 } }),
    ).toBe('Weekly · all models');
    // None spent: the one closest to its limit, a tie going to the first.
    expect(binding({ provider: 'claude', fiveHour: { utilization: 1 }, sevenDay: { utilization: 59 } })).toBe(
      'Weekly · all models',
    );
    expect(binding({ provider: 'claude', fiveHour: { utilization: 40 }, sevenDay: { utilization: 40 } })).toBe(
      '5-hour limit',
    );
    // A spent window past its reset stops nothing.
    expect(
      binding({ provider: 'claude', fiveHour: { utilization: 100, resetsAt: at(-1) }, sevenDay: { utilization: 59 } }),
    ).toBe('Weekly · all models');
    expect(bindingPlanUsageRow([])).toBeUndefined();
  });
});
