import { LOGIN_BROWSER_STATES, LOGIN_FAILURE_REASONS, type LoginEngine, type RunnerLoginState } from '@orbit/shared';

// A module of its own so that the browser's routes (managed-runners/browser-state.ts) can answer with it without
// importing RunnersService, whose module the managed runners' own imports reach.

/** Project a runner row onto the browser-facing relay view (no code, ever). */
export function loginStateOf(r: {
  loginStatus: string | null;
  loginEngine: string | null;
  loginAccount?: string | null;
  loginUrl: string | null;
  loginUserCode: string | null;
  loginMessage: string | null;
  loginExpiresAt?: Date | null;
  loginReason?: string | null;
  loginBrowser?: string | null;
}): RunnerLoginState {
  // A cancel still owed to the runner (cancelLogin) is a sign-in the user has already dismissed.
  const status = r.loginStatus === 'cancelling' ? null : r.loginStatus;
  const waiting = status === 'awaiting_code' || status === 'awaiting_approval';
  const reason = LOGIN_FAILURE_REASONS.find((known) => known === r.loginReason);
  const browser = LOGIN_BROWSER_STATES.find((known) => known === r.loginBrowser);
  return {
    status: (status as RunnerLoginState['status']) ?? null,
    // A row written before the relay drove anything but claude carries no engine.
    engine: status ? ((r.loginEngine as LoginEngine) ?? 'claude') : null,
    userCode: r.loginUserCode,
    url: r.loginUrl,
    message: r.loginMessage,
    account: status ? (r.loginAccount ?? null) : null,
    // As the runner reported them (RunnerApiController.loginResult): how long the link lasts while one
    // is waiting, and why a sign-in failed when a client answers that differently.
    ...(waiting && r.loginExpiresAt ? { expiresAt: r.loginExpiresAt.toISOString() } : {}),
    ...(status === 'failed' && reason ? { reason } : {}),
    // The owner's Use the runner's browser on the link that is waiting, and what the runner did with it.
    ...(waiting && browser ? { browser } : {}),
  };
}
