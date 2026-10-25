import { Logger } from '@nestjs/common';

import {
  announceRunnerRelease,
  assignRunnerRelease,
  currentRunnerReleasePolicy,
  isRunnerReleaseVersion,
  type PublishedRunnerReleases,
  type RunnerReleasePolicy,
} from './runner-release';

/**
 * What /dl publishes, as the apiserver reads it for the runner link (docs/runner-link-design.md §7): the link's Welcome
 * and HeartbeatAck state the release a runner is assigned, so a runner whose work goes over the link asks
 * GET /runner/release nothing. That route assigns from the two versions the runner read from /dl/version.json and
 * /dl/previous/version.json. For the link, the apiserver reads the same two files itself, from the web container that
 * serves them (RUNNER_RELEASE_DL_URL, http://web/dl/ in Compose), and assigns with the same assignRunnerRelease.
 *
 * Nothing waits for it. A read runs in the background, for at most RUNNER_RELEASE_DL_READ_TIMEOUT_MS, and what it found
 * stands for RUNNER_RELEASE_DL_CACHE_MS: the two versions, or nothing when the read failed. The first request after
 * that starts the next read and is answered with what stands until it ends. Unset, not read yet, unreadable or slow, the
 * answer states no release, and a runner told none asks GET /runner/release over HTTPS, as it does today.
 */
export class RunnerReleaseFeed {
  private readonly base: URL | null;
  /** What the last read found, and when it ended; null before the first. */
  private known: { published: PublishedRunnerReleases | null; at: number } | null = null;
  private reading: Promise<void> | null = null;
  private failureLoggedAt: number | null = null;

  constructor(
    url: string | undefined,
    private readonly deps: {
      fetch?: typeof fetch;
      now?: () => number;
      log?: Pick<Logger, 'warn' | 'error'>;
      policy?: () => { policy: RunnerReleasePolicy } | { problems: string[] };
    } = {},
  ) {
    this.base = baseOf(url?.trim() ?? '', this.log);
  }

  /** The releases /dl published at the last read, or null when that is not known. Never waits. */
  published(): PublishedRunnerReleases | null {
    if (!this.base) return null;
    if (!this.known || this.now() - this.known.at >= RUNNER_RELEASE_DL_CACHE_MS) this.refresh(this.base);
    return this.known?.published ?? null;
  }

  /**
   * The release runnerId is assigned, as GET /runner/release would answer it now, or null when none can be stated: /dl
   * not known, a pointer that cannot be read, or a rollback with no release to go back to. In each of those the route
   * assigns nothing either (it answers 409).
   */
  assignedTo(runnerId: string): { version: string; rollback: boolean } | null {
    const published = this.published();
    if (!published) return null;
    const read = (this.deps.policy ?? currentRunnerReleasePolicy)();
    if ('problems' in read) return null;
    announceRunnerRelease(published, read.policy);
    const assignment = assignRunnerRelease(runnerId, published, read.policy);
    return assignment && { version: assignment.version, rollback: assignment.rollback };
  }

  /** The read in flight, if there is one, once it has ended. */
  async settled(): Promise<void> {
    await this.reading;
  }

  private refresh(base: URL): void {
    if (this.reading) return;
    this.reading = this.read(base)
      .then(
        (published) => {
          this.failureLoggedAt = null;
          return published;
        },
        (error: unknown) => {
          const now = this.now();
          if (this.failureLoggedAt === null || now - this.failureLoggedAt >= FAILURE_LOG_EVERY_MS) {
            this.failureLoggedAt = now;
            this.log.warn(`runner releases not read from ${base.href} (${(error as Error)?.message ?? error}): `
              + 'the runner link states no release until a read succeeds, and runners ask GET /runner/release over HTTPS');
          }
          return null;
        },
      )
      .then((published) => {
        this.known = { published, at: this.now() };
        this.reading = null;
      });
  }

  private async read(base: URL): Promise<PublishedRunnerReleases> {
    const signal = AbortSignal.timeout(RUNNER_RELEASE_DL_READ_TIMEOUT_MS);
    const [latest, previous] = await Promise.all([
      this.versionAt(new URL('version.json', base), signal),
      // Empty until one release has replaced another: then there is none, as a runner reads it (selfupdate.go).
      this.versionAt(new URL('previous/version.json', base), signal, { missing: null }),
    ]);
    if (latest === null) throw new Error('version.json is missing');
    return { latest, previous };
  }

  private async versionAt(url: URL, signal: AbortSignal, absent?: { missing: null }): Promise<string | null> {
    const response = await (this.deps.fetch ?? fetch)(url, { signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404 && absent) return absent.missing;
      throw new Error(`${url.pathname} answered ${response.status}`);
    }
    const version = ((await response.json()) as { version?: unknown } | null)?.version;
    if (!isRunnerReleaseVersion(version)) throw new Error(`${url.pathname} names no release version`);
    return version;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private get log(): Pick<Logger, 'warn' | 'error'> {
    return this.deps.log ?? log;
  }
}

/** How long one read of /dl may take, both manifests together. */
export const RUNNER_RELEASE_DL_READ_TIMEOUT_MS = 2_000;
/** How long what a read found stands before the next read. */
export const RUNNER_RELEASE_DL_CACHE_MS = 60_000;
/** A read that keeps failing is logged again after this long. */
const FAILURE_LOG_EVERY_MS = 10 * 60_000;

const log = new Logger('RunnerRelease');

/** The /dl directory RUNNER_RELEASE_DL_URL names, ending in a slash; null when unset or not an http(s) URL. */
function baseOf(text: string, logger: Pick<Logger, 'error'>): URL | null {
  if (text === '') return null;
  let url: URL;
  try {
    url = new URL(text.endsWith('/') ? text : `${text}/`);
  } catch {
    url = new URL('invalid:');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    logger.error(`RUNNER_RELEASE_DL_URL=${JSON.stringify(text)} is not an http(s) URL: the runner link states no release`);
    return null;
  }
  return url;
}
