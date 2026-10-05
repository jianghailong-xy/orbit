import type { RunnerEngineHealth } from '@orbit/shared';

/**
 * What the clients need to know about DeepSeek Harness (`dsh`) that no other engine shares.
 *
 * Harness has no sign-in on the runner: its credential is a configured provider's API key
 * (the `deepseek-harness` preset, runtime `dsh`), handed to the session at dispatch. So a runner
 * can only be asked whether it can START Harness — it declares `provider:dsh`, and its engine
 * report says the pinned CLI is installed on a platform it admits — never whether a key works:
 * the handshake and the model catalogue do not validate one (docs/deepseek-harness-runtime-
 * environment.md, "目录与健康状态"). An invalid key surfaces in the session that used it.
 *
 * The existing `deepseek` preset is a different thing: an Anthropic-compatible endpoint driven by
 * Claude Code. Nothing here applies to it.
 */

/** The preset a Harness API key is connected from. */
export const DSH_PRESET_SLUG = 'deepseek-harness';
/** Where that key is connected. */
export const DSH_CONNECT_HREF = `/providers/new/${DSH_PRESET_SLUG}`;
/** The heartbeat capability the server requires before it creates, resumes or hands out a dsh
 *  session (sessions.service, queue.service). */
export const DSH_RUNNER_CAPABILITY = 'provider:dsh';

/** Why a runner can't start Harness, most fundamental first, or `ready`. */
export type DshRunnerState =
  | 'ready'
  | 'updateRunner'
  | 'unsupportedPlatform'
  | 'notInstalled'
  | 'unsupportedVersion';

export interface DshRunnerFacts {
  capabilities?: readonly string[] | null;
  engines?: RunnerEngineHealth[] | null;
}

/**
 * Whether this runner can start a Harness session. The capability is the server's own gate, so a
 * runner that doesn't declare it is `updateRunner` whatever else it reports. With it, the engine
 * report decides; a runner that declared Harness but hasn't reported its engines yet claims
 * nothing, and stays `ready` — the session itself will say if it can't start.
 */
export function dshRunnerState(runner: DshRunnerFacts | null | undefined): DshRunnerState {
  if (!runner?.capabilities?.includes(DSH_RUNNER_CAPABILITY)) return 'updateRunner';
  const health = runner.engines?.find((engine) => engine.engine === 'dsh');
  if (!health) return 'ready';
  if (/^DSH_(PLATFORM|NODE)_UNSUPPORTED/.test(health.installationError ?? '')) return 'unsupportedPlatform';
  if (!health.installed) return 'notInstalled';
  if (health.dsh && !health.dsh.versionCompatible) return 'unsupportedVersion';
  return 'ready';
}

/** The words a picker row or a runner line uses for a state that blocks a session. */
export const DSH_STATE_LABEL: Record<Exclude<DshRunnerState, 'ready'>, string> = {
  updateRunner: 'Update runner',
  unsupportedPlatform: 'Not supported here',
  notInstalled: 'Not installed',
  unsupportedVersion: 'Unsupported version',
};

/** One sentence on what to do about it. */
export const DSH_STATE_HINT: Record<Exclude<DshRunnerState, 'ready'>, string> = {
  updateRunner: 'This runner predates DeepSeek Harness. It updates itself when no session is running on it.',
  unsupportedPlatform: 'DeepSeek Harness 0.2.0-rc.2 runs on Linux x64 runners with Node 26 only.',
  notInstalled: 'Install DeepSeek Harness on this runner from Providers.',
  unsupportedVersion: 'This runner has a DeepSeek Harness version Orbit does not support. Reinstall it from Providers.',
};

/** What went wrong in a Harness session, when the runner's message says so. */
export type DshRepair = 'needsKey' | 'invalidKey' | 'updateRunner' | 'notInstalled' | 'unsupportedPlatform';

/**
 * Read a runner or server message about a Harness session for the remedy it implies. The fixed
 * `DSH_*` codes come from the runner (dsh_environment.go, dsh_install.go); the key-rejection
 * phrases are the same evidence the runner's own dshRequestValidation accepts as "invalid" —
 * anything vaguer (a rate limit, a 5xx) is not treated as a bad key.
 */
export function dshRepair(message: string | null | undefined): DshRepair | null {
  const text = message ?? '';
  if (text.includes('DSH_CREDENTIAL_MISSING')) return 'needsKey';
  if (text.includes('DSH_CREDENTIAL_INVALID')) return 'invalidKey';
  if (text.startsWith('DeepSeek Harness requires a newer Orbit runner')) return 'updateRunner';
  if (text.includes('DSH_NOT_INSTALLED')) return 'notInstalled';
  if (/DSH_(PLATFORM|NODE)_UNSUPPORTED/.test(text)) return 'unsupportedPlatform';
  const lower = text.toLowerCase();
  if (!lower.startsWith('dsh ')) return null;
  if (lower.includes('no api key') || lower.includes('missing api key')) return 'needsKey';
  if (
    ['invalid api key', 'api key is invalid', 'authentication_error', 'unauthorized', 'status 401', 'status code 401', 'http 401', 'revoked api key', 'api key has been revoked', 'invalid credentials'].some(
      (evidence) => lower.includes(evidence),
    )
  ) {
    return 'invalidKey';
  }
  return null;
}
