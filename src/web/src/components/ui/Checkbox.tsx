import { forwardRef, type HTMLAttributes } from 'react';
import { Checkbox as BaseCheckbox } from '@base-ui/react/checkbox';
import './ChoiceControls.css';

export interface CheckboxProps extends Omit<HTMLAttributes<HTMLSpanElement>, 'onChange' | 'defaultChecked'> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  indeterminate?: boolean;
  disabled?: boolean;
  invalid?: boolean;
  name?: string;
  value?: string;
  form?: string;
  required?: boolean;
  readOnly?: boolean;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { children, className, style, invalid, ...props },
  ref,
) {
  const hasLabel = children != null && typeof children !== 'boolean' && children !== '';
  const Wrapper = hasLabel ? 'label' : 'span';
  return (
    <Wrapper className={`orbit-choice${className ? ` ${className}` : ''}`} style={style}>
      <BaseCheckbox.Root
        {...props}
        inputRef={ref}
        className="orbit-checkbox"
        aria-invalid={invalid || props['aria-invalid'] || undefined}
        // An explicit name must win over Base UI's automatic native-label fallback.
        aria-labelledby={props['aria-labelledby'] ?? (props['aria-label'] ? '' : undefined)}
      />
      {hasLabel && <span className="orbit-choice-label">{children}</span>}
    </Wrapper>
  );
});
