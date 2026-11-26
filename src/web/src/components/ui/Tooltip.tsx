import { useId, useRef, type ReactElement, type ReactNode, type AriaAttributes } from 'react';
import { Tooltip as BaseTooltip } from '@base-ui/react/tooltip';
import { calloutArrowStyle, useFloating, useWholePixelOffsets, type FloatingProps } from './Floating';
import './Floating.css';

/** How long a pointer rests before a tip opens: a control's (a button's name or what it does) at once, a tip on
 *  plain text (a badge, a count, a time) only once the pointer stops, so moving across a list opens none. */
export const CONTROL_TOOLTIP_DELAY_MS = 100;
export const TEXT_TOOLTIP_DELAY_MS = 600;

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
  /** Milliseconds a pointer rests on the trigger before the tip opens: CONTROL_TOOLTIP_DELAY_MS (the default) on a
   *  control, TEXT_TOOLTIP_DELAY_MS on plain text. */
  delay?: number;
  /** The tip of a label that may not fit (a title, a path, a description clamped to two lines), whose words are the
   *  label's own: it opens only while the trigger, or something in it, is cut off, so a label that fits repeats
   *  nothing. Such a tip may be wider (360 px) and waits as a text tip does unless `delay` says otherwise. */
  truncatedOnly?: boolean;
  /** The tip's words in the monospace font: a path, a branch, a command. */
  mono?: boolean;
}

/** Whether `element`, or an element inside it, shows less than its content: an ellipsis or a line clamp. */
export function isCutOff(element: Element | null): boolean {
  if (!element) return false;
  const boxes = [element, ...element.querySelectorAll('*')];
  return boxes.some((box) => {
    const { clientWidth, clientHeight, scrollWidth, scrollHeight } = box as HTMLElement;
    return clientWidth > 0 && (scrollWidth > clientWidth + 1 || scrollHeight > clientHeight + 1);
  });
}

export function Tooltip({ children, content, disabled, toggleOnClick = false, trackTrigger = true, delay, truncatedOnly = false, mono = false, side = 'top', align = 'center', popupClassName, popupStyle, ...state }: TooltipProps) {
  const layer = useFloating(state);
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const { positionerRef, ...offsets } = useWholePixelOffsets(anchor, 12, 8);
  const describedBy = [((children.props as AriaAttributes)['aria-describedby']), layer.open && id].filter(Boolean).join(' ') || undefined;
  const setOpen = (open: boolean) => {
    if (open && truncatedOnly && !isCutOff(anchor.current)) return;
    layer.setOpen(open);
  };
  const classes = ['orbit-tooltip', truncatedOnly && 'orbit-tooltip-wide', mono && 'orbit-tooltip-mono', popupClassName].filter(Boolean).join(' ');
  return <BaseTooltip.Root open={layer.open} onOpenChange={setOpen} disabled={disabled || content == null || content === ''}>
    <BaseTooltip.Trigger ref={anchor} render={children} aria-describedby={describedBy}
      delay={delay ?? (truncatedOnly ? TEXT_TOOLTIP_DELAY_MS : CONTROL_TOOLTIP_DELAY_MS)} closeDelay={100}
      closeOnClick={!toggleOnClick} onClick={toggleOnClick ? () => layer.setOpen(!layer.open) : undefined} />
    <BaseTooltip.Portal container={layer.container()}>
      <BaseTooltip.Positioner ref={positionerRef} side={side} align={align} {...offsets} collisionPadding={8} positionMethod={layer.positionMethod} disableAnchorTracking={!trackTrigger} className="orbit-floating-positioner" style={{ zIndex: layer.zIndex + 70 }}>
        <BaseTooltip.Popup role="tooltip" id={id} className={classes} style={popupStyle}>
          <BaseTooltip.Arrow className="orbit-floating-arrow" style={calloutArrowStyle} />{content}
        </BaseTooltip.Popup>
      </BaseTooltip.Positioner>
    </BaseTooltip.Portal>
  </BaseTooltip.Root>;
}
