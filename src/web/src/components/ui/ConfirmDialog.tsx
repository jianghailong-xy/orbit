import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { ExclamationCircleFilled } from '@ant-design/icons';
import { Button } from './Button';
import { OverlaySurface } from './Overlay';

export interface ConfirmOptions {
  title: ReactNode;
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm: () => unknown | Promise<unknown>;
  returnFocus?: RefObject<HTMLElement | null>;
}

export interface ConfirmDialogProps extends ConfirmOptions {
  open: boolean;
  onClose: (confirmed: boolean) => void;
}

export function ConfirmDialog({ open, ...props }: ConfirmDialogProps) {
  // A new opening gets fresh pending/error state. A stale request cannot close it.
  return open ? <Confirmation {...props} /> : null;
}

function Confirmation({ title, description, confirmText = 'OK', cancelText = 'Cancel', danger = false,
  onConfirm, onClose, returnFocus }: Omit<ConfirmDialogProps, 'open'>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const mounted = useRef(true);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const submit = async () => {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      if (mounted.current) onClose(true);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'Could not complete this action. Please try again.');
    } finally {
      submitting.current = false;
      if (mounted.current) setPending(false);
    }
  };
  return <OverlaySurface kind="confirm" open title={<><ExclamationCircleFilled className="orbit-confirm-icon" aria-hidden />{title}</>}
    description={description} width={416} busy={pending} closable={false} closeOnOutsideClick={false}
    initialFocus={cancel} returnFocus={returnFocus} onClose={() => { if (!submitting.current) onClose(false); }}
    footer={<>
      <Button ref={cancel} disabled={pending} onClick={() => { if (!submitting.current) onClose(false); }}>{cancelText}</Button>
      <Button variant="primary" danger={danger} loading={pending} onClick={() => void submit()}>{confirmText}</Button>
    </>}>
    {error && <div className="orbit-confirm-error" role="alert">{error}</div>}
  </OverlaySurface>;
}

/** Render the holder at the call site, inside the owning dialog/context. One active request per hook. */
export function useConfirm() {
  const [request, setRequest] = useState<{ id: number; options: ConfirmOptions } | null>(null);
  const sequence = useRef(0);
  const active = useRef<{ promise: Promise<boolean>; resolve: (confirmed: boolean) => void } | null>(null);
  const confirm = useCallback((options: ConfirmOptions) => {
    if (active.current) return active.current.promise;
    let resolve!: (confirmed: boolean) => void;
    const promise = new Promise<boolean>((done) => { resolve = done; });
    active.current = { promise, resolve };
    // Menus can remove their focused item. Callers can name the persistent trigger.
    const returnFocus = options.returnFocus ?? { current: document.activeElement as HTMLElement | null };
    setRequest({ id: ++sequence.current, options: { ...options, returnFocus } });
    return promise;
  }, []);
  const finish = useCallback((confirmed: boolean) => {
    active.current?.resolve(confirmed);
    active.current = null;
    setRequest(null);
  }, []);
  useEffect(() => () => {
    active.current?.resolve(false);
    active.current = null;
  }, []);
  const holder = request && <ConfirmDialog key={request.id} {...request.options} open onClose={finish} />;
  return [confirm, holder] as const;
}
