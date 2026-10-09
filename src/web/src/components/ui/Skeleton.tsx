import type { ComponentPropsWithoutRef } from 'react';
import './Skeleton.css';

export interface SkeletonProps extends ComponentPropsWithoutRef<'div'> {
  /** How many lines of placeholder text; the last is 61% wide. */
  rows?: number;
}

/** Placeholder lines while a card's first read is in flight, shimmering as the replaced skeleton
 *  did. Decorative: the region it stands in says it is loading. */
export function Skeleton({ rows = 3, className, ...props }: SkeletonProps) {
  return (
    <div aria-hidden="true" {...props} className={`orbit-skeleton${className ? ` ${className}` : ''}`}>
      <div className="orbit-skeleton-section">
        <ul className="orbit-skeleton-paragraph">
          {Array.from({ length: rows }, (_, index) => <li key={index} style={index === rows - 1 ? { width: '61%' } : undefined} />)}
        </ul>
      </div>
    </div>
  );
}
