import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

/**
 * Google's two endpoints this server talks to (docs/google-sign-in-design.md §4.1, §4.2). Fixed:
 * neither a setting nor a request can point a sign-in anywhere else.
 */
export const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** The two spellings of Google's issuer an ID token carries. */
export const GOOGLE_ISSUERS: readonly string[] = ['https://accounts.google.com', 'accounts.google.com'];

/** How long past its `exp` an ID token is still taken, for clocks that differ (§4.2 step 5). */
export const ID_TOKEN_CLOCK_SKEW_MS = 60_000;

/** The token request's budget: a sign-in waits on it, and a Google that does not answer is a failure. */
const TOKEN_REQUEST_TIMEOUT_MS = 10_000;

/** The S256 challenge of a PKCE verifier (RFC 7636 §4.2): base64url of its sha256, unpadded. */
export function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

/** What an authorization request carries besides the fixed parameters (§4.1). */
export interface GoogleAuthorizationRequest {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  /** Google's side of PKCE: the S256 of the verifier this server keeps for the code exchange. */
  codeChallenge: string;
}

/** The claims of a Google ID token this server reads (§4.2 step 5). Untrusted until verified. */
export interface GoogleIdTokenClaims {
  iss?: unknown;
  aud?: unknown;
  azp?: unknown;
  exp?: unknown;
  nonce?: unknown;
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  hd?: unknown;
  name?: unknown;
}

/** A Google identity whose ID token passed every check: what the flow keeps (§4.2 step 6). */
export interface VerifiedGoogleIdentity {
  sub: string;
  email: string;
  emailVerified: true;
  hd: string | null;
  name: string | null;
}

/**
 * What became of an ID token. A refusal names the claim that failed, for the log, and the code the
 * client is sent back with: GOOGLE_EMAIL_UNVERIFIED for an email Google does not vouch for (§4.2
 * step 5), and GOOGLE_EXCHANGE_FAILED for every other claim — a token that is not this sign-in's is
 * a failed exchange as far as the person signing in can tell.
 */
export type GoogleClaimsVerdict =
  | { ok: true; identity: VerifiedGoogleIdentity }
  | {
      ok: false;
      code: 'GOOGLE_EXCHANGE_FAILED' | 'GOOGLE_EMAIL_UNVERIFIED';
      claim: 'iss' | 'aud' | 'azp' | 'exp' | 'nonce' | 'sub' | 'email_verified' | 'email';
    };

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/**
 * The checks of §4.2 step 5, in OIDC Core 3.1.3.7's order. No signature is checked: the token came
 * straight from Google's token endpoint over TLS, which 3.1.3.7 step 6 accepts in place of one, so
 * there is no JWKS to fetch and no dependency to add.
 *
 *  - `iss` is one of Google's two spellings;
 *  - `aud` is this client — or, as a list, contains it — and `azp`, which a list of audiences
 *    requires, is this client too wherever it is present;
 *  - `exp` is not past, give or take ID_TOKEN_CLOCK_SKEW_MS;
 *  - `nonce` is the flow's;
 *  - `sub` is not empty;
 *  - `email_verified` is `true` — the boolean, nothing that merely reads as true — and there is an email.
 */
export function verifyGoogleIdTokenClaims(
  claims: GoogleIdTokenClaims,
  expected: { clientId: string; nonce: string; now: number },
): GoogleClaimsVerdict {
  const refuse = (claim: Extract<GoogleClaimsVerdict, { ok: false }>['claim']): GoogleClaimsVerdict => ({
    ok: false,
    code: claim === 'email_verified' || claim === 'email' ? 'GOOGLE_EMAIL_UNVERIFIED' : 'GOOGLE_EXCHANGE_FAILED',
    claim,
  });
  if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.includes(claims.iss)) return refuse('iss');
  const audiences = typeof claims.aud === 'string'
    ? [claims.aud]
    : Array.isArray(claims.aud) && claims.aud.every((aud) => typeof aud === 'string') ? (claims.aud as string[]) : [];
  if (!audiences.includes(expected.clientId)) return refuse('aud');
  if ((Array.isArray(claims.aud) || claims.azp !== undefined) && claims.azp !== expected.clientId) return refuse('azp');
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)
    || claims.exp * 1000 + ID_TOKEN_CLOCK_SKEW_MS <= expected.now) return refuse('exp');
  if (typeof claims.nonce !== 'string' || claims.nonce !== expected.nonce) return refuse('nonce');
  const sub = text(claims.sub);
  if (sub === null) return refuse('sub');
  if (claims.email_verified !== true) return refuse('email_verified');
  const email = text(claims.email);
  if (email === null) return refuse('email');
  return { ok: true, identity: { sub, email, emailVerified: true, hd: text(claims.hd), name: text(claims.name) } };
}

/** The payload of a JWT, read and not verified: null for anything that is not one. */
export function jwtPayload(jwt: string): GoogleIdTokenClaims | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? (payload as GoogleIdTokenClaims) : null;
  } catch {
    return null;
  }
}

/**
 * The Google side of signing in (§4): the address a browser is sent to, and the trade of the code it
 * comes back with for an ID token. It speaks to Google with the global `fetch` unless it is handed
 * another, which is how the specs put a fake Google in its place: none of them reaches the network.
 */
export class GoogleOAuthClient {
  private readonly log = new Logger('GoogleSignIn');

  constructor(private readonly request: typeof fetch = fetch) {}

  /** §4.1: openid email profile, the account chooser every time, and Google's side of PKCE. */
  authorizationUrl(input: GoogleAuthorizationRequest): string {
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      scope: 'openid email profile',
      state: input.state,
      nonce: input.nonce,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    return `${GOOGLE_AUTHORIZATION_ENDPOINT}?${query}`;
  }

  /**
   * §4.2 step 4: the code, the client secret and Google's code verifier for the ID token's claims,
   * read and not yet verified — or null when Google refused, could not be reached in time, or
   * answered without an ID token. Nothing else is taken from the answer: the access token, and a
   * refresh token were there one, are dropped here unread, kept nowhere and logged nowhere. A failure
   * is logged with what an administrator can act on — Google's error code, such as `invalid_client`
   * for a secret that is not the client's — and nothing of the request or the answer besides.
   */
  async exchangeCode(input: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
    codeVerifier: string;
  }): Promise<GoogleIdTokenClaims | null> {
    let answer: { id_token?: unknown; error?: unknown } | null;
    let status: number;
    try {
      const response = await this.request(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: input.code,
          client_id: input.clientId,
          client_secret: input.clientSecret,
          redirect_uri: input.redirectUri,
          code_verifier: input.codeVerifier,
        }).toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      });
      status = response.status;
      answer = (await response.json().catch(() => null)) as typeof answer;
    } catch {
      this.log.warn("Google's token endpoint could not be reached");
      return null;
    }
    if (status < 200 || status > 299) {
      const error = typeof answer?.error === 'string' ? ` ${answer.error.slice(0, 64)}` : '';
      this.log.warn(`Google's token endpoint refused the code: ${status}${error}`);
      return null;
    }
    const claims = typeof answer?.id_token === 'string' ? jwtPayload(answer.id_token) : null;
    if (!claims) this.log.warn("Google's token endpoint answered without an ID token");
    return claims;
  }
}
