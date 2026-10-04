import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import './Badge.css';

export interface BadgeProps extends ComponentPropsWithoutRef<'span'> {
  tone?: 'default' | 'info' | 'success' | 'warning' | 'error' | 'blue';
  icon?: ReactNode;
}

/** Compact, non-interactive status label. The text carries the status meaning. */
export function Badge({ tone = 'default', icon, children, className, ...props }: BadgeProps) {
  return (
    <span {...props} className={`orbit-badge orbit-badge-${tone}${className ? ` ${className}` : ''}`}>
      {icon && <span className="orbit-badge-icon" aria-hidden="true">{icon}</span>}
      <span>{children}</span>
    </span>
  );
}
