import { EyeInvisibleOutlined, EyeOutlined } from '@ant-design/icons';
import { useState, type FormEvent } from 'react';
import { api, setSession } from '../api';

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
