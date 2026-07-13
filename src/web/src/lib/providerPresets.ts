// Official preset templates for the Add-provider form: picking one pre-fills the
// slug/label/endpoint/model list so the admin only enters an API key. Phase 1 borrows
// the claude runtime, so every preset here is a vendor's OFFICIAL Anthropic-compatible
// endpoint (the same ones their docs give for Claude Code). Endpoints and model ids
// verified against vendor docs 2026-07; models move fast — the form stays editable.
export interface ProviderPresetModel {
  value: string;
  label: string;
  contextWindow?: number;
}

/** Brand mark for the vendor tile: a monogram over a two-stop gradient. */
export interface ProviderBrand {
  mono: string;
  from: string;
  to: string;
}

export interface ProviderPreset {
  slug: string;
  label: string;
  baseUrl: string;
  models: ProviderPresetModel[];
  defaultModel: string;
  /** Caveat shown under the Base URL (e.g. regional endpoint variants). */
  note?: string;
  /** Logo tile shown in the provider gallery and rows. */
  brand: ProviderBrand;
  /** Vendor console where the user mints an API key (rendered as a "Get your API key" link). */
  keyUrl?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    slug: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/anthropic',
    models: [
      { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
      { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
    ],
    defaultModel: 'deepseek-v4-pro',
    brand: { mono: 'D', from: '#5b7cff', to: '#3a57e8' },
    keyUrl: 'https://platform.deepseek.com',
  },
  {
    slug: 'kimi',
    label: 'Kimi (Moonshot)',
    baseUrl: 'https://api.moonshot.ai/anthropic',
    models: [
      { value: 'kimi-k2.7-code', label: 'Kimi K2.7 Code', contextWindow: 256_000 },
      { value: 'kimi-k2.7-code-highspeed', label: 'Kimi K2.7 Code Highspeed', contextWindow: 256_000 },
      { value: 'kimi-k2.6', label: 'Kimi K2.6', contextWindow: 256_000 },
    ],
    defaultModel: 'kimi-k2.7-code',
    note: 'Global endpoint; the CN platform uses https://api.moonshot.cn/anthropic.',
    brand: { mono: 'K', from: '#3a3a3a', to: '#111111' },
    keyUrl: 'https://platform.moonshot.ai',
  },
  {
    slug: 'glm',
    label: 'Z.AI (GLM)',
    baseUrl: 'https://api.z.ai/api/anthropic',
    models: [
      { value: 'glm-5.2', label: 'GLM-5.2' },
      { value: 'glm-4.7', label: 'GLM-4.7' },
    ],
    defaultModel: 'glm-5.2',
    brand: { mono: 'Z', from: '#33b6b0', to: '#1e8e8e' },
    keyUrl: 'https://z.ai',
  },
  {
    slug: 'minimax',
    label: 'MiniMax',
    baseUrl: 'https://api.minimax.io/anthropic',
    models: [
      { value: 'MiniMax-M3', label: 'MiniMax-M3', contextWindow: 1_000_000 },
      { value: 'MiniMax-M2.7', label: 'MiniMax-M2.7', contextWindow: 204_800 },
      { value: 'MiniMax-M2.7-highspeed', label: 'MiniMax-M2.7 Highspeed', contextWindow: 204_800 },
    ],
    defaultModel: 'MiniMax-M2.7',
    brand: { mono: 'M', from: '#ff5b76', to: '#e11d48' },
    keyUrl: 'https://www.minimax.io',
  },
  {
    slug: 'qwen',
    label: 'Qwen (Model Studio)',
    baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
    models: [
      { value: 'qwen3.7-max', label: 'Qwen3.7 Max' },
      { value: 'qwen3.7-plus', label: 'Qwen3.7 Plus' },
      { value: 'qwen3.6-flash', label: 'Qwen3.6 Flash' },
    ],
    defaultModel: 'qwen3.7-max',
    note: 'Beijing-region endpoint; Singapore/intl uses a workspace-specific URL (see Model Studio docs).',
    brand: { mono: 'Q', from: '#7a72ff', to: '#4f46e5' },
    keyUrl: 'https://bailian.console.aliyun.com',
  },
];
