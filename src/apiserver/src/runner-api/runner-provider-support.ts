import { AgentProvider } from '@orbit/shared';

export const OPENCODE_RUNNER_UPGRADE_ERROR = 'OpenCode requires Orbit runner 0.1.82 or newer; update this runner first';

/**
 * SR35's refusal, as the sentence a person reads on the stalled session.
 *
 * The code leads the message on purpose: `SOURCE_PROTOCOL_UNSUPPORTED` is one of §10.1's ten frozen
 * codes and this is the only place it becomes visible, because it is the one code that must NOT be
 * written to `session.source_refusal_code` — a row that both says "refused because X" and is still
 * queued for dispatch would be the state machine holding two answers at once (§6.1 T4/T8 and
 * migration 0175's `session_source_refusal_chk`). The session stays SELECTED and keeps waiting: a
 * newer runner coming online is all it takes, which is not what a configuration error looks like.
 */
export const SOURCE_PROTOCOL_UNSUPPORTED_ERROR =
  'SOURCE_PROTOCOL_UNSUPPORTED: this task starts from a pinned project commit, which needs a runner ' +
  'that supports source-pin/v1; update this runner first';

/** Parse the positive capability advertisement added to claim/reclaim in runner 0.1.82. */
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
