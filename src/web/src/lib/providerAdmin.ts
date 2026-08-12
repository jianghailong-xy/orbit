// The provider *management* surface shared by the list page and the connect page: the row shape
// the API returns, and where that list lives.

export interface ProviderModelRow {
  value: string;
  label: string;
  contextWindow?: number;
}

// A provider row as the management API returns it: every field except the encrypted key, which
// is surfaced only as `hasApiKey`.
export interface ProviderRow {
  id: string;
  slug: string;
  label: string;
  runtime: string;
  baseUrl: string;
  models: ProviderModelRow[];
  defaultModel: string | null;
  /** The vendor preset this row was created from — its identity, and where its logo comes from.
   *  NULL for a custom endpoint. */
  presetSlug: string | null;
  /** Whether that preset also owns the model list: when it does, `models`/`defaultModel` above are
   *  the preset's current ones, resolved server-side. */
  followsPreset: boolean;
  enabled: boolean;
  hasApiKey: boolean;
}

/** The signed-in user's own (BYOK) provider list — the only one the UI manages. */
export const PROVIDERS_BASE = '/providers/mine';
export const PROVIDERS_LIST_KEY = ['providers', 'mine'];

/**
 * A distinct default name for a provider being connected, given the names already in use.
 *
 * Nothing stops two rows from being called "Anthropic (Claude)" — and a second key for the same
 * vendor is a supported thing to want (a work key and a personal one, two endpoints of the same
 * dialect). But the label is the *only* thing that tells them apart in the model picker: the slug
 * isn't shown, and the logo follows the vendor, so both rows would be the same name under the same
 * logo. So the second one arrives pre-named "Anthropic (Claude) 2", which is a name to overwrite
 * rather than a collision to discover later.
 */
export function suggestProviderName(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((l) => l.trim().toLowerCase()));
  const free = (s: string) => !used.has(s.trim().toLowerCase());
  if (free(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}`;
    if (free(candidate)) return candidate;
  }
}
