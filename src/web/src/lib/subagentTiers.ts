import { queryOptions } from '@tanstack/react-query';
import type { ProviderModelTier, ProviderTierRow, SubagentSize, SubagentTiersResponse } from '@orbit/shared';
import { api } from '../api';

export type { ProviderModelTier, ProviderTierRow };

/** Every provider SubAgents may be routed onto, each with its models' tiers (docs/subagent-design.md §7). */
export const subagentTiersQuery = () =>
  queryOptions({
    queryKey: ['providers', 'subagent-tiers'] as const,
    queryFn: () => api<SubagentTiersResponse>('/providers/subagent-tiers'),
  });

export const TIER_LEVELS: readonly SubagentSize[] = ['S', 'M', 'L', 'XL'];

/** A model's Tier cell: "Not set" with none, "S–XL by effort" when one model spans every tier, else the tiers. */
export function tierText(levels: readonly SubagentSize[]): string {
  if (levels.length === 0) return 'Not set';
  if (levels.length === TIER_LEVELS.length) return 'S–XL by effort';
  return levels.join(' · ');
}

/** A model's Price / M out cell. */
export function priceText(model: ProviderModelTier, billing: ProviderTierRow['billing']): string {
  if (model.outputPricePerMTok != null) return `$${model.outputPricePerMTok.toFixed(2)}`;
  return billing === 'subscription' ? 'Subscription' : '—';
}

/** The SubAgents Providers row's button: how many of the listed providers SubAgents may use. */
export function providersCountText(providers: readonly { slug: string }[], blocked: readonly string[]): string {
  const allowed = providers.filter((provider) => !blocked.includes(provider.slug)).length;
  return `${allowed} of ${providers.length} · Edit`;
}
