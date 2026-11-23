import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { SubagentSize } from '@orbit/shared';
import { api } from '../api';
import { PROVIDERS_BASE } from '../lib/providerAdmin';
import {
  modelTierText,
  qualitySummary,
  subagentTiersQuery,
  TIER_LEVELS,
  type ProviderModelTier,
  type ProviderTierRow,
} from '../lib/subagentTiers';
import { useToast } from '../lib/toast';
import { Menu, type MenuItem } from './ui/Menu';
import { Tooltip } from './ui/Tooltip';

/**
 * A model's tier on Settings → Providers → Model routing (docs/subagent-design.md §7, board docs/mocks/subagent/05.png):
 * a menu of S to XL where the owner may set it, else the tier as text. A preset's tier follows the catalogue; a custom
 * endpoint's model reads Not set until the owner sets one, and ranks after every tiered model until then. A built-in
 * engine's every model is the owner's to tier, overriding the catalogue (board 2026-11-20); a tier the owner set
 * carries a "Yours" tag.
 */
export function ModelTierCell({ provider, model }: { provider: ProviderTierRow; model: ProviderModelTier }) {
  return (
    <>
      <TierCell provider={provider} model={model} />
      {model.source === 'owner' && <span className="model-tiers-yours">Yours</span>}
    </>
  );
}

/**
 * A model's Quality cell: how well it completed work, for display only (docs/subagent-design.md §7.1), on one line
 * (qualitySummary). The figures are the model's on every account listing it; the tooltip has both lines in full and who
 * rated.
 */
export function QualityCell({ model }: { model: ProviderModelTier }) {
  const { text, muted, detail } = qualitySummary(model.quality);
  const cell = <span className={`model-tiers-quality-one${muted ? ' model-tiers-muted' : ''}`} tabIndex={detail ? 0 : undefined}>{text}</span>;
  return detail ? <Tooltip content={detail} toggleOnClick popupStyle={{ whiteSpace: 'pre-line' }}>{cell}</Tooltip> : cell;
}

function TierCell({ provider, model }: { provider: ProviderTierRow; model: ProviderModelTier }) {
  const qc = useQueryClient();
  const toast = useToast();
  const set = useMutation({
    mutationFn: (tier: SubagentSize | null) =>
      api(tierPath(provider), { method: 'PATCH', body: { model: model.model, tier } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: subagentTiersQuery().queryKey }),
    onError: (error: Error) => toast.error(error.message),
  });
  const text = modelTierText(model);
  const unset = model.levels.length === 0;
  const older = unset && !!model.supersededBy;
  if (!model.editable || (!provider.providerId && provider.kind !== 'builtin')) {
    return <span className={older ? 'model-tiers-older' : unset ? 'model-tiers-unset' : undefined}>{text}</span>;
  }
  const items: MenuItem[] = [
    ...TIER_LEVELS.map((level): MenuItem => ({
      key: level,
      label: level,
      checked: model.levels.includes(level),
      closeOnSelect: true,
      onSelect: () => set.mutate(level),
    })),
    ...(!clearable(provider, model) ? [] : [
      { type: 'separator', key: 'sep' } as MenuItem,
      { key: 'clear', label: 'Clear', onSelect: () => set.mutate(null) } as MenuItem,
    ]),
  ];
  return (
    <Menu
      items={items}
      trigger={
        <button
          type="button"
          className={`model-tiers-set${older ? ' model-tiers-older' : unset ? ' model-tiers-unset' : ''}`}
          aria-label={`Tier of ${model.model}: ${text}`}
          disabled={set.isPending}
        >
          {text}
        </button>
      }
    />
  );
}

/** Where a model's tier is written: a key of the owner's own, or a built-in engine's catalogue. */
function tierPath(provider: ProviderTierRow): string {
  return provider.kind === 'builtin'
    ? `/providers/builtin/${encodeURIComponent(provider.slug)}/model-tier`
    : `${PROVIDERS_BASE}/${provider.providerId}/model-tier`;
}

/** Clear is offered where it changes something: a key model with a tier, a built-in model the owner tiered. */
function clearable(provider: ProviderTierRow, model: ProviderModelTier): boolean {
  return provider.kind === 'builtin' ? model.source === 'owner' : model.levels.length > 0;
}
