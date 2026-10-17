import { queryOptions } from '@tanstack/react-query';
import { api } from '../api';
import type { SignInMethods } from './queries';

/**
 * Connecting Google to the account signed in, from its profile page (docs/google-sign-in-design.md
 * §5.3, §8.1): a PKCE verifier kept in this tab, its challenge sent with POST /auth/google/link, the
 * browser sent to Google, and — when Google sends it back to /settings/profile with a ticket — the
 * ticket confirmed with the verifier. The verifier never leaves this tab but for the confirmation.
 */

/** Where this tab keeps the verifier of a Connect Google in flight. */
export const GOOGLE_LINK_VERIFIER_KEY = 'orbit_google_link_verifier';

/** `GET /auth/methods`: whether this server signs people in with Google at all. */
export interface AuthMethods {
  password: true;
  google: boolean;
  googleSignup: boolean;
}

export const authMethodsQuery = () =>
  queryOptions({
    queryKey: ['auth', 'methods'] as const,
    queryFn: () => api<AuthMethods>('/auth/methods'),
    staleTime: 60_000,
  });

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A PKCE verifier (RFC 7636 §4.1): 32 random bytes, 43 base64url characters. */
export function newCodeVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The S256 challenge of a verifier (RFC 7636 §4.2). */
export async function codeChallengeOf(verifier: string): Promise<string> {
  if (!crypto.subtle) throw new Error('Connecting Google needs this page to be opened over HTTPS');
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

/** Connect Google: keep a verifier in this tab, open the link with its challenge, and go to Google. */
export async function startGoogleLink(): Promise<void> {
  const verifier = newCodeVerifier();
  const codeChallenge = await codeChallengeOf(verifier);
  sessionStorage.setItem(GOOGLE_LINK_VERIFIER_KEY, verifier);
  const { authorizationUrl } = await api<{ authorizationUrl: string }>('/auth/google/link', {
    method: 'POST',
    body: { codeChallenge },
  });
  location.assign(authorizationUrl);
}

/**
 * Back from Google with a ticket: confirm it with the verifier this tab kept, taken out as it is
 * read, so it serves one confirmation. A tab that kept none — the link was started in another tab,
 * or the storage was cleared — cannot confirm, and says so.
 */
export async function confirmGoogleLink(ticket: string): Promise<{ signInMethods: SignInMethods }> {
  const codeVerifier = sessionStorage.getItem(GOOGLE_LINK_VERIFIER_KEY);
  sessionStorage.removeItem(GOOGLE_LINK_VERIFIER_KEY);
  if (!codeVerifier) throw new Error('This tab lost track of the Google connection it started — connect Google again');
  return api<{ signInMethods: SignInMethods }>('/auth/google/link/confirm', {
    method: 'POST',
    body: { ticket, codeVerifier },
  });
}

/** What the profile page says when Google sends it back with `google_error` instead of a ticket (§4.2). */
export function googleReturnError(code: string): string {
  switch (code) {
    case 'GOOGLE_CANCELLED':
      return 'You cancelled at Google — nothing was connected.';
    case 'GOOGLE_FLOW_EXPIRED':
      return 'The connection took too long or was finished in another browser — connect Google again.';
    case 'GOOGLE_EMAIL_UNVERIFIED':
      return "Google hasn't verified that account's email address, so it can't be connected.";
    case 'GOOGLE_NOT_CONFIGURED':
      return 'Google sign-in is turned off on this server.';
    default:
      return "Google didn't confirm the sign-in — connect Google again.";
  }
}
