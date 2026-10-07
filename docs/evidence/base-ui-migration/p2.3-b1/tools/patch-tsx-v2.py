#!/usr/bin/env python3
"""Usage: patch-tsx-v2.py <tree> — ToastViewport v2 (on the project tip's file): the phone column keeps its
plain CSS width until a modal takes it; then it holds the width a ResizeObserver last saw in body (or the
probe's) until it empties. No layout read and no extra commit at the transfer; desktop keeps the probe's
left edge as before."""
import sys
p = f'{sys.argv[1]}/src/web/src/components/ToastViewport.tsx'
s = open(p).read()
def sub(old, new):
    global s
    assert s.count(old) == 1, old
    s = s.replace(old, new)
sub("""  const remove = useCallback((id: string) => setShown((items) => items.filter((one) => identityOf(one.toast) !== id)), []);
  if (shown.length === 0) return null;
""", """  const remove = useCallback((id: string) => setShown((items) => items.filter((one) => identityOf(one.toast) !== id)), []);
  // A phone column keeps its plain CSS width, as WebKit lays it out in body, until a modal takes it.
  // The moved column can be laid out against another viewport width, also while the modal closes, so
  // from then on it holds the width it last had in body (or the probe's) until it empties.
  const [bodyWidth, setBodyWidth] = useState<{ width: number; viewportWidth?: number }>();
  const [held, setHeld] = useState(false);
  const showing = shown.length > 0;
  if (showing && portal && !held) setHeld(true);
  if (!showing && (held || bodyWidth)) {
    setHeld(false);
    setBodyWidth(undefined);
  }
  const current = useRef({ portal, held, viewportWidth });
  useLayoutEffect(() => { current.current = { portal, held, viewportWidth }; });
  const observeColumn = useCallback((section: HTMLElement | null) => {
    if (!section) return;
    const observer = new ResizeObserver(([entry]) => {
      const { portal, held, viewportWidth } = current.current;
      if (!portal && !held) setBodyWidth({ width: entry.borderBoxSize[0].inlineSize, viewportWidth });
    });
    observer.observe(section);
    return () => observer.disconnect();
  }, []);
  if (!showing) return null;
""")
sub("""    <section className={narrow ? 'toast-viewport toast-viewport--narrow' : 'toast-viewport'} aria-label="Notifications\"""",
    """    <section ref={observeColumn} className={narrow ? 'toast-viewport toast-viewport--narrow' : 'toast-viewport'} aria-label="Notifications\"""")
sub("""      style={viewportWidth ? narrow
        ? { width: `calc(${viewportWidth}px - 32px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px))` }
        : { left: `calc(${viewportWidth}px - max(16px, env(safe-area-inset-right, 0px)) - 360px)`, right: 'auto' }
        : undefined}>""", """      style={viewportWidth ? narrow
        ? held ? { width: bodyWidth?.viewportWidth === viewportWidth ? `${bodyWidth.width}px` : `calc(${viewportWidth}px - 32px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px))` } : undefined
        : { left: `calc(${viewportWidth}px - max(16px, env(safe-area-inset-right, 0px)) - 360px)`, right: 'auto' }
        : undefined}>""")
open(p, 'w').write(s)
print('patched', p)
