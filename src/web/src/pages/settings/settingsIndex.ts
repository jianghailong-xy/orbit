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
  { path: '/settings/storage', label: 'Storage' },
  { path: '/settings/shared-links', label: 'Shared links' },
  { path: '/settings/access-tokens', label: 'Access tokens' },
  { path: '/settings/terminals', label: 'Terminals' },
  // Board docs/mocks/subagent-workflow/08-report.html: the routing report, last of Personal.
  { path: '/settings/routing-report', label: 'Routing report' },
] as const;

/** The Integrations group of Settings: each connected service's page, its nav label and address. */
export const INTEGRATION_PAGES = [
  { path: '/settings/integrations/feishu', label: 'Feishu' },
  { path: '/settings/integrations/github', label: 'GitHub' },
] as const;
