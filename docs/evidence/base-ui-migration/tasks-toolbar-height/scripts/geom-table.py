#!/usr/bin/env python3
"""geom-table.py [--json OUT] RUN.txt...: P4.3a's KEYS-GEOM lines as one row per run (tree label, project, run: column
heads top+height, .tasks-toolbar top+height, the bulk bar's offset/client height and whether it overflows, .tasks-body
top), then per label and project how many runs had the toolbar shorter than the bar (the 34px state)."""
import json, re, sys, collections, os
args = sys.argv[1:]
out = None
if args and args[0] == '--json':
    out, args = args[1], args[2:]
rows = []
for path in args:
    # runs/geom-LABEL/run.txt (geom.sh) or runs/geom-LABEL.txt (final.sh)
    name = os.path.basename(os.path.dirname(path)) if os.path.basename(path) == 'run.txt' else os.path.basename(path).removesuffix('.txt')
    label = name.removeprefix('geom-')
    for line in open(path, encoding='utf-8', errors='replace'):
        m = re.search(r'KEYS-GEOM (\S+) (\d+) (\{.*\})\s*$', line)
        if not m:
            continue
        g = json.loads(m.group(3))
        toolbar = next((a.split('@')[1] for a in g['above'] if a.startswith('div.tasks-toolbar@')), None)
        top, height = (float(x) for x in toolbar.split('+'))
        bar = g['bar']
        rows.append({'label': label, 'project': m.group(1), 'run': int(m.group(2)), 'headsTop': g['heads'][0],
                     'toolbarTop': top, 'toolbarHeight': height, 'barOffsetHeight': bar['offsetHeight'],
                     'barClientHeight': bar['clientHeight'], 'barOverflows': bar['scrollWidth'] > bar['clientWidth'],
                     'bodyTop': g['body']['box'][0], 'stuck': height < bar['offsetHeight']})
print(f"{'label':10} {'project':22} run  heads   toolbar      bar(off/client) ovf    body    state")
for r in rows:
    print(f"{r['label']:10} {r['project']:22} {r['run']}    {r['headsTop']:6} {r['toolbarTop']}+{r['toolbarHeight']:<5} {r['barOffsetHeight']}/{r['barClientHeight']:<10} {r['barOverflows']!s:6} {r['bodyTop']:6}  {'34px state' if r['stuck'] else 'ok'}")
summary = collections.defaultdict(lambda: [0, 0])
for r in rows:
    tree = r['label'].split('-')[0]
    summary[(tree, r['project'])][0] += r['stuck']
    summary[(tree, r['project'])][1] += 1
    summary[(tree, 'all')][0] += r['stuck']
    summary[(tree, 'all')][1] += 1
print()
for (tree, project), (stuck, total) in sorted(summary.items()):
    print(f"{tree:6} {project:22} 34px state {stuck}/{total}")
if out:
    json.dump({'rows': rows, 'summary': {f'{t} {p}': {'stuck': s, 'runs': n} for (t, p), (s, n) in sorted(summary.items())}}, open(out, 'w'), indent=1)
