/**
 * The Personal group of Settings, as words: each page's nav label and address, and the settings on it
 * with the title and one-line description each row shows. The pages draw their rows from here and
 * Settings' search box searches it, so a setting's copy has one home (docs/mocks/settings-redesign,
 * board-2 note 2).
 *
 * `anchor` is the row's name on its page (SettingsRow's `anchor`): search scrolls to it and flashes it.
 */
export type PersonalSetting = {
  readonly anchor: string;
  readonly path: string;
  readonly title: string;
  readonly description?: string;
};

export const PERSONAL_PAGES = [
  { path: '/settings/general', label: 'General' },
  { path: '/settings/notifications', label: 'Notifications' },
  { path: '/settings/appearance', label: 'Appearance' },
  { path: '/settings/profile', label: 'Profile' },
  { path: '/settings/storage', label: 'Storage' },
  { path: '/settings/shared-links', label: 'Shared links' },
  { path: '/settings/access-tokens', label: 'Access tokens' },
  { path: '/settings/terminals', label: 'Terminals' },
] as const;

/** The Integrations group of Settings: each connected service's page, its nav label and address. */
export const INTEGRATION_PAGES = [{ path: '/settings/integrations/feishu', label: 'Feishu' }] as const;

const setting = <K extends string>(
  anchor: K,
  path: string,
  title: string,
  description?: string,
): PersonalSetting & { anchor: K } => ({ anchor, path, title, description });

export const PERSONAL_SETTINGS = {
  defaultPermissionMode: setting(
    'defaultPermissionMode',
    '/settings/general',
    'Default permission mode',
    'The mode a new session starts in, unless the composer picks another.',
  ),
  modelRouting: setting(
    'modelRouting',
    '/settings/general',
    'Smart model selection',
    'Coordinators suggest a tier for each task; Agents you turn this on for run on that tier.',
  ),
  promptSuggestions: setting(
    'promptSuggestions',
    '/settings/general',
    'Suggested replies',
    "When a Claude turn ends, the empty message box offers what you'd probably type next.",
  ),
  recaps: setting(
    'recaps',
    '/settings/general',
    'Session recaps',
    'Session lists show a one-line summary of each conversation instead of its raw last reply.',
  ),
  enableOrchestration: setting(
    'enableOrchestration',
    '/settings/general',
    'Let sessions orchestrate',
    'Sessions can start and manage other sessions, and manage agents and runners, via the orbit MCP tools.',
  ),
  // Settings › Translation (docs/mocks/session-translation, frames 1 and 2): between New sessions and Orchestration.
  translationEnabled: setting(
    'translationEnabled',
    '/settings/general',
    'Translate conversations',
    'Agents read and write in English; you write and read in your language. Your messages are translated before the agent gets them, its replies before you see them. Tool calls, output and code stay as they are.',
  ),
  translationLanguage: setting(
    'translationLanguage',
    '/settings/general',
    'Your language',
    'What you write in, and what replies are shown in.',
  ),
  agentLanguage: setting('agentLanguage', '/settings/general', 'Agents work in', 'What the agent receives and answers in.'),
  notifySessionFinished: setting(
    'notifySessionFinished',
    '/settings/notifications',
    'When a session finishes',
    'Alert your devices when a run finishes on its own or fails for good.',
  ),
  notifyAgentMessage: setting(
    'notifyAgentMessage',
    '/settings/notifications',
    'When an agent asks for you',
    'Let a running agent alert your devices itself — to ask something only you can answer, or to report what you were waiting for. At most one per session per minute.',
  ),
  theme: setting('theme', '/settings/appearance', 'Theme', 'Synced to your account across devices.'),
  // The Name row's caption stays NAME_CAPTION in ProfilePage.tsx, where the iOS copy-parity test reads it.
  photo: setting('photo', '/settings/profile', 'Photo'),
  name: setting('name', '/settings/profile', 'Name'),
  email: setting('email', '/settings/profile', 'Email'),
  storedFiles: setting(
    'storedFiles',
    '/settings/storage',
    'Stored files',
    'Each file counts once, however many sessions use it. Files agents upload expire after 14 days unless evidence keeps them.',
  ),
} as const;
