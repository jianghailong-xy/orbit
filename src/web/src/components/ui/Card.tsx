import { useId, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import './Card.css';

export interface CardProps extends Omit<ComponentPropsWithoutRef<'section'>, 'title'> {
  title: ReactNode;
  /** What the head carries at its far end, in body text: a link or a small action. */
  extra?: ReactNode;
  /** Small: the replaced small card's 38px head, 14px title and 12px padding. */
  size?: 'default' | 'small';
}

/** A titled panel, named by its title: the bordered box, head and padding of the card it replaces. */
export function Card({ title, extra, size = 'default', className, children, ...props }: CardProps) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} {...props}
      className={`orbit-card${size === 'small' ? ' orbit-card-small' : ''}${className ? ` ${className}` : ''}`}>
      <div className="orbit-card-head">
        <h2 className="orbit-card-title" id={titleId}>{title}</h2>
        {extra != null && extra !== false && <div className="orbit-card-extra">{extra}</div>}
      </div>
      <div className="orbit-card-body">{children}</div>
    </section>
  );
}
