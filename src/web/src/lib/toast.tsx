import {
  BranchesOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  CloseOutlined,
  DeleteOutlined,
  ExclamationCircleFilled,
  InfoCircleFilled,
  SyncOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import { App as AntApp } from 'antd';
import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { encodeId } from './idCodec';
import { titleFirstLine } from './title';

// Every toast in the app goes through this instead of AntApp.useApp().message directly, so
// the one behaviour we want to differ from AntD's default lives in a single place: errors
// don't auto-dismiss. A merge conflict or an API failure is usually the thing you want to
// read twice and paste somewhere, and the default 3s timer takes it away mid-sentence.
// They stay until the × is clicked; index.css re-enables pointer events and text selection
// for error cards only (the rest stay click-through so they can't block the header).

let errSeq = 0;

// AntD's Message notices carry no role and no aria-live, so a screen reader never hears them —
// including the error card that stays on screen precisely because it matters. Notifications set
// their own role (below), so this mirrors just the Message layer into one live region that
// exists before the text lands in it, which is what makes an announcement reliable.
let liveRegion: HTMLElement | null = null;

// The two toast surfaces are separate fixed portals that both hang off the top-right corner, and
// the notification stack has the higher z-index — so a lifecycle card lands directly on top of
// whatever Message toasts are up, including the error card that never times out (its × goes with
// it). Park the Message stack under whatever the notification stack currently occupies, in px,
// and let index.css take the larger of that and the normal top.
let stackHolder: Element | null = null;
let stackObserver: ResizeObserver | null = null;

function syncToastStack(): void {
  const cards = document.querySelectorAll(
    '.ant-notification-topRight .ant-notification-notice-wrapper',
  );
  const last = cards[cards.length - 1];
  const bottom = last ? Math.round(last.getBoundingClientRect().bottom) : 0;
  document.documentElement.style.setProperty('--toast-stack-top', `${bottom}px`);
}

// Called after each notification opens. The holder is created lazily with the very first card and
// AntD hasn't rendered it yet on this frame, so keep looking for a few; once the observer is on it,
// the holder's own resizes (a card entering, leaving, or the stack emptying) drive everything else.
function watchToastStack(attempt = 0): void {
  requestAnimationFrame(() => {
    const holder = document.querySelector('.ant-notification-topRight');
    if (!holder) {
      if (attempt < 10) watchToastStack(attempt + 1);
      return;
    }
    if (holder !== stackHolder) {
      stackObserver?.disconnect();
      stackObserver = new ResizeObserver(syncToastStack);
      stackObserver.observe(holder);
      stackHolder = holder;
    }
    syncToastStack();
  });
}

function announce(content: React.ReactNode, assertive: boolean): void {
  if (typeof content !== 'string' || !content) return;
  if (!liveRegion) {
    liveRegion = document.createElement('div');
    liveRegion.className = 'sr-only';
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
type SessionNoticeIcon =
  | 'check'
  | 'trash'
  | 'branch'
  | 'sync'
  | 'undo'
  | 'info'
  | 'warning'
  | 'error';

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

export function useToast() {
  const { message, notification } = AntApp.useApp();
  const navigate = useNavigate();
  return useMemo(
    () => {
      // Entity-bearing results use a richer card than a short Message: result first, the
      // affected session second, optional diagnostic detail third. Error/warning outcomes stay
      // until dismissed; everything else leaves after eight seconds — twice the Message layer's
      // four, because there's a headline, a session title and sometimes a diagnostic to read.
      // Every card holds while hovered: they all take clicks now that the copy block opens the
      // session, so a card you're reaching for never leaves under the cursor.
      const sessionNotice = ({
        sessionId,
        sessionTitle,
        event,
        headline,
        detail,
        tone = 'success',
        icon,
        duration,
        action,
      }: SessionNoticeOptions): void => {
        const key = `session-${event}-${sessionId}`;
        const title = titleFirstLine(sessionTitle) || 'Untitled session';
        const persistent = tone === 'error' || tone === 'warning';
        // The tone picks the icon unless the caller names one: a failure reads as a failure
        // without every call site having to say so, but "Session permanently deleted" can still
        // show the trash it came from.
        const iconNode = {
          check: <CheckCircleFilled className="session-lifecycle-toast-icon" aria-hidden="true" />,
          trash: <DeleteOutlined className="session-lifecycle-toast-icon" aria-hidden="true" />,
          branch: <BranchesOutlined className="session-lifecycle-toast-icon" aria-hidden="true" />,
          sync: <SyncOutlined className="session-lifecycle-toast-icon" aria-hidden="true" />,
          undo: <UndoOutlined className="session-lifecycle-toast-icon" aria-hidden="true" />,
          info: <InfoCircleFilled className="session-lifecycle-toast-icon" aria-hidden="true" />,
          warning: (
            <ExclamationCircleFilled className="session-lifecycle-toast-icon" aria-hidden="true" />
          ),
          error: <CloseCircleFilled className="session-lifecycle-toast-icon" aria-hidden="true" />,
        }[icon ?? (tone === 'warning' ? 'warning' : tone === 'error' ? 'error' : 'check')];

        notification.open({
          key,
          className: `session-lifecycle-toast session-lifecycle-toast--${tone}`,
          icon: iconNode,
          message: (
            <div className="session-lifecycle-toast-body">
              {/* The card names a session, so it doubles as the way back to it — a result you
                  want to act on is usually a result you want to look at. The copy block (not the
                  whole card) carries the click so the × and Undo keep their own targets. */}
              <button
                type="button"
                className="session-lifecycle-toast-copy"
                aria-label={`Open ${title}`}
                onClick={() => {
                  // A card carrying a diagnostic is also one you select and paste (see the
                  // `user-select` rule for error/warning tones). Releasing a drag counts as a
                  // click, so treat one that ends on a selection as the selection, not a jump.
                  if (window.getSelection()?.toString()) return;
                  notification.destroy(key);
                  navigate(`/sessions/${encodeId(sessionId)}`);
                }}
              >
                <div className="session-lifecycle-toast-status">{headline}</div>
                <div className="session-lifecycle-toast-title" title={title}>
                  {title}
                </div>
                {detail && <div className="session-lifecycle-toast-detail">{detail}</div>}
              </button>
              {action && (
                <button
                  type="button"
                  className="session-lifecycle-toast-undo"
                  aria-label={action.ariaLabel}
                  onClick={() => {
                    notification.destroy(key);
                    action.onClick();
                  }}
                >
                  {action.label}
                </button>
              )}
            </div>
          ),
          duration: persistent ? 0 : (duration ?? 8),
          pauseOnHover: true,
          closable: persistent,
          placement: 'topRight',
          role: persistent ? 'alert' : 'status',
        });
        watchToastStack();
      };

      // The toast vocabulary is a closed set, not everything AntD's message instance happens to
      // carry: `loading` self-destructs after AntD's default 3s while the work it announces is
      // still running, and `open` would let a call site opt out of the conventions above.
      return {
        success: (content: React.ReactNode) => {
          announce(content, false);
          return message.success(content);
        },
        info: (content: React.ReactNode) => {
          announce(content, false);
          return message.info(content);
        },
        warning: (content: React.ReactNode) => {
          announce(content, false);
          return message.warning(content);
        },
        destroy: message.destroy,
        error: (content: React.ReactNode) => {
          const key = `toast-err-${++errSeq}`;
          announce(content, true);
          return message.error({
            key,
            duration: 0,
            content: (
              <span className="toast-err">
                <span className="toast-err-text">{content}</span>
                <button
                  type="button"
                  className="toast-err-close"
                  aria-label="Dismiss"
                  onClick={() => message.destroy(key)}
                >
                  <CloseOutlined />
                </button>
              </span>
            ),
          });
        },
        sessionNotice,
        // Complete/Trash are the two reversible session results. Keep the convenience method
        // so their Undo behavior stays identical while sharing the generic result-card surface.
        sessionAction: ({ sessionId, sessionTitle, action, onUndo }: SessionActionToastOptions) => {
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
              ariaLabel: completed
                ? `Undo completing ${title}`
                : `Undo moving ${title} to Trash`,
              onClick: onUndo,
            },
          });
        },
      };
    },
    [message, notification, navigate],
  );
}
