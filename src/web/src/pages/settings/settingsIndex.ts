/**
 * The Personal group of Settings: each page's nav label and address. The settings on those pages, with the title and
 * one-line description each row shows, are PERSONAL_SETTINGS in @orbit/shared (settingsIndex.ts), where the server
 * reads them too (docs/settings-from-conversation-design.md §6); they are re-exported here for the pages and search.
 */
export { PERSONAL_SETTINGS, translationEnabledDescription, type PersonalSetting } from '@orbit/shared';

export const PERSONAL_PAGES = [
  { path: '/settings/general', label: 'General' },
  { path: '/settings/notifications', label: 'Notifications' },
  { path: '/settings/appearance', label: 'Appearance' },
  { path: '/settings/profile', label: 'Profile' },
  { path: '/settings/shared-links', label: 'Shared links' },
  { path: '/settings/access-tokens', label: 'Access tokens' },
  { path: '/settings/secrets', label: 'Secrets' },
] as const;

/**
 * Providers → Model routing: each model's tier beside how its runs went, and the account's routing switches (Route
 * by tier, Optimize For). It holds what Model tiers and the Routing report were.
 */
export const MODEL_ROUTING_PAGE = { path: '/settings/providers/routing', label: 'Model routing' } as const;

/** The Integrations group of Settings: each connected service's page, its nav label and address. */
export const INTEGRATION_PAGES = [
  { path: '/settings/integrations/feishu', label: 'Feishu' },
  { path: '/settings/integrations/github', label: 'GitHub' },
] as const;
