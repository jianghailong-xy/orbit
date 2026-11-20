import { queryOptions } from '@tanstack/react-query';
import type { SubagentReportGroup, SubagentReportTier, WorkflowReportGroup } from '@orbit/shared';
import { getSubagentRoutingReport } from '../api';
import { wikiDuration } from './wikiRuns';

/**
 * Settings → Routing report (docs/subagent-design.md §7, docs/subagent-workflow-design.md §8 P4, board
 * docs/mocks/subagent-workflow/08-report.html): the words and figures its SubAgents and Workflows views show of
 * `GET /tasks/model-routing/report/subagents`.
 */

export type ReportView = 'subagents' | 'workflows';
export type ReportPeriod = '7d' | '30d' | 'all';

export const REPORT_PERIODS: Array<{ value: ReportPeriod; label: string }> = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: 'all', label: 'All time' },
];
export const DEFAULT_REPORT_PERIOD: ReportPeriod = '30d';

const PERIOD_DAYS: Record<Exclude<ReportPeriod, 'all'>, number> = { '7d': 7, '30d': 30 };

export function reportPeriod(value: string | null): ReportPeriod {
  return REPORT_PERIODS.some((period) => period.value === value) ? (value as ReportPeriod) : DEFAULT_REPORT_PERIOD;
}

/** Where the period starts, as the report's `since`: none for All time. */
export function reportSince(period: ReportPeriod, now: number): string | undefined {
  return period === 'all' ? undefined : new Date(now - PERIOD_DAYS[period] * 86_400_000).toISOString();
}

/** The period in a sentence's words: `in the last 30 days`, or `yet` for All time. */
export function periodPhrase(period: ReportPeriod): string {
  return period === 'all' ? 'yet' : `in the last ${PERIOD_DAYS[period]} days`;
}

/** The report, for a period and an Agent (null: all of them). Its runs are sessions' SubAgent runs and workflows. */
export const subagentRoutingReportQuery = (period: ReportPeriod, agentId: string | null) =>
  queryOptions({
    queryKey: ['routing-report', 'subagents', period, agentId] as const,
    meta: { entities: ['session'] },
    queryFn: () => getSubagentRoutingReport({ since: reportSince(period, Date.now()), agentId: agentId ?? undefined }),
  });

export const isRoutedTier = (tier: SubagentReportTier): boolean => tier !== 'named' && tier !== 'not-routed';

export function tierLabel(tier: SubagentReportTier): string {
  if (tier === 'named') return 'Named';
  if (tier === 'not-routed') return 'Not routed';
  return tier;
}

export const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

export const costText = (usd: number): string => `$${usd.toFixed(2)}`;

/** `part` of `whole` as a whole percentage; null when there is no whole. */
export function percent(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}

/** A median duration in the report's words (`6m 40s`); `—` while no run has ended. */
export const durationText = (ms: number | null): string => (ms === null ? '—' : wikiDuration(ms / 1000));

export interface SubagentTotals {
  runs: number;
  workflowCalls: number;
  ended: number;
  done: number;
  costUsd: number;
  movedOn: number;
  noSize: number;
  /** Runs routed at a tier: what the share without a size is of. */
  routed: number;
}

export function subagentTotals(groups: readonly SubagentReportGroup[]): SubagentTotals {
  const totals: SubagentTotals = { runs: 0, workflowCalls: 0, ended: 0, done: 0, costUsd: 0, movedOn: 0, noSize: 0, routed: 0 };
  for (const group of groups) {
    totals.runs += group.runs;
    totals.workflowCalls += group.workflowCalls;
    totals.ended += group.ended;
    totals.done += group.done;
    totals.costUsd += group.costUsd;
    totals.movedOn += group.movedOn;
    totals.noSize += group.noSize;
    if (isRoutedTier(group.tier)) totals.routed += group.runs;
  }
  return totals;
}

export interface WorkflowTotals {
  runs: number;
  workflows: number;
  calls: number;
  failedCalls: number;
  costUsd: number;
}

export function workflowTotals(groups: readonly WorkflowReportGroup[]): WorkflowTotals {
  return groups.reduce<WorkflowTotals>(
    (totals, group) => ({
      runs: totals.runs + group.runs,
      workflows: totals.workflows + 1,
      calls: totals.calls + group.calls,
      failedCalls: totals.failedCalls + group.failedCalls,
      costUsd: totals.costUsd + group.costUsd,
    }),
    { runs: 0, workflows: 0, calls: 0, failedCalls: 0, costUsd: 0 },
  );
}

export const SUBAGENTS_FOOT =
  "Each run counts under the tier and model Orbit picked for it, workflow calls included. Done: ended runs that " +
  'finished. Moved on: the pick hit a usage limit and the run went on with the next model. No size: the call gave no ' +
  "size, so its type's default tier applied. A subscription that reports no price adds $0.";

export const WORKFLOWS_FOOT =
  "A workflow's calls are SubAgent runs, so they count in SubAgents too. Failed: calls that ended without finishing. " +
  'Duration: the median of its ended runs.';
