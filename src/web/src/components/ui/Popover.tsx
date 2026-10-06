import { useRef, type ReactElement, type ReactNode, type RefObject } from 'react';
import { Popover as BasePopover } from '@base-ui/react/popover';
import { OverlayScope } from './Overlay';
import { calloutArrowStyle, useFloating, useWholePixelOffsets, type FloatingProps } from './Floating';
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
  const anchor = useRef<HTMLButtonElement>(null);
  const offsets = useWholePixelOffsets(anchor, 12);
  return <BasePopover.Root open={layer.open} onOpenChange={layer.setOpen} modal={false}>
    <BasePopover.Trigger ref={anchor} render={trigger} disabled={disabled} openOnHover={openOnHover} delay={100} closeDelay={100} />
    <BasePopover.Portal container={layer.container()}>
      <BasePopover.Positioner side={side} align={align} {...offsets} collisionPadding={8} className="orbit-floating-positioner" style={{ zIndex: layer.zIndex }}>
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
