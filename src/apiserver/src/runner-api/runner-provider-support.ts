import { AgentProvider } from '@orbit/shared';
import { sanitizeRunnerEngines } from '../common/runner-engines';

export const OPENCODE_RUNNER_UPGRADE_ERROR = 'OpenCode requires Orbit runner 0.1.82 or newer; update this runner first';

/** Names no version on purpose: which release first advertises `antigravity` is not known here
 *  until it ships, and a guessed number would send someone to install the wrong one. */
export const ANTIGRAVITY_RUNNER_UPGRADE_ERROR =
  'Antigravity requires a newer Orbit runner; update this runner first';

export const DSH_RUNNER_UPGRADE_ERROR =
  'DeepSeek Harness requires a newer Orbit runner with dsh support; update this runner first';

/**
 * Why a runner that declares dsh still cannot start it, by what its last engine report says. Each
 * leads with the runner's own `DSH_*` code, which the clients' repair reads (web `dshRepair`,
 * OrbitKit `DshRuntime.repair`); the remedy follows the clients' runner-state hints.
 */
export const DSH_NOT_INSTALLED_ERROR =
  'DSH_NOT_INSTALLED: DeepSeek Harness is not installed on this runner, or the runner has not reported it yet; ' +
  'install it from Infrastructure, then try again';
export const DSH_PLATFORM_UNSUPPORTED_ERROR =
  'DSH_PLATFORM_UNSUPPORTED: DeepSeek Harness 0.2.0-rc.2 runs on Linux x64 runners with Node 26 only; ' +
  'use a runner that can run it';
export const DSH_VERSION_INCOMPATIBLE_ERROR =
  'DSH_VERSION_INCOMPATIBLE: this runner has a DeepSeek Harness version Orbit does not support; ' +
  'reinstall it from Infrastructure, then try again';

export const PROVIDER_UNAVAILABLE_ERROR = 'Provider is unavailable; check its configuration';

/** What a member's session on a shared provider waits with (usableProviderScope): nothing about the
 *  provider's configuration is wrong, and only an admin can do something about it. */
export const ADMIN_ONLY_PROVIDER_ERROR =
  'This provider is available to admins only; ask an admin to add you to a shared pool';

/**
 * The built-in runtimes a runner is handed only once it advertises them, each with the sentence its
 * stalled sessions carry until then.
 *
 * Every runner released before a runtime existed reads a provider it does not know as Claude, so a
 * session on one of these, claimed by such a runner, would start `claude` on a conversation that
 * belongs to another CLI. Claude, Codex and Kimi are not here: they predate the advertisement, so
 * a header without them says nothing about them. The claim SQL (QueueService.trySessionClaim) and
 * the database triggers behind it (migrations 0080, 0367 and 0377) hold the same list. A session is on a
 * runtime by its slug or by the configured row it names — a Gemini key borrows Antigravity — so
 * each gate asks providerSlugsOn's question. The dsh discriminator preserves configured keyword
 * collisions; 0372 widened 0367's trigger and 0377 protects dsh claims and lease acquisition.
 */
export const ADVERTISED_RUNTIMES: ReadonlyArray<{
  provider: AgentProvider;
  upgradeError: string;
}> = [
  { provider: AgentProvider.OPENCODE, upgradeError: OPENCODE_RUNNER_UPGRADE_ERROR },
  { provider: AgentProvider.ANTIGRAVITY, upgradeError: ANTIGRAVITY_RUNNER_UPGRADE_ERROR },
  { provider: AgentProvider.DSH, upgradeError: DSH_RUNNER_UPGRADE_ERROR },
];

/**
 * SR35's refusal, as the sentence a person reads on the stalled session.
 *
 * The code leads the message on purpose: `SOURCE_PROTOCOL_UNSUPPORTED` is one of §10.1's ten frozen
 * codes and this is the only place it becomes visible, because it is the one code that must NOT be
 * written to `session.source_refusal_code` — a row that both says "refused because X" and is still
 * queued for dispatch would be the state machine holding two answers at once (§6.1 T4/T8 and
 * migration 0231's `session_source_refusal_chk`). The session stays SELECTED and keeps waiting: a
 * newer runner coming online is all it takes, which is not what a configuration error looks like.
 */
export const SOURCE_PROTOCOL_UNSUPPORTED_ERROR =
  'SOURCE_PROTOCOL_UNSUPPORTED: this task starts from a pinned project commit, which needs a runner ' +
  'that supports source-pin/v1; update this runner first';

/** Parse the positive capability advertisement added to claim/reclaim in runner 0.1.82 (which sent
 *  `claude,codex,opencode`; a runner that can drive agy adds `antigravity`). */
export function advertisedRunnerProviders(header?: string): AgentProvider[] {
  const advertised = new Set(
    (header ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  return Object.values(AgentProvider).filter((provider) => advertised.has(provider));
}

export function runnerAdvertisesProvider(header: string | undefined, provider: AgentProvider): boolean {
  return advertisedRunnerProviders(header).includes(provider);
}

/**
 * Whether a runner that declares dsh can start it now, from the engine report its last heartbeat
 * persisted (`runner.engines`): null when the pinned CLI is installed, its version confirmed, on a
 * platform the runner admits; otherwise the notice above that says why not.
 *
 * The declaration is protocol support and says nothing about the install, so without this a session
 * was claimed and failed at launch with the runner's DSH_NOT_INSTALLED. A missing report, or one
 * with no dsh entry, cannot tell, and is read as not installed rather than let through.
 */
export function dshRuntimeUnavailable(engines: unknown): string | null {
  const dsh = sanitizeRunnerEngines(engines)?.find((engine) => engine.engine === 'dsh');
  if (/^DSH_(PLATFORM|NODE)_UNSUPPORTED/.test(dsh?.installationError ?? '')) return DSH_PLATFORM_UNSUPPORTED_ERROR;
  if (!dsh?.installed) return DSH_NOT_INSTALLED_ERROR;
  if (dsh.installationError || dsh.dsh?.versionCompatible !== true) return DSH_VERSION_INCOMPATIBLE_ERROR;
  return null;
}

/** The heartbeat replaces this snapshot, including when either header is omitted. */
export function withProviderDeclarations(capabilities: readonly string[], providerHeader?: string): string[] {
  return [
    ...capabilities.filter((capability) => !capability.startsWith('provider:')),
    ...advertisedRunnerProviders(providerHeader).map((provider) => `provider:${provider}`),
  ];
}
