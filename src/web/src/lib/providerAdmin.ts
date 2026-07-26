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
