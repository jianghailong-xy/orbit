import { Logger, NotFoundException } from '@nestjs/common';
import { toUuid } from '@orbit/shared';

/**
 * How far native Watch is switched on in this apiserver: the flag a gradual rollout moves forward and a rollback moves
 * back (docs/watch-rollout.md). It is read from the environment, so a change takes effect when the apiserver restarts.
 *
 *   ORBIT_WATCHES=on      every account makes and re-arms watches. The default, and what a server without the flag did.
 *   ORBIT_WATCHES=canary  only the accounts ORBIT_WATCHES_CANARY_OWNERS lists do; every other account is as under drain.
 *   ORBIT_WATCHES=drain   no account makes or re-arms one; the watches already made are still evaluated and delivered.
 *   ORBIT_WATCHES=off     as drain, and this replica runs neither the evaluator nor the delivery worker: the watches
 *                         already made wait, unevaluated, until a replica runs them again.
 *
 * An account Watch is not on for meets it the way a client meets a server that predates it. Every write that would add a
 * wait or a wake — a create, an edit, a resume, a dead letter's redrive — answers 404 WATCHES_DISABLED, which the
 * runner's session_create(wait) of every released version reads as "no watch door here" and waits inline the way it did
 * before watches; and its sessions are claimed with `watchesDisabled`, which a runner that knows it spawns without the
 * watch tools. What reads a wait or stops one is never refused: an owner still sees, pauses and cancels what was made
 * while Watch was on, and an agent still releases the wait it made.
 */

export type WatchRolloutMode = 'on' | 'canary' | 'drain' | 'off';
export const WATCH_ROLLOUT_MODES: readonly WatchRolloutMode[] = ['on', 'canary', 'drain', 'off'];

/** The refusal code of a write Watch is not on for. Not a contract refusal: nothing about the request is wrong. */
export const WATCHES_DISABLED = 'WATCHES_DISABLED';

/** The writes the flag refuses, as `orbit_watch_rollout_refusals_total` labels them. */
export type WatchRolloutGatedWrite = 'create' | 'update' | 'resume' | 'redrive';
export const WATCH_ROLLOUT_GATED_WRITES: readonly WatchRolloutGatedWrite[] = ['create', 'update', 'resume', 'redrive'];

export interface WatchRollout {
  mode: WatchRolloutMode;
  /** The accounts `canary` lets watch, as uuids; empty under every other mode. */
  canaryOwners: ReadonlySet<string>;
  /** What the environment said that could not be taken as written, each with how it was read instead. */
  problems: readonly string[];
}

export function readWatchRollout(env: NodeJS.ProcessEnv = process.env): WatchRollout {
  const problems: string[] = [];
  const raw = (env.ORBIT_WATCHES ?? '').trim().toLowerCase();
  let mode: WatchRolloutMode = 'on';
  if ((WATCH_ROLLOUT_MODES as readonly string[]).includes(raw)) {
    mode = raw as WatchRolloutMode;
  } else if (raw !== '') {
    // A switch somebody reached for and mistyped is read as the setting that stops the most, never as the default.
    mode = 'off';
    problems.push(`ORBIT_WATCHES=${JSON.stringify(env.ORBIT_WATCHES)} is none of ${WATCH_ROLLOUT_MODES.join(', ')}: Watch is off`);
  }
  const listed = (env.ORBIT_WATCHES_CANARY_OWNERS ?? '').split(',').map((id) => id.trim()).filter((id) => id.length > 0);
  const canaryOwners = new Set<string>();
  if (mode === 'canary') {
    for (const id of listed) {
      try {
        canaryOwners.add(toUuid(id).toLowerCase());
      } catch {
        problems.push(`ORBIT_WATCHES_CANARY_OWNERS names ${JSON.stringify(id)}, which is no account id: it is ignored`);
      }
    }
    if (canaryOwners.size === 0) {
      problems.push('ORBIT_WATCHES=canary with no account in ORBIT_WATCHES_CANARY_OWNERS: no account can watch');
    }
  } else if (listed.length > 0) {
    problems.push(`ORBIT_WATCHES_CANARY_OWNERS is read only under ORBIT_WATCHES=canary, and Watch is ${mode}: it is ignored`);
  }
  return { mode, canaryOwners, problems };
}

/** Whether `ownerId` may add a wait or a wake: make a watch, edit or resume one, redrive a dead letter. */
export function watchesAcceptWaits(rollout: WatchRollout, ownerId: string): boolean {
  return rollout.mode === 'on' || (rollout.mode === 'canary' && rollout.canaryOwners.has(ownerId.toLowerCase()));
}

/** Whether this replica runs the evaluator and the delivery worker. */
export function watchWorkersRun(rollout: WatchRollout): boolean {
  return rollout.mode !== 'off';
}

const NOT_MADE: Record<WatchRolloutGatedWrite, string> = {
  create: 'no watch was made',
  update: 'the watch was not edited',
  resume: 'the watch was not resumed',
  redrive: 'the dead letter was not redriven',
};

/** The refusal of a write Watch is not on for: the 404 a server without Watch gives, with the reason in words. */
export function watchesDisabledError(rollout: WatchRollout, write: WatchRolloutGatedWrite): NotFoundException {
  return new NotFoundException({
    code: WATCHES_DISABLED,
    message:
      `Watch is not on for this account on this Orbit server (ORBIT_WATCHES=${rollout.mode}), so ${NOT_MADE[write]}. ` +
      'Watches made before can still be read, paused and cancelled.',
  });
}

/**
 * What a claimed session carries about Watch: nothing when it is on for the session's owner — the payload every runner
 * has always received — and `watchesDisabled` otherwise, which tells a runner that knows the flag to spawn the session
 * without the watch tools.
 */
export function watchClaimFields(rollout: WatchRollout, ownerId: string): { watchesDisabled?: true } {
  return watchesAcceptWaits(rollout, ownerId) ? {} : { watchesDisabled: true };
}

const log = new Logger('WatchRollout');
let announced: string | undefined;

/** The flag as this process's environment sets it, said once in the log whenever what it says changes. */
export function currentWatchRollout(): WatchRollout {
  const rollout = readWatchRollout(process.env);
  const said = [rollout.mode, [...rollout.canaryOwners].sort().join(','), ...rollout.problems].join('|');
  if (said !== announced) {
    announced = said;
    for (const problem of rollout.problems) log.warn(problem);
    if (rollout.mode !== 'on') {
      const who = rollout.mode === 'canary' ? ` for ${rollout.canaryOwners.size} account(s)` : '';
      log.log(`Watch is ${rollout.mode}${who} (docs/watch-rollout.md)`);
    }
  }
  return rollout;
}
