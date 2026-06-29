export const PROVIDER_OPTIONS = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
];

// Model options shared across the app. `value` is the local runtime's model id;
// `label` is the friendly display name shown in every picker.
export const CLAUDE_MODEL_OPTIONS = [
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

export const CODEX_MODEL_OPTIONS = [{ value: 'gpt-5.5', label: 'GPT-5.5' }];

export const MODEL_OPTIONS_BY_PROVIDER: Record<string, { value: string; label: string }[]> = {
  claude: CLAUDE_MODEL_OPTIONS,
  codex: CODEX_MODEL_OPTIONS,
};

export const MODEL_OPTIONS = [...CLAUDE_MODEL_OPTIONS, ...CODEX_MODEL_OPTIONS];

export const DEFAULT_MODEL_BY_PROVIDER: Record<string, string> = {
  claude: 'claude-opus-4-8',
  codex: 'gpt-5.5',
};

export const modelOptionsForProvider = (provider?: string | null) =>
  MODEL_OPTIONS_BY_PROVIDER[provider ?? 'claude'] ?? CLAUDE_MODEL_OPTIONS;

// Reasoning effort is provider-specific. Claude supports "max"; Codex's
// Responses API effort values top out at "xhigh", with "minimal" also available.
export const CLAUDE_EFFORT_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'xHigh' },
  { value: 'max', label: 'Max' },
];

export const CODEX_EFFORT_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'xHigh' },
];

export const effortOptionsForProvider = (provider?: string | null) =>
  provider === 'codex' ? CODEX_EFFORT_OPTIONS : CLAUDE_EFFORT_OPTIONS;

export const normalizeEffortForProvider = (provider: string | null | undefined, effort: string): string =>
  provider === 'codex' && effort === 'max' ? 'xhigh' : effort;

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
