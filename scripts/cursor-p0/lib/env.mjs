// Whitelisted environments for the real Cursor CLI. Nothing from the caller's environment is
// inherited: every variable the CLI sees is named here, so the runner user's ~/.cursor and
// ~/.config/cursor are never read or written.
import { mkdirSync, readFileSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

// The pinned build. CURSOR_P0_VERSION (with CURSOR_P0_TARBALL_SHA256) runs the scenarios against
// another build, to compare it with the pinned one; the pin itself does not move.
export const PINNED_VERSION = '2026.10.14-941492e';
export const PINNED_TARBALL_SHA256 = '6f6bf39dd2df29dcd38643cdfab0155ce71699953889f732deec123f6562bb2d';
export const VERSION = process.env.CURSOR_P0_VERSION ?? PINNED_VERSION;
export const TARBALL_SHA256 = VERSION === PINNED_VERSION ? PINNED_TARBALL_SHA256 : process.env.CURSOR_P0_TARBALL_SHA256 ?? null;
// P0b: darwin/arm64 tarball hash (measured 2026-10-17 on orbit-macos), and the hash of the tarball
// for the platform this harness runs on (only the pinned build has a darwin hash).
export const TARBALL_SHA256_DARWIN = 'c6d9e2eaa1b1e24221517e0b4206b1f1593792e6f0d8a52e9b507bbe7ab0cc77';
export const ACTIVE_TARBALL_SHA256 = VERSION === PINNED_VERSION && process.platform === 'darwin' && process.arch === 'arm64' ? TARBALL_SHA256_DARWIN : TARBALL_SHA256;
export const P0_ROOT = process.env.CURSOR_P0_ROOT ?? '/mnt/data/cursor-p0';
export const CLI_DIR = process.env.CURSOR_P0_CLI ?? join(P0_ROOT, 'cli', VERSION);
export const AGENT = join(CLI_DIR, 'cursor-agent');
export const KEY_FILE = process.env.CURSOR_P0_KEY_FILE ?? '/root/.config/orbit-secrets/cursor-api-key';
export const PATH_VALUE = '/usr/local/bin:/usr/bin:/bin';
export const CANARY = 'ORBIT_P0_CANARY';

export function readApiKey() {
  if (!existsSync(KEY_FILE)) return null;
  const key = readFileSync(KEY_FILE, 'utf8').trim();
  return key || null;
}

// A slot is one isolated account directory tree. Which of its roots a scenario hands to the
// CLI is up to the scenario (layout), so the effect of each variable can be told apart.
export function makeSlot(base, name) {
  const root = join(base, 'slots', name);
  const slot = {
    name, root,
    home: join(root, 'home'),
    config: join(root, 'cursor-config'),
    data: join(root, 'cursor-data'),
    xdgConfig: join(root, 'xdg-config'),
    xdgCache: join(root, 'xdg-cache'),
    xdgData: join(root, 'xdg-data'),
  };
  for (const d of [slot.home, slot.config, slot.data, slot.xdgConfig, slot.xdgCache, slot.xdgData]) mkdirSync(d, { recursive: true });
  return slot;
}

// layout: which variables point into the slot. Default isolates everything.
export function cursorEnv(slot, { layout = 'full', apiKey = null, store = 'file', extra = {} } = {}) {
  const env = { PATH: PATH_VALUE, LANG: 'C.UTF-8', TERM: 'dumb', NO_OPEN_BROWSER: '1', [CANARY]: 'inherited' };
  env.HOME = slot.home;
  if (layout === 'full' || layout === 'config-data') {
    env.CURSOR_CONFIG_DIR = slot.config;
    env.CURSOR_DATA_DIR = slot.data;
  }
  if (layout === 'full' || layout === 'xdg') {
    env.XDG_CONFIG_HOME = slot.xdgConfig;
    env.XDG_CACHE_HOME = slot.xdgCache;
    env.XDG_DATA_HOME = slot.xdgData;
  }
  if (store) env.AGENT_CLI_CREDENTIAL_STORE = store;
  if (apiKey) env.CURSOR_API_KEY = apiKey;
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null) delete env[k];
    else env[k] = v;
  }
  return env;
}

// Real prompts spend the owner's Cursor quota, and each task that spends them has a budget of its
// own: one ledger per task, chosen with CURSOR_P0_LEDGER (default: the current task's). Every
// session/prompt (and every `agent -p`) sent with real credentials is charged to it first; the
// ledger outlives runs and refuses past its cap.
export const LEDGERS = {
  p0a: { file: 'prompts.jsonl', cap: 30, task: 'P0a 34h05eeSDrtKGW2ret55v' },
  p0b: { file: 'p0b-prompts.jsonl', cap: 30, task: 'P0b 34h05fIoCOHhRY79oksON' },
  p0c: { file: 'p0c-prompts.jsonl', cap: 10, task: 'P0c 34h3xGGSqUnA6DTMj1iop' },
};
export const LEDGER_NAME = process.env.CURSOR_P0_LEDGER ?? 'p0c';
if (!LEDGERS[LEDGER_NAME]) throw new Error(`unknown ledger ${LEDGER_NAME}; known: ${Object.keys(LEDGERS).join(', ')}`);
export const PROMPT_CAP = LEDGERS[LEDGER_NAME].cap;
export const LEDGER = join(P0_ROOT, 'ledger', LEDGERS[LEDGER_NAME].file);

export function promptsSpent() {
  if (!existsSync(LEDGER)) return [];
  return readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

export function chargePrompt(runId, scenario, note) {
  if (process.env.CURSOR_P0_SELFTEST === '1') throw new Error('self-test mode never charges real prompts');
  if (VERSION !== PINNED_VERSION) throw new Error(`real prompts go to the pinned build only; refusing ${scenario} on ${VERSION}`);
  const spent = promptsSpent();
  if (spent.length >= PROMPT_CAP) throw new Error(`real prompt cap ${PROMPT_CAP} reached; refusing ${scenario}`);
  mkdirSync(join(P0_ROOT, 'ledger'), { recursive: true });
  const entry = { n: spent.length + 1, at: new Date().toISOString(), runId, scenario, note, version: VERSION };
  appendFileSync(LEDGER, JSON.stringify(entry) + '\n');
  return entry;
}
