import { EyeInvisibleOutlined, EyeOutlined } from '@ant-design/icons';
import { useEffect, useState, type FormEvent } from 'react';
import { api, setSession } from '../api';
import { Button } from '../components/ui/Button';
import {
  createCodeVerifier,
  GOOGLE_SIGN_IN_NOT_FROM_THIS_TAB,
  GOOGLE_SIGN_IN_UNSTARTABLE,
  googleErrorMessage,
  googleExchangeFailure,
  type SignInMethods,
  startGoogleSignIn,
  takeGoogleSignIn,
} from '../lib/googleSignIn';

interface AuthResponse {
  accessToken: string;
  refreshToken: string;
}

/**
 * Where a successful login goes: `next` when it is a path on this site, the root otherwise.
 *
 * `next` comes from the URL, so anyone can write it, and following it anywhere would make the
 * login page an open redirect. Only a single leading `/` is a path here — `//host` and `/\host`
 * are other sites to a browser, and so is anything with a scheme. The browser's own reading has the
 * last word: it drops tabs and newlines before it looks, so `/<tab>/host` is `//host` to it.
 */
export function loginDestination(next: string | null): string {
  if (!next || !/^\/(?![/\\])/.test(next)) return '/';
  try {
    return new URL(next, location.origin).origin === location.origin ? next : '/';
  } catch {
    return '/';
  }
}

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showsPassword, setShowsPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether this server offers Google (docs/google-sign-in-design.md §6). Until it answers — and from
  // a server too old to have the route — the page offers the password alone, as it always has.
  const [methods, setMethods] = useState<SignInMethods | null>(null);
  // Leaving for Google, or back with its ticket and exchanging it.
  const [googleBusy, setGoogleBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api<SignInMethods>('/auth/methods')
      .then((answer) => {
        if (live) setMethods(answer);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  // Back from Google (§4.2, §8.1): /login?google_ticket=T, or /login?google_error=CODE.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ticket = params.get('google_ticket');
    const failure = params.get('google_error');
    if (ticket === null && failure === null) return;
    const started = takeGoogleSignIn();
    // Off the address bar and out of history before anything else. `next` goes back on, so that a
    // password sign-in after a Google one that failed still ends where the visitor was going.
    window.history.replaceState(
      window.history.state,
      '',
      started?.next ? `/login?next=${encodeURIComponent(started.next)}` : '/login',
    );
    if (ticket === null) {
      setError(googleErrorMessage(failure!));
      return;
    }
    if (!started) {
      // No verifier here, so the ticket can sign nobody in from this tab — but shown once, it can never
      // be shown again by anyone (§3.2). A well-formed verifier of no flow, so that no check of the
      // body's shape could turn the request away before the ticket is spent.
      api('/auth/google/exchange', {
        method: 'POST',
        body: { ticket, codeVerifier: createCodeVerifier() },
      }).catch(() => {});
      setError(GOOGLE_SIGN_IN_NOT_FROM_THIS_TAB);
      return;
    }
    setGoogleBusy(true);
    api<AuthResponse>('/auth/google/exchange', {
      method: 'POST',
      body: { ticket, codeVerifier: started.verifier },
    })
      .then((res) => {
        setSession(res);
        // The password login's way out, below: `next` when it is a page on this site, else the root.
        location.href = loginDestination(started.next);
      })
      .catch((err) => {
        setError(googleExchangeFailure(err));
        setGoogleBusy(false);
      });
  }, []);

  // Back from Google's page without signing in: a page the browser restores from its back/forward
  // cache comes back as it was left, still waiting on Google.
  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (event.persisted) setGoogleBusy(false);
    };
    window.addEventListener('pageshow', restored);
    return () => window.removeEventListener('pageshow', restored);
  }, []);

  const continueWithGoogle = async () => {
    if (googleBusy) return;
    setGoogleBusy(true);
    setError(null);
    try {
      await startGoogleSignIn(new URLSearchParams(window.location.search).get('next'));
    } catch {
      setError(GOOGLE_SIGN_IN_UNSTARTABLE);
      setGoogleBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !email || !password) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api<AuthResponse>('/auth/login', { method: 'POST', body: { email, password } });
      setSession(res);
      const next = new URLSearchParams(window.location.search).get('next');
      // Back to the page that sent the visitor here (`next`), else land at the root and let
      // <DefaultLanding> resolve the destination — the first workspace's session list, or
      // onboarding (registration guide / runners) when there's no workspace to open yet. A full
      // reload so BootGate pre-warms that first screen behind the splash.
      location.href = loginDestination(next);
    } catch (err) {
      setError((err as Error).message || "Couldn't sign in");
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-form" onSubmit={submit}>
        <div className="login-brand">
          <span className="login-orbits" aria-hidden />
          <OrbitAppIcon />
        </div>
        <h1 className="login-title">Welcome back</h1>
        <p className="login-subtitle">Sign in to continue to Orbit</p>

        <div className="login-fields">
          <label className="login-field">
            <span className="login-field-label">Email</span>
            <input
              type="email"
              name="email"
              autoComplete="username"
              placeholder="you@example.com"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label className="login-field">
            <span className="login-field-label">Password</span>
            <span className="login-field-row">
              <input
                type={showsPassword ? 'text' : 'password'}
                name="password"
                autoComplete="current-password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="login-eye"
                aria-label={showsPassword ? 'Hide password' : 'Show password'}
                onClick={() => setShowsPassword((v) => !v)}
              >
                {showsPassword ? <EyeInvisibleOutlined /> : <EyeOutlined />}
              </button>
            </span>
          </label>

          {error && (
            <div className="login-error" role="alert">
              {error}
            </div>
          )}

          <button type="submit" className="login-submit" disabled={busy || !email || !password}>
            {busy ? 'Signing in…' : 'Sign In'}
          </button>

          {methods?.google && (
            <>
              <div className="login-or">or</div>
              <Button
                className="login-google"
                size="large"
                icon={<GoogleMark />}
                loading={googleBusy}
                onClick={continueWithGoogle}
              >
                Continue with Google
              </Button>
              {methods.googleSignup && (
                <p className="login-signup">New to Orbit? Continue with Google to create an account.</p>
              )}
            </>
          )}
        </div>
      </form>
    </div>
  );
}

/** The app icon — the favicon's mark in white on the brand tile, as the Mac and iOS login draw it. */
function OrbitAppIcon() {
  return (
    <svg className="login-icon" viewBox="0 0 1024 1024" role="img" aria-label="Orbit">
      <defs>
        <linearGradient id="login-icon-tile" x1="0" y1="0" x2="1024" y2="1024" gradientUnits="userSpaceOnUse">
          <stop stopColor="#5b8cff" />
          <stop offset="1" stopColor="#3370ff" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="229" fill="url(#login-icon-tile)" />
      <g transform="translate(96 118) scale(13)">
        <g transform="rotate(-26 32 32)">
          <ellipse cx="32" cy="32" rx="28" ry="12.5" stroke="#fff" strokeOpacity="0.9" strokeWidth="3.4" fill="none" />
          <circle cx="56" cy="25.6" r="5.4" fill="#fff" />
        </g>
        <rect x="19" y="20" width="26" height="24" rx="6" fill="#fff" />
        <path
          d="M25 27.5 L30 32 L25 36.5 M33 35.8 L39.5 35.8"
          stroke="#3370ff"
          strokeWidth="2.9"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </g>
    </svg>
  );
}

/** Google's four-colour "G", unaltered, as Google's sign-in branding guidelines put it on the button. */
function GoogleMark() {
  return (
    <svg className="login-google-mark" viewBox="0 0 48 48">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}
