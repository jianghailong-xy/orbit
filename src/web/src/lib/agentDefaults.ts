// Model + default options shared across the app — the runner-detail "add agent"
// form, the Settings "Agent defaults" section, and the AgentView composer — so the
// set of models and their order never drift between pickers. `label` is the raw id
// (shown on the agent-default forms); `short` is the friendly name the composer
// shows. Ordered Opus-first to match Claude Code's model picker.
export const MODEL_OPTIONS = [
  { value: 'claude-opus-4-8', label: 'claude-opus-4-8', short: 'Opus 4.8' },
  { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6', short: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5', label: 'claude-haiku-4-5', short: 'Haiku 4.5' },
];

// The permission mode a new session of the agent starts in.
export const MODE_OPTIONS = [
  { value: 'default', label: 'Default' },
  { value: 'plan', label: 'Plan' },
  { value: 'acceptEdits', label: 'Accept Edits' },
  { value: 'auto', label: 'Auto' },
  { value: 'dontAsk', label: "Don't Ask" },
  { value: 'bypassPermissions', label: 'Bypass' },
];

// Auto mode needs a recent model; claude rejects --permission-mode auto on Haiku.
export const AUTO_CAPABLE_MODELS = new Set(['claude-sonnet-4-6', 'claude-opus-4-8']);
export const supportsAuto = (m: string): boolean => AUTO_CAPABLE_MODELS.has(m);

// App defaults used when the user has set no preference of their own.
export const DEFAULT_MODEL = 'claude-opus-4-8';
export const DEFAULT_PERMISSION_MODE = 'auto';
