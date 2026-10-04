import { forwardRef, type HTMLAttributes } from 'react';
import { LoadingOutlined } from '@ant-design/icons';
import { Switch as BaseSwitch } from '@base-ui/react/switch';
import './ChoiceControls.css';

export interface SwitchProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'onChange' | 'defaultChecked' | 'children'> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  disabled?: boolean;
  loading?: boolean;
  invalid?: boolean;
  size?: 'small' | 'middle';
  name?: string;
  value?: string;
  form?: string;
  required?: boolean;
  readOnly?: boolean;
}

export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { className, disabled, loading = false, invalid, size = 'middle', ...props },
  ref,
) {
  return (
    <BaseSwitch.Root
      {...props}
      inputRef={ref}
      className={`orbit-switch${className ? ` ${className}` : ''}`}
      data-size={size}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      aria-invalid={invalid || props['aria-invalid'] || undefined}
      aria-labelledby={props['aria-labelledby'] ?? (props['aria-label'] ? '' : undefined)}
    >
      <BaseSwitch.Thumb className="orbit-switch-thumb">
        {loading && <LoadingOutlined className="orbit-switch-loading" aria-hidden />}
      </BaseSwitch.Thumb>
    </BaseSwitch.Root>
  );
});
