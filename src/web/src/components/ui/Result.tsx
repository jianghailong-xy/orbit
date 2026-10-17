import type { ReactNode } from 'react';
import { CheckCircleFilled, ExclamationCircleFilled, WarningFilled } from '@ant-design/icons';
import { NotFoundImage } from './ResultNotFound';
import './Result.css';

// The replaced result's icons: info is the exclamation circle, warning the triangle.
const ICONS = { success: <CheckCircleFilled />, info: <ExclamationCircleFilled />, warning: <WarningFilled /> };

export interface ResultProps {
  /** `404`: the replaced result's not-found picture in the icon's place (a session link that leads nowhere). */
  status: keyof typeof ICONS | '404';
  title: ReactNode;
  subTitle?: ReactNode;
  /** What to do about it, 24px under the text: the buttons centred, 8px apart (Go home on the 404). */
  extra?: ReactNode;
}

/** Where something ended up, centred under a 72px status icon: the replaced result block. */
export function Result({ status, title, subTitle, extra }: ResultProps) {
  return (
    <div className="orbit-result" data-status={status}>
      {status === '404' ? (
        <div className="orbit-result-icon orbit-result-image" aria-hidden>
          <NotFoundImage />
        </div>
      ) : (
        <div className="orbit-result-icon" aria-hidden>
          {ICONS[status]}
        </div>
      )}
      <div className="orbit-result-title">{title}</div>
      {subTitle != null && <div className="orbit-result-subtitle">{subTitle}</div>}
      {extra != null && <div className="orbit-result-extra">{extra}</div>}
    </div>
  );
}
