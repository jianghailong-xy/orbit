import { Logger } from '@nestjs/common';
import { toUuid, WIKI_EXECUTOR_ENV, WIKI_EXECUTOR_MODES, type WikiExecutorMode } from '@orbit/shared';

/**
 * How far the wiki's server-side execution is switched on (contract `jobs.executor`, design §10): the flag
 * that moves the pipelines from the runner's maintenance sessions to the server's jobs, read by both the
 * apiserver and the wiki-worker so the two always answer the same. Shaped after `wiki-rollout.ts`: a pure
 * read of the environment that says what it could not take as written, and a log of that said once.
 *
 *   ORBIT_WIKI_EXECUTOR=runner  the default: the maintenance session runs the pipelines, and the server
 *                               executes no job — the behavior every deployment has had until now.
 *   ORBIT_WIKI_EXECUTOR=canary  only the accounts ORBIT_WIKI_EXECUTOR_CANARY_OWNERS lists are run by the
 *                               server's worker; every other account is as under runner.
 *   ORBIT_WIKI_EXECUTOR=server  every account is.
 *
 * The flag gates EXECUTION, not history: what a path wrote stays where it was written, and a rollout moves
 * forward or back by itself — the old path is not deleted until P10.
 *
 * A value nobody can read is read as `runner`: a switch reached for and mistyped must land on the path that
 * already runs, never on one that would execute with a worker nobody deployed.
 */
export interface WikiExecutorSwitch {
  mode: WikiExecutorMode;
  /** The accounts `canary` gives the server, as uuids; empty under every other mode. */
  canaryOwners: ReadonlySet<string>;
  /** What the environment said that could not be taken as written, each with how it was read instead. */
  problems: readonly string[];
}

export function readWikiExecutorSwitch(env: NodeJS.ProcessEnv = process.env): WikiExecutorSwitch {
  const problems: string[] = [];
  const raw = (env[WIKI_EXECUTOR_ENV.mode] ?? '').trim().toLowerCase();
  let mode: WikiExecutorMode = 'runner';
  if ((WIKI_EXECUTOR_MODES as readonly string[]).includes(raw)) {
    mode = raw as WikiExecutorMode;
  } else if (raw !== '') {
    problems.push(`${WIKI_EXECUTOR_ENV.mode}=${JSON.stringify(env[WIKI_EXECUTOR_ENV.mode])} is none of `
      + `${WIKI_EXECUTOR_MODES.join(', ')}: the server runs no wiki job (runner)`);
  }
  const listed = (env[WIKI_EXECUTOR_ENV.canaryOwners] ?? '').split(',').map((id) => id.trim()).filter((id) => id.length > 0);
  const canaryOwners = new Set<string>();
  if (mode === 'canary') {
    for (const id of listed) {
      try {
        canaryOwners.add(toUuid(id).toLowerCase());
      } catch {
        problems.push(`${WIKI_EXECUTOR_ENV.canaryOwners} names ${JSON.stringify(id)}, which is no account id: it is ignored`);
      }
    }
    if (canaryOwners.size === 0) {
      problems.push(`${WIKI_EXECUTOR_ENV.mode}=canary with no account in ${WIKI_EXECUTOR_ENV.canaryOwners}: `
        + 'the server runs no wiki job for anyone');
    }
  } else if (listed.length > 0) {
    problems.push(`${WIKI_EXECUTOR_ENV.canaryOwners} is read only under ${WIKI_EXECUTOR_ENV.mode}=canary, and it is `
      + `${mode}: it is ignored`);
  }
  return { mode, canaryOwners, problems };
}

/** Whether the server executes a wiki job for `ownerId` under this switch. */
export function wikiExecutorServes(sw: WikiExecutorSwitch, ownerId: string): boolean {
  if (sw.mode === 'server') return true;
  return sw.mode === 'canary' && sw.canaryOwners.has(ownerId.toLowerCase());
}

/**
 * The owners a worker's claims may cover, in the form a claim query takes them: an array that must contain
 * the row's owner, or null for every owner. Under `runner` it is the empty array — a worker starting with
 * the default claims nothing at all, whatever rows the database holds.
 */
export function wikiExecutorClaimOwners(sw: WikiExecutorSwitch): string[] | null {
  if (sw.mode === 'server') return null;
  return [...sw.canaryOwners];
}

const log = new Logger('WikiExecutor');
let announced: string | undefined;

/** The switch as this process's environment sets it, said once in the log whenever what it says changes. */
export function currentWikiExecutorSwitch(): WikiExecutorSwitch {
  const sw = readWikiExecutorSwitch(process.env);
  const said = [sw.mode, [...sw.canaryOwners].sort().join(','), ...sw.problems].join('|');
  if (said !== announced) {
    announced = said;
    for (const problem of sw.problems) log.warn(problem);
    if (sw.mode !== 'runner') {
      const who = sw.mode === 'canary' ? ` for ${sw.canaryOwners.size} account(s)` : '';
      log.log(`The server executes wiki jobs (${WIKI_EXECUTOR_ENV.mode}=${sw.mode}${who})`);
    }
  }
  return sw;
}
