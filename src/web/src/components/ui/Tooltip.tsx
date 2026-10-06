import { useId, type ReactElement, type ReactNode, type AriaAttributes } from 'react';
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import { calloutArrowStyle, useFloating, type FloatingProps } from './Floating';
import './Floating.css';

export interface TooltipProps extends Omit<FloatingProps, 'returnFocus'> {
  children: ReactElement;
  content: ReactNode;
  disabled?: boolean;
}

export function Tooltip({ children, content, disabled, side = 'top', align = 'center', popupClassName, popupStyle, ...state }: TooltipProps) {
  const layer = useFloating(state);
  const id = useId();
  const describedBy = [((children.props as AriaAttributes)['aria-describedby']), layer.open && id].filter(Boolean).join(' ') || undefined;
  return <BaseTooltip.Root open={layer.open} onOpenChange={layer.setOpen} disabled={disabled || content == null || content === ''}>
    <BaseTooltip.Trigger render={children} aria-describedby={describedBy} delay={100} closeDelay={100} />
    <BaseTooltip.Portal container={layer.container()}>
      <BaseTooltip.Positioner side={side} align={align} sideOffset={12} collisionPadding={8} className="orbit-floating-positioner" style={{ zIndex: layer.zIndex + 70 }}>
        <BaseTooltip.Popup role="tooltip" id={id} className={`orbit-tooltip${popupClassName ? ` ${popupClassName}` : ''}`} style={popupStyle}>
          <BaseTooltip.Arrow className="orbit-floating-arrow" style={calloutArrowStyle} />{content}
        </BaseTooltip.Popup>
      </BaseTooltip.Positioner>
    </BaseTooltip.Portal>
  </BaseTooltip.Root>;
}
