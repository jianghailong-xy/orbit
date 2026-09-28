#!/usr/bin/env python3
"""TEMPORARY evidence probe (see ../README.md). Cut the real options menu out of AgentsView.swift —
from sessionOptionsMenu's doc comment to the `#endif` closing its iOS block, so the helpers after it
come along — and drop it verbatim into the stand-in."""
import sys

src = open(sys.argv[1]).read()
template = open(sys.argv[2]).read()
start = src.index('    private func sessionOptionsMenu(')
head = src.rfind('\n', 0, start) + 1
while True:
    prev_end = head - 1
    prev_start = src.rfind('\n', 0, prev_end) + 1
    if src[prev_start:prev_end].strip().startswith('///'):
        head = prev_start
    else:
        break
end = src.index('\n    #endif', start)
print(template.replace('// @@REAL_MENU@@', src[head:end]))
