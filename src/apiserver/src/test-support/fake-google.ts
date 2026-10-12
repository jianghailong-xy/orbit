import { createHash, randomBytes } from 'node:crypto';

import { GOOGLE_AUTHORIZATION_ENDPOINT, GOOGLE_TOKEN_ENDPOINT } from '../auth/google-oauth.client';

/**
 * Google, as far as signing in to Orbit reaches it (docs/google-sign-in-design.md §4), in-process:
 * the authorization page a browser is sent to, which hands it back a code, and the token endpoint
 * that trades that code for an ID token. A spec hands `fake.fetch` to `GoogleOAuthClient` in place of
 * the global one, so no spec reaches the network; any other address it is asked for fails the spec.
 *
 * It holds the apiserver to what Google holds it to: the token request must come from the client the
 * authorization named, with its secret, the same redirect URI and the verifier of the code challenge
 * the authorization carried (Google's side of PKCE), and a code trades once. What it answers is what
 * a case asks for: by default a well-formed ID token for the account that signed in, with the nonce
 * the authorization carried; `claims` changes any claim, and `tokenAnswer` breaks the answer itself.
 */

/** A Google account the fake signs in as. */
export interface FakeGoogleAccount {
  sub: string;
  email: string;
  hd?: string;
  name?: string;
}

/** How the token endpoint answers, when not as Google would to a good request. */
export type FakeTokenAnswer =
  | 'ok'
  /** HTTP 400 `invalid_grant`, as for a bad, used or expired code. */
  | 'refused'
  /** Google cannot be reached: the request throws. */
  | 'unreachable'
  /** 200 with a body that is not JSON. */
  | 'not-json'
  /** 200 with JSON that carries no `id_token`. */
  | 'no-id-token'
  /** 200 with an `id_token` that is not a JWT. */
  | 'not-a-jwt';

interface Grant {
  account: FakeGoogleAccount;
  clientId: string;
  redirectUri: string;
  nonce: string;
  codeChallenge: string;
  claims: Record<string, unknown>;
}

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

export class FakeGoogle {
  /** Every token request the endpoint received, its form fields as sent. */
  readonly tokenRequests: URLSearchParams[] = [];
  /** Every access token the endpoint handed out: none may be stored or answered anywhere. */
  readonly accessTokens: string[] = [];
  /** How the token endpoint answers the next requests. */
  tokenAnswer: FakeTokenAnswer = 'ok';
  /**
   * Google trades a code once. Off, it trades one as often as it is presented: what a case needs to
   * show that the apiserver does not lean on that — two callbacks with one state still get one ticket.
   */
  codesTradeOnce = true;
  private readonly grants = new Map<string, Grant>();
  private barrier?: { size: number; arrived: Array<() => void> };

  /**
   * Hold the next `size` token requests until all of them have arrived, then answer them together:
   * how a case makes callbacks race past every check before any of them writes. Released after five
   * seconds whatever arrived, so a case that sends fewer fails on its assertions rather than hanging.
   */
  holdTokenRequests(size: number): void {
    const barrier = { size, arrived: [] as Array<() => void> };
    this.barrier = barrier;
    setTimeout(() => this.release(barrier), 5_000).unref();
  }

  private release(barrier: { arrived: Array<() => void> }): void {
    if (this.barrier === barrier) this.barrier = undefined;
    for (const resolve of barrier.arrived.splice(0)) resolve();
  }

  constructor(
    readonly clientId: string,
    readonly clientSecret: string,
  ) {}

  /**
   * The browser at Google's authorization page, `account` signing in: the request is read as Google
   * reads it, and the answer is where Google sends the browser back — the callback's path and query,
   * with a fresh code and the state the request carried. `claims` are laid over the ID token's.
   */
  authorize(authorizationUrl: string, account: FakeGoogleAccount, claims: Record<string, unknown> = {}): string {
    const url = new URL(authorizationUrl);
    if (`${url.origin}${url.pathname}` !== GOOGLE_AUTHORIZATION_ENDPOINT) throw new Error(`not Google's authorization page: ${authorizationUrl}`);
    const query = url.searchParams;
    const one = (name: string) => {
      const values = query.getAll(name);
      if (values.length !== 1) throw new Error(`the authorization request carries ${values.length} ${name}`);
      return values[0];
    };
    if (one('response_type') !== 'code') throw new Error('response_type is not code');
    if (one('client_id') !== this.clientId) throw new Error('an unknown client');
    if (one('code_challenge_method') !== 'S256') throw new Error('PKCE is not S256');
    const code = `4/0A${randomBytes(24).toString('base64url')}`;
    this.grants.set(code, {
      account,
      clientId: one('client_id'),
      redirectUri: one('redirect_uri'),
      nonce: one('nonce'),
      codeChallenge: one('code_challenge'),
      claims,
    });
    const back = new URL(one('redirect_uri'));
    back.search = new URLSearchParams({ state: one('state'), code, scope: 'email profile openid' }).toString();
    return `${back.pathname}${back.search}`;
  }

  /** The person declines at Google: back to the callback with `error=access_denied` and the state. */
  deny(authorizationUrl: string): string {
    const query = new URL(authorizationUrl).searchParams;
    const back = new URL(query.get('redirect_uri')!);
    back.search = new URLSearchParams({ error: 'access_denied', state: query.get('state')! }).toString();
    return `${back.pathname}${back.search}`;
  }

  /** The ID token the endpoint would issue for a grant: header, claims and a signature nobody checks. */
  private idToken(grant: Grant): string {
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: 'https://accounts.google.com',
      azp: grant.clientId,
      aud: grant.clientId,
      sub: grant.account.sub,
      email: grant.account.email,
      email_verified: true,
      at_hash: randomBytes(16).toString('base64url'),
      nonce: grant.nonce,
      ...(grant.account.hd === undefined ? {} : { hd: grant.account.hd }),
      ...(grant.account.name === undefined ? {} : { name: grant.account.name }),
      iat: now,
      exp: now + 3600,
      ...grant.claims,
    };
    return `${b64url({ alg: 'RS256', kid: 'fake-google', typ: 'JWT' })}.${b64url(claims)}.${randomBytes(64).toString('base64url')}`;
  }

  /** The global fetch's stand-in: Google's token endpoint, and nothing else. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url !== GOOGLE_TOKEN_ENDPOINT) throw new Error(`the fake Google has no ${url}`);
    if (init?.method !== 'POST') throw new Error('the token endpoint takes POST');
    const form = new URLSearchParams(String(init.body));
    this.tokenRequests.push(form);
    const barrier = this.barrier;
    if (barrier) {
      await new Promise<void>((resolve) => {
        barrier.arrived.push(resolve);
        if (barrier.arrived.length >= barrier.size) this.release(barrier);
      });
    }
    if (this.tokenAnswer === 'unreachable') throw new TypeError('fetch failed');
    const refuse = (error: string) => new Response(JSON.stringify({ error }), { status: 400, headers: { 'content-type': 'application/json' } });
    const grant = this.grants.get(form.get('code') ?? '');
    // A code trades once, whatever the answer.
    if (this.codesTradeOnce) this.grants.delete(form.get('code') ?? '');
    if (!grant || form.get('grant_type') !== 'authorization_code') return refuse('invalid_grant');
    if (form.get('client_id') !== grant.clientId || form.get('client_secret') !== this.clientSecret) return refuse('invalid_client');
    if (form.get('redirect_uri') !== grant.redirectUri) return refuse('redirect_uri_mismatch');
    const verifier = form.get('code_verifier') ?? '';
    if (createHash('sha256').update(verifier).digest('base64url') !== grant.codeChallenge) return refuse('invalid_grant');
    if (this.tokenAnswer === 'refused') return refuse('invalid_grant');
    if (this.tokenAnswer === 'not-json') return new Response('<html>Bad Gateway</html>', { status: 200, headers: { 'content-type': 'text/html' } });
    const accessToken = `ya29.${randomBytes(32).toString('base64url')}`;
    this.accessTokens.push(accessToken);
    const body: Record<string, unknown> = {
      access_token: accessToken,
      expires_in: 3599,
      scope: 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile',
      token_type: 'Bearer',
    };
    if (this.tokenAnswer === 'not-a-jwt') body.id_token = 'not-a-jwt';
    else if (this.tokenAnswer !== 'no-id-token') body.id_token = this.idToken(grant);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}
