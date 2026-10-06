import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Logger } from '@nestjs/common';

/**
 * Which runner release each runner is to run: the staged rollout and the rollback of the binary /dl publishes
 * (docs/release-process.md, "Runner rollout and rollback").
 *
 * /dl publishes at most two releases: the latest at /dl/version.json, and the one it replaced at
 * /dl/previous/version.json, which the web image carries over from the image before it (src/web/Dockerfile). A
 * runner reports both versions to GET /api/runner/release, and the release pointer — runner-release.json at the
 * repository root, baked into this image — says which of the two it gets:
 *
 *   rolloutPercent  0–100, default 100: the share of runners the latest release goes to, by a hash of the runner's
 *                   id. Every other runner is assigned the previous release, held back by the rollout.
 *   rollback        a release version, default null. Naming the latest release points the pointer back at the
 *                   previous one: every runner is assigned the previous release, marked as a rollback, so a runner
 *                   already on the latest installs the older one. Naming the previous release withdraws it — the
 *                   fix has shipped on top of a rolled-back release — so every runner is assigned the latest and
 *                   no runner is held on the withdrawn one. A version that is neither is ignored.
 *
 * Changing the pointer is a commit and a deploy: the history of runner-release.json is the record of who moved it,
 * when and why.
 */

export interface RunnerReleasePolicy {
  rolloutPercent: number;
  rollback: string | null;
}

/** What /dl publishes, as the runner asking read it. */
export interface PublishedRunnerReleases {
  latest: string;
  previous: string | null;
}

export interface RunnerReleaseAssignment {
  /** The release this runner is to run: the latest or the previous one. */
  version: string;
  /** The release pointer was moved back to `version`: a runner on a newer release installs it anyway. */
  rollback: boolean;
  /** `version` is the previous release only because this runner is outside the latest release's rollout. */
  heldByRollout: boolean;
}

/** A runner release version, as package.json numbers it: dot-separated whole numbers. */
export function isRunnerReleaseVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d+(\.\d+)*$/.test(value);
}

/** How the runner orders releases (runner-go isNewer): component by component, a missing component reading 0. */
export function compareRunnerReleaseVersions(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/**
 * The policy runner-release.json states, or the problems that keep it from being read. Nothing in a pointer that
 * cannot be read is guessed at: the caller assigns no runner anything until it is fixed.
 */
export function readRunnerReleasePolicy(raw: unknown): { policy: RunnerReleasePolicy } | { problems: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { problems: ['it is not a JSON object'] };
  const { rolloutPercent = 100, rollback = null } = raw as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof rolloutPercent !== 'number' || !Number.isInteger(rolloutPercent) || rolloutPercent < 0 || rolloutPercent > 100) {
    problems.push(`rolloutPercent ${JSON.stringify(rolloutPercent)} is not a whole number from 0 to 100`);
  }
  if (rollback !== null && !isRunnerReleaseVersion(rollback)) {
    problems.push(`rollback ${JSON.stringify(rollback)} is neither null nor a release version`);
  }
  return problems.length ? { problems } : { policy: { rolloutPercent: rolloutPercent as number, rollback: rollback as string | null } };
}

/**
 * Where a runner falls in a rollout, 0–99: the first four bytes of the SHA-256 of its id, mod 100. It depends on
 * nothing else, so a runner keeps its place from release to release, and raising rolloutPercent only adds runners.
 */
export function rolloutBucket(runnerId: string): number {
  return createHash('sha256').update(runnerId).digest().readUInt32BE(0) % 100;
}

/**
 * The release `runnerId` is to run, or null when the pointer is rolled back with no previous release to go to — then
 * no runner is moved at all, rather than the release being rolled back going to more of them.
 */
export function assignRunnerRelease(
  runnerId: string,
  published: PublishedRunnerReleases,
  policy: RunnerReleasePolicy,
): RunnerReleaseAssignment | null {
  const { latest } = published;
  let previous = published.previous;
  // Only an older release can be held at or rolled back to: anything else is not a previous release.
  if (previous !== null && compareRunnerReleaseVersions(previous, latest) >= 0) previous = null;
  if (policy.rollback === latest) {
    return previous === null ? null : { version: previous, rollback: true, heldByRollout: false };
  }
  if (previous === null || policy.rollback === previous || rolloutBucket(runnerId) < policy.rolloutPercent) {
    return { version: latest, rollback: false, heldByRollout: false };
  }
  return { version: previous, rollback: false, heldByRollout: true };
}

/** The pointer in one line, for the log: what every runner is assigned, as /dl publishes the releases now. */
export function describeRunnerRelease(published: PublishedRunnerReleases, policy: RunnerReleasePolicy): string {
  const { latest, previous } = published;
  const older = previous !== null && compareRunnerReleaseVersions(previous, latest) < 0 ? previous : null;
  if (policy.rollback === latest) {
    return older === null
      ? `runner-release.json rolls back ${latest}, but /dl keeps no release before it: no runner is moved`
      : `runner release ${latest} is rolled back: every runner is assigned ${older}`;
  }
  const ignored =
    policy.rollback !== null && policy.rollback !== older
      ? `runner-release.json rolls back ${policy.rollback}, which /dl no longer publishes: ignored. `
      : '';
  if (older === null || policy.rollback === older || policy.rolloutPercent === 100) {
    const withdrawn = older !== null && policy.rollback === older ? ` (${older} is withdrawn)` : '';
    return `${ignored}runner release ${latest} to every runner${withdrawn}`;
  }
  return `${ignored}runner release ${latest} to ${policy.rolloutPercent}% of runners; the rest are held at ${older}`;
}

// From dist/runner-api (or the specs' build/runner-api) back to the repository root, where the image keeps it too.
export const RUNNER_RELEASE_POLICY_FILE = path.resolve(__dirname, '../../../../runner-release.json');

const log = new Logger('RunnerRelease');
let loaded: { policy: RunnerReleasePolicy } | { problems: string[] } | undefined;
let announced: string | undefined;

/**
 * The pointer in `file`. A missing file is a deployment without one, which publishes the way every release did before
 * it: the latest release to every runner.
 */
export function loadRunnerReleasePolicy(file: string): { policy: RunnerReleasePolicy } | { problems: string[] } {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    log.warn(`${file} is missing: every runner is assigned the latest release`);
    return { policy: { rolloutPercent: 100, rollback: null } };
  }
  try {
    return readRunnerReleasePolicy(JSON.parse(text));
  } catch {
    return { problems: ['it is not JSON'] };
  }
}

/** The pointer this image ships, read once: it changes only with the image. */
export function currentRunnerReleasePolicy(): { policy: RunnerReleasePolicy } | { problems: string[] } {
  if (!loaded) {
    loaded = loadRunnerReleasePolicy(RUNNER_RELEASE_POLICY_FILE);
    if ('problems' in loaded) {
      log.error(`${RUNNER_RELEASE_POLICY_FILE} cannot be read (${loaded.problems.join('; ')}): no runner is assigned a release`);
    }
  }
  return loaded;
}

/** Says what the pointer does once in the log, and again whenever that changes. */
export function announceRunnerRelease(published: PublishedRunnerReleases, policy: RunnerReleasePolicy): void {
  const said = describeRunnerRelease(published, policy);
  if (said !== announced) {
    announced = said;
    log.log(said);
  }
}
