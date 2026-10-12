#!/usr/bin/env python3
"""Usage: patch-css-final.py <tree> — the delivered CSS change: the compositing hint moves from each
card (.toast) to the notification column (.toast-viewport)."""
import sys
p = f'{sys.argv[1]}/src/web/src/index.css'
s = open(p).read()
old_toast = '''  text-align: start;
  /* Keep the original card's rasterization when its host enters the top layer. */
  will-change: transform;
}'''
assert s.count(old_toast) == 1
s = s.replace(old_toast, '''  text-align: start;
}''')
old_vp = '''  max-width: calc(100vw - 32px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px));
  pointer-events: none;
}'''
assert s.count(old_vp) == 1
s = s.replace(old_vp, '''  max-width: calc(100vw - 32px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px));
  pointer-events: none;
  /* One composited layer at the column's whole-pixel origin, as the body-mounted column had. A layer
     per card starts at a pill's fractional x and rasterizes its text differently. */
  will-change: transform;
}''')
open(p, 'w').write(s)
print('patched', p)
