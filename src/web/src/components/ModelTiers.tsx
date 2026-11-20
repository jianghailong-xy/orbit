import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SubagentSize } from '@orbit/shared';
import { api } from '../api';
import { PROVIDERS_BASE } from '../lib/providerAdmin';
import { priceText, subagentTiersQuery, TIER_LEVELS, tierText, type ProviderModelTier, type ProviderTierRow } from '../lib/subagentTiers';
import { useToast } from '../lib/toast';
import { Menu, type MenuItem } from './ui/Menu';

/**
 * The Providers page's Tier column (docs/subagent-design.md §7, board docs/mocks/subagent/05.png): every model
 * SubAgents can be routed onto, with its tier. A preset's tier and price follow the catalogue; a custom
 * endpoint's model reads Not set, and the owner sets one here. Until then it ranks after every tiered model.
 * A built-in engine lists its whole catalogue, every model the owner's to tier, overriding the catalogue's tier
 * (board 2026-11-20: list all; a tier the owner set carries a "Yours" tag).
 */
export function ModelTiers() {
  const tiers = useQuery(subagentTiersQuery());
  const rows = (tiers.data?.providers ?? []).flatMap((provider) =>
    provider.models.map((model) => ({ provider, model })));
  if (!tiers.isSuccess || rows.length === 0) return null;
  return (
    <div id="tiers">
      <div className="re-sec-head" style={{ marginTop: 28 }}>
        <h3>Model tiers</h3>
        <span className="re-sec-sub">The tier SubAgents are routed by, per model.</span>
      </div>
      <table className="model-tiers">
        <thead>
          <tr>
            <th>Provider</th>
            <th>Model</th>
            <th>Tier</th>
            <th>Price / M out</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ provider, model }) => (
            <tr key={`${provider.slug}:${model.model}`}>
              <td>{provider.label}</td>
              <td className="model-tiers-model">{model.model}</td>
              <td>
                <TierCell provider={provider} model={model} />
                {model.source === 'owner' && <span className="model-tiers-yours">Yours</span>}
              </td>
              <td className="model-tiers-price">{priceText(model, provider.billing)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="model-tiers-foot">
        Preset tiers and prices follow the catalogue. A model with no tier still runs SubAgents, after every model whose
        tier fits.
      </div>
    </div>
  );
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
  const text = tierText(model.levels);
  const unset = model.levels.length === 0;
  if (!model.editable || (!provider.providerId && provider.kind !== 'builtin')) {
    return <span className={unset ? 'model-tiers-unset' : undefined}>{text}</span>;
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
          className={`model-tiers-set${unset ? ' model-tiers-unset' : ''}`}
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
