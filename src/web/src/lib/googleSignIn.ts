import { ApiError } from '../api';

/**
 * Signing in to Orbit with Google, the Web's half (docs/google-sign-in-design.md §3.2, §8.1): the
 * login page proves it is the tab that started a sign-in by a PKCE pair of its own — the challenge
 * goes to /api/auth/google/start, the verifier stays in this tab's sessionStorage beside `next` and
 * is shown only to POST /api/auth/google/exchange, with the ticket the callback brings back. The
 * server never hears `next`: it sends every Web sign-in back to /login, and the page itself goes on.
 */

/** GET /api/auth/methods (§6): whether this server offers Google, and whether Google opens accounts. */
export interface SignInMethods {
  password: boolean;
  google: boolean;
  googleSignup: boolean;
}

/** One started sign-in, as this tab keeps it until Google sends it back. */
export interface GoogleSignInStart {
  verifier: string;
  /** The login page's own `next`, raw: loginDestination judges it on the way out, as it does a password login's. */
  next: string | null;
}

const STARTED_KEY = 'orbit_google_sign_in';

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A PKCE code verifier (RFC 7636 §4.1): 32 random bytes, 43 base64url characters. */
export function createCodeVerifier(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Its S256 challenge (RFC 7636 §4.2): base64url of the verifier's SHA-256, the 43 characters /start takes. */
async function codeChallengeOf(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

/**
 * Leave for Google: keep a fresh verifier and `next` in this tab, then send the browser to /start
 * with the verifier's challenge. Throws where it cannot — WebCrypto's digest exists only on a secure
 * page (HTTPS or localhost), and a browser may refuse sessionStorage.
 */
export async function startGoogleSignIn(next: string | null): Promise<void> {
  const verifier = createCodeVerifier();
  const challenge = await codeChallengeOf(verifier);
  sessionStorage.setItem(STARTED_KEY, JSON.stringify({ verifier, next } satisfies GoogleSignInStart));
  location.assign(`/api/auth/google/start?client=web&code_challenge=${challenge}`);
}

/**
 * The sign-in this tab started, taken out as it is read so that it is used at most once; null when
 * this tab started none — Google's answer arrived in another tab or browser, or the tab lost it.
 */
export function takeGoogleSignIn(): GoogleSignInStart | null {
  try {
    const raw = sessionStorage.getItem(STARTED_KEY);
    sessionStorage.removeItem(STARTED_KEY);
    const started = JSON.parse(raw ?? 'null') as Partial<GoogleSignInStart> | null;
    if (typeof started?.verifier !== 'string') return null;
    return { verifier: started.verifier, next: typeof started.next === 'string' ? started.next : null };
  } catch {
    return null;
  }
}

const TOO_MANY = 'Too many Google sign-ins from your network. Wait a minute, then continue with Google again.';

/**
 * What to tell someone a Google sign-in failed for, by the code it failed with — a `google_error` the
 * start or the callback sent back to /login (§4.1, §4.2) or the exchange's refusal (§4.3, §5.2, §5.5) —
 * in words that say what to do next. English: the Web has no i18n.
 */
const FAILURES: Record<string, string> = {
  GOOGLE_NOT_CONFIGURED:
    'Google sign-in is turned off on this Orbit server. Sign in with your email and password, or ask an administrator to turn it on.',
  GOOGLE_RATE_LIMITED: TOO_MANY,
  GOOGLE_SIGN_IN_BUSY:
    'Too many Google sign-ins are in progress on this Orbit server. Wait a few minutes, then continue with Google again, or sign in with your password.',
  GOOGLE_BAD_REQUEST:
    "Orbit couldn't start Google sign-in from this page. Reload the page, then continue with Google again; if it keeps failing, sign in with your password.",
  GOOGLE_FLOW_EXPIRED:
    'That Google sign-in expired or was finished in a different browser. Continue with Google again from this page.',
  GOOGLE_CANCELLED: 'Google sign-in was cancelled. Continue with Google to try again, or sign in with your password.',
  GOOGLE_EXCHANGE_FAILED:
    "Orbit couldn't confirm your sign-in with Google. Try again in a moment; if it keeps failing, ask an administrator to check this server's Google sign-in settings.",
  GOOGLE_EMAIL_UNVERIFIED:
    "Your Google account's email address isn't verified. Verify it with Google, then continue with Google again.",
  GOOGLE_FLOW_MISMATCH: 'This Google sign-in expired or was already used. Continue with Google again from this page.',
  SETUP_REQUIRED:
    'This Orbit server has no accounts yet. Create its first administrator at /setup with an email and password.',
  GOOGLE_EMAIL_AMBIGUOUS:
    'More than one Orbit account uses this email address, differing only in capital letters. Ask an administrator to remove the duplicate, or sign in with your password.',
  GOOGLE_ACCOUNT_MISMATCH:
    'The Orbit account with this email address is connected to a different Google account. Continue with that Google account, or sign in with your password.',
  GOOGLE_EMAIL_NOT_AUTHORITATIVE:
    "Google can't confirm that this email address is still yours. Sign in with your password, then connect Google on your profile page.",
  GOOGLE_ACCOUNT_NOT_FOUND:
    'No Orbit account uses this Google account yet. Ask an administrator to create one for your email address, then continue with Google again.',
  ACCOUNT_DISABLED: 'This Orbit account is disabled. Ask an administrator to enable it again.',
};

const UNKNOWN = "Couldn't sign in with Google. Continue with Google to try again, or sign in with your password.";

/** Google's answer came to a tab that holds no verifier for it: the ticket was spent unused (§3.2 rule 2). */
export const GOOGLE_SIGN_IN_NOT_FROM_THIS_TAB =
  "This Google sign-in didn't start in this browser tab, so it can't finish here. Continue with Google again from this page.";

/** The page could not leave for Google at all (see startGoogleSignIn). */
export const GOOGLE_SIGN_IN_UNSTARTABLE =
  "Couldn't start Google sign-in in this browser. Make sure Orbit is open over HTTPS, then try again.";

/** The sentence for a `google_error` code — which arrives in the URL, so anything at all may be in it. */
export function googleErrorMessage(code: string): string {
  return Object.hasOwn(FAILURES, code) ? FAILURES[code] : UNKNOWN;
}

/** The sentence for an exchange that failed: by its code, by its status for the rate limit (which has none), else general. */
export function googleExchangeFailure(error: unknown): string {
  if (!(error instanceof ApiError)) return UNKNOWN;
  if (error.code !== undefined && Object.hasOwn(FAILURES, error.code)) return FAILURES[error.code];
  return error.status === 429 ? TOO_MANY : UNKNOWN;
}
