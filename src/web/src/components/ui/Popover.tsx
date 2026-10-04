import { useRef, type ReactElement, type ReactNode, type RefObject } from 'react';
import { Popover as BasePopover } from '@base-ui/react/popover';
import { OverlayScope } from './Overlay';
import { calloutArrowStyle, useFloating, type FloatingProps } from './Floating';
import './Floating.css';

export interface PopoverProps extends FloatingProps {
  trigger: ReactElement;
  title: ReactNode;
  children: ReactNode;
  openOnHover?: boolean;
  disabled?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
}

export function Popover({ trigger, title, children, openOnHover = false, disabled, initialFocus,
  side = 'top', align = 'center', popupClassName, popupStyle, returnFocus, ...state }: PopoverProps) {
  const layer = useFloating(state);
  const popup = useRef<HTMLDivElement>(null);
  return <BasePopover.Root open={layer.open} onOpenChange={layer.setOpen} modal={false}>
    <BasePopover.Trigger render={trigger} disabled={disabled} openOnHover={openOnHover} delay={100} closeDelay={100} />
    <BasePopover.Portal container={layer.container()}>
      <BasePopover.Positioner side={side} align={align} sideOffset={12} collisionPadding={8} className="orbit-floating-positioner orbit-callout-positioner" style={{ zIndex: layer.zIndex }}>
        <BasePopover.Popup ref={popup} initialFocus={initialFocus ?? popup} finalFocus={returnFocus}
          className={`orbit-popover${popupClassName ? ` ${popupClassName}` : ''}`} style={popupStyle}>
          <BasePopover.Arrow className="orbit-floating-arrow" style={calloutArrowStyle} />
          {title != null && <BasePopover.Title className="orbit-popover-title">{title}</BasePopover.Title>}
          <OverlayScope>{children}</OverlayScope>
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  </BasePopover.Root>;
}
