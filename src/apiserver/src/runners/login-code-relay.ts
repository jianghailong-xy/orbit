/**
 * Antigravity's pasted authorization code, between the browser that sends it and the heartbeat that
 * hands it to the runner — and nowhere else.
 *
 * It is never written down: not to `runner.login_code` (claude's relay, which keeps its code in the
 * row until the next heartbeat), not to a log, not into any response but that one heartbeat's
 * `loginRequest`. It lives in this process's memory, bound to the runner and to the sign-in it was
 * pasted for (the attempt: `login_at`), and goes as soon as anything settles that sign-in — handed
 * over (once), cancelled, replaced by another start, reported on by the runner, timed out.
 *
 * ONE PROCESS. A code held here is handed over only by a heartbeat that reaches this same process.
 * With several apiserver replicas behind a gateway that does not pin a runner to one of them, a code
 * pasted on one replica waits for a heartbeat that lands there, and is dropped when its sign-in times
 * out if none does: the price of never passing it through the database, which is the only channel
 * the replicas share. codex-login.service.ts keeps its device sign-in to one process the same way.
 */
export class LoginCodeRelay {
  private readonly held = new Map<string, { attempt: string; code: string; timer: ReturnType<typeof setTimeout> }>();

  /** Hold `code` for this runner's sign-in `attempt` until `expiresAt` (epoch ms), replacing any
   *  code still held for the runner. One past its time is not held at all. */
  hold(runnerId: string, attempt: string, code: string, expiresAt: number): void {
    this.drop(runnerId);
    const ttl = expiresAt - Date.now();
    if (ttl <= 0) return;
    const timer = setTimeout(() => this.drop(runnerId, attempt), ttl);
    // Never what keeps the process alive.
    timer.unref?.();
    this.held.set(runnerId, { attempt, code, timer });
  }

  /** The code held for this runner's `attempt`, handed over once: it is gone from here when this
   *  returns. A code held for any other attempt is dropped — it can never be this one's. */
  take(runnerId: string, attempt: string): string | undefined {
    const entry = this.held.get(runnerId);
    if (!entry) return undefined;
    this.drop(runnerId);
    return entry.attempt === attempt ? entry.code : undefined;
  }

  /** Forget the code held for this runner — only if it is for `attempt`, when one is named. */
  drop(runnerId: string, attempt?: string): void {
    const entry = this.held.get(runnerId);
    if (!entry || (attempt !== undefined && entry.attempt !== attempt)) return;
    clearTimeout(entry.timer);
    this.held.delete(runnerId);
  }

  /** Whether a code is waiting for this runner — never which one. */
  holds(runnerId: string): boolean {
    return this.held.has(runnerId);
  }
}

/** This process's relay: the sign-in routes put a code in (RunnersService.submitLoginCode), the
 *  runner's heartbeat takes it out (RunnerApiController.drainLoginRequest). */
export const loginCodeRelay = new LoginCodeRelay();
