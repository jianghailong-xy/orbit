import { queryOptions } from '@tanstack/react-query';
import type { ModelQuality, ProviderModelTier, ProviderTierRow, SubagentSize, SubagentTiersResponse } from '@orbit/shared';
import { api } from '../api';

export type { ProviderModelTier, ProviderTierRow };

/** Every provider SubAgents may be routed onto, each with its models' tiers (docs/subagent-design.md §7). */
export const subagentTiersQuery = () =>
  queryOptions({
    queryKey: ['providers', 'subagent-tiers'] as const,
    meta: { entities: ['provider'] },
    queryFn: () => api<SubagentTiersResponse>('/providers/subagent-tiers'),
  });

export const TIER_LEVELS: readonly SubagentSize[] = ['S', 'M', 'L', 'XL'];

/** A model's Tier cell: "Not set" with none, "S–XL by effort" when one model spans every tier, else the tiers. */
export function tierText(levels: readonly SubagentSize[]): string {
  if (levels.length === 0) return 'Not set';
  if (levels.length === TIER_LEVELS.length) return 'S–XL by effort';
  return levels.join(' · ');
}

/** A model's Tier cell text: `tierText`, but an older family member reads "Older · uses <newest>" in place of Not set. */
export function modelTierText(model: ProviderModelTier): string {
  return model.levels.length === 0 && model.supersededBy ? `Older · uses ${model.supersededBy}` : tierText(model.levels);
}

/** A model's Price / M out cell. */
export function priceText(model: ProviderModelTier, billing: ProviderTierRow['billing']): string {
  if (model.outputPricePerMTok != null) return `$${model.outputPricePerMTok.toFixed(2)}`;
  return billing === 'subscription' ? 'Subscription' : '—';
}

/**
 * A model's Quality cell (docs/subagent-design.md §7.1, board docs/mocks/model-quality/01-board.png, owner's A1·B1·C1):
 * two lines, SubAgents and Tasks, each its figure or why there is none; one "No runs yet" when the model has
 * neither a SubAgent run nor a done task. `raters` is the SubAgents line's tooltip, null when there is none to show.
 */
export interface QualityLines {
  empty: boolean;
  subagents: { text: string; muted: boolean; raters: string | null };
  tasks: { text: string; muted: boolean };
}

export function qualityLines(quality: ModelQuality): QualityLines {
  const { subagent, tasks } = quality;
  const rated = subagent.averageRating !== null;
  const passed = tasks.firstPassRate !== null;
  const raters = subagent.raters.map((rater) => `${rater.label ?? rater.provider} (${rater.count})`).join(' · ');
  return {
    empty: subagent.runCount === 0 && tasks.completedTaskCount === 0,
    subagents: {
      text: rated
        ? `${subagent.averageRating!.toFixed(1)} · ${subagent.ratedCount} rated of ${subagent.runCount}`
        : 'Not enough ratings',
      muted: !rated,
      raters: rated && raters ? `Rated by ${raters}` : null,
    },
    tasks: {
      text: passed
        ? `${Math.round(tasks.firstPassRate! * 100)}% first pass · ${tasks.completedTaskCount} tasks`
        : 'Not enough tasks',
      muted: !passed,
    },
  };
}

/**
 * The Quality cell of Settings → Model routing on one line: the figures there are ("Rated 4.1 (18) · 47% first pass ·
 * 91 tasks"), "Not enough data" with neither, "No runs yet" with no run at all. `detail` is its tooltip: both lines in
 * full, and who rated.
 */
export function qualitySummary(quality: ModelQuality): { text: string; muted: boolean; detail: string | null } {
  const lines = qualityLines(quality);
  if (lines.empty) return { text: 'No runs yet', muted: true, detail: null };
  const { subagent, tasks } = quality;
  const parts = [
    ...(subagent.averageRating !== null ? [`Rated ${subagent.averageRating.toFixed(1)} (${subagent.ratedCount})`] : []),
    ...(tasks.firstPassRate !== null ? [`${Math.round(tasks.firstPassRate * 100)}% first pass · ${tasks.completedTaskCount} tasks`] : []),
  ];
  const detail = [`SubAgents: ${lines.subagents.text}`, `Tasks: ${lines.tasks.text}`, ...(lines.subagents.raters ? [lines.subagents.raters] : [])]
    .join('\n');
  return parts.length > 0 ? { text: parts.join(' · '), muted: false, detail } : { text: 'Not enough data', muted: true, detail };
}

/** What the Quality column means, under the table. */
export const QUALITY_FOOT = 'Quality is shown, not used for routing. SubAgents: the parent session\'s 1–5 rating of each ' +
  'result, last 90 days, recent ratings weighed more. Tasks: share of done tasks that passed on their first run; runs ' +
  'that hit a usage limit or a model at capacity are left out.';

/** The SubAgents Providers row's button: how many of the listed providers SubAgents may use. */
export function providersCountText(providers: readonly { slug: string }[], blocked: readonly string[]): string {
  const allowed = providers.filter((provider) => !blocked.includes(provider.slug)).length;
  return `${allowed} of ${providers.length} · Edit`;
}
