import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { Button as BaseButton } from '@base-ui/react/button';
import { LoadingOutlined } from '@ant-design/icons';
import './Button.css';

interface ButtonAppearance {
  variant?: 'default' | 'primary' | 'dashed' | 'text' | 'link';
  size?: 'small' | 'middle' | 'large';
  danger?: boolean;
  icon?: ReactNode;
  /** `end`: the icon follows the text (a disclosure caret), 8px after it as before it. */
  iconPlacement?: 'start' | 'end';
}

export interface ButtonProps extends ComponentPropsWithoutRef<'button'>, ButtonAppearance {
  loading?: boolean;
}

/** Actions use native button semantics; `type` is the HTML button type. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({
  variant = 'default', size = 'middle', danger = false, icon, iconPlacement = 'start', loading = false,
  disabled, type = 'button', className, children, ...props
}, ref) {
  const mark = (loading || icon) && <span className="orbit-button-icon" aria-hidden="true">{loading ? <LoadingOutlined spin /> : icon}</span>;
  return (
    <BaseButton {...props} ref={ref} type={type} disabled={disabled || loading}
      focusableWhenDisabled={loading && !disabled} aria-busy={loading || undefined}
      data-loading={loading || undefined}
      className={`orbit-button orbit-button-${variant} orbit-button-${size}${danger ? ' orbit-button-danger' : ''}${children == null ? ' orbit-button-icon-only' : ''}${className ? ` ${className}` : ''}`}>
      {iconPlacement === 'start' && mark}
      {children != null && <span>{children}</span>}
      {iconPlacement === 'end' && mark}
    </BaseButton>
  );
});

export interface LinkButtonProps extends ComponentPropsWithoutRef<'a'>, ButtonAppearance {}

/** Navigation stays an anchor, including target, download and modified clicks. */
export const LinkButton = forwardRef<HTMLAnchorElement, LinkButtonProps>(function LinkButton({
  variant = 'default', size = 'middle', danger = false, icon, iconPlacement = 'start', className, children, ...props
}, ref) {
  const mark = icon && <span className="orbit-button-icon" aria-hidden="true">{icon}</span>;
  return (
    <a {...props} ref={ref}
      className={`orbit-button orbit-button-${variant} orbit-button-${size}${danger ? ' orbit-button-danger' : ''}${children == null ? ' orbit-button-icon-only' : ''}${className ? ` ${className}` : ''}`}>
      {iconPlacement === 'start' && mark}
      {children != null && <span>{children}</span>}
      {iconPlacement === 'end' && mark}
    </a>
  );
});
