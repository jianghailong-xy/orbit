import { forwardRef, type HTMLAttributes } from 'react';
import { Radio as BaseRadio } from '@base-ui/react/radio';
import { RadioGroup as BaseRadioGroup } from '@base-ui/react/radio-group';
import './ChoiceControls.css';

type RadioValue = string | number;

export interface RadioGroupProps<Value extends RadioValue = RadioValue>
  extends Omit<HTMLAttributes<HTMLDivElement>, 'onChange' | 'defaultValue'> {
  value: Value;
  onValueChange?: (value: Value) => void;
  name?: string;
  form?: string;
  disabled?: boolean;
  required?: boolean;
  readOnly?: boolean;
  invalid?: boolean;
  variant?: 'default' | 'button';
  /** Buttons only: the checked one outlined (default) or filled with the primary colour. */
  buttonStyle?: 'outline' | 'solid';
  size?: 'small' | 'middle';
}

export function RadioGroup<Value extends RadioValue>({
  className, variant = 'default', buttonStyle = 'outline', size = 'middle', invalid, ...props
}: RadioGroupProps<Value>) {
  return (
    <BaseRadioGroup
      {...props}
      className={`orbit-radio-group${className ? ` ${className}` : ''}`}
      data-variant={variant}
      data-button-style={variant === 'button' ? buttonStyle : undefined}
      data-size={size}
      aria-invalid={invalid || props['aria-invalid'] || undefined}
    />
  );
}

export interface RadioProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'onChange' | 'defaultValue'> {
  value: RadioValue;
  disabled?: boolean;
  invalid?: boolean;
}

export const Radio = forwardRef<HTMLInputElement, RadioProps>(function Radio(
  { children, className, style, invalid, ...props },
  ref,
) {
  const hasLabel = children != null && typeof children !== 'boolean' && children !== '';
  const Wrapper = hasLabel ? 'label' : 'span';
  return (
    <Wrapper className={`orbit-choice orbit-radio-button${className ? ` ${className}` : ''}`} style={style}>
      <BaseRadio.Root
        {...props}
        inputRef={ref}
        className="orbit-radio"
        aria-invalid={invalid || props['aria-invalid'] || undefined}
        aria-labelledby={props['aria-labelledby'] ?? (props['aria-label'] ? '' : undefined)}
      />
      {hasLabel && <span className="orbit-choice-label">{children}</span>}
    </Wrapper>
  );
});
