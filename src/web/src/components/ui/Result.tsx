import type { ReactNode } from 'react';
import { CheckCircleFilled, ExclamationCircleFilled, WarningFilled } from '@ant-design/icons';
import './Result.css';

// The replaced result's icons: info is the exclamation circle, warning the triangle.
const ICONS = { success: <CheckCircleFilled />, info: <ExclamationCircleFilled />, warning: <WarningFilled /> };

export interface ResultProps {
  status: keyof typeof ICONS;
  title: ReactNode;
  subTitle?: ReactNode;
}

/** Where something ended up, centred under a 72px status icon: the replaced result block. */
export function Result({ status, title, subTitle }: ResultProps) {
  return (
    <div className="orbit-result" data-status={status}>
      <div className="orbit-result-icon" aria-hidden>
        {ICONS[status]}
      </div>
      <div className="orbit-result-title">{title}</div>
      {subTitle != null && <div className="orbit-result-subtitle">{subTitle}</div>}
    </div>
  );
}
