import type { ComponentPropsWithoutRef, ReactNode } from 'react';
import './Badge.css';

export interface BadgeProps extends ComponentPropsWithoutRef<'span'> {
  /** Status tones, and the preset colours (blue, green, orange, red, gold, purple) the replaced tags drew. */
  tone?: 'default' | 'info' | 'success' | 'warning' | 'error' | 'blue' | 'green' | 'orange' | 'red' | 'gold' | 'purple';
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
