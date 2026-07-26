// The provider *management* surface shared by the list page and the connect page: the row shape
// those APIs return, and which of the two lists a page is acting on.

export interface ProviderModelRow {
  value: string;
  label: string;
  contextWindow?: number;
}

// A provider row as the management APIs return it (mine or shared): every field except the
// encrypted key, which is surfaced only as `hasApiKey`.
export interface ProviderRow {
  id: string;
  slug: string;
  label: string;
  runtime: string;
  baseUrl: string;
  models: ProviderModelRow[];
  defaultModel: string | null;
  /** The vendor preset this row follows, if any: `models`/`defaultModel` above are the preset's
   *  current ones, resolved server-side. NULL means the row maintains its own list. */
  presetSlug: string | null;
  enabled: boolean;
  hasApiKey: boolean;
}

/** Whose list a page manages: the signed-in user's own (BYOK), or the deployment-wide one
 *  admins maintain. Carried in the URL as `?scope=shared` so a connect page is deep-linkable. */
export type ProviderScope = 'mine' | 'shared';

export const PROVIDER_SCOPES: Record<ProviderScope, { basePath: string; listKey: string[] }> = {
  mine: { basePath: '/providers/mine', listKey: ['providers', 'mine'] },
  shared: { basePath: '/admin/providers', listKey: ['admin', 'providers'] },
};

export function providerScopeFrom(value: string | null): ProviderScope {
  return value === 'shared' ? 'shared' : 'mine';
}

/** Query string that carries a non-default scope through a link ('' for the personal list). */
export function scopeSuffix(scope: ProviderScope): string {
  return scope === 'shared' ? '?scope=shared' : '';
}
