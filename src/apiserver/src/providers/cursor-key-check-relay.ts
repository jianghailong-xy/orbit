import { randomBytes } from 'node:crypto';
import {
  AgentProvider,
  CURSOR_KEY_CHECK_STATES,
  type CursorKeyCheckCommand,
  type CursorKeyCheckState,
} from '@orbit/shared';
import { sanitizeRunnerEngines } from '../common/runner-engines';
import { runnerIsOnline, runnerLastBeatAt, type RunnerBeats } from '../runners/runner-presence';
import { keyFingerprint } from './provider-engine-resolution';

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
 * ONE PROCESS, as LoginCodeRelay. A check is handed over only by a heartbeat that reaches this process,
 * and settled only by an answer that reaches it. With several API replicas behind a gateway that does not
 * pin a runner to one of them, a check can go unanswered and is settled as no answer when its wait is up:
 * the price of never passing the key through the database, the one channel the replicas share.
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
  settle: (state: CursorKeyCheckState | null) => void;
}

export class CursorKeyCheckRelay {
  /** How long ask() waits for an answer. */
  waitMs = CURSOR_KEY_CHECK_WAIT_MS;
  private readonly held = new Map<string, HeldCheck>();

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
        settle: (state) => {
          clearTimeout(timer);
          resolve(state);
        },
      });
    });
  }

  /** The checks held for this runner that no heartbeat has taken yet, each handed over once: their keys
   *  are gone from here when this returns. */
  take(runnerId: string): CursorKeyCheckCommand[] {
    const commands: CursorKeyCheckCommand[] = [];
    for (const [checkId, check] of this.held) {
      if (check.runnerId !== runnerId || check.apiKey === null) continue;
      commands.push({ checkId, apiKey: check.apiKey });
      check.apiKey = null;
    }
    return commands;
  }

  /** A runner's answer to a check: settles it, once, when the check is still waited on, was handed to this
   *  runner and is about the key it names by fingerprint. Whether it did. */
  answer(runnerId: string, result: { checkId: string; state: string; keyFingerprint: string }): boolean {
    const check = this.held.get(result.checkId);
    if (!check || check.runnerId !== runnerId || check.apiKey !== null || check.fingerprint !== result.keyFingerprint) {
      return false;
    }
    if (!CURSOR_KEY_CHECK_STATES.includes(result.state as CursorKeyCheckState)) return false;
    this.settle(result.checkId, result.state as CursorKeyCheckState);
    return true;
  }

  private settle(checkId: string, state: CursorKeyCheckState | null): void {
    const check = this.held.get(checkId);
    if (!check) return;
    this.held.delete(checkId);
    check.settle(state);
  }
}

/** This process's relay: ProvidersService asks, the runner's heartbeat takes (RunnerApiController), and
 *  its answer settles (RunnerProvidersController). */
export const cursorKeyCheckRelay = new CursorKeyCheckRelay();
