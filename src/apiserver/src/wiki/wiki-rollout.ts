import { CanActivate, ExecutionContext, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { toUuid, type WikiRefusal } from '@orbit/shared';

/**
 * How far the Orbit Wiki is switched on in this apiserver (contract `agentSurface.rollout`, design §5.2): the flag a
 * gradual rollout moves forward and a rollback moves back. It is read from the environment, so a change takes effect
 * when the apiserver restarts. Shaped after `watches/watch-rollout.ts`.
 *
 *   ORBIT_WIKI=on      every account has the wiki. The default, and what a server without the flag did.
 *   ORBIT_WIKI=canary  only the accounts ORBIT_WIKI_CANARY_OWNERS lists do; every other account is as under off.
 *   ORBIT_WIKI=off     no account has it.
 *
 * There is no `drain`: the wiki has no worker that could keep running for what was made before, so the only
 * question is whether an account has it at all.
 *
 * An account the wiki is not on for meets it the way a client meets a server that predates it:
 *   - every route on both doors — `/api/wiki/*` and `/api/runner/wiki/*`, reads as well as writes — answers
 *     404 WIKI_DISABLED before it reads anything (`WikiRolloutGuard`);
 *   - its sessions are claimed with `wikiDisabled`, which a runner that knows it spawns without the wiki tools;
 *   - no `<orbit_wiki_context>` is appended to what is delivered to them (`appendWikiContext`);
 *   - an `orbit-wiki:` link card reads as one naming nothing (`LinkPreviewsService`).
 * What was written while it was on stays in the database untouched, and is there again when it is switched back on.
 */

export type WikiRolloutMode = 'on' | 'canary' | 'off';
export const WIKI_ROLLOUT_MODES: readonly WikiRolloutMode[] = ['on', 'canary', 'off'];

/** The refusal code of a request the wiki is not on for (contract `refusals`): 404, as a server without it. */
export const WIKI_DISABLED = 'WIKI_DISABLED';

export interface WikiRollout {
  mode: WikiRolloutMode;
  /** The accounts `canary` gives the wiki, as uuids; empty under every other mode. */
  canaryOwners: ReadonlySet<string>;
  /** What the environment said that could not be taken as written, each with how it was read instead. */
  problems: readonly string[];
}

export function readWikiRollout(env: NodeJS.ProcessEnv = process.env): WikiRollout {
  const problems: string[] = [];
  const raw = (env.ORBIT_WIKI ?? '').trim().toLowerCase();
  let mode: WikiRolloutMode = 'on';
  if ((WIKI_ROLLOUT_MODES as readonly string[]).includes(raw)) {
    mode = raw as WikiRolloutMode;
  } else if (raw !== '') {
    // A switch somebody reached for and mistyped is read as the setting that stops the most, never as the default.
    mode = 'off';
    problems.push(`ORBIT_WIKI=${JSON.stringify(env.ORBIT_WIKI)} is none of ${WIKI_ROLLOUT_MODES.join(', ')}: the wiki is off`);
  }
  const listed = (env.ORBIT_WIKI_CANARY_OWNERS ?? '').split(',').map((id) => id.trim()).filter((id) => id.length > 0);
  const canaryOwners = new Set<string>();
  if (mode === 'canary') {
    for (const id of listed) {
      try {
        canaryOwners.add(toUuid(id).toLowerCase());
      } catch {
        problems.push(`ORBIT_WIKI_CANARY_OWNERS names ${JSON.stringify(id)}, which is no account id: it is ignored`);
      }
    }
    if (canaryOwners.size === 0) {
      problems.push('ORBIT_WIKI=canary with no account in ORBIT_WIKI_CANARY_OWNERS: no account has the wiki');
    }
  } else if (listed.length > 0) {
    problems.push(`ORBIT_WIKI_CANARY_OWNERS is read only under ORBIT_WIKI=canary, and the wiki is ${mode}: it is ignored`);
  }
  return { mode, canaryOwners, problems };
}

/** Whether `ownerId` has the wiki. A request that names no account has it only when every account does. */
export function wikiOnFor(rollout: WikiRollout, ownerId: string | null | undefined): boolean {
  if (rollout.mode === 'on') return true;
  return rollout.mode === 'canary' && !!ownerId && rollout.canaryOwners.has(ownerId.toLowerCase());
}

/** The refusal of a request the wiki is not on for: the 404 a server without the wiki gives, with the reason in words. */
export function wikiDisabledError(rollout: WikiRollout): NotFoundException {
  const refusal: WikiRefusal = {
    code: WIKI_DISABLED,
    message:
      `The Orbit wiki is not on for this account on this Orbit server (ORBIT_WIKI=${rollout.mode}), `
      + 'so nothing was read from it or written to it.',
  };
  return new NotFoundException(refusal);
}

/**
 * What a claimed session carries about the wiki: nothing when it is on for the session's owner — the payload every
 * runner has always received — and `wikiDisabled` otherwise, which tells a runner that knows the flag to spawn the
 * session without the wiki tools (runner-go `wiki_tools.go`, ORBIT_WIKI=off in the engine's environment).
 */
export function wikiClaimFields(rollout: WikiRollout, ownerId: string): { wikiDisabled?: true } {
  return wikiOnFor(rollout, ownerId) ? {} : { wikiDisabled: true };
}

const log = new Logger('WikiRollout');
let announced: string | undefined;

/** The flag as this process's environment sets it, said once in the log whenever what it says changes. */
export function currentWikiRollout(): WikiRollout {
  const rollout = readWikiRollout(process.env);
  const said = [rollout.mode, [...rollout.canaryOwners].sort().join(','), ...rollout.problems].join('|');
  if (said !== announced) {
    announced = said;
    for (const problem of rollout.problems) log.warn(problem);
    if (rollout.mode !== 'on') {
      const who = rollout.mode === 'canary' ? ` for ${rollout.canaryOwners.size} account(s)` : '';
      log.log(`The wiki is ${rollout.mode}${who} (ORBIT_WIKI)`);
    }
  }
  return rollout;
}

/**
 * The wiki's doors, closed to an account the wiki is not on for. Listed AFTER the door's own credential guard on both
 * controllers — `@UseGuards(JwtAuthGuard, WikiRolloutGuard)` and `@UseGuards(RunnerAuthGuard, WikiRolloutGuard)` — so
 * the account is the one the credential proved: the user door's `request.user`, the runner door's runner owner. A
 * request that is not authenticated is still that guard's 401 or 403, and says nothing about the flag.
 *
 * On the class, not on a route: every route either controller has, and every one added to it later, is behind it
 * (`wiki-rollout.spec.ts` walks both controllers' routes to hold that).
 */
@Injectable()
export class WikiRolloutGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: { userId?: string }; runner?: { ownerId?: string } }>();
    const rollout = currentWikiRollout();
    if (wikiOnFor(rollout, request.user?.userId ?? request.runner?.ownerId)) return true;
    throw wikiDisabledError(rollout);
  }
}
