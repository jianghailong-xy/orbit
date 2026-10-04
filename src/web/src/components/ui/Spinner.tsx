import type { ComponentPropsWithoutRef } from 'react';
import './Spinner.css';

export interface SpinnerProps extends ComponentPropsWithoutRef<'span'> {
  size?: 'small' | 'middle';
}

export function Spinner({ size = 'middle', className, ...props }: SpinnerProps) {
  return (
    <span role="status" aria-label="Loading" {...props}
      className={`orbit-spinner orbit-spinner-${size}${className ? ` ${className}` : ''}`}>
      <span className="orbit-spinner-dots" aria-hidden="true"><i /><i /><i /><i /></span>
    </span>
  );
}
