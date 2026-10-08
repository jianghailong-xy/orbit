import type { ComponentPropsWithRef, ReactNode } from 'react';
import { CloseCircleFilled } from '@ant-design/icons';
import './TextControls.css';

export interface InputProps extends Omit<ComponentPropsWithRef<'input'>, 'size' | 'prefix'> {
  size?: 'small' | 'middle' | 'large';
  invalid?: boolean;
  prefix?: ReactNode;
  suffix?: ReactNode;
  /** A Clear button at the end while the field holds text (it keeps its place, unseen, while empty).
   *  `onClear` empties the value the caller holds; focus returns to the field. */
  allowClear?: boolean;
  onClear?: () => void;
}

export function Input({
  size = 'middle', invalid = false, prefix, suffix, allowClear = false, onClear, className, style, disabled,
  ...props
}: InputProps) {
  const hasPrefix = prefix != null && typeof prefix !== 'boolean' && prefix !== '';
  const hasSuffix = suffix != null && typeof suffix !== 'boolean' && suffix !== '';
  const adorned = hasPrefix || hasSuffix || allowClear;
  const clearable = allowClear && !disabled && !props.readOnly && props.value != null && props.value !== '';
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
      {(hasSuffix || allowClear) && <span className="orbit-input-suffix">
        {allowClear && <button type="button" className="orbit-input-clear" aria-label="Clear" data-hidden={clearable ? undefined : ''}
          // Pressed with the pointer, the field keeps its focus (no blur), as with the replaced field.
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.currentTarget.closest('.orbit-input-affix')?.querySelector<HTMLInputElement>('.orbit-input-field')?.focus();
            onClear?.();
          }}><CloseCircleFilled aria-hidden /></button>}
        {suffix}
      </span>}
    </span>
  );
}
