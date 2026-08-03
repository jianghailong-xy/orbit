// The provider *management* surface shared by the list page and the connect page: the row shape
// the API returns, and where that list lives.

import { queryOptions } from '@tanstack/react-query';
import { api } from '../api';

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
  /** "api_key" or "subscription" — a subscription row is one Claude account, holding a
   *  `claude setup-token` instead of an API key. */
  authMode?: string;
  /** Subscription rows only: the account a new agent runs on. At most one per user. */
  isDefault?: boolean;
}

/** The signed-in user's own (BYOK) provider list — the only one the UI manages. */
export const PROVIDERS_BASE = '/providers/mine';
export const PROVIDERS_LIST_KEY = ['providers', 'mine'];

/**
 * Claude subscription accounts. They're ModelProvider rows underneath — so they show up in the
 * pickers and an agent can name one — but they're created and removed through their own routes,
 * since an account needs only a name and a token where an API-key provider needs an endpoint and
 * a model list.
 *
 * The token is write-only: no route returns it, so a stored account surfaces only as its label
 * and when it was added.
 */
export interface SubscriptionAccount {
  id: string;
  slug: string;
  /** The user's own label. The token carries no account identity, so this is the only way to
   *  tell two accounts apart. */
  label: string;
  isDefault: boolean;
  enabled: boolean;
  setAt: string;
}

export const SUBSCRIPTIONS_BASE = '/providers/subscriptions';

export const subscriptionAccountsQuery = () =>
  queryOptions({
    queryKey: ['providers', 'subscriptions'] as const,
    queryFn: () => api<SubscriptionAccount[]>(SUBSCRIPTIONS_BASE),
  });
