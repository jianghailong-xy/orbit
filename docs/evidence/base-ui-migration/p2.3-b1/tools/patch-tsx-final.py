#!/usr/bin/env python3
"""Usage: patch-tsx-final.py <tree> — the delivered ToastViewport change (same behavior as candidate F,
one pin effect after the probe): notifications no modal has taken keep their plain CSS geometry; the
first transfer into a modal pins the geometry the column had on screen in body; a column first shown
inside a modal, or after a resize, follows the body-level probe; the pin is dropped when it empties."""
import sys
p = f'{sys.argv[1]}/src/web/src/components/ToastViewport.tsx'
s = open(p).read()
def sub(old, new):
    global s
    assert s.count(old) == 1, old
    s = s.replace(old, new)

sub("""import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';""",
    """import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';""")
sub("""    return element;
  });
  useLayoutEffect(() => {
    // Reparenting restarts CSS animations even when React keeps the same DOM.""",
    """    return element;
  });
  // Where the column sits in body when a modal takes it, read before the host moves (see `pin`).
  const leftBody = useRef<DOMRect>(undefined);
  useLayoutEffect(() => {
    // Reparenting restarts CSS animations even when React keeps the same DOM.""")
sub("""    (portal ?? document.body).appendChild(host);
    host.showPopover?.();
    return () => { host.remove(); };
  }, [host, portal]);""",
    """    (portal ?? document.body).appendChild(host);
    host.showPopover?.();
    return () => {
      if (!portal) leftBody.current = host.firstElementChild?.getBoundingClientRect();
      host.remove();
    };
  }, [host, portal]);""")
sub("""  const remove = useCallback((id: string) => setShown((items) => items.filter((one) => identityOf(one.toast) !== id)), []);
  if (shown.length === 0) return null;
""", """  const remove = useCallback((id: string) => setShown((items) => items.filter((one) => identityOf(one.toast) !== id)), []);
  // Until a modal takes the column it keeps its plain CSS geometry. Moved into a modal, WebKit can lay
  // it out against another viewport width, also while the modal closes, so it keeps the geometry it had
  // in body until it empties. Shown first inside a modal, or after a resize, it follows the probe.
  const [pin, setPin] = useState<{ rect?: DOMRect; narrow: boolean; viewportWidth?: number }>();
  const showing = shown.length > 0;
  useLayoutEffect(() => {
    const rect = leftBody.current;
    leftBody.current = undefined;
    if (!showing) setPin(undefined);
    else if (portal) setPin((current) => current ?? { rect: rect?.width ? rect : undefined, narrow, viewportWidth });
  }, [portal, showing]);
  if (!showing) return null;
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
