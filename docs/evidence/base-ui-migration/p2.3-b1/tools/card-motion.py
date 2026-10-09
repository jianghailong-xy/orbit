#!/usr/bin/env python3
"""Usage: card-motion.py <collected-dir>... — for each 'notification card stays fixed' run: frames sampled,
and every frame whose card DOM, opacity or rect differs from the settled rect (the test's own rule), with
phase, time and the x/width offsets, so a replayed entrance (x +16 px easing back to 0) can be told from a
geometry change (a constant offset or a width change)."""
import json, pathlib, sys
for d in map(pathlib.Path, sys.argv[1:]):
    status = {t['name']: t['status'] for t in json.loads((d / 'summary.json').read_text())['tests']}
    print(f'== {d}')
    for p in sorted(d.glob('*--continuous-card-motion.json')):
        name = p.name.split('--continuous-card-motion.json')[0]
        m = json.loads(p.read_text()); b = m['before']
        bad = [s for s in m['samples'] if not s['sameNode'] or not s['card'] or s['opacity'] != '1'
               or any(abs(s['card'][k] - b[k]) > .1 for k in ['x', 'y', 'width', 'height'])]
        line = f"  {name:95.95} {status.get(name):10} frames {len(m['samples']):4} shifted {len(bad)}"
        if bad:
            line += ' | ' + ', '.join(f"{s['phase']}@{round(s['t'] - m['samples'][0]['t'])}ms dx={round(s['card']['x'] - b['x'], 2) if s['card'] else None} dw={round(s['card']['width'] - b['width'], 2) if s['card'] else None}" for s in bad[:8])
        print(line)
