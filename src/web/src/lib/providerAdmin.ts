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
}

/** The signed-in user's own (BYOK) provider list — the only one the UI manages. */
export const PROVIDERS_BASE = '/providers/mine';
export const PROVIDERS_LIST_KEY = ['providers', 'mine'];

/**
 * The account-level Claude subscription token (`claude setup-token`), injected as
 * CLAUDE_CODE_OAUTH_TOKEN into this user's claude sessions on EVERY runner.
 *
 * It authenticates the same vendor the `anthropic` preset does, which is why both live behind
 * the one Anthropic tile: the choice between them is a billing choice (plan quota vs per-token),
 * not a choice of vendor. It stays out of the provider table's own shape — it has no endpoint of
 * its own and adds no model to the pickers — so the list page renders it as a synthetic row.
 *
 * Write-only: the server never returns the token, only whether one is stored and when.
 */
export interface SubscriptionStatus {
  configured: boolean;
  setAt: string | null;
}

export const SUBSCRIPTION_PATH = '/providers/subscription';

export const subscriptionQuery = () =>
  queryOptions({
    queryKey: ['providers', 'subscription'] as const,
    queryFn: () => api<SubscriptionStatus>(SUBSCRIPTION_PATH),
  });
