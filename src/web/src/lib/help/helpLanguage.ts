import { useSyncExternalStore } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DEFAULT_HELP_LANGUAGE, isHelpLanguage, type HelpLanguage } from '@orbit/shared';
import { getToken } from '../../api';
import { meQuery } from '../queries';

/**
 * The language the help articles are read in (docs/help/<language>): chosen in the help center with the picker,
 * remembered in this browser, so it holds across visits and every help view — the /help pages and the drawer.
 * English is the library's own language; the others ship as translated copies beside it.
 */

/** Where the choice is kept, in this browser. */
export const HELP_LANGUAGE_KEY = 'orbit.help.language';

const listeners = new Set<() => void>();

/** The language this browser chose, or null when it never did: read every time, so clearing storage is a reset. */
function read(): HelpLanguage | null {
  try {
    const stored = localStorage.getItem(HELP_LANGUAGE_KEY);
    return isHelpLanguage(stored) ? stored : null;
  } catch {
    // A browser that refuses storage has no memory.
    return null;
  }
}

/** Chooses the language for every help view, and remembers it in this browser. */
export function setHelpLanguage(language: HelpLanguage): void {
  try {
    localStorage.setItem(HELP_LANGUAGE_KEY, language);
  } catch {
    // See read().
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function useStoredHelpLanguage(): HelpLanguage | null {
  return useSyncExternalStore(subscribe, read, () => null);
}

/**
 * The language articles are read in: the one chosen in the help center, else the signed-in account's Translation ›
 * Your language when the help library has it, else English. A choice made in the help center wins from then on.
 */
export function useHelpLanguage(): { language: HelpLanguage; setLanguage: (language: HelpLanguage) => void } {
  const stored = useStoredHelpLanguage();
  const signedIn = !!getToken();
  const me = useQuery({ ...meQuery(), enabled: signedIn });
  const preferred = me.data?.preferences?.translationLanguage;
  const language = stored ?? (isHelpLanguage(preferred) ? preferred : DEFAULT_HELP_LANGUAGE);
  return { language, setLanguage: setHelpLanguage };
}
