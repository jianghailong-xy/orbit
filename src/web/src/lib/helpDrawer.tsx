import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

/** The help drawer's two tabs (board docs/mocks/help-center/01-web.png ①). */
export type HelpTab = 'articles' | 'ask';

/** Where the full help center lives; the drawer's ↗ and the account menu's Help center row open it. */
export const HELP_PATH = '/help';

/**
 * Any page can open the drawer without importing it: a `window` CustomEvent of this name whose detail is a
 * `HelpDrawerAt` (`src/web/src/lib/help/openHelpDrawer.ts` sends it, e.g. /help's Ask button).
 */
export const HELP_DRAWER_EVENT = 'orbit:help-drawer';

/** Where to open the drawer: an article (shown on Articles), a tab, and for Ask a question to start from. */
export interface HelpDrawerAt {
  tab?: HelpTab;
  slug?: string | null;
  query?: string | null;
  /** On Ask: the Ask session to continue (/help → Your questions), or null for a new question. */
  askSession?: string | null;
}

export interface HelpDrawerState {
  open: boolean;
  tab: HelpTab;
  /** The article the Articles tab shows, or null for its list ("For this page"). */
  slug: string | null;
  /** The question the Ask tab starts from, when the drawer was opened with one. */
  query: string | null;
  /** The Ask conversation the Ask tab shows, or null for a new question. Kept while the drawer is closed. */
  askSession: string | null;
}

export interface HelpDrawerApi extends HelpDrawerState {
  /**
   * Open the drawer — on an article (`slug`, which shows the Articles tab) or on a tab. A Learn more link calls
   * `openHelp({ slug })`; with nothing named the drawer opens where it was left.
   */
  openHelp: (at?: HelpDrawerAt) => void;
  toggleHelp: () => void;
  closeHelp: () => void;
  setTab: (tab: HelpTab) => void;
  /** Show this Ask conversation on the Ask tab, or null to start a new question. */
  setAskSession: (sessionId: string | null) => void;
}

const CLOSED: HelpDrawerState = { open: false, tab: 'articles', slug: null, query: null, askSession: null };
const noop = () => {};

/** Outside a provider (a share page, a component test) the drawer is closed and asks do nothing. */
const HelpDrawerCtx = createContext<HelpDrawerApi>({
  ...CLOSED,
  openHelp: noop,
  toggleHelp: noop,
  closeHelp: noop,
  setTab: noop,
  setAskSession: noop,
});

export const useHelpDrawer = (): HelpDrawerApi => useContext(HelpDrawerCtx);

/** Focus is somewhere text is typed: ? is a character there, not a shortcut. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest('[contenteditable=""], [contenteditable="true"]')) return true;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

/** Something drawn over the page that takes Esc for itself. */
const OVERLAY = '[role="dialog"], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="listbox"]';

/**
 * The help drawer's state for every signed-in page — the app's and Settings' — so it stays open across them, and its
 * keys: ? (Shift+/) opens and closes it except while typing, Esc closes it. The keys are read in the capture phase so
 * an Esc that closes the drawer is not also Settings' Esc, which leaves Settings.
 */
export function HelpDrawerProvider({ enabled = true, children }: { enabled?: boolean; children: ReactNode }) {
  const [state, setState] = useState<HelpDrawerState>(CLOSED);
  const openRef = useRef(false);
  openRef.current = state.open;

  const openHelp = useCallback((at?: HelpDrawerAt) => {
    setState((prev) => {
      if (at?.slug) return { ...prev, open: true, tab: 'articles', slug: at.slug };
      if (at?.tab === 'ask') {
        // A question or an article handed over starts a new Ask; a session named continues that one.
        const askSession = at.askSession !== undefined ? at.askSession : at.query ? null : prev.askSession;
        return { ...prev, open: true, tab: 'ask', query: at.query ?? null, askSession };
      }
      if (at?.tab === 'articles') return { ...prev, open: true, tab: 'articles', slug: null };
      return { ...prev, open: true };
    });
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const onOpen = (event: Event) => openHelp((event as CustomEvent<HelpDrawerAt | null>).detail ?? undefined);
    window.addEventListener(HELP_DRAWER_EVENT, onOpen);
    return () => window.removeEventListener(HELP_DRAWER_EVENT, onOpen);
  }, [openHelp, enabled]);
  const closeHelp = useCallback(() => setState((prev) => (prev.open ? { ...prev, open: false } : prev)), []);
  const toggleHelp = useCallback(() => setState((prev) => ({ ...prev, open: !prev.open })), []);
  const setTab = useCallback((tab: HelpTab) => setState((prev) => ({ ...prev, tab })), []);
  const setAskSession = useCallback((askSession: string | null) => setState((prev) => ({ ...prev, askSession })), []);

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === '?' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (isTypingTarget(event.target) || isTypingTarget(document.activeElement)) return;
        event.preventDefault();
        toggleHelp();
        return;
      }
      if (event.key === 'Escape') {
        if (!openRef.current || document.querySelector(OVERLAY)) return;
        event.preventDefault();
        closeHelp();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [toggleHelp, closeHelp, enabled]);

  // Signing out closes it; signed out it stays closed.
  useEffect(() => {
    if (!enabled) setState(CLOSED);
  }, [enabled]);

  const api = useMemo<HelpDrawerApi>(
    () => ({ ...state, open: enabled && state.open, openHelp, toggleHelp, closeHelp, setTab, setAskSession }),
    [state, enabled, openHelp, toggleHelp, closeHelp, setTab, setAskSession],
  );
  return <HelpDrawerCtx.Provider value={api}>{children}</HelpDrawerCtx.Provider>;
}
