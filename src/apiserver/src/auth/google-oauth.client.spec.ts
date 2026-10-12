import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Logger } from '@nestjs/common';

import { FakeGoogle } from '../test-support/fake-google';
import {
  GOOGLE_TOKEN_ENDPOINT,
  GoogleOAuthClient,
  type GoogleIdTokenClaims,
  jwtPayload,
  s256,
  verifyGoogleIdTokenClaims,
} from './google-oauth.client';

/**
 * The Google side of signing in (docs/google-sign-in-design.md §4.1, §4.2 steps 4–5): the
 * authorization request, the code exchange at the token endpoint, and the checks an ID token's claims
 * must pass. Google is the in-process fake (test-support/fake-google.ts); nothing reaches the network.
 */

/** What the client logged, kept here rather than printed. */
const logged: string[] = [];
const keep = (message: unknown) => { logged.push(String(message)); };
Logger.overrideLogger({ log: keep, warn: keep, error: keep, debug: keep, verbose: keep });

const CLIENT_ID = '1234-abc.apps.googleusercontent.com';
const NONCE = 'n-0S6_WzA2Mj';
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const SECONDS = Math.floor(NOW / 1000);

/** Claims that pass every check; each case changes what it is about. */
const GOOD: GoogleIdTokenClaims = {
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  azp: CLIENT_ID,
  exp: SECONDS + 3600,
  nonce: NONCE,
  sub: '110169484474386276334',
  email: 'ada@example.com',
  email_verified: true,
  hd: 'example.com',
  name: 'Ada Lovelace',
};

const verify = (over: Record<string, unknown>, drop: string[] = []) => {
  const claims: Record<string, unknown> = { ...GOOD, ...over };
  for (const name of drop) delete claims[name];
  return verifyGoogleIdTokenClaims(claims, { clientId: CLIENT_ID, nonce: NONCE, now: NOW });
};

test('S256 is RFC 7636 Appendix B: base64url of the sha256, unpadded', () => {
  assert.equal(s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('the authorization request: Google\'s fixed page, openid email profile, the account chooser, state, nonce and S256 PKCE', () => {
  const url = new URL(new GoogleOAuthClient(async () => assert.fail('no request is made')).authorizationUrl({
    clientId: CLIENT_ID,
    redirectUri: 'https://orbit.example.test/api/auth/google/callback',
    state: 'the-state',
    nonce: NONCE,
    codeChallenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  }));
  assert.equal(`${url.origin}${url.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.deepEqual([...url.searchParams].sort(), [
    ['client_id', CLIENT_ID],
    ['code_challenge', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'],
    ['code_challenge_method', 'S256'],
    ['nonce', NONCE],
    ['prompt', 'select_account'],
    ['redirect_uri', 'https://orbit.example.test/api/auth/google/callback'],
    ['response_type', 'code'],
    ['scope', 'openid email profile'],
    ['state', 'the-state'],
  ]);
});

test('the code exchange posts the code, the client and Google\'s verifier, and answers the ID token\'s claims and nothing else', async () => {
  const google = new FakeGoogle(CLIENT_ID, 'GOCSPX-secret');
  const client = new GoogleOAuthClient(google.fetch);
  const redirectUri = 'https://orbit.example.test/api/auth/google/callback';
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const authorization = client.authorizationUrl({ clientId: CLIENT_ID, redirectUri, state: 's', nonce: NONCE, codeChallenge: s256(verifier) });
  const code = new URLSearchParams(google.authorize(authorization, { sub: '42', email: 'ada@gmail.com', name: 'Ada' }).split('?')[1]).get('code')!;

  let sent: RequestInit | undefined;
  const claims = await new GoogleOAuthClient(async (input, init) => {
    assert.equal(input, GOOGLE_TOKEN_ENDPOINT);
    sent = init;
    return google.fetch(input, init);
  }).exchangeCode({ clientId: CLIENT_ID, clientSecret: 'GOCSPX-secret', redirectUri, code, codeVerifier: verifier });

  assert.equal(sent?.method, 'POST');
  assert.equal(sent?.redirect, 'error', 'a redirect from the token endpoint is a failure, not a hop');
  assert.equal((sent?.headers as Record<string, string>)['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual([...google.tokenRequests[0]].sort(), [
    ['client_id', CLIENT_ID],
    ['client_secret', 'GOCSPX-secret'],
    ['code', code],
    ['code_verifier', verifier],
    ['grant_type', 'authorization_code'],
    ['redirect_uri', redirectUri],
  ]);
  assert.ok(claims);
  assert.equal(claims.sub, '42');
  assert.equal(claims.nonce, NONCE);
  assert.equal(claims.aud, CLIENT_ID);
  // The answer carried an access token; what the client hands back is the ID token's claims alone.
  assert.equal(google.accessTokens.length, 1);
  assert.ok(!JSON.stringify(claims).includes(google.accessTokens[0]));
  assert.ok(!('access_token' in claims) && !('id_token' in claims));

  // A code trades once.
  const again = await client.exchangeCode({ clientId: CLIENT_ID, clientSecret: 'GOCSPX-secret', redirectUri, code, codeVerifier: verifier });
  assert.equal(again, null);
});

test('the code exchange fails — null — when Google refuses, cannot be reached, or answers without an ID token, and logs why without a secret', async () => {
  logged.length = 0;
  const codes: string[] = [];
  const accessTokens: string[] = [];
  const redirectUri = 'https://orbit.example.test/api/auth/google/callback';
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const attempt = async (setup: (google: FakeGoogle) => void, input: { codeVerifier?: string; clientSecret?: string } = {}) => {
    const google = new FakeGoogle(CLIENT_ID, 'GOCSPX-secret');
    setup(google);
    const client = new GoogleOAuthClient(google.fetch);
    const authorization = client.authorizationUrl({ clientId: CLIENT_ID, redirectUri, state: 's', nonce: NONCE, codeChallenge: s256(verifier) });
    const code = new URLSearchParams(google.authorize(authorization, { sub: '42', email: 'ada@gmail.com' }).split('?')[1]).get('code')!;
    codes.push(code);
    const claims = await client.exchangeCode({
      clientId: CLIENT_ID,
      clientSecret: input.clientSecret ?? 'GOCSPX-secret',
      redirectUri,
      code,
      codeVerifier: input.codeVerifier ?? verifier,
    });
    accessTokens.push(...google.accessTokens);
    return claims;
  };
  assert.ok(await attempt(() => undefined), 'the control: a good exchange answers claims');
  for (const answer of ['refused', 'unreachable', 'not-json', 'no-id-token', 'not-a-jwt'] as const) {
    assert.equal(await attempt((google) => { google.tokenAnswer = answer; }), null, answer);
  }
  // Google's side of PKCE: a verifier that does not answer the challenge is refused at Google.
  assert.equal(await attempt(() => undefined, { codeVerifier: `${verifier.slice(0, -1)}A` }), null, 'another verifier');
  assert.equal(await attempt(() => undefined, { clientSecret: 'GOCSPX-wrong' }), null, 'another secret');
  // A token endpoint that redirects is not followed.
  const redirecting = new GoogleOAuthClient(async (_input, init) => {
    assert.equal(init?.redirect, 'error');
    throw new TypeError('unexpected redirect');
  });
  assert.equal(await redirecting.exchangeCode({ clientId: CLIENT_ID, clientSecret: 's', redirectUri, code: 'c', codeVerifier: verifier }), null);

  // What an administrator can act on — Google's error code — and nothing of the request or answer.
  assert.deepEqual(logged, [
    "Google's token endpoint refused the code: 400 invalid_grant",
    "Google's token endpoint could not be reached",
    "Google's token endpoint answered without an ID token",
    "Google's token endpoint answered without an ID token",
    "Google's token endpoint answered without an ID token",
    "Google's token endpoint refused the code: 400 invalid_grant",
    "Google's token endpoint refused the code: 400 invalid_client",
    "Google's token endpoint could not be reached",
  ]);
  assert.equal(accessTokens.length, 3, 'the control, and the answers without an ID token or with one that is not a JWT, carried one');
  for (const secret of ['GOCSPX-secret', 'GOCSPX-wrong', verifier, ...codes, ...accessTokens]) {
    assert.ok(!logged.some((line) => line.includes(secret)), `the log carries ${secret}`);
  }
});

test('a JWT\'s payload is read only from three segments of base64url JSON', () => {
  const payload = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  assert.deepEqual(jwtPayload(`h.${payload({ sub: '1' })}.s`), { sub: '1' });
  for (const bad of ['', 'one', 'two.parts', `h.${payload({ sub: '1' })}.s.extra`, 'h.!!!.s', `h.${payload([1])}.s`, `h.${payload(null)}.s`, `h.${payload('text')}.s`]) {
    assert.equal(jwtPayload(bad), null, bad);
  }
});

test('ID token claims: each check of §4.2 step 5 passes what it should and refuses what it should, with the code the client is sent back with', () => {
  assert.deepEqual(verify({}), {
    ok: true,
    identity: { sub: GOOD.sub, email: GOOD.email, emailVerified: true, hd: 'example.com', name: 'Ada Lovelace' },
  });

  const cases: Array<[string, Record<string, unknown>, string[], string | null]> = [
    // iss: Google's two spellings, nothing else.
    ['iss without the scheme', { iss: 'accounts.google.com' }, [], null],
    ['iss of another issuer', { iss: 'https://accounts.google.com.evil.test' }, [], 'iss'],
    ['iss over http', { iss: 'http://accounts.google.com' }, [], 'iss'],
    ['no iss', {}, ['iss'], 'iss'],
    // aud / azp.
    ['aud of another client', { aud: 'another.apps.googleusercontent.com', azp: 'another.apps.googleusercontent.com' }, [], 'aud'],
    ['aud of another client, azp this one', { aud: 'another.apps.googleusercontent.com' }, [], 'aud'],
    ['no aud', {}, ['aud'], 'aud'],
    ['aud as a number', { aud: 1234 }, [], 'aud'],
    ['aud as a list with this client and azp this client', { aud: [CLIENT_ID, 'other'] }, [], null],
    ['aud as a list with this client and no azp', { aud: [CLIENT_ID, 'other'] }, ['azp'], 'azp'],
    ['aud as a list with this client and azp another', { aud: [CLIENT_ID, 'other'], azp: 'other' }, [], 'azp'],
    ['aud as a list without this client', { aud: ['other', 'more'], azp: CLIENT_ID }, [], 'aud'],
    ['aud this client, no azp', {}, ['azp'], null],
    ['aud this client, azp another', { azp: 'another.apps.googleusercontent.com' }, [], 'azp'],
    // exp, with sixty seconds for clocks that differ.
    ['exp 59 s past', { exp: SECONDS - 59 }, [], null],
    ['exp 60 s past', { exp: SECONDS - 60 }, [], 'exp'],
    ['exp an hour past', { exp: SECONDS - 3600 }, [], 'exp'],
    ['exp as a string', { exp: String(SECONDS + 3600) }, [], 'exp'],
    ['no exp', {}, ['exp'], 'exp'],
    // nonce.
    ['another nonce', { nonce: 'n-another' }, [], 'nonce'],
    ['no nonce', {}, ['nonce'], 'nonce'],
    // sub.
    ['an empty sub', { sub: '' }, [], 'sub'],
    ['a numeric sub', { sub: 42 }, [], 'sub'],
    ['no sub', {}, ['sub'], 'sub'],
    // email_verified: the boolean true, and an email to go with it.
    ['email_verified false', { email_verified: false }, [], 'email_verified'],
    ['email_verified "true"', { email_verified: 'true' }, [], 'email_verified'],
    ['email_verified 1', { email_verified: 1 }, [], 'email_verified'],
    ['no email_verified', {}, ['email_verified'], 'email_verified'],
    ['verified with no email', {}, ['email'], 'email'],
    ['verified with an empty email', { email: '' }, [], 'email'],
  ];
  for (const [what, over, drop, refused] of cases) {
    const verdict = verify(over, drop);
    if (refused === null) {
      assert.equal(verdict.ok, true, `${what}: refused ${JSON.stringify(verdict)}`);
      continue;
    }
    assert.equal(verdict.ok, false, `${what}: passed`);
    if (verdict.ok) continue;
    assert.equal(verdict.claim, refused, what);
    assert.equal(
      verdict.code,
      refused === 'email_verified' || refused === 'email' ? 'GOOGLE_EMAIL_UNVERIFIED' : 'GOOGLE_EXCHANGE_FAILED',
      what,
    );
  }

  // hd and name are taken when present and are null when absent; neither decides anything here.
  const plain = verify({}, ['hd', 'name']);
  assert.ok(plain.ok);
  assert.deepEqual(plain.identity, { sub: GOOD.sub, email: GOOD.email, emailVerified: true, hd: null, name: null });
});
