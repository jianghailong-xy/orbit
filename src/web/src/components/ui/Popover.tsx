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
  /** As the replaced popover's `arrow.pointAtCenter`: above or below its trigger and aligned to one edge, the
   *  popover moves so its arrow points at the trigger's centre, and flips at the viewport's edge without sliding. */
  pointAtCenter?: boolean;
  /** False: no arrow, and 4px from the trigger instead of 12px, as the replaced popover without one (the New
   *  Session engine list). */
  arrow?: boolean;
  /** The room kept from the viewport's edges as the popover slides back inside it (default 8px); 0 for one the
   *  replaced popover slid flush to the edge (`align.overflow.shiftX`): the Plan usage popover on a phone. */
  collisionPadding?: number;
}

export function Popover({ trigger, title, children, openOnHover = false, disabled, initialFocus, pointAtCenter = false, arrow = true,
  collisionPadding = 8, side = 'top', align = 'center', popupClassName, popupStyle, returnFocus, ...state }: PopoverProps) {
  const layer = useFloating(state);
  const popup = useRef<HTMLDivElement>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const pointAt = pointAtCenter && align !== 'center' ? align : undefined;
  const { positionerRef, ...offsets } = useWholePixelOffsets(anchor, arrow ? 12 : 4, collisionPadding, pointAt);
  return <BasePopover.Root open={layer.open} onOpenChange={layer.setOpen} modal={false}>
    <BasePopover.Trigger ref={anchor} render={trigger} disabled={disabled} openOnHover={openOnHover} delay={100} closeDelay={100} />
    <BasePopover.Portal container={layer.container()}>
      <BasePopover.Positioner ref={positionerRef} side={side} align={align} {...offsets} collisionPadding={pointAt ? 0 : collisionPadding} positionMethod={layer.positionMethod} className="orbit-floating-positioner" style={{ zIndex: layer.zIndex }}>
        <BasePopover.Popup ref={popup} initialFocus={initialFocus ?? popup} finalFocus={returnFocus}
          className={`orbit-popover${popupClassName ? ` ${popupClassName}` : ''}`} style={popupStyle}>
          {arrow && <BasePopover.Arrow className="orbit-floating-arrow" style={calloutArrowStyle} />}
          {title != null && <BasePopover.Title className="orbit-popover-title">{title}</BasePopover.Title>}
          <OverlayScope>{children}</OverlayScope>
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  </BasePopover.Root>;
}
