#!/usr/bin/env python3
"""Usage: patch-css-none.py <tree> — control E1: no compositing hint at all (the steady state of a hint
that only applies while the notification animates)."""
import sys
p = f'{sys.argv[1]}/src/web/src/index.css'
s = open(p).read()
old = '''  text-align: start;
  /* Keep the original card's rasterization when its host enters the top layer. */
  will-change: transform;
}'''
assert s.count(old) == 1
s = s.replace(old, '''  text-align: start;
}''')
open(p, 'w').write(s)
print('patched', p)
