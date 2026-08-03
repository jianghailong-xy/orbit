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
// success/info/warning/loading pass through to AntD unchanged.

let errSeq = 0;

interface SessionActionToastOptions {
  sessionId: string;
  sessionTitle: string;
  action: 'complete' | 'trash';
  onUndo: () => void;
}

type SessionNoticeTone = 'success' | 'neutral' | 'info' | 'warning' | 'error' | 'danger';
type SessionNoticeIcon = 'check' | 'trash' | 'branch' | 'sync' | 'undo' | 'info';

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
      // until dismissed; successful outcomes pause on hover and leave after eight seconds.
      const sessionNotice = ({
        sessionId,
        sessionTitle,
        event,
        headline,
        detail,
        tone = 'success',
        icon = 'check',
        duration,
        action,
      }: SessionNoticeOptions): void => {
        const key = `session-${event}-${sessionId}`;
        const title = titleFirstLine(sessionTitle) || 'Untitled session';
        const persistent = tone === 'error' || tone === 'warning';
        const iconNode = {
          check: <CheckCircleFilled className="session-lifecycle-toast-icon" aria-hidden="true" />,
          trash: <DeleteOutlined className="session-lifecycle-toast-icon" aria-hidden="true" />,
          branch: <BranchesOutlined className="session-lifecycle-toast-icon" aria-hidden="true" />,
          sync: <SyncOutlined className="session-lifecycle-toast-icon" aria-hidden="true" />,
          undo: <UndoOutlined className="session-lifecycle-toast-icon" aria-hidden="true" />,
          info: <InfoCircleFilled className="session-lifecycle-toast-icon" aria-hidden="true" />,
        }[icon];

        notification.open({
          key,
          className: `session-lifecycle-toast session-lifecycle-toast--${tone}`,
          icon:
            tone === 'error' ? (
              <CloseCircleFilled className="session-lifecycle-toast-icon" aria-hidden="true" />
            ) : tone === 'warning' ? (
              <ExclamationCircleFilled className="session-lifecycle-toast-icon" aria-hidden="true" />
            ) : (
              iconNode
            ),
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
      };

      return {
        ...message,
        error: (content: React.ReactNode) => {
          const key = `toast-err-${++errSeq}`;
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
