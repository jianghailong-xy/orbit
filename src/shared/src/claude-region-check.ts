/**
 * The region check's shared rules (docs/claude-region-check-contract.md), for the control plane and
 * the web alike: what Cloudflare's country and region decide against Anthropic's list (§2, §3), what a
 * stored verdict means now (§5), which credentials talk to Anthropic (§8), and the words a refused or
 * stopped turn carries (§9, §10). runner-go keeps its own copies of the constants it needs.
 */
import {
  CLAUDE_EXCLUDED_REGIONS,
  CLAUDE_REGION_NAMES,
  CLAUDE_SUPPORTED_COUNTRIES,
  CLAUDE_SUPPORTED_TERRITORIES,
} from './claude-regions';
import {
  CLAUDE_REGION_UNSUPPORTED,
  type ClaudeRegionCheckResponse,
  type ClaudeRegionDecidedVerdict,
  type RunnerRegion,
} from './dto';
import { AgentProvider } from './enums';

/** How long a decided verdict outlives the checks after it that could not decide (owner decision ③,
 *  contract §5). runner-go carries a verdict over for the same 24 hours. */
export const CLAUDE_REGION_CARRY_OVER_MS = 24 * 60 * 60 * 1000;

/** What one check concludes from Cloudflare's headers: the route's answer without the two fields the
 *  route adds itself (`viaProxy`, `asOf`). */
export type ClaudeRegionResult = Pick<ClaudeRegionCheckResponse, 'verdict' | 'country' | 'regionCode' | 'name'>;

const SUPPORTED: ReadonlySet<string> = new Set([
  ...CLAUDE_SUPPORTED_COUNTRIES.map(([code]) => code),
  ...CLAUDE_SUPPORTED_TERRITORIES.map(([code]) => code),
]);
const EXCLUDED: ReadonlyMap<string, string> = new Map(CLAUDE_EXCLUDED_REGIONS);
/** The listed countries with excluded regions (Ukraine): the only ones whose verdict needs the region. */
const SPLIT_BY_REGION: ReadonlySet<string> = new Set(CLAUDE_EXCLUDED_REGIONS.map(([code]) => code.slice(0, 2)));

const UNKNOWN: ClaudeRegionResult = { verdict: 'unknown', country: null, regionCode: null, name: null };

/**
 * What a country (CF-IPCountry) and first-level region (cf-region-code) decide (contract §3). The
 * caller trusts the headers already: a request that did not come through a trusted proxy is unknown
 * and never gets here.
 *
 * - A code that names no country is unknown: none at all, Cloudflare's XX (no data) and T1 (Tor).
 * - A country the list does not name, and that is no territory of one it does, is blocked.
 * - Ukraine needs the region. An excluded one is blocked under its own name, any other is allowed, and
 *   none is unknown: the country alone cannot tell Kyiv from Crimea. Cloudflare sends the region
 *   without its country (`43`); `UA-43` reads the same.
 * - Everything else is allowed. Only Ukraine's answer carries a regionCode.
 */
export function regionVerdictFor(country: string | null | undefined, regionCode?: string | null): ClaudeRegionResult {
  const code = (country ?? '').trim().toUpperCase();
  const name = /^[A-Z]{2}$/.test(code) ? CLAUDE_REGION_NAMES[code] : undefined;
  if (!name) return UNKNOWN;
  if (!SUPPORTED.has(code)) return { verdict: 'blocked', country: code, regionCode: null, name };
  if (!SPLIT_BY_REGION.has(code)) return { verdict: 'allowed', country: code, regionCode: null, name };
  const region = subdivisionOf(code, regionCode);
  if (!region) return UNKNOWN;
  const excluded = EXCLUDED.get(region);
  return excluded
    ? { verdict: 'blocked', country: code, regionCode: region, name: excluded }
    : { verdict: 'allowed', country: code, regionCode: region, name };
}

/** cf-region-code as a full ISO 3166-2 code under `country`, or null when there is none to read. */
function subdivisionOf(country: string, regionCode: string | null | undefined): string | null {
  const raw = (regionCode ?? '').trim().toUpperCase();
  const code = raw.startsWith(`${country}-`) ? raw : `${country}-${raw}`;
  return /^[A-Z]{2}-[A-Z0-9]{1,3}$/.test(code) ? code : null;
}

/**
 * Whether a runner's Anthropic-bound Claude turns are gated now (owner decision ③, contract §5):
 * blocked only while the stored verdict is blocked and was decided less than
 * CLAUDE_REGION_CARRY_OVER_MS ago. Everything else is allowed: no row, an allowed row, a blocked row
 * gone stale. Pass null for a runner that does not declare claude-region/v1, which is never gated.
 */
export function effectiveRegionVerdict(
  region: Pick<RunnerRegion, 'verdict' | 'decidedAt'> | null | undefined,
  now: Date,
): ClaudeRegionDecidedVerdict {
  if (region?.verdict !== 'blocked') return 'allowed';
  return now.getTime() - Date.parse(region.decidedAt) < CLAUDE_REGION_CARRY_OVER_MS ? 'blocked' : 'allowed';
}

/** The preset slug of an Anthropic API key (providerPresets.ts). */
const ANTHROPIC_PRESET = 'anthropic';

// The WHATWG URL parser every runtime this package runs on provides (Node, browsers); the package
// compiles against ES2022 alone, which does not declare it.
declare const URL: new (url: string) => { hostname: string };

/** What credentialIsAnthropicBound reads of a credential. An EngineCredential (providerEngines.ts) is
 *  one; so is a web picker row, which knows a key's preset but not its endpoint. */
export type AnthropicBoundCredential =
  | { kind: 'login' | 'pool'; engine: string }
  | { kind: 'key'; presetSlug: string | null; baseUrl?: string | null }
  | { kind: 'opencode' };

/**
 * Whether a credential talks to Anthropic (owner decision ①, contract §8): Claude Code's own sign-in,
 * a Claude pool, or a key whose preset is Anthropic's or whose base URL is on anthropic.com. A
 * DeepSeek, Moonshot or local vLLM key is not, even under Claude Code; nor is another engine's sign-in
 * or pool, or OpenCode's own configuration. Only Claude Code sessions are gated (decision ⑥), so the
 * caller checks the engine as well. The runner answers the same question from the environment.
 */
export function credentialIsAnthropicBound(credential: AnthropicBoundCredential): boolean {
  switch (credential.kind) {
    case 'login':
    case 'pool':
      return credential.engine === AgentProvider.CLAUDE;
    case 'key':
      return credential.presetSlug === ANTHROPIC_PRESET || isAnthropicHost(credential.baseUrl);
    case 'opencode':
      return false;
  }
}

/** Whether a base URL's host is anthropic.com or a name under it (api.anthropic.com), compared
 *  without case or a trailing dot. A look-alike such as anthropic.com.example is not. */
function isAnthropicHost(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false;
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return false;
  }
  return host === 'anthropic.com' || host.endsWith('.anthropic.com');
}

/**
 * `session.error` for an Anthropic-bound Claude turn refused for the region (contract §9): the code,
 * then board 04's sentence. `machine` is the runner's name, `region` the decided name
 * (RunnerRegion.name). A client reads the place from runner.region, never from this sentence.
 */
export function claudeRegionRefusedError(machine: string, region: string): string {
  return `${CLAUDE_REGION_UNSUPPORTED}: ${machine}’s connection to Anthropic is in ${region}, where Anthropic doesn’t offer Claude.`;
}

/** `session.error` for a running turn stopped after a confirmed flip (owner decision ④, contract §10):
 *  the code, then board 04's "stopped" sentence. */
export function claudeRegionStoppedError(machine: string, region: string): string {
  return `${CLAUDE_REGION_UNSUPPORTED}: Claude Code stopped on ${machine}: its connection to Anthropic is now in ${region}, where Anthropic doesn’t offer Claude.`;
}
