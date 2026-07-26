// How the Providers page sees a model credential.
//
// There are two kinds and they are the same kind of thing: a local login (the Claude Code / Codex
// CLI signed in on a runner) and an API key (a ModelProvider row). Both answer "which models can
// I run, and on whose bill" — they differ in where the secret lives, and therefore in reach:
//
//   an API key is per-user   → configured once, usable on every runner
//   a local login is per-runner → signed in on one machine, invisible to the others
//
// That reach difference is the whole reason this file exists. Nothing else in the product tells
// you that the agent you just pointed at your second runner has no Claude subscription behind it,
// because the credential isn't in our database — it's on that machine's disk, and only the
// heartbeat's engine report makes it visible here.

import { PROVIDER_PRESETS } from '@orbit/shared';
import type { ProviderRow } from './providerAdmin';

/** One engine CLI as a runner reported it (mirrors @orbit/shared EngineStatus). */
export interface RunnerEngine {
  provider: string;
  installed: boolean;
  version?: string;
  auth: 'yes' | 'no' | 'unknown';
  onServicePath: boolean;
}

/** The bits of GET /runners this file reads. */
export interface RunnerLike {
  id: string;
  name: string;
  displayName?: string | null;
  status?: string;
  /** Absent/null on a runner too old to report, or one still doing its first probe. */
  engines?: RunnerEngine[] | null;
}

/**
 * A local login's state on one machine. `notReported` is deliberately not folded into
 * `missing`: "this runner has never told us" and "this runner says the CLI isn't there" lead to
 * different advice, and guessing wrong sends someone to install something they already have.
 */
export type LocalLoginState = 'signedIn' | 'signedOut' | 'unknown' | 'missing' | 'notReported';

export interface LocalLoginOnRunner {
  runnerId: string;
  runnerName: string;
  state: LocalLoginState;
  version?: string;
  /** Installed and signed in, but not on the background service's PATH — it works when you try
   *  it by hand and fails under the runner, which is the confusing one. */
  pathWarning: boolean;
}

export interface LocalLogin {
  /** The built-in provider slug an agent stores: 'claude' | 'codex'. */
  provider: string;
  label: string;
  /** How to fix a signed-out engine, and the headless form for an unattended service. */
  loginCmd: string;
  headlessCmd: string;
  runners: LocalLoginOnRunner[];
  signedIn: number;
}

/** One vendor and every way the user can reach it. */
export interface VendorGroup {
  key: string;
  label: string;
  /** Preset slug the logo tile is drawn from. */
  logoSlug: string;
  /** Present only for the two vendors whose CLI can hold a subscription login. */
  localLogin?: LocalLogin;
  apiKeys: ProviderRow[];
}

// The two engines that can carry a local login, each mapped to the vendor whose API keys belong
// in the same group. Commands mirror runner-go's engineSpecs (doctor.go) — the runner is the one
// that runs them; this copy only has to render.
const LOCAL_LOGIN_ENGINES = [
  {
    provider: 'claude',
    label: 'Claude Code',
    vendor: 'anthropic',
    loginCmd: 'claude auth login',
    headlessCmd: 'claude setup-token',
  },
  {
    provider: 'codex',
    label: 'Codex',
    vendor: 'openai',
    loginCmd: 'codex login',
    headlessCmd: 'set OPENAI_API_KEY in the service env',
  },
];

function stateOf(engine: RunnerEngine | undefined, reported: boolean): LocalLoginState {
  if (!reported || !engine) return 'notReported';
  if (!engine.installed) return 'missing';
  if (engine.auth === 'yes') return 'signedIn';
  if (engine.auth === 'no') return 'signedOut';
  return 'unknown';
}

/**
 * Group every credential the user has by vendor: the local logins their runners report, plus the
 * API keys they've configured. Vendors with neither are left out — the gallery is what offers
 * those.
 *
 * Anthropic and OpenAI always appear once a runner exists, even with nothing signed in and no key:
 * "no Claude anywhere" is the single most useful thing this page can say, and it can only say it
 * by showing the row.
 */
export function vendorGroups(runners: RunnerLike[], providers: ProviderRow[]): VendorGroup[] {
  const groups: VendorGroup[] = [];

  for (const engine of LOCAL_LOGIN_ENGINES) {
    const onRunners: LocalLoginOnRunner[] = runners.map((r) => {
      const reported = Array.isArray(r.engines);
      const found = (r.engines ?? []).find((e) => e.provider === engine.provider);
      return {
        runnerId: r.id,
        runnerName: r.displayName || r.name,
        state: stateOf(found, reported),
        version: found?.version,
        pathWarning: !!found?.installed && !found.onServicePath,
      };
    });
    const preset = PROVIDER_PRESETS.find((p) => p.slug === engine.vendor);
    const apiKeys = providers.filter((p) => p.presetSlug === engine.vendor);
    if (!onRunners.length && !apiKeys.length) continue;
    groups.push({
      key: engine.vendor,
      label: preset?.label ?? engine.label,
      logoSlug: engine.vendor,
      localLogin: {
        provider: engine.provider,
        label: engine.label,
        loginCmd: engine.loginCmd,
        headlessCmd: engine.headlessCmd,
        runners: onRunners,
        signedIn: onRunners.filter((r) => r.state === 'signedIn').length,
      },
      apiKeys,
    });
  }

  // Every other vendor the user has a key for, in the order the API returned them.
  for (const p of providers) {
    const vendor = p.presetSlug ?? p.slug;
    if (LOCAL_LOGIN_ENGINES.some((e) => e.vendor === vendor)) continue;
    const existing = groups.find((g) => g.key === vendor);
    if (existing) {
      existing.apiKeys.push(p);
      continue;
    }
    groups.push({
      key: vendor,
      label: PROVIDER_PRESETS.find((x) => x.slug === vendor)?.label ?? p.label,
      logoSlug: vendor,
      apiKeys: [p],
    });
  }

  return groups;
}

/** The one-line reach summary under a local login — the fact the rest of the product hides. */
export function localLoginCoverage(login: LocalLogin): string {
  const total = login.runners.length;
  if (!total) return 'No runners enrolled';
  if (login.signedIn === total) return total === 1 ? 'Signed in on your runner' : `Signed in on all ${total} runners`;
  if (login.signedIn === 0) return `Not signed in on any of your ${total} runner${total > 1 ? 's' : ''}`;
  return `Signed in on ${login.signedIn} of ${total} runners`;
}
