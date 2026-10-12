#!/usr/bin/env python3
"""Usage: patch-tsx-e2.py <tree> — control E2: the inline geometry only while a modal owns the column
(the pre-57f792135 condition), with the persistent probe kept."""
import sys
p = f'{sys.argv[1]}/src/web/src/components/ToastViewport.tsx'
s = open(p).read()
old = "      style={viewportWidth ? narrow"
assert s.count(old) == 1
s = s.replace(old, "      style={portal && viewportWidth ? narrow")
open(p, 'w').write(s)
print('patched', p)
