import type { ComponentPropsWithRef } from 'react';
import './TextControls.css';

export interface TextareaProps extends ComponentPropsWithRef<'textarea'> {
  invalid?: boolean;
}

export function Textarea({ invalid = false, className, disabled, ...props }: TextareaProps) {
  return (
    <textarea
      {...props}
      className={['orbit-text-control', 'orbit-textarea', className].filter(Boolean).join(' ')}
      disabled={disabled}
      data-invalid={invalid ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      aria-invalid={invalid || props['aria-invalid'] || undefined}
    />
  );
}
