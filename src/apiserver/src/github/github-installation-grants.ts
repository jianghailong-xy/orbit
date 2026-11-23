import { Injectable, Logger } from '@nestjs/common';
import { GithubCallError, GithubClient, PULL_REQUEST_LANDING_PERMISSIONS, type GithubInstallationGrant } from './github-api.client';
import { GithubAppConfigService } from './github-app-config.service';

/** How long one installation's grant is held before GitHub is asked again (docs/design/protected-branch-landing.md §10). */
export const INSTALLATION_GRANT_TTL_MS = 10 * 60_000;
/** How long an installation GitHub could not be asked about waits before the next try. */
export const INSTALLATION_GRANT_RETRY_MS = 60_000;

const LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 };

/** Whether `granted` covers every permission landing through a pull request needs, at the level it needs. */
export function grantsPullRequestLanding(granted: Record<string, string>): boolean {
  return Object.entries(PULL_REQUEST_LANDING_PERMISSIONS)
    .every(([name, level]) => (LEVEL[granted[name] ?? ''] ?? 0) >= LEVEL[level]);
}

/** The permissions landing through a pull request needs that `granted` lacks, by name, for the settings read (§10). */
export function pullRequestPermissionsPending(granted: Record<string, string>): string[] {
  return Object.entries(PULL_REQUEST_LANDING_PERMISSIONS)
    .filter(([name, level]) => (LEVEL[granted[name] ?? ''] ?? 0) < LEVEL[level])
    .map(([name]) => name);
}

/** Where an installation's owner reviews the App's new permissions (§10 step 4). */
export function installationReviewUrl(grant: Pick<GithubInstallationGrant, 'id' | 'account' | 'type'>): string {
  return grant.type === 'Organization'
    ? `https://github.com/organizations/${grant.account}/settings/installations/${grant.id}`
    : `https://github.com/settings/installations/${grant.id}`;
}

interface HeldGrant {
  at: number;
  grant: GithubInstallationGrant | null;
}

/**
 * What each installation of the App granted (docs/design/protected-branch-landing.md §3 rule 3, §10 step 3), read with
 * the App's own credential and held for ten minutes — read again at once when GitHub says its owner accepted new
 * permissions (`installation` · `new_permissions_accepted`). Until an installation grants the pull request permissions,
 * its workspaces land exactly as they did before: this is the switch that keeps the feature off where it cannot work.
 */
@Injectable()
export class GithubInstallationGrants {
  private readonly log = new Logger('GithubInstallationGrants');
  private readonly held = new Map<string, HeldGrant>();
  private readonly reading = new Map<string, Promise<GithubInstallationGrant | null>>();

  /** The clock; a spec sets its own. */
  now: () => number = () => Date.now();

  constructor(
    private readonly config: GithubAppConfigService,
    private readonly github: GithubClient,
  ) {}

  /** The installation's grant, or null when it cannot be read now (no App set up, GitHub not answering, gone). */
  async grant(installationId: string): Promise<GithubInstallationGrant | null> {
    const held = this.held.get(installationId);
    const ttl = held?.grant ? INSTALLATION_GRANT_TTL_MS : INSTALLATION_GRANT_RETRY_MS;
    if (held && this.now() - held.at < ttl) return held.grant;
    let pending = this.reading.get(installationId);
    if (!pending) {
      pending = this.read(installationId).finally(() => this.reading.delete(installationId));
      this.reading.set(installationId, pending);
    }
    return pending;
  }

  /** Whether landing through a pull request is switched on for this installation; null when it cannot be told. */
  async pullRequestsGranted(installationId: string): Promise<boolean | null> {
    const grant = await this.grant(installationId);
    return grant ? grantsPullRequestLanding(grant.permissions) : null;
  }

  /** GitHub said the installation's permissions changed: the next question asks GitHub again. */
  forget(installationId: string): void {
    this.held.delete(installationId);
  }

  private async read(installationId: string): Promise<GithubInstallationGrant | null> {
    const app = await this.config.credentials();
    if (!app) return null;
    try {
      const grant = await this.github.installationGrant({ appId: app.appId, privateKey: app.privateKey, installationId });
      this.held.set(installationId, { at: this.now(), grant });
      return grant;
    } catch (error) {
      // The status only: GitHub's answer can quote what it was sent.
      this.log.warn(`installation ${installationId}'s permissions not read: ${error instanceof GithubCallError ? error.status : (error as Error)?.name}`);
      this.held.set(installationId, { at: this.now(), grant: null });
      return null;
    }
  }
}
