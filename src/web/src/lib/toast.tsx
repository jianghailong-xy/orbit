import { CloseOutlined } from '@ant-design/icons';
import { App as AntApp } from 'antd';
import React, { useMemo } from 'react';

// Every toast in the app goes through this instead of AntApp.useApp().message directly, so
// the one behaviour we want to differ from AntD's default lives in a single place: errors
// don't auto-dismiss. A merge conflict or an API failure is usually the thing you want to
// read twice and paste somewhere, and the default 3s timer takes it away mid-sentence.
// They stay until the × is clicked; index.css re-enables pointer events and text selection
// for error cards only (the rest stay click-through so they can't block the header).
// success/info/warning/loading pass through to AntD unchanged.

let errSeq = 0;

export function useToast() {
  const { message } = AntApp.useApp();
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
    }),
    [message],
  );
}
