#!/usr/bin/env python3
"""Usage: filter-merge-check.py <full output of the merge check> > filtered.txt

Keeps the merge check output a reviewer reads: everything up to Vitest's RUN line (the whole web build), every
Vitest result line of a test file (passed, failed or skipped), any FAIL block header, and Vitest's summary
(Test Files, Tests, Errors, Start at, Duration) plus the closing exit line. Drops the stderr blocks of console
warnings that tests print while they run. Colour codes are removed."""
import re, sys

lines = [re.sub(r'\x1b\[[0-9;]*m', '', l) for l in open(sys.argv[1], encoding='utf-8', errors='replace').read().splitlines()]
run = next(i for i, l in enumerate(lines) if l.lstrip().startswith('RUN '))
keep = lines[:run + 1]
summary = re.compile(r'^\s*(Test Files|Tests|Errors|Start at|Duration|Type Errors)\b')
for l in lines[run + 1:]:
    if re.match(r'^ (✓|❯|×|↓) ', l) or 'FAIL' in l or summary.match(l) or l.startswith('merge check exit'):
        keep.append(l)
print('\n'.join(keep))
