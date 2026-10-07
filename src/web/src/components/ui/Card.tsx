import { useId, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import './Card.css';

export interface CardProps extends Omit<ComponentPropsWithoutRef<'section'>, 'title'> {
  title: ReactNode;
}

/** A titled panel, named by its title: the bordered box, head and padding of the card it replaces. */
export function Card({ title, className, children, ...props }: CardProps) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} {...props} className={`orbit-card${className ? ` ${className}` : ''}`}>
      <div className="orbit-card-head">
        <h2 className="orbit-card-title" id={titleId}>{title}</h2>
      </div>
      <div className="orbit-card-body">{children}</div>
    </section>
  );
}
