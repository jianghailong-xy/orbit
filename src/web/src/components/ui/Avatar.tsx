import { useState, type ComponentPropsWithoutRef } from 'react';
import './Avatar.css';

export interface AvatarProps extends ComponentPropsWithoutRef<'span'> {
  /** Width and height in px. */
  size?: number;
  /** A picture drawn in place of the text, cut to the circle; the text shows while there is none or it fails to load. */
  src?: string;
  alt?: string;
}

/** A round avatar: a picture, or the initials it falls back to. */
export function Avatar({ size = 32, src, alt = '', className, style, children, ...props }: AvatarProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const picture = src && failed !== src ? src : null;
  return (
    <span {...props} className={`orbit-avatar${picture ? ' orbit-avatar-image' : ''}${className ? ` ${className}` : ''}`} style={{ width: size, height: size, ...style }}>
      {picture ? <img src={picture} alt={alt} onError={() => setFailed(picture)} /> : <span className="orbit-avatar-string">{children}</span>}
    </span>
  );
}
