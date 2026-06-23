import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, getToken } from '../api';
import { meQuery, type Me } from './queries';

export type ThemeMode = 'system' | 'light' | 'dark';
type Resolved = 'light' | 'dark';

const STORAGE_KEY = 'orbit-theme';
const mq = () => window.matchMedia('(prefers-color-scheme: dark)');

function readMode(): ThemeMode {
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

function resolve(mode: ThemeMode): Resolved {
  if (mode === 'system') return mq().matches ? 'dark' : 'light';
  return mode;
}

type Ctx = { mode: ThemeMode; resolved: Resolved; setMode: (m: ThemeMode) => void };
const ThemeContext = createContext<Ctx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [mode, setModeState] = useState<ThemeMode>(readMode);
  const [resolved, setResolved] = useState<Resolved>(() => resolve(readMode()));

  // Theme is account-synced. localStorage is the instant-paint cache (read above, so
  // first paint never flashes); the account preference is the source of truth, fetched
  // only when signed in (on /login we just use the cached/system theme).
  const me = useQuery({ ...meQuery(), enabled: !!getToken() });
  const serverTheme = me.data?.preferences?.theme;

  // Adopt the account theme when it arrives (sign-in, or a change made on another
  // device). A functional update reads the latest mode without making it a dep, so a
  // local setMode below never bounces back to the server value.
  useEffect(() => {
    if (!serverTheme) return;
    setModeState((cur) => (serverTheme !== cur ? serverTheme : cur));
  }, [serverTheme]);

  // Reflect the resolved theme onto <html data-theme> (drives the CSS tokens) and
  // mirror the choice to localStorage for the next first paint. Re-runs on change.
  useEffect(() => {
    const r = resolve(mode);
    setResolved(r);
    document.documentElement.setAttribute('data-theme', r);
    localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  // While following the system, track OS-level light/dark changes live.
  useEffect(() => {
    if (mode !== 'system') return;
    const m = mq();
    const onChange = () => {
      const r = m.matches ? 'dark' : 'light';
      setResolved(r);
      document.documentElement.setAttribute('data-theme', r);
    };
    m.addEventListener('change', onChange);
    return () => m.removeEventListener('change', onChange);
  }, [mode]);

  // Public setter: apply locally, then persist to the account. Optimistically patch the
  // cached `me` so the adopt-effect sees the new value and won't revert before the PATCH
  // lands. Fire-and-forget — a failed sync just leaves the local choice in place.
  const setMode = (m: ThemeMode) => {
    setModeState(m);
    if (!getToken()) return;
    qc.setQueryData<Me>(meQuery().queryKey, (prev) =>
      prev ? { ...prev, preferences: { ...prev.preferences, theme: m } } : prev,
    );
    void api('/users/me/preferences', { method: 'PATCH', body: { theme: m } }).catch(() => {});
  };

  return (
    <ThemeContext.Provider value={{ mode, resolved, setMode }}>{children}</ThemeContext.Provider>
  );
}

export function useThemeMode(): Ctx {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useThemeMode must be used within ThemeProvider');
  return ctx;
}
