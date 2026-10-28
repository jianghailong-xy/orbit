import { randomBytes } from 'node:crypto';
import {
  AgentProvider,
  CURSOR_KEY_CHECK_STATES,
  type CursorKeyCheckCommand,
  type CursorKeyCheckState,
} from '@orbit/shared';
import { sanitizeRunnerEngines } from '../common/runner-engines';
import { relayPeers, type RelayPeers } from '../runners/relay-peers';
import { runnerIsOnline, runnerLastBeatAt, type RunnerBeats } from '../runners/runner-presence';
import { keyFingerprint } from './provider-engine-resolution';

/** What one process asks another of the checks it holds (runners/relay-peers.ts): hand their keys over, or take an
 *  answer to one. */
const TAKE_CURSOR_KEY_CHECKS = 'take-cursor-key-checks';
const ANSWER_CURSOR_KEY_CHECK = 'answer-cursor-key-check';

/**
 * A Cursor API key checked on a runner while somebody waits for the answer — the key typed into the
 * connect form (POST /providers/test), or a saved one checked again — and held in this process's memory
 * the whole way, the way login-code-relay.ts holds Antigravity's pasted code.
 *
 * The server never uses a Cursor key itself. Only Cursor CLI tells a key Cursor refuses from a Cursor API
 * it cannot reach, by `agent models` (docs/cursor-runtime-contract.md §9), so the check goes to a runner of
 * the key's owner that can ask (cursorKeyCheckers): online, the pinned Cursor CLI installed, and a release
 * that declares cursor-key-check/v1. The runner is woken to heartbeat now (RealtimeService.notifyRunnerWake);
 * that heartbeat, from a process that declares the capability, takes the key, once (take); the runner asks
 * `agent models` in a throwaway home with the key in memory and answers by POST
 * /runner/cursor-key-check-result with what Cursor said and the key's fingerprint, never the key (answer).
 *
 * The key is held from the ask until a heartbeat takes it, and then forgotten: the answer names the key by
 * its fingerprint, which is all that is kept until it comes. Nothing writes the key down — no row, no log
 * line, no event — and nothing here puts it in an error.
 *
 * SEVERAL PROCESSES, as LoginCodeRelay. The person's request reached one apiserver process, and over the
 * runner link the gateway hands the runner's heartbeat and its answer to any of them. The process that asked
 * says so to the others (runners/relay-peers.ts) — the runner and the check's id, never the key — until the
 * check settles. A link heartbeat that reaches another process takes the key from it (takeAnywhere), over
 * NATS, in the one reply that hands it over, for the check ids it was told of and no other; an answer that
 * reaches another process is taken to it (answerAnywhere), which settles the check as if the answer had come
 * here. A key handed over after the heartbeat that asked stopped waiting is held by the process that asked,
 * for what is left of the wait, and handed on from there. Never through the database, the one channel the
 * processes share besides.
 */

/** What a runner declares before it is handed a Cursor key to check. */
export const CURSOR_KEY_CHECK_V1 = 'cursor-key-check/v1';

/** How long a person waits for a runner's answer: its heartbeat, at once on the wake; `agent models`, about
 *  2–4 s, which the runner gives up on at 15 s (cursorKeyCheckTimeout, cursor_key_check.go); and the POST of
 *  the answer. */
export const CURSOR_KEY_CHECK_WAIT_MS = 25_000;

/** How many keys one runner is asked to check at once: each is a Cursor CLI process on that machine. */
export const CURSOR_KEY_CHECKS_PER_RUNNER = 4;

/** What cursorKeyCheckers reads of a runner: its liveness as runners/runner-presence.ts reads it, too. */
export interface CursorKeyCheckerRow extends RunnerBeats {
  id: string;
  status: string;
  capabilities: string[] | null;
  capabilitiesReportedAt: Date | null;
  engines: unknown;
}

/**
 * The runners that can check a Cursor key now, the most recently heard from first: online, declaring
 * cursor-key-check/v1 in the capabilities their heartbeat persisted, with the pinned Cursor CLI installed —
 * an engine report naming no installationError, which is how a runner says the build it has is not the
 * pinned one, or is one it cannot run here (cursor_health.go). A runner with no report of Cursor CLI
 * cannot tell, and is not asked.
 */
export function cursorKeyCheckers<T extends CursorKeyCheckerRow>(runners: readonly T[], now = Date.now()): T[] {
  return runners
    .filter((runner) => {
      // The runners list's rule: not marked offline, and heard from within three heartbeats.
      if (!runnerIsOnline(runner, now)) return false;
      if (!runner.capabilitiesReportedAt || !(runner.capabilities ?? []).includes(CURSOR_KEY_CHECK_V1)) return false;
      const cursor = sanitizeRunnerEngines(runner.engines)?.find((engine) => engine.engine === AgentProvider.CURSOR);
      return !!cursor?.installed && !cursor.installationError;
    })
    .sort((a, b) => (runnerLastBeatAt(b)?.getTime() ?? 0) - (runnerLastBeatAt(a)?.getTime() ?? 0));
}

interface HeldCheck {
  runnerId: string;
  /** The key, until a heartbeat takes it. */
  apiKey: string | null;
  /** The key's fingerprint, which the answer has to name. */
  fingerprint: string;
  /** When the wait for its answer ends (epoch ms). */
  until: number;
  /** Settles the wait: null for a key another process handed over late, which is only handed on from here (adopt). */
  settle: ((state: CursorKeyCheckState | null) => void) | null;
}

export class CursorKeyCheckRelay {
  /** How long ask() waits for an answer. */
  waitMs = CURSOR_KEY_CHECK_WAIT_MS;
  private readonly held = new Map<string, HeldCheck>();
  /** The timers of the keys handed on from here (adopt); a check this process waits on keeps its own in `settle`. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** `peers` reach the other apiserver processes (relayPeers); without them this process's checks are its own alone. */
  constructor(private readonly peers?: RelayPeers) {
    peers?.serve(TAKE_CURSOR_KEY_CHECKS, (request) => ({
      checks: this.handOver(request.runnerId, Array.isArray(request.checkIds) ? request.checkIds : []),
    }));
    peers?.serve(ANSWER_CURSOR_KEY_CHECK, (request) => ({
      accepted: this.answer(request.runnerId, {
        checkId: String(request.checkId ?? ''),
        state: String(request.state ?? ''),
        keyFingerprint: String(request.keyFingerprint ?? ''),
      }),
    }));
  }

  /** Whether this runner may be asked one more check. */
  hasRoom(runnerId: string): boolean {
    let asked = 0;
    for (const check of this.held.values()) if (check.runnerId === runnerId) asked++;
    return asked < CURSOR_KEY_CHECKS_PER_RUNNER;
  }

  /** Hold `apiKey` for this runner's next heartbeat, and wait for its answer: what Cursor said of the key,
   *  or null when none came within waitMs. */
  ask(runnerId: string, apiKey: string): Promise<CursorKeyCheckState | null> {
    const checkId = randomBytes(16).toString('hex');
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(checkId, null), this.waitMs);
      // Never what keeps the process alive.
      timer.unref?.();
      this.held.set(checkId, {
        runnerId,
        apiKey,
        fingerprint: keyFingerprint(apiKey),
        until: Date.now() + this.waitMs,
        settle: (state) => {
          clearTimeout(timer);
          resolve(state);
        },
      });
      this.peers?.hold('cursor-key-check', runnerId, checkId, this.waitMs);
    });
  }

  /** The checks held for this runner that no heartbeat has taken yet, each handed over once: their keys
   *  are gone from here when this returns. */
  take(runnerId: string): CursorKeyCheckCommand[] {
    return this.handOver(runnerId).map(({ checkId, apiKey }) => ({ checkId, apiKey }));
  }

  /**
   * take, here and from every process that said it holds a check for this runner: a link heartbeat's, which
   * any process may answer. Each is asked for the check ids it named, waited for a second at most
   * (RelayPeers.ask), and nothing rather than a failure when it does not answer; the keys one hands over
   * after that are held here and handed on (adopt).
   */
  async takeAnywhere(runnerId: string): Promise<CursorKeyCheckCommand[]> {
    const commands = this.take(runnerId);
    const peers = this.peers;
    if (!peers) return commands;
    const answers = await Promise.all(
      peers.holders('cursor-key-check', runnerId).map((holder) =>
        peers.ask(holder.instance, { type: TAKE_CURSOR_KEY_CHECKS, runnerId, checkIds: holder.items }, (late) =>
          this.adopt(runnerId, late),
        ),
      ),
    );
    for (const answer of answers) {
      for (const check of handedOver(answer)) commands.push({ checkId: check.checkId, apiKey: check.apiKey });
    }
    return commands;
  }

  /** A runner's answer to a check: settles it, once, when the check is still waited on, was handed to this
   *  runner and is about the key it names by fingerprint. Whether it did. */
  answer(runnerId: string, result: { checkId: string; state: string; keyFingerprint: string }): boolean {
    const check = this.held.get(result.checkId);
    if (!check?.settle || check.runnerId !== runnerId || check.apiKey !== null || check.fingerprint !== result.keyFingerprint) {
      return false;
    }
    if (!CURSOR_KEY_CHECK_STATES.includes(result.state as CursorKeyCheckState)) return false;
    this.settle(result.checkId, result.state as CursorKeyCheckState);
    return true;
  }

  /** answer, here or in the process that said it waits on this check: a runner's answer, which the gateway may
   *  have forwarded to any process. Whether it settled the check. */
  async answerAnywhere(runnerId: string, result: { checkId: string; state: string; keyFingerprint: string }): Promise<boolean> {
    if (this.answer(runnerId, result)) return true;
    const peers = this.peers;
    if (!peers) return false;
    const answers = await Promise.all(
      peers
        .holders('cursor-key-check', runnerId)
        .filter((holder) => holder.items.includes(result.checkId))
        .map((holder) =>
          peers.ask(holder.instance, {
            type: ANSWER_CURSOR_KEY_CHECK,
            runnerId,
            checkId: result.checkId,
            state: result.state,
            keyFingerprint: result.keyFingerprint,
          }),
        ),
    );
    return answers.some((answer) => answer?.accepted === true);
  }

  /** The untaken checks held for this runner — of these ids, when named — with what is left of their wait, each
   *  handed over once. A check this process waits on keeps its fingerprint for the answer; one it only handed on goes. */
  private handOver(runnerId: string, only?: readonly unknown[]): Array<CursorKeyCheckCommand & { ttlMs: number }> {
    const out: Array<CursorKeyCheckCommand & { ttlMs: number }> = [];
    const now = Date.now();
    for (const [checkId, check] of this.held) {
      if (check.runnerId !== runnerId || check.apiKey === null || (only && !only.includes(checkId))) continue;
      out.push({ checkId, apiKey: check.apiKey, ttlMs: check.until - now });
      check.apiKey = null;
      if (!check.settle) this.settle(checkId, null);
    }
    return out;
  }

  /** Keys another process handed over after the heartbeat that asked had stopped waiting: held here for what is left
   *  of their wait, said to be, and the runner has its next heartbeat now. Their answers settle where they were asked. */
  private adopt(runnerId: string, answer: Record<string, unknown>): void {
    let adopted = false;
    for (const check of handedOver(answer)) {
      if (!(check.ttlMs > 0) || this.held.has(check.checkId)) continue;
      const timer = setTimeout(() => this.settle(check.checkId, null), check.ttlMs);
      timer.unref?.();
      this.held.set(check.checkId, {
        runnerId,
        apiKey: check.apiKey,
        fingerprint: keyFingerprint(check.apiKey),
        until: Date.now() + check.ttlMs,
        settle: null,
      });
      this.timers.set(check.checkId, timer);
      this.peers?.hold('cursor-key-check', runnerId, check.checkId, check.ttlMs);
      adopted = true;
    }
    if (adopted) this.peers?.nudge(runnerId);
  }

  private settle(checkId: string, state: CursorKeyCheckState | null): void {
    const check = this.held.get(checkId);
    if (!check) return;
    this.held.delete(checkId);
    const timer = this.timers.get(checkId);
    if (timer) clearTimeout(timer);
    this.timers.delete(checkId);
    this.peers?.release('cursor-key-check', check.runnerId, checkId);
    check.settle?.(state);
  }
}

/** The checks one process handed over (the answer to TAKE_CURSOR_KEY_CHECKS), each as it must read. */
function handedOver(answer: Record<string, unknown> | null): Array<CursorKeyCheckCommand & { ttlMs: number }> {
  const checks = Array.isArray(answer?.checks) ? (answer.checks as unknown[]) : [];
  return checks.flatMap((check) => {
    const c = check as Record<string, unknown> | null;
    return c && typeof c.checkId === 'string' && typeof c.apiKey === 'string' && c.apiKey !== ''
      ? [{ checkId: c.checkId, apiKey: c.apiKey, ttlMs: Number(c.ttlMs) || 0 }]
      : [];
  });
}

/** This process's relay: ProvidersService asks, the runner's heartbeat takes (RunnerApiController), and
 *  its answer settles (RunnerProvidersController), whichever process the gateway forwarded them to. */
export const cursorKeyCheckRelay = new CursorKeyCheckRelay(relayPeers);
