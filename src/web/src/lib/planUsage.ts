import {
  AgentProvider,
  codexAccountSnapshot,
  type PlanUsage,
  type PlanUsageRateLimit,
  type PlanUsageSnapshot,
  type PlanUsageWindow,
} from '@orbit/shared';
import type { ConfiguredProvider } from './workspaceDefaults';

export interface PlanUsageDisplayRow {
  key: string;
  label: string;
  groupLabel?: string;
  window: PlanUsageWindow;
  percent: number;
  nearLimit: boolean;
  remaining?: boolean;
}

export interface PlanUsageSectionInfo {
  key: string;
  title: string;
  note: string;
  usage: PlanUsageSnapshot;
}

/** Pick the quota snapshot for one runtime without leaking another runtime's
 * legacy-flat payload into it. New runners nest snapshots by provider; older
 * runners reported one flat snapshot, where Claude may omit `provider` and
 * Codex/Kimi identify themselves explicitly (or, for Codex, by its bucket
 * fields). Antigravity's is never in a heartbeat's planUsage: it is found here
 * only once a reader has folded its engine's in (withEnginePlanUsage), nested,
 * or flat and naming itself when the runner reported no other quota. */
export function planUsageSnapshotForProvider(
  usage: PlanUsage | null | undefined,
  provider: string,
): PlanUsageSnapshot | null {
  if (!usage) return null;
  if (provider === 'kimi') {
    if (usage.kimi) return usage.kimi;
    return usage.provider === 'kimi' ? usage : null;
  }
  if (provider === 'antigravity') {
    if (usage.antigravity) return usage.antigravity;
    return usage.provider === 'antigravity' ? usage : null;
  }
  if (provider === 'codex') {
    if (usage.codex) return usage.codex;
    if (usage.provider && usage.provider !== 'codex') return null;
    return usage.provider === 'codex' || usage.primary || usage.secondary || usage.rateLimits?.length
      ? usage
      : null;
  }
  if (provider === 'claude') {
    if (usage.claude) return usage.claude;
    return !usage.provider || usage.provider === 'claude' ? usage : null;
  }
  return null;
}

/** One Codex account's own quota on a runner (codexAccountSnapshot): Default's is the Codex
 *  snapshot's own windows, any other account's is its entry under `accounts`. Null when the runner
 *  reports none for that account. */
export function codexAccountPlanUsage(
  usage: PlanUsage | null | undefined,
  accountId: string,
): PlanUsageSnapshot | null {
  const codex = planUsageSnapshotForProvider(usage, 'codex');
  return (codex && codexAccountSnapshot(codex, accountId)) ?? null;
}

/**
 * The quota to show for a session on `engine` spending `provider`.
 *
 * Quota belongs to the credential the session actually spends, so the lookup follows the same
 * order dispatch does: an engine's own sign-in runs on the runner's login and reports through the
 * heartbeat, while a key (or pool) bills its own account and reports against that — on whichever
 * engine runs it. A key therefore never falls back to the runner's numbers — those are a different
 * subscription — and simply has no gauge when its credential has no quota to report. OpenCode's own
 * configuration and the legacy built-in `dsh` report none.
 */
export function sessionPlanUsage(
  engine: string,
  provider: string,
  runnerUsage: PlanUsage | null | undefined,
  configured?: ConfiguredProvider[] | null,
): PlanUsageSnapshot | null {
  // An engine's own sign-in: the slug is the engine's name. A configured row that shadows it is not
  // what dispatch runs (isBuiltinProvider wins), so its credential is not the one being spent either.
  if (provider === engine) return planUsageSnapshotForProvider(runnerUsage, engine);
  const builtin = Object.values(AgentProvider).some((p) => p === provider);
  return (builtin ? undefined : configured?.find((p) => p.slug === provider))?.planUsage ?? null;
}

/** Split a runner's possibly multi-runtime quota payload into display sections. */
export function planUsageSnapshots(usage: PlanUsage): PlanUsageSectionInfo[] {
  if (usage.claude || usage.codex || usage.kimi) {
    return [
      usage.claude && {
        key: 'claude',
        title: 'Claude usage',
        note: 'Account-wide Claude subscription quota for this runner login',
        usage: usage.claude,
      },
      usage.codex && {
        key: 'codex',
        title: 'Codex usage',
        note: 'Account-wide Codex rate limits for this runner login',
        usage: usage.codex,
      },
      usage.kimi && {
        key: 'kimi',
        title: 'Kimi usage',
        note: 'Account-wide Kimi quota for this runner login',
        usage: usage.kimi,
      },
    ].filter(Boolean) as PlanUsageSectionInfo[];
  }

  const provider =
    usage.provider === 'kimi'
      ? 'kimi'
      : usage.provider === 'codex' || usage.primary || usage.secondary || usage.rateLimits?.length
        ? 'codex'
        : 'claude';
  if (provider === 'kimi') {
    return [{ key: 'kimi', title: 'Kimi usage', note: 'Account-wide Kimi quota for this runner login', usage }];
  }
  const codex = provider === 'codex';
  return [
    {
      key: provider,
      title: codex ? 'Codex usage' : 'Claude usage',
      note: codex
        ? 'Account-wide Codex rate limits for this runner login'
        : 'Account-wide Claude subscription quota for this runner login',
      usage,
    },
  ];
}

type NamedWindowKey = 'fiveHour' | 'sevenDay' | 'sevenDayOpus' | 'sevenDaySonnet' | 'month';

const CLAUDE_ROWS: { key: NamedWindowKey; label: string }[] = [
  { key: 'fiveHour', label: '5-hour limit' },
  { key: 'sevenDay', label: 'Weekly · all models' },
  { key: 'sevenDayOpus', label: 'Weekly · Opus' },
  { key: 'sevenDaySonnet', label: 'Weekly · Sonnet' },
];

/** Kimi Code's windows (PlanUsageSnapshot), in the words its own /usage panel uses for them. The month
 *  is one bar, its total: the coding share of it (`monthCode`) is not drawn, on every client — the
 *  owner's call, 2026-10-08 — though the quota decisions in @orbit/shared still read it. */
const KIMI_ROWS: { key: NamedWindowKey; label: string }[] = [
  { key: 'fiveHour', label: '5h limit' },
  { key: 'sevenDay', label: 'Weekly limit' },
  { key: 'month', label: 'Monthly limit' },
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
  if (usage.provider === 'antigravity') return (usage.buckets ?? []).map((bucket) => {
    const used = (1 - bucket.remainingFraction) * 100;
    return {
      key: bucket.id,
      label: bucket.window === 'weekly' ? 'Weekly' : bucket.window === '5h' ? '5-hour' : bucket.window,
      groupLabel: bucket.id,
      window: { utilization: used, resetsAt: bucket.resetTime },
      percent: clampPercent(bucket.remainingFraction * 100),
      nearLimit: used >= 90,
      remaining: true,
    };
  });
  const codex = usage.provider === 'codex' || !!usage.primary || !!usage.secondary || !!usage.rateLimits?.length;
  if (codex) return codexRows(usage);
  return (usage.provider === 'kimi' ? KIMI_ROWS : CLAUDE_ROWS).flatMap(({ key, label }) => {
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

/**
 * A Kimi login whose plan carries no quota limit: the runner read its quota and the answer held no
 * window at all — Kimi Code's /usage skips a limit the backend omits, so a plan with none reads as
 * none. Distinct from a login never read or whose read failed ("No quota reported"): this one was
 * read, and there is no quota to gauge. The coding share of the month (`monthCode`) counts as a
 * window here though it is never drawn: a plan that reports it has a limit.
 */
export function kimiNoQuotaLimit(snapshot: PlanUsageSnapshot | null | undefined): boolean {
  return (
    !!snapshot &&
    snapshot.provider === 'kimi' &&
    !snapshot.fiveHour &&
    !snapshot.sevenDay &&
    !snapshot.month &&
    !snapshot.monthCode
  );
}

/**
 * planUsageRows as they stand at `now`. A window whose reset has passed reads as the fresh window it
 * now is — nothing used, no reset to name — rather than as the reading taken before it rolled over.
 * The runner reads again just after a reset, so a past one outlives it only on a reading that has
 * stopped refreshing, and its number is then about a window that is over: the quota decisions pass
 * such a window by already (quotaNearLimit, accountToStartOn), and what is drawn says the same.
 */
export function currentPlanUsageRows(usage: PlanUsageSnapshot, now: number = Date.now()): PlanUsageDisplayRow[] {
  return planUsageRows(usage).map((row) => {
    if (row.remaining) return row;
    const { resetsAt, ...window } = row.window;
    const at = Date.parse(resetsAt ?? '');
    if (Number.isNaN(at) || at > now) return row;
    return { ...row, window: { ...window, utilization: 0 }, percent: 0, nearLimit: false };
  });
}

/**
 * The window that stops a login, or will stop it first: a spent one (100%) before any other — of
 * several, the one that resets last, since the login is back only once every spent one has — else
 * the one closest to its limit, a tie going to the first (the 5-hour window). Anything that shows one
 * number for a login shows this one rather than the first window: a Claude login's 5-hour window can
 * read 6% while its weekly one is spent. Pass currentPlanUsageRows, so a window past its reset is not
 * what stops anything.
 */
export function bindingPlanUsageRow(rows: PlanUsageDisplayRow[]): PlanUsageDisplayRow | undefined {
  // A spent window with no reset named holds the login for as long as anyone can tell.
  const resetOf = (row: PlanUsageDisplayRow) => Date.parse(row.window.resetsAt ?? '') || Infinity;
  const spent = rows.filter((row) => row.window.utilization >= 100);
  if (spent.length > 0) return spent.reduce((last, row) => (resetOf(row) > resetOf(last) ? row : last));
  return rows.reduce<PlanUsageDisplayRow | undefined>(
    (tightest, row) => (!tightest || row.window.utilization > tightest.window.utilization ? row : tightest),
    undefined,
  );
}
