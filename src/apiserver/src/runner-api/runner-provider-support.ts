import { AgentProvider } from '@orbit/shared';

export const OPENCODE_RUNNER_UPGRADE_ERROR = 'OpenCode requires Orbit runner 0.1.82 or newer; update this runner first';

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
