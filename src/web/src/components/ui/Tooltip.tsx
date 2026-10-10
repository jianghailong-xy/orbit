import { useId, useRef, type ReactElement, type ReactNode, type AriaAttributes } from 'react';
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import { calloutArrowStyle, useFloating, useWholePixelOffsets, type FloatingProps } from './Floating';
import './Floating.css';

export interface TooltipProps extends Omit<FloatingProps, 'returnFocus'> {
  children: ReactElement;
  content: ReactNode;
  disabled?: boolean;
  /** A press on the trigger opens a closed tip and closes an open one, as well as hover and focus opening it
   *  (the replaced tip's click trigger): a tip whose words a touch reader has to reach. Otherwise a press closes it. */
  toggleOnClick?: boolean;
  /** False: the tip is placed when it opens and stays there, as the replaced tip (aligned once) did — for a trigger that
   *  turns (a spinner), whose box changes with every frame and would bob a tracking tip up and down with it (P5.3). */
  trackTrigger?: boolean;
}

export function Tooltip({ children, content, disabled, toggleOnClick = false, trackTrigger = true, side = 'top', align = 'center', popupClassName, popupStyle, ...state }: TooltipProps) {
  const layer = useFloating(state);
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const { positionerRef, ...offsets } = useWholePixelOffsets(anchor, 12, 8);
  const describedBy = [((children.props as AriaAttributes)['aria-describedby']), layer.open && id].filter(Boolean).join(' ') || undefined;
  return <BaseTooltip.Root open={layer.open} onOpenChange={layer.setOpen} disabled={disabled || content == null || content === ''}>
    <BaseTooltip.Trigger ref={anchor} render={children} aria-describedby={describedBy} delay={100} closeDelay={100}
      closeOnClick={!toggleOnClick} onClick={toggleOnClick ? () => layer.setOpen(!layer.open) : undefined} />
    <BaseTooltip.Portal container={layer.container()}>
      <BaseTooltip.Positioner ref={positionerRef} side={side} align={align} {...offsets} collisionPadding={8} positionMethod={layer.positionMethod} disableAnchorTracking={!trackTrigger} className="orbit-floating-positioner" style={{ zIndex: layer.zIndex + 70 }}>
        <BaseTooltip.Popup role="tooltip" id={id} className={`orbit-tooltip${popupClassName ? ` ${popupClassName}` : ''}`} style={popupStyle}>
          <BaseTooltip.Arrow className="orbit-floating-arrow" style={calloutArrowStyle} />{content}
        </BaseTooltip.Popup>
      </BaseTooltip.Positioner>
    </BaseTooltip.Portal>
  </BaseTooltip.Root>;
}
