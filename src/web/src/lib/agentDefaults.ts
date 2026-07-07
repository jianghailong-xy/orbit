export const PROVIDER_OPTIONS = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
];

// Model options shared across the app. `value` is the local runtime's model id;
// `label` is the friendly display name shown in every picker.
export const CLAUDE_MODEL_OPTIONS = [
  { value: 'claude-fable-5', label: 'Fable 5' },
  { value: 'claude-opus-4-8', label: 'Opus 4.8' },
  { value: 'claude-sonnet-5', label: 'Sonnet 5' },
  { value: 'claude-haiku-4-5', label: 'Haiku 4.5' },
];

export const CODEX_MODEL_OPTIONS = [
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini' },
  { value: 'gpt-5.3-codex-spark', label: 'GPT-5.3 Codex Spark' },
];

export const MODEL_OPTIONS_BY_PROVIDER: Record<string, { value: string; label: string }[]> = {
  claude: CLAUDE_MODEL_OPTIONS,
  codex: CODEX_MODEL_OPTIONS,
};

export const MODEL_OPTIONS = [...CLAUDE_MODEL_OPTIONS, ...CODEX_MODEL_OPTIONS];

// Per-model context-window size (max input tokens), for the composer's context-usage
// gauge. Claude values are the models' true windows (Opus 4.8 / Sonnet 5 / Fable 5 = 1M,
// Haiku 4.5 = 200K); Codex is a best-effort default. Keep in sync with Swift's
// AgentDefaults.contextWindow(for:).
export const CONTEXT_WINDOW_BY_MODEL: Record<string, number> = {
  'claude-fable-5': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
  'gpt-5.5': 400_000,
  'gpt-5.4': 400_000,
  'gpt-5.4-mini': 400_000,
  'gpt-5.3-codex-spark': 400_000,
};
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const contextWindowFor = (model?: string | null): number =>
  (model && CONTEXT_WINDOW_BY_MODEL[model]) || DEFAULT_CONTEXT_WINDOW;

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
export const AUTO_CAPABLE_MODELS = new Set(['claude-fable-5', 'claude-opus-4-8', 'claude-sonnet-5']);
export const supportsAuto = (m: string): boolean => AUTO_CAPABLE_MODELS.has(m);

// App defaults used when the user has set no preference of their own.
export const DEFAULT_MODEL = 'claude-opus-4-8';
export const DEFAULT_PERMISSION_MODE = 'auto';
