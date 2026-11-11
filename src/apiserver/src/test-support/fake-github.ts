import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify } from 'node:crypto';

import { GITHUB_API, GITHUB_WEB } from '../github/github-api.client';

/**
 * GitHub, as far as GitHub-backed workspaces P0 reach it (docs/github-workspace-design.md §5.1, §5.2),
 * in-process: a spec hands `fake.fetch` to `GithubClient`, so nothing reaches the network, and any
 * address it does not know fails the request loudly.
 *
 * It holds the apiserver to what GitHub holds it to: GET /app only with a JWT the App's private key
 * signed, naming the App's ID; a code trades once, for the client that asked for it, with its secret,
 * the same redirect URI and the verifier of the challenge (PKCE); a refresh token trades once; a user
 * token reaches only that user's installations; a revoked or expired token is 401.
 */

export interface FakeRepo {
  id: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string;
  branches: string[];
}

export interface FakeInstallation {
  id: number;
  account: string;
  type: 'User' | 'Organization';
  selection: 'all' | 'selected';
  repos: FakeRepo[];
}

export interface FakeGithubUser {
  id: number;
  login: string;
  installations: FakeInstallation[];
}

interface Grant {
  user: FakeGithubUser;
  clientId: string;
  redirectUri: string;
  challenge: string;
}

interface UserToken {
  user: FakeGithubUser;
  expiresAt: number;
}

const s256 = (verifier: string) => createHash('sha256').update(verifier, 'utf8').digest('base64url');
const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export class FakeGithub {
  readonly privateKey: string;
  /** A key of no App: what a wrong private key is. */
  readonly otherPrivateKey: string;
  readonly appId = 4242;
  readonly slug = 'orbit-fake';
  readonly clientId = 'Iv23liFakeClient';
  readonly clientSecret = 'fake-client-secret-0123456789';
  /** Every token request, its fields as sent. */
  readonly tokenRequests: URLSearchParams[] = [];
  /** Every access and refresh token handed out: none may be answered by the apiserver. */
  readonly issued: string[] = [];
  /** Every access token revoked through DELETE /applications/:client_id/token. */
  readonly revoked: string[] = [];
  /** How long an access token lives, in seconds; null hands out tokens that do not expire. */
  accessLifetime: number | null = 8 * 3600;
  private readonly grants = new Map<string, Grant>();
  private readonly tokens = new Map<string, UserToken>();
  private readonly refreshTokens = new Map<string, FakeGithubUser>();

  constructor() {
    const pem = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    this.privateKey = pem();
    this.otherPrivateKey = pem();
  }

  /** The user approves on GitHub's authorization page: where GitHub sends the browser back. */
  authorize(authorizationUrl: string, user: FakeGithubUser): string {
    const url = new URL(authorizationUrl);
    if (`${url.origin}${url.pathname}` !== `${GITHUB_WEB}/login/oauth/authorize`) throw new Error(`not GitHub's authorization page: ${authorizationUrl}`);
    if (url.searchParams.get('code_challenge_method') !== 'S256') throw new Error('no S256 challenge');
    const code = randomBytes(10).toString('hex');
    this.grants.set(code, {
      user,
      clientId: url.searchParams.get('client_id') ?? '',
      redirectUri: url.searchParams.get('redirect_uri') ?? '',
      challenge: url.searchParams.get('code_challenge') ?? '',
    });
    const back = new URL(url.searchParams.get('redirect_uri') ?? '');
    back.searchParams.set('code', code);
    back.searchParams.set('state', url.searchParams.get('state') ?? '');
    return `${back.pathname}${back.search}`;
  }

  /** Every access token of this user stops working, as when they revoke Orbit's authorization on GitHub. */
  revokeAll(user: FakeGithubUser): void {
    for (const [token, held] of this.tokens) if (held.user === user) this.tokens.delete(token);
    for (const [token, held] of this.refreshTokens) if (held === user) this.refreshTokens.delete(token);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const auth = headers.get('authorization') ?? '';
    if (url.origin === GITHUB_WEB && url.pathname === '/login/oauth/access_token' && method === 'POST') {
      return this.token(new URLSearchParams(String(init?.body ?? '')));
    }
    if (url.origin !== GITHUB_API) throw new Error(`the fake GitHub does not serve ${url.href}`);
    if (method === 'GET' && url.pathname === '/app') return this.app(auth);
    if (method === 'DELETE' && url.pathname === `/applications/${this.clientId}/token`) {
      if (auth !== `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`) return json(401, { message: 'Bad credentials' });
      const token = (JSON.parse(String(init?.body ?? '{}')) as { access_token?: string }).access_token ?? '';
      if (!this.tokens.delete(token)) return json(404, { message: 'Not Found' });
      this.revoked.push(token);
      return new Response(null, { status: 204 });
    }
    const held = auth.startsWith('Bearer ') ? this.tokens.get(auth.slice(7)) : undefined;
    if (!held || held.expiresAt <= Date.now()) return json(401, { message: 'Bad credentials' });
    const user = held.user;
    if (method === 'GET' && url.pathname === '/user') return json(200, { id: user.id, login: user.login });
    if (method === 'GET' && url.pathname === '/user/installations') {
      return json(200, {
        total_count: user.installations.length,
        installations: user.installations.map((i) => ({ id: i.id, account: { login: i.account, type: i.type }, repository_selection: i.selection })),
      });
    }
    const repos = /^\/user\/installations\/(\d+)\/repositories$/.exec(url.pathname);
    if (method === 'GET' && repos) {
      const installation = user.installations.find((i) => i.id === Number(repos[1]));
      if (!installation) return json(404, { message: 'Not Found' });
      const perPage = Number(url.searchParams.get('per_page') ?? 30);
      const page = Number(url.searchParams.get('page') ?? 1);
      return json(200, {
        total_count: installation.repos.length,
        repositories: installation.repos.slice((page - 1) * perPage, page * perPage).map((r) => ({
          id: r.id, full_name: r.fullName, private: r.private, default_branch: r.defaultBranch, pushed_at: r.pushedAt,
        })),
      });
    }
    const branches = /^\/repos\/([^/]+\/[^/]+)\/branches$/.exec(url.pathname);
    if (method === 'GET' && branches) {
      const repo = user.installations.flatMap((i) => i.repos).find((r) => r.fullName === branches[1]);
      if (!repo) return json(404, { message: 'Not Found' });
      return json(200, repo.branches.map((name) => ({ name })));
    }
    throw new Error(`the fake GitHub does not serve ${method} ${url.pathname}`);
  };

  private app(auth: string): Response {
    const jwt = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const [head, body, signature] = jwt.split('.');
    if (!head || !body || !signature) return json(401, { message: 'A JSON web token could not be decoded' });
    const ok = verify('RSA-SHA256', Buffer.from(`${head}.${body}`), createPublicKey(this.privateKey), Buffer.from(signature, 'base64url'));
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { iss?: unknown; exp?: number };
    if (String(claims.iss) !== String(this.appId)) return json(404, { message: 'Integration not found' });
    if (!ok || (claims.exp ?? 0) * 1000 <= Date.now()) return json(401, { message: "'Issuer' claim ('iss') must be an Integer" });
    return json(200, { id: this.appId, slug: this.slug, client_id: this.clientId, name: 'Orbit (fake)' });
  }

  private token(form: URLSearchParams): Response {
    this.tokenRequests.push(form);
    if (form.get('client_id') !== this.clientId || form.get('client_secret') !== this.clientSecret) {
      return json(200, { error: 'incorrect_client_credentials' });
    }
    let user: FakeGithubUser | undefined;
    if (form.get('grant_type') === 'refresh_token') {
      const refresh = form.get('refresh_token') ?? '';
      user = this.refreshTokens.get(refresh);
      this.refreshTokens.delete(refresh);
      if (!user) return json(200, { error: 'bad_refresh_token' });
    } else {
      const code = form.get('code') ?? '';
      const grant = this.grants.get(code);
      this.grants.delete(code);
      if (!grant || grant.clientId !== this.clientId || grant.redirectUri !== form.get('redirect_uri')
        || grant.challenge !== s256(form.get('code_verifier') ?? '')) {
        return json(200, { error: 'bad_verification_code' });
      }
      user = grant.user;
    }
    const access = `ghu_${randomBytes(18).toString('hex')}`;
    const lifetime = this.accessLifetime;
    this.tokens.set(access, { user, expiresAt: lifetime === null ? Number.MAX_SAFE_INTEGER : Date.now() + lifetime * 1000 });
    this.issued.push(access);
    if (lifetime === null) return json(200, { access_token: access, token_type: 'bearer', scope: '' });
    const refresh = `ghr_${randomBytes(30).toString('hex')}`;
    this.refreshTokens.set(refresh, user);
    this.issued.push(refresh);
    return json(200, {
      access_token: access, expires_in: lifetime, refresh_token: refresh, refresh_token_expires_in: 15_897_600, token_type: 'bearer', scope: '',
    });
  }
}
