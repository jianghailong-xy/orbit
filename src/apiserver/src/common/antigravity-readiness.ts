import type { AntigravityGoogleLogin, RunnerAntigravityState } from '@orbit/shared';
import { sanitizeRunnerEngines } from './runner-engines';
import { runnerOs } from './runner-platform';

/** Runner relays an Antigravity Google sign-in (src/runner-go/login.go). One that does not has no
 *  such sign-in at all, so a start would only ever come back failed. */
export const ANTIGRAVITY_GOOGLE_LOGIN_V1 = 'antigravity-google-login/v1';

/** The refusal for a runner that does not declare it, from the start and from the heartbeat alike. */
export const ANTIGRAVITY_GOOGLE_LOGIN_TOO_OLD =
  'This runner is too old to sign Antigravity in with Google — update it, then try again.';

/** The refusal for a runner on another platform: the runner's own words for it (login.go), so the
 *  card reads the same whichever side refused. */
export const ANTIGRAVITY_GOOGLE_LOGIN_LINUX_ONLY = 'Antigravity 的 Google 登录暂时只支持 Linux runner';

export function hasGeminiEnvKey(env: unknown): boolean {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return false;
  const key = (env as Record<string, unknown>).GEMINI_API_KEY;
  return typeof key === 'string' && key.trim() !== '';
}

/**
 * Whether Orbit can sign this runner's Antigravity into Google, from what its last heartbeat
 * declared: the relay itself, then the platform, which is Linux only for now (macOS keeps agy's
 * login in the system keychain). A runner that relays it but has not named its platform is let
 * through: it refuses a platform it cannot do on its own, and the relay reports that.
 */
export function antigravityGoogleLogin(runner: { capabilities?: readonly string[] }): AntigravityGoogleLogin {
  if (!runner.capabilities?.includes(ANTIGRAVITY_GOOGLE_LOGIN_V1)) return 'needs_update';
  const os = runnerOs(runner.capabilities);
  return os && os !== 'linux' ? 'unsupported_platform' : 'available';
}

/** An Antigravity sign-in still running on the machine: started, waiting for its code, or dismissed
 *  with its cancel not yet handed over (RunnersService.cancelLogin). */
export function antigravitySignInUnderWay(runner: { loginEngine?: string | null; loginStatus?: string | null }): boolean {
  return (
    runner.loginEngine === 'antigravity' &&
    (runner.loginStatus === 'pending' || runner.loginStatus === 'awaiting_code' || runner.loginStatus === 'cancelling')
  );
}

/** Why a Google sign-in is not started on this runner, in words for whoever asked — or null when
 *  it can be. */
export function antigravityGoogleLoginRefusal(runner: { capabilities?: readonly string[] }): string | null {
  switch (antigravityGoogleLogin(runner)) {
    case 'needs_update':
      return ANTIGRAVITY_GOOGLE_LOGIN_TOO_OLD;
    case 'unsupported_platform':
      return ANTIGRAVITY_GOOGLE_LOGIN_LINUX_ONLY;
    default:
      return null;
  }
}

/** Persisted provider declarations share Runner.capabilities with named protocol capabilities. */
export function antigravityState(runner: { capabilities?: readonly string[]; engines: unknown }): RunnerAntigravityState {
  const health = sanitizeRunnerEngines(runner.engines)?.find((entry) => entry.engine === 'antigravity');
  // A runner from before Google sign-in names no source, and the env key is all its yes can mean.
  const authSource = health?.authSource ?? (health?.auth === 'yes' ? 'env_key' : null);
  return {
    supported: runner.capabilities?.includes('provider:antigravity') ?? false,
    installed: health?.installed ?? null,
    version: health?.version ?? null,
    // A Google sign-in the probe could not read still counts: only a definite `no` takes it away,
    // as only a definite `no` refuses a session (signedOutEngineRefusal). So does any Google account
    // the runner added: a session can start on it (automaticAccount) whatever Default's says.
    envKeyAvailable:
      health?.auth === 'yes' ||
      (health?.auth === 'unknown' && authSource === 'google') ||
      (health?.accounts ?? []).some((account) => account.id !== 'default' && account.auth !== 'no'),
    authSource,
    googleLogin: antigravityGoogleLogin(runner),
  };
}
