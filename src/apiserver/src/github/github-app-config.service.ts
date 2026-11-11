import { BadRequestException, BadGatewayException, Injectable } from '@nestjs/common';
import type { GithubAppConfig } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { decryptSecret, encryptSecret } from '../providers/provider-crypto';
import { GithubCallError, GithubClient, isPrivateKey } from './github-api.client';

const ROW = 'github';

/** `GET` and `PUT /admin/integrations/github` (docs/github-workspace-design.md §5.1). Says whether a secret is saved, never what it is. */
export interface GithubAppSettings {
  enabled: boolean;
  /** A decimal string: an App ID is a BIGINT. Null before the first save. */
  appId: string | null;
  slug: string | null;
  clientId: string;
  secretSaved: boolean;
  keySaved: boolean;
  /**
   * The client secret or the private key is saved and the `PROVIDER_SECRET_KEY` in force cannot decrypt
   * it: GitHub is off for everyone until the administrator enters it again.
   */
  secretUnreadable: boolean;
  /** What to enter as the App's callback URL on GitHub. */
  callbackUrl: string;
  /** How many accounts have connected GitHub. */
  connectedUsers: number;
  /** How many live workspaces were cloned from GitHub. */
  clonedWorkspaces: number;
}

export interface GithubAppChange {
  enabled: boolean;
  appId: string;
  clientId: string;
  /** Left out, the saved one stays. */
  clientSecret?: string;
  /** Left out, the saved one stays. */
  privateKey?: string;
}

/** The App as the user routes use it, its secrets decrypted. */
export interface GithubAppCredentials {
  appId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
}

/** The one address GitHub sends a browser back to: this deployment's PUBLIC_ORIGIN and the callback route. */
export function githubCallbackUrl(): string {
  const origin = (process.env.PUBLIC_ORIGIN?.trim() || 'http://localhost:2086').replace(/\/+$/, '');
  return `${origin}/api/integrations/github/callback`;
}

/** The plaintext of a stored secret, or null for none saved or one the key in force cannot read. */
function readable(stored: string): string | null {
  if (stored === '') return null;
  try {
    return decryptSecret(stored);
  } catch {
    return null;
  }
}

const unreadable = (stored: string) => stored !== '' && readable(stored) === null;

function refuse(message: string): never {
  throw new BadRequestException({ code: 'GITHUB_APP_CHECK_FAILED', message });
}

/**
 * The deployment's GitHub App (§4 `github_app_config`, §5.1). No row and a row that is off are the same:
 * Settings offers no GitHub, and every user route answers as if there were none. Read on every request,
 * so a save holds from the next one.
 */
@Injectable()
export class GithubAppConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly github: GithubClient,
  ) {}

  private row(): Promise<GithubAppConfig | null> {
    return this.prisma.githubAppConfig.findUnique({ where: { id: ROW } });
  }

  async settings(): Promise<GithubAppSettings> {
    const [row, connectedUsers, clonedWorkspaces] = await Promise.all([
      this.row(),
      this.prisma.githubConnection.count(),
      this.prisma.workspace.count({ where: { githubRepoId: { not: null }, deletedAt: null } }),
    ]);
    return {
      enabled: row?.enabled ?? false,
      appId: row ? row.appId.toString() : null,
      slug: row?.slug ?? null,
      clientId: row?.clientId ?? '',
      secretSaved: (row?.clientSecretEnc ?? '') !== '',
      keySaved: (row?.privateKeyEnc ?? '') !== '',
      secretUnreadable: row !== null && (unreadable(row.clientSecretEnc) || unreadable(row.privateKeyEnc)),
      callbackUrl: githubCallbackUrl(),
      connectedUsers,
      clonedWorkspaces,
    };
  }

  /**
   * One upsert of the whole setting, after GitHub vouched for it: GET /app with a JWT the private key
   * signs must answer this App ID, and the client ID must be that App's. A secret or key given replaces
   * the saved one; none given keeps it. Nothing is written when the check fails.
   */
  async update(adminId: string, change: GithubAppChange): Promise<GithubAppSettings> {
    const row = await this.row();
    if (change.privateKey !== undefined && !isPrivateKey(change.privateKey)) {
      refuse('That private key could not be read. Paste the whole .pem file GitHub generated, including its BEGIN and END lines.');
    }
    const privateKey = change.privateKey ?? (row ? readable(row.privateKeyEnc) : null);
    if (privateKey === null) {
      refuse(row?.privateKeyEnc ? "The saved private key can't be read. Enter it again." : 'Add the App\'s private key.');
    }
    if (change.clientSecret === undefined && row && unreadable(row.clientSecretEnc)) {
      refuse("The saved client secret can't be read. Enter it again.");
    }
    if (change.enabled && change.clientSecret === undefined && !row?.clientSecretEnc) {
      refuse('Add the App\'s client secret before turning it on.');
    }

    let app;
    try {
      app = await this.github.app(change.appId, privateKey);
    } catch (error) {
      if (error instanceof GithubCallError && error.status === 401) {
        refuse(`GitHub did not accept this private key for App ID ${change.appId}. Check that the ID and the key belong to the same App.`);
      }
      if (error instanceof GithubCallError && error.status === 404) refuse(`GitHub has no App with ID ${change.appId}.`);
      throw new BadGatewayException({ code: 'GITHUB_UNAVAILABLE', message: "Couldn't reach GitHub to check the App. Try again." });
    }
    if (String(app.id) !== change.appId) refuse(`This private key belongs to App ID ${app.id}, not ${change.appId}.`);
    if (app.clientId !== '' && app.clientId !== change.clientId) {
      refuse(`The client ID doesn't match the App ${app.slug}: GitHub says ${app.clientId}.`);
    }

    const fields = {
      enabled: change.enabled,
      appId: BigInt(change.appId),
      slug: app.slug,
      clientId: change.clientId,
      updatedById: adminId,
      ...(change.clientSecret === undefined ? {} : { clientSecretEnc: encryptSecret(change.clientSecret) }),
      ...(change.privateKey === undefined ? {} : { privateKeyEnc: encryptSecret(change.privateKey) }),
    };
    await this.prisma.githubAppConfig.upsert({
      where: { id: ROW },
      create: { id: ROW, clientSecretEnc: '', privateKeyEnc: '', ...fields },
      update: fields,
    });
    return this.settings();
  }

  /** The App the user routes use, or null while GitHub is off: no row, switched off, or a secret missing or unreadable. */
  async credentials(): Promise<GithubAppCredentials | null> {
    const row = await this.row();
    if (!row || !row.enabled || row.clientId === '') return null;
    const clientSecret = readable(row.clientSecretEnc);
    const privateKey = readable(row.privateKeyEnc);
    if (clientSecret === null || privateKey === null) return null;
    return { appId: row.appId.toString(), slug: row.slug, clientId: row.clientId, clientSecret, privateKey };
  }
}
