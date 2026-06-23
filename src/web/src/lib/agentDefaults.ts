// New-agent default options, shared by the runner-detail "add agent" form and the
// Settings "Agent defaults" section, so a user's saved defaults and the form's
// option lists never drift. Keep MODEL_OPTIONS in sync with AgentView's own copy.

export const MODEL_OPTIONS = [
  { value: 'claude-sonnet-4-6', label: 'claude-sonnet-4-6' },
  { value: 'claude-opus-4-8', label: 'claude-opus-4-8' },
  { value: 'claude-haiku-4-5', label: 'claude-haiku-4-5' },
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

// App defaults used when the user has set no preference of their own.
export const DEFAULT_MODEL = 'claude-sonnet-4-6';
export const DEFAULT_PERMISSION_MODE = 'auto';
