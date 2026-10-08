import { useEffect, useRef, useState, type ReactElement, type ReactNode, type RefObject } from 'react';
import { Popover as BasePopover } from '@base-ui/react/popover';
import { ExclamationCircleFilled } from '@ant-design/icons';
import { Button } from './Button';
import { calloutArrowStyle, useFloating, useWholePixelOffsets, type FloatingProps } from './Floating';
import './Floating.css';

export interface PopconfirmProps extends FloatingProps {
  /** The button that asks. Without one, pass `anchor` and open the question with `open`. */
  trigger?: ReactElement;
  anchor?: RefObject<Element | null>;
  title: ReactNode;
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  /** A request the caller tracks itself, shown on the confirm button. */
  confirmLoading?: boolean;
  /** A returned promise keeps the question open, its button loading, until it settles; resolving closes it. */
  onConfirm: () => unknown;
  onCancel?: () => void;
  disabled?: boolean;
}

/** The small anchored question in front of a destructive press. */
export function Popconfirm({ trigger, anchor, title, description, confirmText = 'OK', cancelText = 'Cancel',
  danger = false, confirmLoading = false, onConfirm, onCancel, disabled, side = 'top', align = 'center',
  popupClassName, popupStyle, returnFocus, ...state }: PopconfirmProps) {
  const layer = useFloating(state);
  const popup = useRef<HTMLDivElement>(null);
  const triggerNode = useRef<HTMLButtonElement>(null);
  const { positionerRef, ...offsets } = useWholePixelOffsets(anchor ?? triggerNode, 12, 0);
  const [pending, setPending] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);
  const confirm = () => {
    if (pending) return;
    const result = onConfirm();
    if (!result || typeof (result as PromiseLike<unknown>).then !== 'function') {
      layer.setOpen(false);
      return;
    }
    setPending(true);
    (result as PromiseLike<unknown>).then(
      () => { if (!mounted.current) return; setPending(false); layer.setOpen(false); },
      () => { if (mounted.current) setPending(false); },
    );
  };
  return <BasePopover.Root open={layer.open} onOpenChange={(next) => { if (!pending || next) layer.setOpen(next); }} modal={false}>
    {trigger && <BasePopover.Trigger ref={triggerNode} render={trigger} disabled={disabled} />}
    <BasePopover.Portal container={layer.container()}>
      {/* No collision padding: the replaced confirmation was shifted right up to the viewport edge. Placed in
          the page's own coordinates as the replaced one was (see useFloating): inside a dialog it is neither
          held to the dialog's width nor, on its first frame, placed by the dialog's offset. */}
      <BasePopover.Positioner ref={positionerRef} anchor={anchor} side={side} align={align} {...offsets} collisionPadding={0} positionMethod={layer.positionMethod} className="orbit-floating-positioner" style={{ zIndex: layer.zIndex }}>
        <BasePopover.Popup ref={popup} initialFocus={popup} finalFocus={returnFocus}
          className={`orbit-popover orbit-popconfirm${popupClassName ? ` ${popupClassName}` : ''}`} style={popupStyle}>
          <BasePopover.Arrow className="orbit-floating-arrow" style={calloutArrowStyle} />
          <div className="orbit-popconfirm-message">
            <span className="orbit-popconfirm-icon" aria-hidden><ExclamationCircleFilled /></span>
            <div className="orbit-popconfirm-text">
              <BasePopover.Title className="orbit-popconfirm-title" render={<div />}>{title}</BasePopover.Title>
              {description != null && <BasePopover.Description className="orbit-popconfirm-description" render={<div />}>
                {description}
              </BasePopover.Description>}
            </div>
          </div>
          <div className="orbit-popconfirm-buttons">
            <Button size="small" disabled={pending} onClick={() => { onCancel?.(); layer.setOpen(false); }}>{cancelText}</Button>
            <Button size="small" variant="primary" danger={danger} loading={pending || confirmLoading} onClick={confirm}>{confirmText}</Button>
          </div>
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  </BasePopover.Root>;
}
