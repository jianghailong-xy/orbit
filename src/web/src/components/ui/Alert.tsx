import type { ReactNode } from 'react';
import { CloseCircleFilled } from '@ant-design/icons';
import './Alert.css';

export interface AlertProps {
  /** Only the error tone is in use. */
  type: 'error';
  title: ReactNode;
  description?: ReactNode;
  className?: string;
}

/** An inline status block that announces itself (role=alert), with its icon, title and detail. */
export function Alert({ type, title, description, className }: AlertProps) {
  return (
    <div role="alert" className={`orbit-alert orbit-alert-${type}${description != null ? ' orbit-alert-with-description' : ''}${className ? ` ${className}` : ''}`}>
      <span className="orbit-alert-icon" aria-hidden><CloseCircleFilled /></span>
      <div className="orbit-alert-section">
        <div className="orbit-alert-title">{title}</div>
        {description != null && <div className="orbit-alert-description">{description}</div>}
      </div>
    </div>
  );
}
