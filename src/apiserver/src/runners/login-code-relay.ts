import { relayPeers, type RelayPeers } from './relay-peers';

/** What one process asks another of the code it holds (relay-peers.ts): hand it over, or drop it. */
const TAKE_LOGIN_CODE = 'take-login-code';
const DROP_LOGIN_CODE = 'drop-login-code';

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
 * SEVERAL PROCESSES. Over the runner link the gateway hands a runner's heartbeats to any apiserver
 * process, while the paste reached one of them. The process that holds a code says so to the others
 * (relay-peers.ts) — the runner and the attempt, never the code — and a link heartbeat that reaches
 * another process takes it from the holder (takeAnywhere): over NATS, in the one reply that hands it
 * over, for the attempt that heartbeat read and no other. A reply that comes after the heartbeat
 * stopped waiting makes the process that asked the holder, for what is left of the code's time. Every
 * process forgets its code when the sign-in settles wherever that is heard (drop). Never through the
 * database, the only other channel the processes share. codex-login.service.ts keeps its device
 * sign-in to one process: only a person's requests reach it, and those reach the main process.
 */
export class LoginCodeRelay {
  private readonly held = new Map<string, { attempt: string; code: string; expiresAt: number; timer: ReturnType<typeof setTimeout> }>();

  /** `peers` reach the other apiserver processes (relayPeers); without them this process's code is its own alone. */
  constructor(private readonly peers?: RelayPeers) {
    // Handed over only for the attempt the asking heartbeat read. One that names another is left alone: that
    // process may have read the row before this sign-in started.
    peers?.serve(TAKE_LOGIN_CODE, (request) => {
      const entry = this.held.get(request.runnerId);
      if (!entry || entry.attempt !== request.attempt) return {};
      this.forget(request.runnerId);
      return { code: entry.code, ttlMs: entry.expiresAt - Date.now() };
    });
    peers?.serve(DROP_LOGIN_CODE, (request) => {
      this.forget(request.runnerId, typeof request.attempt === 'string' ? request.attempt : undefined);
      return {};
    });
  }

  /** Hold `code` for this runner's sign-in `attempt` until `expiresAt` (epoch ms), replacing any
   *  code still held for the runner, here or in another process. One past its time is not held at all. */
  hold(runnerId: string, attempt: string, code: string, expiresAt: number): void {
    this.drop(runnerId);
    const ttl = expiresAt - Date.now();
    if (ttl <= 0) return;
    const timer = setTimeout(() => this.forget(runnerId, attempt), ttl);
    // Never what keeps the process alive.
    timer.unref?.();
    this.held.set(runnerId, { attempt, code, expiresAt, timer });
    this.peers?.hold('login-code', runnerId, attempt, ttl);
  }

  /** The code held for this runner's `attempt`, handed over once: it is gone from here when this
   *  returns. A code held for any other attempt is dropped — it can never be this one's. */
  take(runnerId: string, attempt: string): string | undefined {
    const entry = this.held.get(runnerId);
    if (!entry) return undefined;
    this.forget(runnerId);
    return entry.attempt === attempt ? entry.code : undefined;
  }

  /**
   * take, here or from the process that said it holds the code for this runner's `attempt`: a link
   * heartbeat's, which any process may answer. It waits for that process for a second at most
   * (RelayPeers.ask), and answers nothing rather than fail; the code that process handed over after
   * that is held here, said to be, and the runner told to beat again (adopt).
   */
  async takeAnywhere(runnerId: string, attempt: string): Promise<string | undefined> {
    const here = this.take(runnerId, attempt);
    const peers = this.peers;
    if (here !== undefined || !peers) return here;
    const holders = peers.holders('login-code', runnerId).filter((holder) => holder.items.includes(attempt));
    const answers = await Promise.all(
      holders.map((holder) =>
        peers.ask(holder.instance, { type: TAKE_LOGIN_CODE, runnerId, attempt }, (late) => this.adopt(runnerId, attempt, late)),
      ),
    );
    for (const answer of answers) {
      if (typeof answer?.code === 'string' && answer.code !== '') return answer.code;
    }
    return undefined;
  }

  /** Forget the code held for this runner — only if it is for `attempt`, when one is named — here and
   *  in every process that said it holds one. */
  drop(runnerId: string, attempt?: string): void {
    this.forget(runnerId, attempt);
    const peers = this.peers;
    if (!peers) return;
    for (const holder of peers.holders('login-code', runnerId)) {
      peers.tell(holder.instance, { type: DROP_LOGIN_CODE, runnerId, ...(attempt !== undefined ? { attempt } : {}) });
    }
  }

  /** Whether a code is waiting for this runner here — never which one. */
  holds(runnerId: string): boolean {
    return this.held.has(runnerId);
  }

  /** A code another process handed over after the heartbeat that asked had stopped waiting: held here for
   *  what is left of its time, and the runner has its next heartbeat now. */
  private adopt(runnerId: string, attempt: string, answer: Record<string, unknown>): void {
    const ttl = Number(answer.ttlMs);
    if (typeof answer.code !== 'string' || answer.code === '' || !(ttl > 0)) return;
    this.hold(runnerId, attempt, answer.code, Date.now() + ttl);
    this.peers?.nudge(runnerId);
  }

  /** Forget the code held here for this runner — only if it is for `attempt`, when one is named. */
  private forget(runnerId: string, attempt?: string): void {
    const entry = this.held.get(runnerId);
    if (!entry || (attempt !== undefined && entry.attempt !== attempt)) return;
    clearTimeout(entry.timer);
    this.held.delete(runnerId);
    this.peers?.release('login-code', runnerId, entry.attempt);
  }
}

/** This process's relay: the sign-in routes put a code in (RunnersService.submitLoginCode), the
 *  runner's heartbeat takes it out (RunnerApiController.drainLoginRequest), from whichever process
 *  holds it when the gateway forwarded the beat. */
export const loginCodeRelay = new LoginCodeRelay(relayPeers);
