// Model options shared across the app — the runner-detail "add agent" form, the
// Settings "Agent defaults" section, and the AgentView composer — so the set of
// models, their order, and their labels never drift between pickers. `value` is the
// claude --model id; `label` is the friendly display name shown in every picker.
// Ordered Opus-first to match Claude Code's model picker.
export const MODEL_OPTIONS = [
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
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
