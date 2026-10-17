#!/usr/bin/env python3
"""Usage: patch-tsx-pin.py <tree> — candidate F: notifications no modal has taken keep their plain CSS
geometry; the first transfer into a modal pins the geometry the column had on screen in body; a column
first shown inside a modal, or after a resize, follows the body-level probe as before; the pin is
dropped when the column empties."""
import sys
p = f'{sys.argv[1]}/src/web/src/components/ToastViewport.tsx'
s = open(p).read()
def sub(old, new):
    global s
    assert s.count(old) == 1, old
    s = s.replace(old, new)

sub("""import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';""",
    """import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';""")
sub("""  useLayoutEffect(() => {
    // Reparenting restarts CSS animations even when React keeps the same DOM.
    // Carry the current entrance or exit time into its new parent.
    for (const toast of host.querySelectorAll<HTMLElement>('[data-toast-animation-start]')) {
      toast.style.animationDelay = `${Number(toast.dataset.toastAnimationStart) - Number(document.timeline.currentTime)}ms`;
    }
    (portal ?? document.body).appendChild(host);
    host.showPopover?.();
    return () => { host.remove(); };
  }, [host, portal]);""",
    """  // Where the column was in body when a modal took it, read before the host moves (see `pin`).
  const leftBody = useRef<DOMRect>(undefined);
  const [pin, setPin] = useState<{ rect?: DOMRect; narrow: boolean; viewportWidth?: number }>();
  useLayoutEffect(() => {
    // Reparenting restarts CSS animations even when React keeps the same DOM.
    // Carry the current entrance or exit time into its new parent.
    for (const toast of host.querySelectorAll<HTMLElement>('[data-toast-animation-start]')) {
      toast.style.animationDelay = `${Number(toast.dataset.toastAnimationStart) - Number(document.timeline.currentTime)}ms`;
    }
    const rect = leftBody.current;
    leftBody.current = undefined;
    if (portal && rect?.width) setPin((current) => current ?? { rect, narrow, viewportWidth });
    (portal ?? document.body).appendChild(host);
    host.showPopover?.();
    return () => {
      if (!portal) leftBody.current = host.firstElementChild?.getBoundingClientRect();
      host.remove();
    };
  }, [host, portal]);""")
sub("""  const remove = useCallback((id: string) => setShown((items) => items.filter((one) => identityOf(one.toast) !== id)), []);
  if (shown.length === 0) return null;
""", """  const remove = useCallback((id: string) => setShown((items) => items.filter((one) => identityOf(one.toast) !== id)), []);
  const showing = shown.length > 0;
  useLayoutEffect(() => {
    // A column first shown inside a modal had no body geometry: it follows the probe.
    if (showing && portal) setPin((current) => current ?? { narrow, viewportWidth });
    if (!showing) setPin(undefined);
  }, [showing]);
  if (!showing) return null;
  // Until a modal takes the column it keeps its plain CSS geometry. Afterwards WebKit can lay the
  // moved column out against another viewport width, also while the modal closes: keep the geometry
  // it had in body until it empties, or follow the body-level probe after a resize.
  const probed: CSSProperties | undefined = viewportWidth ? narrow
    ? { width: `calc(${viewportWidth}px - 32px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px))` }
    : { left: `calc(${viewportWidth}px - max(16px, env(safe-area-inset-right, 0px)) - 360px)`, right: 'auto' }
    : undefined;
  const style = pin && (pin.rect && pin.narrow === narrow && pin.viewportWidth === viewportWidth
    ? narrow ? { width: `${pin.rect.width}px` } : { left: `${pin.rect.left}px`, right: 'auto' }
    : probed);
""")
sub("""      style={viewportWidth ? narrow
        ? { width: `calc(${viewportWidth}px - 32px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px))` }
        : { left: `calc(${viewportWidth}px - max(16px, env(safe-area-inset-right, 0px)) - 360px)`, right: 'auto' }
        : undefined}>""", """      style={style}>""")
open(p, 'w').write(s)
print('patched', p)
