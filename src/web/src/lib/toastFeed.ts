import type { ReactNode } from 'react';

/**
 * The toast system's rules (docs/mocks/toast-system, board ④) — the web port of the native clients'
 * `ToastFeed` (src/macos/OrbitKit/Sources/OrbitKit/App/ToastFeed.swift), so the same outcome is the
 * same kind of toast on every client.
 *
 * What a toast asks of you decides its level: a confirmation is a pill that leaves on its own; a toast
 * with something to decide (Undo) or a diagnostic to read is a card; a failure or something waiting on
 * you is pinned, and nothing posted after it can replace it. One operation is one toast: a keyed toast
 * takes the place of its operation's toast already up.
 */

export type ToastTone = 'success' | 'neutral' | 'info' | 'warning' | 'error';
export type ToastLevel = 'confirm' | 'progress' | 'result' | 'attention';
export type ToastGlyph = 'check' | 'trash' | 'branch' | 'sync' | 'undo' | 'info' | 'warning' | 'error';

export interface ToastAction {
  label: string;
  ariaLabel: string;
  onClick: () => void;
}

export interface ToastItem {
  id: string;
  /** The outcome: "Accepted", "Couldn't merge into main". */
  message: ReactNode;
  /** What it happened to: the session, or an entry's title. */
  subtitle?: ReactNode;
  /** The diagnostic — for a failure, the server's own words. */
  detail?: ReactNode;
  tone: ToastTone;
  /** Overrides the tone's glyph, so "Moved to Trash" still shows the trash it came from. */
  icon?: ToastGlyph;
  /** The session it reports on: the toast doubles as the way into it. */
  sessionId?: string;
  /** The one thing you might do about it — Undo. */
  action?: ToastAction;
  /** One operation's toasts share a key, so its result takes its progress toast's place. */
  key?: string;
  /** Work under way: a spinner until its result replaces it. */
  inProgress?: boolean;
  /** Seconds it stays, overriding its level's; 0 stays until dismissed. */
  duration?: number;
}

/** A failure or an approval waits for you whatever else it carries; a card is only for an action to
 *  take or a diagnostic to read — an outcome that merely names its session is a pill you can click. */
export function levelOf(toast: ToastItem): ToastLevel {
  if (toast.tone === 'warning' || toast.tone === 'error') return 'attention';
  if (toast.inProgress) return 'progress';
  if (toast.action || present(toast.detail)) return 'result';
  return 'confirm';
}

/** Seconds a toast stays when nothing replaces it; null for the ones that wait for you. A progress
 *  toast's minute is only a net under a result that never comes. */
export function dwellOf(toast: ToastItem): number | null {
  if (levelOf(toast) === 'attention') return null;
  if (toast.duration !== undefined) return toast.duration > 0 ? toast.duration : null;
  switch (levelOf(toast)) {
    case 'confirm':
      return 3;
    case 'result':
      return 6;
    default:
      return 60;
  }
}

function present(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false && node !== '';
}

export interface ToastFeed {
  /** Toasts that wait for you, oldest first. */
  pinned: ToastItem[];
  /** Toasts that pass, oldest first; the newest few are drawn. */
  transient: ToastItem[];
  /** The pinned toast drawn open on a narrow screen; the others — and this one once folded — are pills. */
  expanded: string | null;
  /** What last went up, to make two quick identical posts one toast. */
  last: { text: string; at: number } | null;
}

export const EMPTY_FEED: ToastFeed = { pinned: [], transient: [], expanded: null, last: null };

/** How many passing toasts the feed keeps; the wide corner stack draws both, a phone the newest. */
export const TRANSIENT_KEPT = 2;

function textOf(toast: ToastItem): string | null {
  const parts = [toast.message, toast.subtitle ?? '', toast.detail ?? '', toast.tone];
  return parts.every((part) => typeof part === 'string') ? parts.join('\u001f') : null;
}

/**
 * Puts `toast` up. Answers the next feed and the id the toast is shown under — a keyed update keeps
 * the id of the toast it replaces, so it changes in place rather than arriving again — or a null id
 * when it repeats what went up under two seconds ago.
 *
 * A failure pins (its operation's progress toast goes); a success clears its operation's earlier
 * failure, which the retry it reports has answered.
 */
export function post(feed: ToastFeed, toast: ToastItem, now: number): { feed: ToastFeed; id: string | null } {
  const text = textOf(toast);
  if (!toast.key && text !== null && feed.last && feed.last.text === text && now - feed.last.at < 2000) {
    return { feed, id: null };
  }
  const last = text !== null ? { text, at: now } : feed.last;
  const attention = levelOf(toast) === 'attention';
  let pinned = feed.pinned;
  let transient = feed.transient;
  let expanded = feed.expanded;

  if (toast.key) {
    const passing = transient.find((one) => one.key === toast.key);
    if (passing) {
      if (!attention) {
        const kept = { ...toast, id: passing.id };
        return {
          feed: { ...feed, transient: transient.map((one) => (one.id === passing.id ? kept : one)), last },
          id: kept.id,
        };
      }
      transient = transient.filter((one) => one.id !== passing.id);
    }
    const waiting = pinned.find((one) => one.key === toast.key);
    if (waiting) {
      if (attention) {
        const kept = { ...toast, id: waiting.id };
        return {
          feed: { ...feed, transient, pinned: pinned.map((one) => (one.id === waiting.id ? kept : one)), expanded: kept.id, last },
          id: kept.id,
        };
      }
      pinned = pinned.filter((one) => one.id !== waiting.id);
      if (expanded === waiting.id) expanded = null;
    }
  }

  if (attention) {
    return { feed: { pinned: [...pinned, toast], transient, expanded: toast.id, last }, id: toast.id };
  }
  return {
    feed: { pinned, transient: [...transient, toast].slice(-TRANSIENT_KEPT), expanded, last },
    id: toast.id,
  };
}

/** ×, a click through to its session, or Undo. */
export function dismiss(feed: ToastFeed, id: string): ToastFeed {
  return {
    ...feed,
    pinned: feed.pinned.filter((one) => one.id !== id),
    transient: feed.transient.filter((one) => one.id !== id),
    expanded: feed.expanded === id ? null : feed.expanded,
  };
}

/** A dwell running out: only ever a passing toast. */
export function expire(feed: ToastFeed, id: string): ToastFeed {
  return { ...feed, transient: feed.transient.filter((one) => one.id !== id) };
}

/** Folds an open pinned card back into its pill. */
export function fold(feed: ToastFeed, id: string): ToastFeed {
  return feed.expanded === id ? { ...feed, expanded: null } : feed;
}

/** Opens a pinned toast's card from its pill. */
export function unfold(feed: ToastFeed, id: string): ToastFeed {
  return feed.pinned.some((one) => one.id === id) ? { ...feed, expanded: id } : feed;
}
