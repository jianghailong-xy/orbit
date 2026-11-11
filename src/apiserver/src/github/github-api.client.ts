import { Logger } from '@nestjs/common';
import { createPrivateKey, createSign } from 'node:crypto';

/**
 * GitHub, as far as GitHub-backed workspaces reach it (docs/github-workspace-design.md §3, §5.1, §5.2).
 * Fixed addresses: neither a setting nor a request can point a call anywhere else. It speaks with the
 * global `fetch` unless handed another, which is how the specs put a fake GitHub in its place.
 */
export const GITHUB_WEB = 'https://github.com';
export const GITHUB_API = 'https://api.github.com';

/** A call's budget: a page or a save waits on it, and a GitHub that does not answer is a failure. */
const REQUEST_TIMEOUT_MS = 15_000;

/** The repositories one listing reads at most, across every installation: 10 pages of 100 each. */
export const MAX_LISTED_REPOSITORIES = 1_000;

/** GitHub answered, but not with what was asked: a refusal (`status` 4xx) or a failure. */
export class GithubCallError extends Error {
  constructor(
    readonly status: number,
    readonly githubError: string | null,
  ) {
    super(`GitHub answered ${status}${githubError ? ` ${githubError}` : ''}`);
  }
}

/** What GET /app answers that Orbit reads. */
export interface GithubApp {
  id: number;
  slug: string;
  clientId: string;
}

/** A user-to-server token, as GitHub hands it out. Null expiries: the App's user tokens do not expire. */
export interface GithubUserTokens {
  accessToken: string;
  refreshToken: string | null;
  accessExpiresAt: Date | null;
  refreshExpiresAt: Date | null;
}

export interface GithubInstallation {
  id: number;
  account: string;
  /** `User` | `Organization`. */
  type: string;
  /** `all` | `selected`. */
  repositorySelection: string;
}

export interface GithubRepository {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  installationId: number;
  pushedAt: string | null;
}

/** The App's own credential for GET /app (§5.1): an RS256 JWT, issued a minute back for clock drift, valid nine. */
export function appJwt(appId: string, privateKeyPem: string, now = Date.now()): string {
  const seconds = Math.floor(now / 1000);
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: seconds - 60, exp: seconds + 540, iss: appId })}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(createPrivateKey(privateKeyPem)).toString('base64url');
  return `${unsigned}.${signature}`;
}

/** Whether a PEM is a private key node can sign with; never says why not. */
export function isPrivateKey(pem: string): boolean {
  try {
    return createPrivateKey(pem).asymmetricKeyType === 'rsa';
  } catch {
    return false;
  }
}

const expiry = (seconds: unknown, now: number): Date | null =>
  typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? new Date(now + seconds * 1000) : null;

export class GithubClient {
  private readonly log = new Logger('GitHub');

  constructor(private readonly request: typeof fetch = fetch) {}

  /** §5.2: the authorization page, with the state and GitHub's side of PKCE. No scope: a GitHub App has none. */
  authorizationUrl(input: { clientId: string; redirectUri: string; state: string; codeChallenge: string }): string {
    const query = new URLSearchParams({
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${GITHUB_WEB}/login/oauth/authorize?${query}`;
  }

  /** GET /app with the App's JWT (§5.1). A 401 is a key that is not this App's. */
  async app(appId: string, privateKeyPem: string): Promise<GithubApp> {
    const answer = await this.api<{ id?: unknown; slug?: unknown; client_id?: unknown }>('GET', '/app', `Bearer ${appJwt(appId, privateKeyPem)}`);
    if (typeof answer.id !== 'number' || typeof answer.slug !== 'string') throw new GithubCallError(502, 'unexpected answer');
    return { id: answer.id, slug: answer.slug, clientId: typeof answer.client_id === 'string' ? answer.client_id : '' };
  }

  /** Trade the callback's code for the user's tokens (§5.2). */
  exchangeCode(input: { clientId: string; clientSecret: string; redirectUri: string; code: string; codeVerifier: string }): Promise<GithubUserTokens> {
    return this.token({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    });
  }

  /** Trade a refresh token for a new pair; GitHub retires the one presented. */
  refresh(input: { clientId: string; clientSecret: string; refreshToken: string }): Promise<GithubUserTokens> {
    return this.token({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
    });
  }

  async user(accessToken: string): Promise<{ id: number; login: string }> {
    const answer = await this.api<{ id?: unknown; login?: unknown }>('GET', '/user', `Bearer ${accessToken}`);
    if (typeof answer.id !== 'number' || typeof answer.login !== 'string') throw new GithubCallError(502, 'unexpected answer');
    return { id: answer.id, login: answer.login };
  }

  /** The App's installations this user can reach. */
  async installations(accessToken: string): Promise<GithubInstallation[]> {
    const answer = await this.api<{ installations?: Array<Record<string, unknown>> }>(
      'GET', '/user/installations?per_page=100', `Bearer ${accessToken}`,
    );
    return (answer.installations ?? []).map((row) => {
      const account = (row.account ?? {}) as { login?: unknown; type?: unknown };
      return {
        id: Number(row.id),
        account: typeof account.login === 'string' ? account.login : '',
        type: typeof account.type === 'string' ? account.type : 'User',
        repositorySelection: row.repository_selection === 'all' ? 'all' : 'selected',
      };
    });
  }

  /** The repositories of one installation this user can reach, up to `limit`, with how many there are. */
  async installationRepositories(accessToken: string, installationId: number, limit: number): Promise<{ total: number; repositories: GithubRepository[] }> {
    const repositories: GithubRepository[] = [];
    let total = 0;
    for (let page = 1; repositories.length < limit; page += 1) {
      const answer = await this.api<{ total_count?: unknown; repositories?: Array<Record<string, unknown>> }>(
        'GET', `/user/installations/${installationId}/repositories?per_page=100&page=${page}`, `Bearer ${accessToken}`,
      );
      total = typeof answer.total_count === 'number' ? answer.total_count : 0;
      const rows = answer.repositories ?? [];
      for (const row of rows) {
        repositories.push({
          id: Number(row.id),
          fullName: String(row.full_name ?? ''),
          private: row.private === true,
          defaultBranch: String(row.default_branch ?? ''),
          installationId,
          pushedAt: typeof row.pushed_at === 'string' ? row.pushed_at : null,
        });
      }
      if (rows.length < 100 || repositories.length >= total) break;
    }
    return { total, repositories: repositories.slice(0, limit) };
  }

  /** A repository's branch names, the first 100. */
  async branches(accessToken: string, fullName: string): Promise<string[]> {
    const answer = await this.api<Array<{ name?: unknown }>>('GET', `/repos/${fullName}/branches?per_page=100`, `Bearer ${accessToken}`);
    return (Array.isArray(answer) ? answer : []).map((row) => String(row.name ?? '')).filter((name) => name !== '');
  }

  /** Revoke a user token (§5.2 DELETE). Already revoked or expired (404) is done too. */
  async revoke(input: { clientId: string; clientSecret: string; accessToken: string }): Promise<void> {
    const basic = Buffer.from(`${input.clientId}:${input.clientSecret}`).toString('base64');
    try {
      await this.api('DELETE', `/applications/${encodeURIComponent(input.clientId)}/token`, `Basic ${basic}`, { access_token: input.accessToken });
    } catch (error) {
      if (error instanceof GithubCallError && error.status === 404) return;
      throw error;
    }
  }

  private async token(form: Record<string, string>): Promise<GithubUserTokens> {
    let status: number;
    let answer: Record<string, unknown> | null;
    try {
      const response = await this.request(`${GITHUB_WEB}/login/oauth/access_token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'Orbit' },
        body: new URLSearchParams(form).toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = response.status;
      answer = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    } catch {
      this.log.warn("GitHub's token endpoint could not be reached");
      throw new GithubCallError(502, 'unreachable');
    }
    // GitHub answers a refused code or refresh token 200 with an `error`.
    const error = typeof answer?.error === 'string' ? answer.error.slice(0, 64) : null;
    if (status < 200 || status > 299 || error !== null || typeof answer?.access_token !== 'string') {
      this.log.warn(`GitHub's token endpoint refused: ${status}${error ? ` ${error}` : ''}`);
      throw new GithubCallError(status >= 400 ? status : 400, error);
    }
    const now = Date.now();
    return {
      accessToken: answer.access_token,
      refreshToken: typeof answer.refresh_token === 'string' && answer.refresh_token !== '' ? answer.refresh_token : null,
      accessExpiresAt: expiry(answer.expires_in, now),
      refreshExpiresAt: expiry(answer.refresh_token_expires_in, now),
    };
  }

  private async api<T>(method: string, route: string, authorization: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.request(`${GITHUB_API}${route}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization,
          'user-agent': 'Orbit',
          'x-github-api-version': '2022-11-28',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      this.log.warn(`GitHub could not be reached: ${method} ${route.split('?')[0]}`);
      throw new GithubCallError(502, 'unreachable');
    }
    if (response.status === 204) return undefined as T;
    const answer = (await response.json().catch(() => null)) as T & { message?: unknown };
    if (!response.ok) {
      const message = typeof answer?.message === 'string' ? answer.message.slice(0, 120) : null;
      this.log.warn(`GitHub refused ${method} ${route.split('?')[0]}: ${response.status}${message ? ` ${message}` : ''}`);
      throw new GithubCallError(response.status, message);
    }
    return answer;
  }
}
