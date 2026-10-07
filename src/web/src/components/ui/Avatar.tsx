import type { ComponentPropsWithoutRef } from 'react';
import './Avatar.css';

export interface AvatarProps extends ComponentPropsWithoutRef<'span'> {
  /** Width and height in px. */
  size?: number;
}

/** A round initials badge. Only text content today: the panel's people and workspaces have no picture. */
export function Avatar({ size = 32, className, style, children, ...props }: AvatarProps) {
  return (
    <span {...props} className={`orbit-avatar${className ? ` ${className}` : ''}`} style={{ width: size, height: size, ...style }}>
      <span className="orbit-avatar-string">{children}</span>
    </span>
  );
}
