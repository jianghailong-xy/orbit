import { Link } from 'react-router-dom';
import { PROVIDER_PRESETS, type ProviderBrand } from '../lib/providerPresets';
import { PROVIDER_GLYPHS } from '../lib/providerGlyphs';
import { scopeSuffix, type ProviderScope } from '../lib/providerAdmin';

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

/** The vendor picker. Every card is a link into the connect page, so a vendor's onboarding is
 *  deep-linkable (/providers/new/anthropic) and the browser's back button works. */
export function ProviderGallery({ scope }: { scope: ProviderScope }) {
  const suffix = scopeSuffix(scope);
  return (
    <div className="provider-gallery">
      {PROVIDER_PRESETS.map((p) => (
        <Link key={p.slug} to={`/providers/new/${p.slug}${suffix}`} className="provider-card">
          <ProviderTile slug={p.slug} label={p.label} />
          <div style={{ minWidth: 0 }}>
            <div className="pc-name">{p.label}</div>
            <div className="pc-sub">
              {p.runtime === 'codex' ? 'OpenAI-compatible' : 'Anthropic-compatible'}
            </div>
          </div>
        </Link>
      ))}
      <Link to={`/providers/new/custom${suffix}`} className="provider-card custom">
        <ProviderTile slug="custom" label="Custom" muted />
        <div style={{ minWidth: 0 }}>
          <div className="pc-name">Custom</div>
          <div className="pc-sub">Manual endpoint</div>
        </div>
      </Link>
    </div>
  );
}
