import type { CSSProperties, ReactNode } from 'react';
import { CloseCircleFilled, ExclamationCircleFilled } from '@ant-design/icons';
import './Alert.css';

export interface AlertProps {
  type: 'error' | 'warning';
  title: ReactNode;
  description?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

/** An inline status block that announces itself (role=alert), with its icon, title and detail. */
export function Alert({ type, title, description, className, style }: AlertProps) {
  return (
    <div role="alert" style={style} className={`orbit-alert orbit-alert-${type}${description != null ? ' orbit-alert-with-description' : ''}${className ? ` ${className}` : ''}`}>
      <span className="orbit-alert-icon" aria-hidden>{type === 'warning' ? <ExclamationCircleFilled /> : <CloseCircleFilled />}</span>
      <div className="orbit-alert-section">
        <div className="orbit-alert-title">{title}</div>
        {description != null && <div className="orbit-alert-description">{description}</div>}
      </div>
    </div>
  );
}
