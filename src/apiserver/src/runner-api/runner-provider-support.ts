import { AgentProvider } from '@orbit/shared';

export const OPENCODE_RUNNER_UPGRADE_ERROR = 'OpenCode requires Orbit runner 0.1.82 or newer; update this runner first';

/** Names no version on purpose: which release first advertises `antigravity` is not known here
 *  until it ships, and a guessed number would send someone to install the wrong one. */
export const ANTIGRAVITY_RUNNER_UPGRADE_ERROR =
  'Antigravity requires a newer Orbit runner; update this runner first';

export const DSH_RUNNER_UPGRADE_ERROR =
  'DeepSeek Harness requires a newer Orbit runner with dsh support; update this runner first';

export const PROVIDER_UNAVAILABLE_ERROR = 'Provider is unavailable; check its configuration';

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

/** The heartbeat replaces this snapshot, including when either header is omitted. */
export function withProviderDeclarations(capabilities: readonly string[], providerHeader?: string): string[] {
  return [
    ...capabilities.filter((capability) => !capability.startsWith('provider:')),
    ...advertisedRunnerProviders(providerHeader).map((provider) => `provider:${provider}`),
  ];
}
