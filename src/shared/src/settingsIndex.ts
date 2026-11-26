/**
 * The Personal group of Settings' rows, as words: each setting's title, the page it is on and the one-line description
 * its row shows. The web's pages draw their rows from here and Settings' search box searches it, so a setting's copy
 * has one home (docs/mocks/settings-redesign, board-2 note 2). It lives in shared so the server can name a row too: a
 * refused settings proposal links the row the owner changes it on (docs/settings-from-conversation-design.md §6).
 *
 * `anchor` is the row's name on its page (the web's SettingsRow `anchor`): search scrolls to it and flashes it.
 */
export type PersonalSetting = {
  readonly anchor: string;
  readonly path: string;
  readonly title: string;
  readonly description?: string;
};

const setting = <K extends string>(
  anchor: K,
  path: string,
  title: string,
  description?: string,
): PersonalSetting & { anchor: K } => ({ anchor, path, title, description });

/** The Translate conversations row's line, naming the language agents work in ("Agents work in"). */
export function translationEnabledDescription(agentLanguage: string): string {
  return `Agents read and write in ${agentLanguage}; you write and read in your language. Your messages are translated before the agent gets them, its replies before you see them. Tool calls, output and code stay as they are.`;
}

export const PERSONAL_SETTINGS = {
  defaultPermissionMode: setting(
    'defaultPermissionMode',
    '/settings/general',
    'Default permission mode',
    'The mode a new session starts in, unless the composer picks another.',
  ),
  // Providers → Model routing, beside the model tiers they route by.
  modelRouting: setting(
    'modelRouting',
    '/settings/providers/routing',
    'Route by tier',
    'Task runs and SubAgents run on a model of the tier their work needs.',
  ),
  optimizeFor: setting(
    'optimizeFor',
    '/settings/providers/routing',
    'Optimize For',
    'What to favour when a model is picked at a tier.',
  ),
  // docs/routing-account-health-design.md §7.5: off by default; the providers the owner blocked stay out either way.
  relaxBlockedPins: setting(
    'relaxBlockedPins',
    '/settings/providers/routing',
    'Run pinned tasks elsewhere',
    "When the account a task is pinned to can't run, let it run on another account. Providers you've blocked stay out either way.",
  ),
  promptSuggestions: setting(
    'promptSuggestions',
    '/settings/general',
    'Suggested replies',
    "When a Claude turn ends, the empty message box offers what you'd probably type next.",
  ),
  // Board docs/mocks/prompt-optimizer frame 1: right under Suggested replies.
  promptOptimizer: setting(
    'promptOptimizer',
    '/settings/general',
    'Prompt optimizer',
    "Show an Optimize button in the composer. DeepSeek rewrites your draft with this session's context; you review it before it replaces the draft.",
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
  cardFreeTaskCreates: setting(
    'cardFreeTaskCreates',
    '/settings/general',
    'Tasks a session files without asking',
    'After this many, each task a session creates waits for your OK on a card. 0 asks for every one.',
  ),
  // Settings › Translation (docs/mocks/session-translation, frames 1 and 2): between New sessions and Orchestration.
  translationEnabled: setting(
    'translationEnabled',
    '/settings/general',
    'Translate conversations',
    translationEnabledDescription('English'),
  ),
  translationLanguage: setting(
    'translationLanguage',
    '/settings/general',
    'Your language',
    'What you write in, and what replies are shown in.',
  ),
  translationBilingual: setting('translationBilingual', '/settings/general', 'Show both languages'),
  agentLanguage: setting('agentLanguage', '/settings/general', 'Agents work in', 'What the agent receives and answers in.'),
  notifySessionFinished: setting(
    'notifySessionFinished',
    '/settings/notifications',
    'When a session finishes',
    'Alert your devices when a session you started finishes on its own or fails for good. Task, coordinator and agent-started sessions stay quiet; Project done still rings.',
  ),
  // This browser's own switch (docs/web-push-design.md): a row only where the server sends web push, so search finds it
  // only there too (settingsSearch's `webPush`).
  browserNotifications: setting(
    'browserNotifications',
    '/settings/notifications',
    'Notifications in this browser',
    'Show Orbit alerts on this computer, even with no Orbit tab open.',
  ),
  notifyAgentMessage: setting(
    'notifyAgentMessage',
    '/settings/notifications',
    'When an agent asks for you',
    'Let a running agent alert your devices itself — to ask something only you can answer, or to report what you were waiting for. At most one per session per minute.',
  ),
  theme: setting('theme', '/settings/appearance', 'Theme', 'Synced to your account across devices.'),
  // The Name row's caption stays NAME_CAPTION in the web's ProfilePage.tsx, where the iOS copy-parity test reads it.
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
