import { BadGatewayException, BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type GithubConnection } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { decryptSecret, encryptSecret } from '../providers/provider-crypto';
import {
  GithubCallError,
  GithubClient,
  type GithubInstallation,
  type GithubRepository,
  type GithubUserTokens,
  MAX_LISTED_REPOSITORIES,
} from './github-api.client';
import { type GithubAppCredentials, GithubAppConfigService, githubCallbackUrl } from './github-app-config.service';

/** A connection in flight lasts ten minutes and is used once (docs/github-workspace-design.md §5.2). */
export const GITHUB_FLOW_TTL_MS = 10 * 60_000;
/** How long one account's listing of repositories is reused (§5.2). */
export const GITHUB_LIST_CACHE_MS = 60_000;
/** A repository page. */
export const GITHUB_REPO_PAGE = 30;
/** A token this close to its expiry is refreshed first. */
const REFRESH_MARGIN_MS = 60_000;
/** What retiring a Push as me token came to (§16 Q1): the pair rotated, how many tokens GitHub revoked, and why not. */
export interface OwnerTokenRetirement {
  refreshed: boolean;
  revoked: number;
  failure: string | null;
}

/** A GitHub failure as a log line may say it: its status and GitHub's error code, never what was sent. */
function describeGithubError(error: unknown): string {
  return error instanceof GithubCallError ? `GitHub answered ${error.status}${error.githubError ? ` ${error.githubError}` : ''}` : 'GitHub could not be reached';
}

/** A Push as me push is handed a token with at least this long left, refreshed first otherwise (§5.2). */
export const PUSH_TOKEN_MIN_VALIDITY_MS = 15 * 60_000;
/** What an expiry GitHub did not give is stored as: a token that does not expire. */
const NEVER = new Date('9999-12-31T00:00:00Z');
const DEFAULT_RETURN = '/settings/integrations/github';

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const token = () => randomBytes(32).toString('base64url');
const s256 = (verifier: string) => createHash('sha256').update(verifier, 'utf8').digest('base64url');

/** A path on this site, and nothing a browser could read as another one. */
export function safeReturnPath(value: unknown): string {
  return typeof value === 'string' && value.length <= 500 && /^\/(?![/\\])[^\s\\]*$/.test(value) ? value : DEFAULT_RETURN;
}

function withQuery(path: string, key: string, value: string): string {
  const [base, hash] = path.split('#', 2);
  const joined = `${base}${base.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(value)}`;
  return hash === undefined ? joined : `${joined}#${hash}`;
}

const notConnected = () => new ConflictException({ code: 'GITHUB_NOT_CONNECTED', message: 'Connect GitHub in Settings → Integrations first.' });
const notConfigured = () => new ConflictException({ code: 'GITHUB_NOT_CONFIGURED', message: 'GitHub is not set up on this Orbit. Ask an administrator.' });
const unavailable = () => new BadGatewayException({ code: 'GITHUB_UNAVAILABLE', message: "GitHub didn't answer. Try again in a moment." });

export interface GithubInstallationView extends GithubInstallation {
  /** How many repositories the installation reaches for this user. */
  repositoryCount: number;
}

/** `GET /integrations/github` (§5.2). */
export interface GithubIntegrationView {
  /** An administrator set up the App and it is on. */
  available: boolean;
  connected: boolean;
  login: string | null;
  connectedAt: string | null;
  /** Connected, and GitHub no longer takes the tokens: Reconnect. */
  needsReconnect: boolean;
  /** Null when GitHub could not be asked. */
  installations: GithubInstallationView[] | null;
  /** Where the user installs the App on another account. */
  installUrl: string | null;
  /** The account's live workspaces cloned from GitHub. */
  workspaceCount: number;
  /** Those workspaces, newest first, with the credential each clone used (board 02, note 3). */
  workspaces: GithubWorkspaceView[];
}

export interface GithubWorkspaceView {
  id: string;
  name: string;
  /** The machine's name as the person sees it: its display name, else its name. */
  machine: string | null;
  /** `owner/name`, read from the workspace's repoUrl. */
  repository: string | null;
  cloneState: string | null;
  /** `machine` | `github-app`; null until the runner reports which one the clone used. */
  credential: string | null;
}

/** The most "Workspaces from GitHub" lists. */
const WORKSPACES_LISTED = 200;

/** `https://github.com/<owner>/<name>.git` → `owner/name`. */
function repositoryOf(repoUrl: string | null): string | null {
  const match = repoUrl ? /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(repoUrl) : null;
  return match ? match[1]! : null;
}

interface Listing {
  at: number;
  installations: GithubInstallationView[];
  repositories: GithubRepository[];
}

/**
 * Each account's GitHub connection (§4 `github_connection`, §5.2): connecting through the App's code
 * flow, disconnecting, and the lists the setup card picks from — all read with the account's own
 * user-to-server token, refreshed when it expires.
 */
@Injectable()
export class GithubConnectionService {
  private readonly listings = new Map<string, Listing>();
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: GithubAppConfigService,
    private readonly github: GithubClient,
  ) {}

  async view(ownerId: string): Promise<GithubIntegrationView> {
    const where = { ownerId, githubRepoId: { not: null }, deletedAt: null };
    const [app, row, workspaceCount, workspaces] = await Promise.all([
      this.config.credentials(),
      this.prisma.githubConnection.findUnique({ where: { ownerId } }),
      this.prisma.workspace.count({ where }),
      this.prisma.workspace.findMany({
        where,
        select: {
          id: true, name: true, repoUrl: true, cloneState: true, cloneCredential: true,
          runner: { select: { name: true, displayName: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: WORKSPACES_LISTED,
      }),
    ]);
    const base: GithubIntegrationView = {
      available: app !== null,
      connected: row !== null,
      login: row?.login ?? null,
      connectedAt: row?.createdAt.toISOString() ?? null,
      needsReconnect: false,
      installations: null,
      installUrl: app ? `https://github.com/apps/${app.slug}/installations/new` : null,
      workspaceCount,
      workspaces: workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        machine: w.runner ? (w.runner.displayName || w.runner.name) : null,
        repository: repositoryOf(w.repoUrl),
        cloneState: w.cloneState,
        credential: w.cloneCredential,
      })),
    };
    if (!app || !row) return { ...base, installations: row ? null : [] };
    try {
      // Read afresh: this page is where someone comes back to after installing the App somewhere.
      this.listings.delete(ownerId);
      const listing = await this.listing(ownerId, app);
      return { ...base, installations: listing.installations };
    } catch (error) {
      if (error instanceof ConflictException) return { ...base, needsReconnect: true };
      return base;
    }
  }

  /** Open a flow and answer where to send the browser, with the binding cookie's value (§5.2). */
  async start(ownerId: string, returnTo: unknown): Promise<{ authorizationUrl: string; binding: string }> {
    const app = await this.config.credentials();
    if (!app) throw notConfigured();
    await this.prisma.githubOAuthFlow.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    const state = token();
    const binding = token();
    const codeVerifier = token();
    await this.prisma.githubOAuthFlow.create({
      data: {
        ownerId,
        stateHash: sha256(state),
        bindingHash: sha256(binding),
        codeVerifier,
        returnPath: safeReturnPath(returnTo),
        expiresAt: new Date(Date.now() + GITHUB_FLOW_TTL_MS),
      },
    });
    const authorizationUrl = this.github.authorizationUrl({
      clientId: app.clientId,
      redirectUri: githubCallbackUrl(),
      state,
      codeChallenge: s256(codeVerifier),
    });
    return { authorizationUrl, binding };
  }

  /**
   * GitHub's return (§5.2). Answers only where to send the browser: the page the flow started from with
   * `github=connected`, or with `github_error=<code>`. The flow is taken by its state with one DELETE, so
   * a second callback with the same state finds nothing; it must come from the browser that started it.
   */
  async callback(query: { state?: string; code?: string; error?: string; setupAction?: string }, bindings: string[]): Promise<string> {
    // GitHub's return from installing the App, which carries no state of ours: nothing to connect, back to the page.
    if ((query.state === undefined || query.state === '') && query.setupAction !== undefined) {
      return withQuery(DEFAULT_RETURN, 'github', 'installed');
    }
    const flows = typeof query.state === 'string' && query.state !== ''
      ? await this.prisma.$queryRaw<Array<{ ownerId: string; bindingHash: string; codeVerifier: string; returnPath: string; expiresAt: Date }>>`
          DELETE FROM "github_oauth_flow" WHERE "state_hash" = ${sha256(query.state)}
          RETURNING "owner_id" AS "ownerId", "binding_hash" AS "bindingHash", "code_verifier" AS "codeVerifier",
                    "return_path" AS "returnPath", "expires_at" AS "expiresAt"`
      : [];
    const flow = flows[0];
    if (!flow) return withQuery(DEFAULT_RETURN, 'github_error', 'GITHUB_FLOW_EXPIRED');
    const fail = (code: string) => withQuery(flow.returnPath, 'github_error', code);
    if (flow.expiresAt.getTime() <= Date.now()) return fail('GITHUB_FLOW_EXPIRED');
    if (!bindings.some((binding) => sha256(binding) === flow.bindingHash)) return fail('GITHUB_FLOW_EXPIRED');
    if (query.error !== undefined) return fail('GITHUB_DENIED');
    if (typeof query.code !== 'string' || query.code === '') return fail('GITHUB_EXCHANGE_FAILED');
    const app = await this.config.credentials();
    if (!app) return fail('GITHUB_NOT_CONFIGURED');

    let tokens: GithubUserTokens;
    let user: { id: number; login: string };
    try {
      tokens = await this.github.exchangeCode({
        clientId: app.clientId,
        clientSecret: app.clientSecret,
        redirectUri: githubCallbackUrl(),
        code: query.code,
        codeVerifier: flow.codeVerifier,
      });
      user = await this.github.user(tokens.accessToken);
    } catch {
      return fail('GITHUB_EXCHANGE_FAILED');
    }

    const githubUserId = BigInt(user.id);
    const taken = await this.prisma.githubConnection.findUnique({ where: { githubUserId } });
    if (taken && taken.ownerId !== flow.ownerId) return fail('GITHUB_ACCOUNT_IN_USE');
    const fields = { githubUserId, login: user.login, ...this.stored(tokens) };
    try {
      await this.prisma.githubConnection.upsert({
        where: { ownerId: flow.ownerId },
        create: { ownerId: flow.ownerId, ...fields },
        update: fields,
      });
    } catch (error) {
      // Another account connected the same GitHub account at the same moment.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return fail('GITHUB_ACCOUNT_IN_USE');
      throw error;
    }
    this.listings.delete(flow.ownerId);
    return withQuery(flow.returnPath, 'github', 'connected');
  }

  /** Remove the connection, and revoke its token on GitHub (§5.2). Workspaces stay. */
  async disconnect(ownerId: string): Promise<GithubIntegrationView> {
    const row = await this.prisma.githubConnection.findUnique({ where: { ownerId } });
    if (row) await this.prisma.githubConnection.deleteMany({ where: { id: row.id } });
    this.listings.delete(ownerId);
    const app = await this.config.credentials();
    if (row && app) {
      let accessToken: string | null = null;
      try {
        accessToken = decryptSecret(row.accessTokenEnc);
      } catch {
        accessToken = null;
      }
      // The connection is gone from Orbit whatever GitHub answers; a token GitHub could not be told
      // about expires in its eight hours.
      if (accessToken) await this.github.revoke({ clientId: app.clientId, clientSecret: app.clientSecret, accessToken }).catch(() => undefined);
    }
    return this.view(ownerId);
  }

  /** §5.2: the repositories the account can pick, most recently pushed first, `q` matched in the full name. */
  async repositories(ownerId: string, q: unknown, cursor: unknown): Promise<{ repositories: GithubRepository[]; nextCursor: string | null }> {
    const app = await this.config.credentials();
    if (!app) throw notConfigured();
    const offset = cursor === undefined || cursor === '' ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new BadRequestException('cursor is not one this server gave');
    const needle = typeof q === 'string' ? q.trim().toLowerCase() : '';
    const listing = await this.listing(ownerId, app);
    const matched = needle === '' ? listing.repositories : listing.repositories.filter((repo) => repo.fullName.toLowerCase().includes(needle));
    const page = matched.slice(offset, offset + GITHUB_REPO_PAGE);
    const next = offset + GITHUB_REPO_PAGE;
    return { repositories: page, nextCursor: next < matched.length ? String(next) : null };
  }

  /** §5.2: a repository's branches, the default first. Only a repository the account can pick. */
  async branches(ownerId: string, repoId: string, q: unknown): Promise<{ defaultBranch: string; branches: string[] }> {
    const app = await this.config.credentials();
    if (!app) throw notConfigured();
    const repo = (await this.listing(ownerId, app)).repositories.find((row) => String(row.id) === repoId);
    if (!repo) throw new NotFoundException({ code: 'GITHUB_REPO_NOT_FOUND', message: 'That repository is not one Orbit can reach for you.' });
    const names = await this.call(ownerId, app, (accessToken) => this.github.branches(accessToken, repo.fullName));
    const needle = typeof q === 'string' ? q.trim().toLowerCase() : '';
    // The default branch exists whether or not the pages read reached it, and it is the one most people pick.
    const all = names.includes(repo.defaultBranch) || repo.defaultBranch === '' ? names : [repo.defaultBranch, ...names];
    const matched = all.filter((name) => needle === '' || name.toLowerCase().includes(needle));
    matched.sort((a, b) => (a === repo.defaultBranch ? -1 : b === repo.defaultBranch ? 1 : a.localeCompare(b)));
    return { defaultBranch: repo.defaultBranch, branches: matched };
  }

  /**
   * The repository `repoId` as the account sees it now on GitHub, read with the account's own user-to-server token,
   * or null when the account cannot see it (§5.3's GITHUB_REPO_FORBIDDEN, §5.4's access re-check). `fresh` reads
   * GitHub again rather than the minute-old listing. GitHub off answers GITHUB_NOT_CONFIGURED; no connection, or one
   * GitHub no longer takes, GITHUB_NOT_CONNECTED; GitHub not answering, GITHUB_UNAVAILABLE.
   */
  async reachableRepository(ownerId: string, repoId: string, options: { fresh: boolean }): Promise<GithubRepository | null> {
    const app = await this.config.credentials();
    if (!app) throw notConfigured();
    if (options.fresh) this.listings.delete(ownerId);
    const listing = await this.listing(ownerId, app);
    return listing.repositories.find((repo) => String(repo.id) === repoId) ?? null;
  }

  /** The account's installations and repositories, read from GitHub at most once a minute. */
  private async listing(ownerId: string, app: GithubAppCredentials): Promise<Listing> {
    const cached = this.listings.get(ownerId);
    if (cached && Date.now() - cached.at < GITHUB_LIST_CACHE_MS) return cached;
    const listing = await this.call(ownerId, app, async (accessToken) => {
      const installations = await this.github.installations(accessToken);
      const views: GithubInstallationView[] = [];
      const repositories: GithubRepository[] = [];
      for (const installation of installations) {
        const room = Math.max(0, MAX_LISTED_REPOSITORIES - repositories.length);
        const read = room > 0 ? await this.github.installationRepositories(accessToken, installation.id, room) : { total: 0, repositories: [] };
        views.push({ ...installation, repositoryCount: read.total });
        repositories.push(...read.repositories);
      }
      repositories.sort((a, b) => (b.pushedAt ?? '').localeCompare(a.pushedAt ?? ''));
      return { at: Date.now(), installations: views, repositories };
    });
    this.listings.set(ownerId, listing);
    return listing;
  }

  /**
   * Run `use` with the account's access token. GitHub refusing the token (401) means the user revoked
   * Orbit's authorization: the connection is marked as needing a reconnect, and the call answers
   * GITHUB_NOT_CONNECTED, as does a connection whose refresh token has run out.
   */
  private async call<T>(ownerId: string, app: GithubAppCredentials, use: (accessToken: string) => Promise<T>): Promise<T> {
    const accessToken = await this.accessToken(ownerId, app);
    try {
      return await use(accessToken);
    } catch (error) {
      if (error instanceof GithubCallError && error.status === 401) {
        // A Push as me retirement (retireOwnerToken) may have rotated the pair and revoked this very token while the
        // call was in flight: the connection is live, under its new token, so the call is made once more with it.
        const current = await this.storedAccessToken(ownerId);
        if (current !== null && current !== accessToken) {
          try {
            return await use(current);
          } catch (again) {
            if (!(again instanceof GithubCallError) || again.status !== 401) {
              if (again instanceof GithubCallError) throw unavailable();
              throw again;
            }
          }
        }
        const now = new Date();
        await this.prisma.githubConnection.updateMany({ where: { ownerId }, data: { accessExpiresAt: now, refreshExpiresAt: now } });
        this.listings.delete(ownerId);
        throw notConnected();
      }
      if (error instanceof GithubCallError) throw unavailable();
      throw error;
    }
  }

  /**
   * The owner's own user-to-server token for one Push as me push (docs/design/protected-branch-landing.md §5.2),
   * refreshed first when less than PUSH_TOKEN_MIN_VALIDITY_MS of it is left, with when it expires. GitHub off answers
   * GITHUB_NOT_CONFIGURED; no live connection, GITHUB_NOT_CONNECTED. Never cached outside the stored connection.
   */
  async ownerPushToken(ownerId: string): Promise<{ token: string; expiresAt: Date }> {
    const app = await this.config.credentials();
    if (!app) throw notConfigured();
    const token = await this.accessToken(ownerId, app, PUSH_TOKEN_MIN_VALIDITY_MS);
    const row = await this.prisma.githubConnection.findUnique({ where: { ownerId }, select: { accessExpiresAt: true } });
    if (!row) throw notConnected();
    return { token, expiresAt: row.accessExpiresAt };
  }

  /**
   * docs/design/protected-branch-landing.md §5.3, §16 Q1: retire the token a Push as me push was handed, once the push
   * has reported back. The connection is refreshed first (a new pair stored, the one any later call reads), then the
   * token that was stored before the refresh is revoked with `DELETE /applications/{client_id}/token` — the token Push
   * as me hands out is the stored one — and so is `handed`, when this process remembers a different one. Never the
   * grant: the owner's connection stays live under its new token.
   *
   * Never throws. A refresh GitHub refuses leaves the connection as it is and revokes nothing that is stored (that
   * would leave the connection with a dead token); a revoke GitHub refuses leaves that token to its expiry. Either is
   * answered in `failure` for the caller to record. Nothing here can make a second handout possible: that is the
   * attempt row's compare-and-set (push-as-me.service.ts).
   */
  async retireOwnerToken(ownerId: string, handed: string | null): Promise<OwnerTokenRetirement> {
    const app = await this.config.credentials().catch(() => null);
    if (!app) return { refreshed: false, revoked: 0, failure: 'GitHub is not set up on this Orbit' };
    // One refresh per account at a time: GitHub retires a refresh token the first time it is used.
    await this.refreshing.get(ownerId)?.catch(() => undefined);
    const row = await this.prisma.githubConnection.findUnique({ where: { ownerId } });
    if (!row) return { refreshed: false, revoked: 0, failure: 'the owner has no GitHub connection' };
    const before = this.decrypt(row.accessTokenEnc);
    let rotated: string | null = null;
    let failure: string | null = null;
    const refreshToken = this.decrypt(row.refreshTokenEnc);
    if (refreshToken === null || row.refreshExpiresAt.getTime() <= Date.now()) {
      failure = 'the connection has no refresh token to rotate with';
    } else {
      const rotation = this.github.refresh({ clientId: app.clientId, clientSecret: app.clientSecret, refreshToken })
        .then(async (tokens) => {
          await this.prisma.githubConnection.update({ where: { id: row.id }, data: this.stored(tokens) });
          this.listings.delete(ownerId);
          return tokens.accessToken;
        });
      // Held as the account's refresh, so a call that needs the token meanwhile waits for the new one — or, if the
      // rotation fails, takes the one still stored.
      const held = rotation.catch(() => before ?? '');
      this.refreshing.set(ownerId, held);
      try {
        rotated = await rotation;
      } catch (error) {
        failure = `the refresh failed: ${describeGithubError(error)}`;
      } finally {
        if (this.refreshing.get(ownerId) === held) this.refreshing.delete(ownerId);
      }
    }
    // Revoked: the token stored before the refresh, once it is stored no longer, and the one handed out.
    const targets = new Set<string>();
    if (rotated !== null && before) targets.add(before);
    if (handed && handed !== before) targets.add(handed);
    targets.delete(rotated ?? '');
    let revoked = 0;
    for (const accessToken of targets) {
      try {
        await this.github.revoke({ clientId: app.clientId, clientSecret: app.clientSecret, accessToken });
        revoked += 1;
      } catch (error) {
        failure = [failure, `a revoke failed: ${describeGithubError(error)}`].filter(Boolean).join('; ');
      }
    }
    return { refreshed: rotated !== null, revoked, failure };
  }

  /** The account's stored access token, or null. */
  private async storedAccessToken(ownerId: string): Promise<string | null> {
    const row = await this.prisma.githubConnection.findUnique({ where: { ownerId }, select: { accessTokenEnc: true } });
    return row ? this.decrypt(row.accessTokenEnc) : null;
  }

  private async accessToken(ownerId: string, app: GithubAppCredentials, margin = REFRESH_MARGIN_MS): Promise<string> {
    const row = await this.prisma.githubConnection.findUnique({ where: { ownerId } });
    if (!row) throw notConnected();
    if (row.accessExpiresAt.getTime() - margin > Date.now()) {
      const plain = this.decrypt(row.accessTokenEnc);
      if (plain !== null) return plain;
    }
    // One refresh per account at a time: GitHub retires a refresh token the first time it is used.
    let pending = this.refreshing.get(ownerId);
    if (!pending) {
      pending = this.refresh(row, app, margin).finally(() => this.refreshing.delete(ownerId));
      this.refreshing.set(ownerId, pending);
    }
    return pending;
  }

  private async refresh(read: GithubConnection, app: GithubAppCredentials, margin = REFRESH_MARGIN_MS): Promise<string> {
    // Read again: a refresh that ended between the first read and this one already stored a new pair.
    const row = await this.prisma.githubConnection.findUnique({ where: { id: read.id } });
    if (!row) throw notConnected();
    if (row.accessExpiresAt.getTime() - margin > Date.now()) {
      const plain = this.decrypt(row.accessTokenEnc);
      if (plain !== null) return plain;
    }
    const refreshToken = this.decrypt(row.refreshTokenEnc);
    if (refreshToken === null || row.refreshExpiresAt.getTime() <= Date.now()) throw notConnected();
    let tokens: GithubUserTokens;
    try {
      tokens = await this.github.refresh({ clientId: app.clientId, clientSecret: app.clientSecret, refreshToken });
    } catch (error) {
      if (!(error instanceof GithubCallError) || error.status >= 500) throw unavailable();
      // Another apiserver may have used this refresh token first: take what it stored.
      const now = await this.prisma.githubConnection.findUnique({ where: { ownerId: row.ownerId } });
      if (now && now.accessExpiresAt.getTime() - REFRESH_MARGIN_MS > Date.now()) {
        const plain = this.decrypt(now.accessTokenEnc);
        if (plain !== null) return plain;
      }
      const at = new Date();
      await this.prisma.githubConnection.updateMany({ where: { id: row.id, updatedAt: row.updatedAt }, data: { accessExpiresAt: at, refreshExpiresAt: at } });
      throw notConnected();
    }
    await this.prisma.githubConnection.update({ where: { id: row.id }, data: this.stored(tokens) });
    return tokens.accessToken;
  }

  private stored(tokens: GithubUserTokens) {
    return {
      accessTokenEnc: encryptSecret(tokens.accessToken),
      refreshTokenEnc: tokens.refreshToken === null ? '' : encryptSecret(tokens.refreshToken),
      accessExpiresAt: tokens.accessExpiresAt ?? NEVER,
      refreshExpiresAt: tokens.refreshToken === null ? NEVER : (tokens.refreshExpiresAt ?? NEVER),
    };
  }

  private decrypt(stored: string): string | null {
    if (stored === '') return null;
    try {
      return decryptSecret(stored);
    } catch {
      return null;
    }
  }
}
