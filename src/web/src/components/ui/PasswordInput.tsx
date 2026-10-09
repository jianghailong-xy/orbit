import { useState, type KeyboardEvent } from 'react';
import { EyeInvisibleOutlined, EyeOutlined } from '@ant-design/icons';
import { Input, type InputProps } from './Input';

export interface PasswordInputProps extends Omit<InputProps, 'type'> {
  /** Whether the password shows; given, the toggle asks for a change through `onVisibleChange`. */
  visible?: boolean;
  onVisibleChange?: (visible: boolean) => void;
}

/**
 * A password field with the replaced field's show/hide toggle at its end: a button in the Tab order
 * (Enter or Space), named Show or Hide and pressed while the password shows; pressing it keeps focus
 * and the caret in the field. A `suffix` follows the toggle.
 */
export function PasswordInput({ suffix, disabled, visible: shownProp, onVisibleChange, ...props }: PasswordInputProps) {
  const [shownState, setShownState] = useState(false);
  const visible = shownProp ?? shownState;
  const flip = () => {
    if (disabled) return;
    if (shownProp === undefined) setShownState(!visible);
    onVisibleChange?.(!visible);
  };
  const toggle = (
    <span
      role="button"
      tabIndex={disabled ? -1 : 0}
      className="orbit-password-toggle"
      aria-label={visible ? 'Hide' : 'Show'}
      aria-pressed={visible}
      aria-disabled={disabled || undefined}
      onMouseDown={(event) => event.preventDefault()}
      onMouseUp={(event) => event.preventDefault()}
      onClick={flip}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        if (!event.repeat) flip();
      }}
    >
      {visible ? <EyeOutlined /> : <EyeInvisibleOutlined />}
    </span>
  );
  return <Input {...props} disabled={disabled} type={visible ? 'text' : 'password'} suffix={<>{toggle}{suffix}</>} />;
}
