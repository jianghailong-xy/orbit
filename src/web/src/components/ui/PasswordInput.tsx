import { useState, type KeyboardEvent } from 'react';
import { EyeInvisibleOutlined, EyeOutlined } from '@ant-design/icons';
import { Input, type InputProps } from './Input';

export type PasswordInputProps = Omit<InputProps, 'type'>;

/**
 * A password field with the replaced field's show/hide toggle at its end: a button in the Tab order
 * (Enter or Space), named Show or Hide and pressed while the password shows; pressing it keeps focus
 * and the caret in the field. A `suffix` follows the toggle.
 */
export function PasswordInput({ suffix, disabled, ...props }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);
  const flip = () => {
    if (!disabled) setVisible((shown) => !shown);
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
