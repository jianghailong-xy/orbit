import { useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import './Avatar.css';

export interface AvatarProps extends ComponentPropsWithoutRef<'span'> {
  /** Width and height in px. */
  size?: number;
  /** A picture drawn in place of the text, cut to the circle; the text shows while there is none or it fails to load. */
  src?: string;
  alt?: string;
  /** Drawn in place of the text while there is no picture, at half the avatar's size, as the replaced icon avatar
   *  (the account menu's person while no photo is set). */
  icon?: ReactNode;
}

/** A round avatar: a picture, or the icon or initials it falls back to. */
export function Avatar({ size = 32, src, alt = '', icon, className, style, children, ...props }: AvatarProps) {
  const [failed, setFailed] = useState<string | null>(null);
  const picture = src && failed !== src ? src : null;
  const hasIcon = icon != null;
  return (
    <span {...props}
      className={`orbit-avatar${picture ? ' orbit-avatar-image' : ''}${hasIcon ? ' orbit-avatar-icon' : ''}${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size, ...(hasIcon ? { fontSize: size / 2 } : {}), ...style }}>
      {picture ? <img src={picture} alt={alt} onError={() => setFailed(picture)} />
        : hasIcon ? icon : <span className="orbit-avatar-string">{children}</span>}
    </span>
  );
}
