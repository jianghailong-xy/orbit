import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { AlertDialog } from '@base-ui/react/alert-dialog';
import { CloseOutlined } from '@ant-design/icons';
import { registerFeedbackLayer } from './feedbackPortal';
import './Overlay.css';

interface Scope {
  container: RefObject<HTMLDivElement | null>;
  level: number;
  children: Map<symbol, () => void>;
}
const OverlayContext = createContext<Scope | null>(null);

function useScope() {
  const parent = useContext(OverlayContext);
  const container = useRef<HTMLDivElement>(null);
  const level = parent ? parent.level + 1 : 0;
  const scope = useMemo(() => ({ container, level, children: new Map<symbol, () => void>() }), [level]);
  const setContainer = useCallback((node: HTMLDivElement | null) => {
    container.current = node;
    if (!node) return;
    // Stop native focusout before it reaches the parent's focus manager. A
    // React onBlur runs too late when the child is a different portal root.
    const stop = (event: FocusEvent) => event.stopPropagation();
    node.addEventListener('focusout', stop);
    return () => { node.removeEventListener('focusout', stop); container.current = null; };
  }, []);
  return { parent, scope, setContainer };
}

/** Put this inside an old modal/drawer so Orbit portals stay in its focus boundary. */
export function OverlayScope({ children }: { children: ReactNode }) {
  const { scope } = useScope();
  return <OverlayContext.Provider value={scope}><div ref={scope.container}>{children}</div></OverlayContext.Provider>;
}

/** Temporary bridge for a controlled legacy popup inside an Orbit overlay.
 * Pass getContainer/zIndex to the legacy component's public portal props. */
export function useOverlayChild(open: boolean, onEscape: () => void) {
  const scope = useContext(OverlayContext);
  const escape = useRef(onEscape);
  useLayoutEffect(() => { escape.current = onEscape; });
  useLayoutEffect(() => {
    if (!open || !scope) return;
    const key = Symbol();
    scope.children.set(key, () => escape.current());
    return () => { scope.children.delete(key); };
  }, [open, scope]);
  const getContainer = useCallback(() => scope?.container.current ?? document.body, [scope]);
  return { getContainer, zIndex: 1000 + (scope ? scope.level + 1 : 0) * 100, inOverlay: scope !== null };
}

export interface OverlayProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  width?: CSSProperties['width'];
  className?: string;
  style?: CSSProperties;
  initialFocus?: RefObject<HTMLElement | null>;
  returnFocus?: RefObject<HTMLElement | null>;
  closeOnEscape?: boolean;
  closeOnOutsideClick?: boolean;
  closable?: boolean;
  busy?: boolean;
  keepMounted?: boolean;
}

/** Shared implementation; business code uses Dialog, Drawer or ConfirmDialog. */
export function OverlaySurface({
  open, onClose, title, description, children, footer, width = 520, className, style,
  initialFocus, returnFocus, closeOnEscape = true, closeOnOutsideClick = true,
  closable = true, busy = false, keepMounted = false, kind = 'dialog',
  placement = 'right', height = 378, headerActions,
}: OverlayProps & {
  kind?: 'dialog' | 'drawer' | 'confirm';
  placement?: 'right' | 'bottom';
  height?: CSSProperties['height'];
  headerActions?: ReactNode;
}) {
  const { parent, scope, setContainer } = useScope();
  const popup = useRef<HTMLDivElement>(null);
  const setPopup = useCallback((node: HTMLDivElement | null) => {
    popup.current = node;
    if (!node || !open) return;
    return registerFeedbackLayer(node, scope.level);
  }, [open, scope.level]);
  const Root = kind === 'confirm' ? AlertDialog.Root : BaseDialog.Root;
  const zIndex = 1000 + scope.level * 100;
  return (
    <Root open={open} disablePointerDismissal={!closeOnOutsideClick || busy}
      onOpenChange={(next, details) => {
        if (next) return;
        const child = [...scope.children.values()].at(-1);
        if (child) {
          details.cancel();
          if (details.reason === 'escape-key') child();
          return;
        }
        if (busy || (!closeOnEscape && details.reason === 'escape-key')) {
          details.cancel();
          return;
        }
        onClose();
      }}>
      <BaseDialog.Portal container={parent?.container} keepMounted={keepMounted}>
        <BaseDialog.Backdrop forceRender className="orbit-overlay-backdrop" style={{ zIndex }} />
        <BaseDialog.Viewport className={`orbit-overlay-viewport orbit-${kind}-viewport`} style={{ zIndex }}>
          <BaseDialog.Popup ref={setPopup} initialFocus={() => {
            // Base UI moves focus in on the next animation frame. Until then keys reach the page behind
            // the dialog (Enter re-presses its opener, Tab moves along the page), where the replaced modal
            // already had focus inside; so focus now, as Base UI would, and leave it nothing to do.
            const target = initialFocus ? initialFocus.current : popup.current;
            // An empty initialFocus ref falls back to Base UI's default, as it did.
            if (!target) return true;
            if (!popup.current?.contains(document.activeElement)) target.focus({ preventScroll: target === popup.current });
            return false;
          }} finalFocus={returnFocus}
            className={`orbit-overlay orbit-${kind}${className ? ` ${className}` : ''}`}
            data-placement={kind === 'drawer' ? placement : undefined} aria-busy={busy || undefined}
            style={{ width: kind === 'drawer' && placement === 'bottom' ? '100%' : width,
              height: kind === 'drawer' ? (placement === 'right' ? '100%' : height) : undefined, ...style }}>
            <OverlayContext.Provider value={scope}>
              <div className="orbit-overlay-header">
                {closable && <BaseDialog.Close className="orbit-overlay-close" disabled={busy} aria-label="Close">
                  <CloseOutlined aria-hidden />
                </BaseDialog.Close>}
                <BaseDialog.Title className="orbit-overlay-title">{title}</BaseDialog.Title>
                {headerActions}
              </div>
              <div className="orbit-overlay-body">
                {description != null && <BaseDialog.Description className="orbit-overlay-description" render={<div />}>
                  {description}
                </BaseDialog.Description>}
                {children}
              </div>
              {footer != null && <div className="orbit-overlay-footer">{footer}</div>}
              {/* A removed child owns focus restoration. Its blur must not ask the
                  parent focus manager to restore the parent popup on the next frame. */}
              <div ref={setContainer} />
            </OverlayContext.Provider>
          </BaseDialog.Popup>
        </BaseDialog.Viewport>
      </BaseDialog.Portal>
    </Root>
  );
}
