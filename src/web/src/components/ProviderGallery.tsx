import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { PROVIDER_PRESETS, type ProviderBrand } from '@orbit/shared';
import { api } from '../api';
import {
  PROVIDERS_BASE,
  PROVIDERS_LIST_KEY,
  subscriptionQuery,
  type ProviderRow,
} from '../lib/providerAdmin';
import { PROVIDER_GLYPHS } from '../lib/providerGlyphs';

// The brand for a provider: presets ship one; a custom provider falls back to a neutral monogram
// derived from its label.
export function brandFor(slug: string, label: string): ProviderBrand {
  const preset = PROVIDER_PRESETS.find((p) => p.slug === slug);
  if (preset) return preset.brand;
  return { mono: (label.trim()[0] ?? '?').toUpperCase(), from: '#9aa0a8', to: '#6b7178' };
}

// The square logo tile: the vendor's brand glyph (white) over its brand gradient — falling back to
// a monogram when no glyph is known, or a dashed neutral "+" tile for "Custom".
export function ProviderTile({
  slug,
  label,
  size = 40,
  muted = false,
}: {
  slug: string;
  label: string;
  size?: number;
  muted?: boolean;
}) {
  const radius = Math.round(size * 0.26);
  if (muted) {
    return (
      <div
        className="provider-tile"
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          background: 'var(--fill-muted)',
          color: 'var(--text-3)',
          border: '1px dashed var(--border)',
          fontSize: Math.round(size * 0.5),
        }}
      >
        +
      </div>
    );
  }
  const brand = brandFor(slug, label);
  const glyph = PROVIDER_GLYPHS[slug];
  return (
    <div
      className="provider-tile"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: `linear-gradient(135deg, ${brand.from}, ${brand.to})`,
      }}
    >
      {glyph ? (
        <svg
          viewBox="0 0 24 24"
          width={Math.round(size * 0.56)}
          height={Math.round(size * 0.56)}
          fill="currentColor"
          style={{ color: '#fff' }}
          dangerouslySetInnerHTML={{ __html: glyph }}
        />
      ) : (
        <span style={{ fontSize: Math.round(size * 0.42) }}>{brand.mono}</span>
      )}
    </div>
  );
}

/** What a tile says under the vendor name: its endpoint dialect until something is set up, then
 *  what that is. Anthropic can be both at once — a subscription and keys — and says so, since
 *  which one is in play is the whole reason its two forms share a tile. */
function connectedLabel(runtime: string | undefined, count: number, subbed: boolean): string {
  if (subbed) return count ? `Subscription · ${count} key${count === 1 ? '' : 's'}` : 'Subscription';
  if (count === 0) return runtime === 'codex' ? 'OpenAI-compatible' : 'Anthropic-compatible';
  return count === 1 ? 'Connected' : `Connected · ${count} keys`;
}

/** The vendor picker. Every card is a link into the connect page, so a vendor's onboarding is
 *  deep-linkable (/providers/new/anthropic) and the browser's back button works.
 *
 *  A vendor already connected says so on its card — otherwise the gallery is a wall of identical
 *  logos with no way to tell what's set up. It stays a link either way: a second key for the same
 *  vendor is a supported thing to want. */
export function ProviderGallery() {
  const providers = useQuery({
    queryKey: PROVIDERS_LIST_KEY,
    queryFn: () => api<ProviderRow[]>(PROVIDERS_BASE),
  });
  // The Claude subscription is authentication for the Anthropic tile too — the tile is the only
  // way in to either — so it has to count towards that tile being marked connected.
  const subscription = useQuery(subscriptionQuery());
  // How many of the user's providers each vendor accounts for. A row records the preset it was
  // created from, so a second Anthropic key — which lands on the slug "anthropic-2" — still counts
  // towards Anthropic.
  const connected = new Map<string, number>();
  for (const p of providers.data ?? []) {
    if (p.presetSlug) connected.set(p.presetSlug, (connected.get(p.presetSlug) ?? 0) + 1);
  }

  return (
    <div className="provider-gallery">
      {PROVIDER_PRESETS.map((p) => {
        const count = connected.get(p.slug) ?? 0;
        const subbed = p.slug === 'anthropic' && (subscription.data?.configured ?? false);
        return (
          <Link
            key={p.slug}
            to={`/providers/new/${p.slug}`}
            className={`provider-card${count || subbed ? ' connected' : ''}`}
          >
            {/* The check rides on the logo's corner rather than the row, so marking a card costs
                no width — these names already fill it. */}
            <span className="pc-logo">
              <ProviderTile slug={p.slug} label={p.label} />
              {(count > 0 || subbed) && (
                <span className="pc-check" aria-hidden="true">
                  ✓
                </span>
              )}
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="pc-name">{p.label}</div>
              <div className="pc-sub">{connectedLabel(p.runtime, count, subbed)}</div>
            </div>
          </Link>
        );
      })}
      <Link to="/providers/new/custom" className="provider-card custom">
        <ProviderTile slug="custom" label="Custom" muted />
        <div style={{ minWidth: 0 }}>
          <div className="pc-name">Custom</div>
          <div className="pc-sub">Manual endpoint</div>
        </div>
      </Link>
    </div>
  );
}
