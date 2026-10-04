import type { ComponentPropsWithRef, ReactNode } from 'react';
import './TextControls.css';

export interface InputProps extends Omit<ComponentPropsWithRef<'input'>, 'size' | 'prefix'> {
  size?: 'small' | 'middle' | 'large';
  invalid?: boolean;
  prefix?: ReactNode;
  suffix?: ReactNode;
}

export function Input({
  size = 'middle', invalid = false, prefix, suffix, className, style, disabled,
  ...props
}: InputProps) {
  const hasPrefix = prefix != null && typeof prefix !== 'boolean' && prefix !== '';
  const hasSuffix = suffix != null && typeof suffix !== 'boolean' && suffix !== '';
  const adorned = hasPrefix || hasSuffix;
  const classes = ['orbit-text-control', 'orbit-input', className].filter(Boolean).join(' ');
  const state = {
    'data-size': size,
    'data-invalid': invalid ? '' : undefined,
    'data-disabled': disabled ? '' : undefined,
  };
  const input = (
    <input
      {...props}
      {...(!adorned ? state : {})}
      className={adorned ? 'orbit-input-field' : classes}
      style={adorned ? undefined : style}
      disabled={disabled}
      aria-invalid={invalid || props['aria-invalid'] || undefined}
    />
  );
  if (!adorned) return input;
  return (
    <span {...state} className={`${classes} orbit-input-affix`} style={style} onClick={(event) => {
      if (!disabled && !event.defaultPrevented) {
        event.currentTarget.querySelector<HTMLInputElement>('.orbit-input-field')?.focus();
      }
    }}>
      {hasPrefix && <span className="orbit-input-prefix">{prefix}</span>}
      {input}
      {hasSuffix && <span className="orbit-input-suffix">{suffix}</span>}
    </span>
  );
}
