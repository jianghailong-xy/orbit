#!/usr/bin/env python3
"""flows-table.py RUN.txt...: the transitions probe's FLOW-PROBE lines -- per step the toolbar and bar heights two
frames after it and 600 ms later, and whether the toolbar disagreed with the bar -- then per label, flow and step the
count of runs where it disagreed."""
import json, re, sys, os, collections
counts = collections.defaultdict(lambda: [0, 0, 0])
for path in sys.argv[1:]:
    label = os.path.basename(os.path.dirname(path)).removeprefix('flows-')
    for line in open(path, encoding='utf-8', errors='replace'):
        m = re.search(r'FLOW-PROBE (\S+) (\S+) (\d+) (\[.*\])\s*$', line)
        if not m:
            continue
        project, flow, run = m.group(1), m.group(2), int(m.group(3))
        for s in json.loads(m.group(4)):
            now, later = s['now'], s['later']
            off_now = abs(now['toolbar'] - now['bar']) > 0.5
            off_later = abs(later['toolbar'] - later['bar']) > 0.5
            key = (label.split('-')[0], project, flow, s['step'])
            counts[key][0] += off_now
            counts[key][1] += off_later
            counts[key][2] += 1
            print(f"{label:8} {project:22} {flow:7} {run} {s['step']:24} now tb {now['toolbar']:5} bar {now['bar']} ovf {now['overflows']!s:5} | later tb {later['toolbar']:5} bar {later['bar']}  {'TOOLBAR != BAR' if off_now else ''}{' (still later)' if off_later else ''}")
print()
for (tree, project, flow, step), (now, later, n) in sorted(counts.items()):
    print(f"{tree:5} {project:22} {flow:7} {step:24} toolbar != bar: {now}/{n} after two frames, {later}/{n} 600 ms later")
