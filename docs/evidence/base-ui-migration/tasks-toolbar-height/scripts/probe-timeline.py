#!/usr/bin/env python3
"""probe-timeline.py RUN.txt PROJECT INDEX...: compact timeline of one probe record from the bulk bar's insertion:
frames, resize observations, and mutation records counted per (time, region)."""
import json, re, sys, itertools
path, project = sys.argv[1], sys.argv[2]
for idx in map(int, sys.argv[3:]):
    for line in open(path, encoding='utf-8', errors='replace'):
        m = re.search(r'TOOLBAR-PROBE (\S+) (\d+) (\{.*\})\s*$', line)
        if not (m and m.group(1) == project and int(m.group(2)) == idx):
            continue
        r = json.loads(m.group(3))
        ev = r['events']
        ins = next(e['t'] for e in ev if e['kind'] == 'mutation' and e.get('added') and any('tasks-bulkbar' in a for a in e['added']))
        print(f"== {project} {idx}: settled toolbar {r['toolbar']['h']} bar {r['bar']['offsetHeight']}; bar inserted at {ins}")
        frames = 0
        out = []
        for (t, kind), group in itertools.groupby([e for e in ev if e['t'] >= ins - 40], key=lambda e: (e['t'], e['kind'])):
            group = list(group)
            if kind == 'frame':
                out.append(f"{t:8} frame {group[0]['n']}")
                if t > ins: frames += 1
            elif kind == 'resize':
                out.append(f"{t:8} RO " + ', '.join(f"{g['target'].split('.')[1] if '.' in g['target'] else g['target']} {g['h']}" for g in group))
            else:
                counts = {}
                for g in group:
                    key = f"{g['region']}:{g['type']}"
                    counts[key] = counts.get(key, 0) + 1
                out.append(f"{t:8} MO {counts}")
            if frames > 3:
                break
        print('\n'.join(out))
