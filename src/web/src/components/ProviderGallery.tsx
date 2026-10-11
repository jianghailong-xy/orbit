import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AgentProvider,
  credentialEngines,
  ENGINE_CLI_NAMES,
  PROVIDER_PRESETS,
  type RunnerEngineHealth,
} from '@orbit/shared';
import { api } from '../api';
import { DSH_PRESET_SLUG } from '../lib/dshRuntime';
import { PROVIDERS_BASE, PROVIDERS_LIST_KEY, type ProviderRow } from '../lib/providerAdmin';
import { PROVIDER_GLYPHS } from '../lib/providerGlyphs';
import { runnersQuery } from '../lib/queries';
import { brandForProvider, ENGINE_PRESET } from '../lib/sessionProviderChoices';

/** Just the part of a runner this gallery reads: which engines it is signed into, and its name. */
interface SignedInRunner {
  name: string;
  displayName?: string | null;
  engines?: RunnerEngineHealth[] | null;
}

// Match the iOS provider tile: a white glyph over the brand gradient, or a monogram when unknown.
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
  const { brand, glyphKey } = brandForProvider(slug, label, slug);
  const glyph = PROVIDER_GLYPHS[glyphKey ?? slug];
  return (
    <div
      className="provider-tile"
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        background: `linear-gradient(135deg, ${brand.from}, ${brand.to})`,
        border: glyphKey === 'antigravity' ? '1px solid rgba(255,255,255,0.16)' : undefined,
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

/** An engine's mark, as its row on a machine card draws it: its vendor's, Antigravity's own, OpenCode's
 *  monogram — and DeepSeek's for DeepSeek Harness, DeepSeek's own agent. */
export function EngineTile({ engine, size }: { engine: AgentProvider; size: number }) {
  const slug = engine === AgentProvider.DSH ? 'deepseek' : (ENGINE_PRESET[engine] ?? engine);
  return <ProviderTile slug={slug} label={ENGINE_CLI_NAMES[engine]} size={size} />;
}

/** Each vendor by the company's own name — in the gallery, on its connect page and over its keys — and
 *  never by an engine: one key runs on several (the owner's choice A, 2026-10-09). */
const VENDOR_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  deepseek: 'DeepSeek',
  moonshot: 'Moonshot (Kimi)',
  glm: 'Z.AI (GLM)',
  minimax: 'MiniMax',
  qwen: 'Qwen',
  custom: 'Custom',
};

/** The vendor a key is counted and grouped under: the preset it was made from — a row from the retired
 *  DeepSeek Harness preset is a DeepSeek key like any other — or `custom` for an endpoint of its own. */
export const vendorOf = (presetSlug: string | null | undefined): string =>
  !presetSlug ? 'custom' : presetSlug === DSH_PRESET_SLUG ? 'deepseek' : presetSlug;

export const vendorName = (vendor: string): string =>
  VENDOR_NAMES[vendor] ?? PROVIDER_PRESETS.find((p) => p.slug === vendor)?.label ?? vendor;

/** The engines a key not yet connected will run on, by the shared compatibility table: what a vendor's
 *  card and its connect form promise before the server has a key to answer for. A saved key's own are
 *  the server's (`ProviderRow.engines`), which alone can tell a Claude subscription token — that one
 *  runs on Claude Code only. */
export const newKeyEngines = (key: { runtime?: string | null; presetSlug: string | null; baseUrl: string }): AgentProvider[] =>
  credentialEngines({
    kind: 'key',
    runtime: key.runtime ?? AgentProvider.CLAUDE,
    presetSlug: key.presetSlug,
    baseUrl: key.baseUrl,
    subscriptionToken: false,
  });

/** The vendor picker. Every card is a link into the connect page, so a vendor's onboarding is
 *  deep-linkable (/providers/new/anthropic) and the browser's back button works.
 *
 *  A card is a vendor, never an engine — DeepSeek Harness is one of the engines a DeepSeek key runs
 *  on, so it has no card of its own; until a vendor is connected, its card says which engines its key
 *  runs on. A vendor already connected says so on its card — otherwise the gallery is a wall of
 *  identical logos with no way to tell what's set up. It stays a link either way: a second key for the
 *  same vendor is a supported thing to want. */
export function ProviderGallery() {
  const providers = useQuery({
    queryKey: PROVIDERS_LIST_KEY,
    queryFn: () => api<ProviderRow[]>(PROVIDERS_BASE),
  });
  const runners = useQuery(runnersQuery());
  // How many of the user's keys each vendor accounts for. A row records the preset it was created
  // from, so a second Anthropic key — which lands on the slug "anthropic-2" — still counts towards
  // Anthropic, and a key from the retired DeepSeek Harness preset towards DeepSeek (vendorOf).
  const connected = new Map<string, number>();
  for (const p of providers.data ?? []) {
    if (!p.presetSlug) continue;
    const vendor = vendorOf(p.presetSlug);
    connected.set(vendor, (connected.get(vendor) ?? 0) + 1);
  }
  // Three of these vendors are also engines the user may already be signed into on a machine of
  // their own. Say so on the card: buying a key for a subscription you already pay for is the one
  // mistake this gallery can lead someone into. It stays a link — a key alongside a sign-in is a
  // supported thing to want — it just no longer looks like the only way in.
  const signedInOn = new Map<string, string>();
  for (const runner of (runners.data ?? []) as SignedInRunner[]) {
    for (const engine of runner.engines ?? []) {
      const preset = ENGINE_PRESET[engine.engine];
      if (!preset || signedInOn.has(preset)) continue;
      if (engine.installed && engine.auth === 'yes') {
        signedInOn.set(preset, runner.displayName || runner.name);
      }
    }
  }

  return (
    <div className="provider-gallery">
      {PROVIDER_PRESETS.filter((p) => p.slug !== DSH_PRESET_SLUG).map((p) => {
        const count = connected.get(p.slug) ?? 0;
        return (
          <Link
            key={p.slug}
            to={`/providers/new/${p.slug}`}
            className={`provider-card${count ? ' connected' : ''}`}
          >
            {/* The check rides on the logo's corner rather than the row, so marking a card costs
                no width — these names already fill it. */}
            <span className="pc-logo">
              <ProviderTile slug={p.slug} label={vendorName(p.slug)} />
              {count > 0 && (
                <span className="pc-check" aria-hidden="true">
                  ✓
                </span>
              )}
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="pc-name">{vendorName(p.slug)}</div>
              <div className={`pc-sub${!count && signedInOn.has(p.slug) ? ' pc-local' : ''}`}>
                {count === 0
                  ? (signedInOn.get(p.slug)
                      ? `Already signed in on ${signedInOn.get(p.slug)}`
                      : newKeyEngines({ runtime: p.runtime, presetSlug: p.slug, baseUrl: p.baseUrl })
                          .map((engine) => ENGINE_CLI_NAMES[engine])
                          .join(' · '))
                  : count === 1
                    ? 'Connected'
                    : `Connected · ${count} keys`}
              </div>
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
