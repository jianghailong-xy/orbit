import type React from 'react';
import { titleFirstLine } from './title';
import type { ToastGlyph, ToastTone } from './toastFeed';
import { clearToasts, showToast } from './toastStore';

// Every toast in the app goes through this, and from here into one feed (lib/toastFeed.ts, the web
// port of the native clients' ToastFeed) that components/ToastViewport.tsx draws — docs/mocks/
// toast-system. What a toast asks of you decides its shape and how long it stays: a confirmation is
// a pill that leaves after three seconds; a toast with an Undo or a diagnostic is a card for six; a
// failure is pinned until its ×, and nothing posted after it can push it off the screen. A merge
// conflict or an API failure is usually the thing you want to read twice and paste somewhere.
//
// Every toast says what happened to what. The first argument is that headline — "Accepted",
// "Couldn't save the schedule" — and the optional second is the line under it: the thing it
// happened to (an entry's title), or for a failure the server's own words. Never pass the
// server's words as the headline: "revision 12 is stale" on its own doesn't say which action
// failed.
//
// None of these hands anything back. AntD's handle, which they used to return, was a thenable that
// settled when the toast closed, and `onError: (e) => message.error(…)` returned it to TanStack
// Query, which waited on it: an error toast never closes on its own, so the mutation stayed pending
// — its button spinning — until someone clicked the toast's ×.

// Toasts paint; a screen reader hears them through one live region that exists before the text
// lands in it, which is what makes an announcement reliable. A failure interrupts; the rest wait.
let liveRegion: HTMLElement | null = null;

// The line under a headline, when there is one worth drawing: an empty server message or a
// detail that only repeats the headline adds nothing.
function detailOf(headline: React.ReactNode, detail: React.ReactNode | undefined): React.ReactNode | undefined {
  if (detail == null || detail === false) return undefined;
  if (typeof detail === 'string') {
    const trimmed = detail.trim();
    if (!trimmed || trimmed === headline) return undefined;
    return trimmed;
  }
  return detail;
}

function announce(headline: React.ReactNode, assertive: boolean, ...lines: React.ReactNode[]): void {
  if (typeof headline !== 'string' || !headline) return;
  const content = [headline, ...lines.filter((line): line is string => typeof line === 'string' && line !== '')].join('. ');
  if (!liveRegion) {
    liveRegion = document.createElement('div');
    liveRegion.className = 'sr-only';
    // Fixed, where the class says absolute: hung after the app at the end of <body>, an absolute box
    // sits just under the fold and makes the document 1px taller than the window. That pixel gives the
    // document WebKit's 8px page scrollbar (index.css), which narrows fixed layers laid out after it on
    // a phone and makes a modal's scroll lock lose the place of the page beneath it. A fixed box adds
    // nothing to the document's height.
    liveRegion.style.position = 'fixed';
    liveRegion.setAttribute('aria-atomic', 'true');
    document.body.appendChild(liveRegion);
  }
  liveRegion.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
  // Clear first: writing the same string twice in a row is otherwise not a change, and the
  // second "Saved" would pass in silence.
  liveRegion.textContent = '';
  const el = liveRegion;
  setTimeout(() => {
    el.textContent = content;
  }, 50);
}

interface SessionActionToastOptions {
  sessionId: string;
  sessionTitle: string;
  action: 'complete' | 'trash';
  onUndo: () => void;
}

type SessionNoticeTone = 'success' | 'neutral' | 'info' | 'warning' | 'error' | 'danger';
type SessionNoticeIcon = ToastGlyph;

interface SessionNoticeOptions {
  sessionId: string;
  sessionTitle: string;
  event: string;
  headline: React.ReactNode;
  detail?: React.ReactNode;
  tone?: SessionNoticeTone;
  icon?: SessionNoticeIcon;
  duration?: number;
  action?: {
    label: string;
    ariaLabel: string;
    onClick: () => void;
  };
}

// A result about a session: the outcome, the session it happened in, and an optional diagnostic.
// The toast doubles as the way back to that session — a result you want to act on is usually a
// result you want to look at. Keyed by event and session, so the same operation's next result takes
// this one's place instead of stacking under it. "Danger" is a destructive outcome that went as
// asked (Session permanently deleted): said plainly, with the trash it came from, not as a failure.
function sessionNotice({
  sessionId,
  sessionTitle,
  event,
  headline,
  detail,
  tone = 'success',
  icon,
  duration,
  action,
}: SessionNoticeOptions): void {
  const title = titleFirstLine(sessionTitle) || 'Untitled session';
  const toastTone: ToastTone = tone === 'danger' ? 'neutral' : tone;
  const line = detailOf(headline, detail);
  announce(headline, toastTone === 'error' || toastTone === 'warning', title, line);
  showToast({
    message: headline,
    subtitle: title,
    detail: line,
    tone: toastTone,
    icon,
    sessionId,
    action,
    key: `session-${event}-${sessionId}`,
    duration,
  });
}

const TOAST = {
  success: (content: React.ReactNode, detail?: React.ReactNode): void => {
    const line = detailOf(content, detail);
    announce(content, false, line);
    showToast({ message: content, subtitle: line, tone: 'success' });
  },
  info: (content: React.ReactNode, detail?: React.ReactNode): void => {
    const line = detailOf(content, detail);
    announce(content, false, line);
    showToast({ message: content, subtitle: line, tone: 'info' });
  },
  // Something that didn't go as asked and that you should take in: pinned like a failure, its line
  // read as the reason.
  warning: (content: React.ReactNode, detail?: React.ReactNode): void => {
    const line = detailOf(content, detail);
    announce(content, true, line);
    showToast({ message: content, detail: line, tone: 'warning' });
  },
  // `headline` names what failed ("Couldn't save the schedule"); `detail` is why, usually the
  // server's own message, kept selectable so it can be pasted.
  error: (headline: React.ReactNode, detail?: React.ReactNode): void => {
    const line = detailOf(headline, detail);
    announce(headline, true, line);
    showToast({ message: headline, detail: line, tone: 'error' });
  },
  destroy: clearToasts,
  sessionNotice,
  // Complete/Trash are the two reversible session results. Keep the convenience method
  // so their Undo behavior stays identical while sharing the generic result-card surface.
  sessionAction: ({ sessionId, sessionTitle, action, onUndo }: SessionActionToastOptions): void => {
    const completed = action === 'complete';
    const title = titleFirstLine(sessionTitle) || 'Untitled session';
    sessionNotice({
      sessionId,
      sessionTitle,
      event: action,
      headline: completed ? 'Session completed' : 'Moved to Trash',
      tone: completed ? 'success' : 'neutral',
      icon: completed ? 'check' : 'trash',
      action: {
        label: 'Undo',
        ariaLabel: completed ? `Undo completing ${title}` : `Undo moving ${title} to Trash`,
        onClick: onUndo,
      },
    });
  },
};

/** The app's toasts. A hook for the call sites' sake; the feed it posts into is app-wide. */
export function useToast(): typeof TOAST {
  return TOAST;
}
