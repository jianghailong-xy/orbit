import type { PlanUsageRateLimit, PlanUsageSnapshot, PlanUsageWindow } from '@orbit/shared';

export interface PlanUsageDisplayRow {
  key: string;
  label: string;
  groupLabel?: string;
  window: PlanUsageWindow;
  percent: number;
  nearLimit: boolean;
}

const CLAUDE_ROWS: { key: 'fiveHour' | 'sevenDay' | 'sevenDayOpus' | 'sevenDaySonnet'; label: string }[] = [
  { key: 'fiveHour', label: '5-hour limit' },
  { key: 'sevenDay', label: 'Weekly · all models' },
  { key: 'sevenDayOpus', label: 'Weekly · Opus' },
  { key: 'sevenDaySonnet', label: 'Weekly · Sonnet' },
];

function clampPercent(value: number): number {
  return Math.round(Math.min(100, Math.max(0, value)));
}

function approximately(minutes: number, expected: number): boolean {
  return minutes >= expected * 0.95 && minutes <= expected * 1.05;
}

// Keep this duration mapping in lockstep with Codex TUI's get_limits_duration.
function codexWindowLabel(window: PlanUsageWindow, secondary: boolean): string {
  const minutes = window.windowDurationMins;
  if (typeof minutes === 'number') {
    if (approximately(minutes, 5 * 60)) return '5h limit';
    if (approximately(minutes, 24 * 60)) return 'Daily limit';
    if (approximately(minutes, 7 * 24 * 60)) return 'Weekly limit';
    if (approximately(minutes, 30 * 24 * 60)) return 'Monthly limit';
    if (approximately(minutes, 365 * 24 * 60)) return 'Annual limit';
  }
  if (window.label === '5-hour limit') return '5h limit';
  return window.label || (secondary ? 'Secondary usage limit' : 'Usage limit');
}

function codexBuckets(usage: PlanUsageSnapshot): PlanUsageRateLimit[] {
  if (usage.rateLimits?.length) {
    return [...usage.rateLimits].sort((a, b) =>
      (a.limitId || 'codex').localeCompare(b.limitId || 'codex'),
    );
  }
  if (usage.primary || usage.secondary) {
    return [
      {
        limitId: usage.limitId || 'codex',
        limitName: usage.limitName,
        primary: usage.primary,
        secondary: usage.secondary,
        credits: usage.credits,
      },
    ];
  }
  return [];
}

function codexRows(usage: PlanUsageSnapshot): PlanUsageDisplayRow[] {
  return codexBuckets(usage).flatMap((bucket, bucketIndex) => {
    const windows = [
      { role: 'primary', secondary: false, window: bucket.primary },
      { role: 'secondary', secondary: true, window: bucket.secondary },
    ].filter((entry): entry is { role: string; secondary: boolean; window: PlanUsageWindow } => !!entry.window);
    const bucketLabel = bucket.limitName || bucket.limitId || 'codex';
    const prefixed = bucketLabel.toLowerCase() !== 'codex';
    return windows.map(({ role, secondary, window }, windowIndex) => {
      const baseLabel = codexWindowLabel(window, secondary);
      const label = prefixed && windows.length === 1 ? `${bucketLabel} ${baseLabel}` : baseLabel;
      const percent = clampPercent(window.utilization);
      return {
        key: `${bucket.limitId || bucketLabel || bucketIndex}:${role}`,
        label,
        groupLabel: prefixed && windows.length > 1 && windowIndex === 0 ? `${bucketLabel} limit` : undefined,
        window,
        percent,
        nearLimit: window.utilization >= 90,
      };
    });
  });
}

export function planUsageRows(usage: PlanUsageSnapshot): PlanUsageDisplayRow[] {
  const codex = usage.provider === 'codex' || !!usage.primary || !!usage.secondary || !!usage.rateLimits?.length;
  if (codex) return codexRows(usage);
  return CLAUDE_ROWS.flatMap(({ key, label }) => {
    const window = usage[key];
    if (!window || typeof window.utilization !== 'number') return [];
    const percent = clampPercent(window.utilization);
    return [
      {
        key,
        label: window.label || label,
        window,
        percent,
        nearLimit: window.utilization >= 90,
      },
    ];
  });
}
