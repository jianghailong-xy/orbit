#!/usr/bin/env python3
"""Usage: root-cause-table.py <out.md> <label=run-label>... — per screenshot and tree: the notification's
host, the column's inline style and width (and its width without the inline style), the fixed-position
probes, each card's x and will-change, and in Chromium the compositor layer that paints the cards
(owner node, size, compositing reasons). Reads runs/<run-label>/states.json."""
import json, sys
out, pairs = sys.argv[1], [a.split('=', 1) for a in sys.argv[2:]]
states = {label: json.load(open(f'/var/tmp/p23b1/runs/{run}/states.json')) for label, run in pairs}
keys = sorted(set().union(*[s.keys() for s in states.values()]))
lines = ['| screenshot | tree | host | column width (inline / without inline) | fresh fixed probe / persistent probe | card x, will-change | Chromium layer painting the cards |',
         '| --- | --- | --- | --- | --- | --- | --- |']
def layer_of(st):
    L = st.get('layers')
    if not L or not L.get('latest'): return '—'
    picks = []
    for l in L['latest']['layers']:
        n = l['node'] or {}
        cls = n.get('className') or ''
        if l['drawsContent'] and (cls.startswith('toast') or 'toast-viewport' in cls):
            name = n.get('name', '').lower() + '.' + cls.split()[0]
            picks.append(f"{name} {l['width']}×{l['height']} {','.join(l['reasons'] or [])}")
    return '<br>'.join(picks) or 'none drawn by the notification'
for key in keys:
    for label, _ in pairs:
        st = states[label].get(key)
        if not st: continue
        d = st['dom']; s = d['section'] or {}; h = d['host'] or {}
        host = 'body' if h.get('tag') == 'BODY' else f"div.toast-layer (popover, top layer: {h.get('popoverOpen')})"
        inline = s.get('inlineStyle')
        width = s.get('rect', {}).get('width')
        un = ((s.get('uninlined') or {}).get('rect') or {}).get('width')
        width_cell = f"{width:g} ({'inline' if inline else 'CSS'})" + (f" / {un:g}" if un is not None else '')
        probes = f"{d['probes']['bodyInset0']['width']:g} / {', '.join(f'{p['width']:g}' for p in d['probes']['persistent']) or '—'}"
        cards = '<br>'.join(f"{c['className'].split()[1] if len(c['className'].split()) > 1 else c['className']}: x={c['rect']['x']:g}, {c['style']['willChange']}" for c in d['cards'])
        lines.append(f"| {key} | {label} | {host} | {width_cell} | {probes} | {cards} | {layer_of(st)} |")
open(out, 'w').write('\n'.join(lines) + '\n')
print(len(lines) - 2, 'rows')
