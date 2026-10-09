import type { CSSProperties, ReactNode } from 'react';
import { CloseCircleFilled, ExclamationCircleFilled } from '@ant-design/icons';
import './Alert.css';

export interface AlertProps {
  type: 'error' | 'warning';
  title: ReactNode;
  description?: ReactNode;
  /** What to do about it, after the text: a Retry, a repair. */
  action?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** Present, as the replaced alert read it: an empty string or `false` is no description, no action. */
const shown = (node: ReactNode) => node != null && node !== false && node !== '';

/** An inline status block that announces itself (role=alert), with its icon, title and detail. */
export function Alert({ type, title, description, action, className, style }: AlertProps) {
  const described = shown(description);
  return (
    <div role="alert" style={style} className={`orbit-alert orbit-alert-${type}${described ? ' orbit-alert-with-description' : ''}${className ? ` ${className}` : ''}`}>
      <span className="orbit-alert-icon" aria-hidden>{type === 'warning' ? <ExclamationCircleFilled /> : <CloseCircleFilled />}</span>
      <div className="orbit-alert-section">
        <div className="orbit-alert-title">{title}</div>
        {described && <div className="orbit-alert-description">{description}</div>}
      </div>
      {shown(action) && <div className="orbit-alert-actions">{action}</div>}
    </div>
  );
}
