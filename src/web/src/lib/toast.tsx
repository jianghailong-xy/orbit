import { CheckCircleFilled, CloseOutlined, DeleteOutlined } from '@ant-design/icons';
import { App as AntApp } from 'antd';
import React, { useMemo } from 'react';
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

export function useToast() {
  const { message, notification } = AntApp.useApp();
  return useMemo(
    () => ({
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
      // Completing and trashing are reversible session-level actions, so they get a richer
      // two-line card than the app's short messages: outcome first, the affected title second,
      // and a real Undo button. Notification supplies the native top-right stack and horizontal
      // entrance motion; AgentView keeps that stack anchored below whichever header is visible.
      sessionAction: ({ sessionId, sessionTitle, action, onUndo }: SessionActionToastOptions) => {
        const key = `undo-${sessionId}`;
        const title = titleFirstLine(sessionTitle) || 'Untitled session';
        const completed = action === 'complete';
        const status = completed ? 'Session completed' : 'Moved to Trash';
        const undoLabel = completed
          ? `Undo completing ${title}`
          : `Undo moving ${title} to Trash`;

        notification.open({
          key,
          className: `session-lifecycle-toast session-lifecycle-toast--${action}`,
          icon: completed ? (
            <CheckCircleFilled className="session-lifecycle-toast-icon" aria-hidden="true" />
          ) : (
            <DeleteOutlined className="session-lifecycle-toast-icon" aria-hidden="true" />
          ),
          message: (
            <div className="session-lifecycle-toast-body">
              <div className="session-lifecycle-toast-copy">
                <div className="session-lifecycle-toast-status">{status}</div>
                <div className="session-lifecycle-toast-title" title={title}>
                  {title}
                </div>
              </div>
              <button
                type="button"
                className="session-lifecycle-toast-undo"
                aria-label={undoLabel}
                onClick={() => {
                  notification.destroy(key);
                  onUndo();
                }}
              >
                Undo
              </button>
            </div>
          ),
          duration: 8,
          pauseOnHover: true,
          closable: false,
          placement: 'topRight',
          role: 'status',
        });
      },
    }),
    [message, notification],
  );
}
