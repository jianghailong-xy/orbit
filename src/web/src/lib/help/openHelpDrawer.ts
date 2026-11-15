/** The window event the help drawer (lib/helpDrawer) listens for: open it on a tab, an article or a question. */
export const HELP_DRAWER_EVENT = 'orbit:help-drawer';

export interface OpenHelpDrawer {
  tab?: 'articles' | 'ask';
  slug?: string | null;
  query?: string | null;
  /** On Ask: the Ask session to continue, or null for a new question. */
  askSession?: string | null;
}

/** Open the help drawer from anywhere, without importing the drawer itself (the /help pages sit outside it). */
export function openHelpDrawer(detail: OpenHelpDrawer): void {
  window.dispatchEvent(new CustomEvent<OpenHelpDrawer>(HELP_DRAWER_EVENT, { detail }));
}
