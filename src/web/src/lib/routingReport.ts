import { queryOptions } from '@tanstack/react-query';
import type { SubagentReportGroup, SubagentReportTier, SubagentSize, WorkflowReportGroup } from '@orbit/shared';
import { getSubagentRoutingReport } from '../api';
import type { ProviderModelTier, ProviderTierRow } from './subagentTiers';
import { TIER_LEVELS } from './subagentTiers';
import { wikiDuration } from './wikiRuns';

/**
 * Settings → Providers → Model routing (docs/subagent-design.md §7, docs/subagent-workflow-design.md §8 P4): the words
 * and figures its SubAgents and Workflows views show of `GET /tasks/model-routing/report/subagents`, and the SubAgents
 * view's rows: each model's tier as `GET /providers/subagent-tiers` lists it, beside how its runs went.
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
  'Each run counts under the model Orbit picked for it, workflow calls included; Ran at splits its runs by the tier they ' +
  'were routed at. Done: ended runs that finished. Moved on: the pick hit a usage limit and the run went on with the ' +
  "next model. No size: the call gave no size, so its type's default tier applied. A model on several accounts opens " +
  'to each. Preset tiers and prices follow the catalogue. A model with no tier still runs SubAgents, after every ' +
  'model whose tier fits.';

export const WORKFLOWS_FOOT =
  "A workflow's calls are SubAgent runs, so they count in SubAgents too. Failed: calls that ended without finishing. " +
  'Duration: the median of its ended runs.';

/** How one model's runs went, summed over the report rows that picked it. */
export interface RunFigures {
  runs: number;
  ended: number;
  done: number;
  costUsd: number;
  movedOn: number;
}

/** One tier a model was routed at: its runs there, and whether that tier is one the model is set to now. */
export interface TierRuns extends RunFigures {
  tier: SubagentSize;
  outside: boolean;
}

/**
 * One row of the SubAgents view: a model as the tier list names it (null when the list no longer has it, as for a
 * removed key), with the runs routing gave it in the period.
 */
export interface RoutingModelRow extends RunFigures {
  key: string;
  provider: ProviderTierRow | null;
  model: ProviderModelTier | null;
  modelLabel: string;
  providerLabel: string | null;
  /** The tiers it was routed at, S to XL; empty for a row of named or unrouted runs. */
  tiers: TierRuns[];
  /** Of `runs`, those routed at a tier it is not set to now (all of them for a model with no tier). */
  outsideRuns: number;
}

/**
 * One model in a section: its accounts (the providers listing it, by the tier list's `identity`), and their runs
 * summed. One account's block draws as a single row; several open to their accounts.
 */
export interface RoutingModelBlock extends RunFigures {
  key: string;
  modelLabel: string;
  /** Most runs first, then the tier list's order. */
  accounts: RoutingModelRow[];
  /** The accounts' runs by tier, S to XL; a tier is outside when any account ran there outside its own tiers. */
  tiers: TierRuns[];
  outsideRuns: number;
}

/** The SubAgents view's models, in its sections. */
export interface RoutingSections {
  /** Every model with a tier, and every model routed at one: by name. A model's
   *  accounts with no tier and no runs are listed with it here rather than folded away. */
  tiered: RoutingModelBlock[];
  /** Runs that named their model, so routing picked no tier. */
  named: RoutingModelBlock[];
  /** Runs routing left alone. */
  notRouted: RoutingModelBlock[];
  /** Models with no tier that ran nothing in the period, folded away. */
  idle: RoutingModelBlock[];
}

const rowKey = (provider: string | null, model: string | null) => `${provider ?? ''}\n${model ?? ''}`;

/**
 * A model id with an engine's wrapping taken off, as the server's modelRuleKey (apiserver model-identity.ts) spells it:
 * lower case, a `["vendor", "model"]` token read as its model, a `[variant]` dropped, a `vendor/` prefix dropped, a dot
 * between digits written as a dash. A trailing `-max` stays: it names a model (`qwen3.7-max`). For a row the tier list does not have, so has no identity:
 * `gpt-6.2-sol` there is still GPT-6.2 Sol's `gpt-6-2-sol`.
 */
export function modelRuleKey(model: string): string {
  let id = model.trim();
  if (id.startsWith('[')) {
    try {
      const parts: unknown = JSON.parse(id);
      if (Array.isArray(parts) && typeof parts[parts.length - 1] === 'string') id = parts[parts.length - 1] as string;
    } catch {
      // Not a token: read as written.
    }
  }
  id = id.toLowerCase().replace(/\[.*\]$/, '');
  id = id.slice(id.lastIndexOf('/') + 1);
  return id.replace(/(\d)\.(?=\d)/g, '$1-') || model;
}

/** Model names in reading order, the numbers in them as numbers: GPT-5.6 Sol, GPT-6.1 Sol, GPT-6.2 Sol. */
const byName = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

const sum = (groups: readonly RunFigures[]): RunFigures =>
  groups.reduce<RunFigures>(
    (total, group) => ({
      runs: total.runs + group.runs,
      ended: total.ended + group.ended,
      done: total.done + group.done,
      costUsd: total.costUsd + group.costUsd,
      movedOn: total.movedOn + group.movedOn,
    }),
    { runs: 0, ended: 0, done: 0, costUsd: 0, movedOn: 0 },
  );

/**
 * The tier list and the report, joined on provider slug and model id: a report row names the provider and model
 * routing picked, which are the tier list's slug and model.
 */
export function routingSections(providers: readonly ProviderTierRow[], groups: readonly SubagentReportGroup[]): RoutingSections {
  const listed = new Map<string, { provider: ProviderTierRow; model: ProviderModelTier; order: number }>();
  for (const provider of providers)
    for (const model of provider.models) {
      const key = rowKey(provider.slug, model.model);
      if (!listed.has(key)) listed.set(key, { provider, model, order: listed.size });
    }

  // Which model a row is: the tier list's identity, so one model's accounts on every provider are one block.
  // A row the tier list does not have falls back to its id's rule key, so it still joins its model.
  const identityOf = (key: string) => listed.get(key)?.model.identity?.key ?? modelRuleKey(key.slice(key.indexOf('\n') + 1));

  const byKind = { routed: new Map<string, SubagentReportGroup[]>(), named: new Map<string, SubagentReportGroup[]>(), notRouted: new Map<string, SubagentReportGroup[]>() };
  for (const group of groups) {
    const into = group.tier === 'named' ? byKind.named : group.tier === 'not-routed' ? byKind.notRouted : byKind.routed;
    const key = rowKey(group.provider, group.model);
    into.set(key, [...(into.get(key) ?? []), group]);
  }

  const row = (key: string, picked: readonly SubagentReportGroup[]): RoutingModelRow => {
    const entry = listed.get(key) ?? null;
    const first = picked[0];
    const levels = entry?.model.levels;
    const tiers = TIER_LEVELS.flatMap((tier): TierRuns[] => {
      const at = picked.filter((group) => group.tier === tier);
      // A model the list no longer has cannot be said to be outside its tier.
      return at.length === 0 ? [] : [{ tier, ...sum(at), outside: !!levels && !levels.includes(tier) }];
    });
    return {
      key,
      provider: entry?.provider ?? null,
      model: entry?.model ?? null,
      modelLabel: entry?.model.identity?.name ?? first?.modelLabel ?? entry?.model.model ?? 'No model',
      providerLabel: entry?.provider.label ?? first?.providerLabel ?? null,
      ...sum(picked),
      tiers,
      outsideRuns: tiers.reduce((total, tier) => total + (tier.outside ? tier.runs : 0), 0),
    };
  };
  const order = (key: string) => listed.get(key)?.order ?? Number.MAX_SAFE_INTEGER;
  const byRuns = (a: { runs: number; key: string }, b: { runs: number; key: string }) =>
    b.runs - a.runs || order(a.key) - order(b.key);
  // A section's rows as one block per model: the first account names it, the accounts' runs are summed.
  const blocks = (rows: RoutingModelRow[]): RoutingModelBlock[] => {
    const byModel = new Map<string, RoutingModelRow[]>();
    for (const row of [...rows].sort(byRuns)) byModel.set(identityOf(row.key), [...(byModel.get(identityOf(row.key)) ?? []), row]);
    return [...byModel.values()].map((accounts): RoutingModelBlock => {
      const tiers = TIER_LEVELS.flatMap((tier): TierRuns[] => {
        const at = accounts.flatMap((account) => account.tiers.filter((runs) => runs.tier === tier));
        return at.length === 0 ? [] : [{ tier, ...sum(at), outside: at.some((runs) => runs.outside) }];
      });
      return {
        key: accounts[0].key,
        // The vendor's name where an account has one, so an unlisted account's id does not name the model.
        modelLabel: accounts.find((account) => account.model?.identity?.name)?.model?.identity?.name ?? accounts[0].modelLabel,
        accounts,
        ...sum(accounts),
        tiers,
        outsideRuns: accounts.reduce((total, account) => total + account.outsideRuns, 0),
      };
    }).sort((a, b) => byName.compare(a.modelLabel, b.modelLabel));
  };

  const tiered: RoutingModelRow[] = [];
  const idle: RoutingModelRow[] = [];
  for (const [key, entry] of listed) {
    if (byKind.routed.has(key)) continue;
    const ranAtAll = byKind.named.has(key) || byKind.notRouted.has(key);
    if (entry.model.levels.length > 0) tiered.push(row(key, []));
    else if (!ranAtAll) idle.push(row(key, []));
  }
  for (const [key, picked] of byKind.routed) tiered.push(row(key, picked));
  // An idle account of a model that has a tiered block is one of that model's accounts, not a model of its own.
  const tieredModels = new Set(tiered.map((account) => identityOf(account.key)));
  const rest = (map: Map<string, SubagentReportGroup[]>) => blocks([...map].map(([key, picked]) => row(key, picked)));
  return {
    tiered: blocks([...tiered, ...idle.filter((account) => tieredModels.has(identityOf(account.key)))]),
    named: rest(byKind.named),
    notRouted: rest(byKind.notRouted),
    idle: blocks(idle.filter((account) => !tieredModels.has(identityOf(account.key)))),
  };
}
