#!/usr/bin/env python3
"""css-order.py DIST [CHUNK_MAP]: the stylesheets index.html links, in order, with the Orbit component
classes each one carries (class stem -> rule count), and with CHUNK_MAP (chunk-map.config.mjs) the
src/components/ui modules of each chunk whose CSS is linked before the entry's own."""
import json, os, re, sys
dist = sys.argv[1]
html = open(os.path.join(dist, 'index.html'), encoding='utf-8').read()
links = re.findall(r'<link rel="stylesheet"[^>]*href="/([^"]+)"', html)
for i, href in enumerate(links):
    css = open(os.path.join(dist, href), encoding='utf-8').read()
    stems = {}
    for m in re.findall(r'\.orbit-([a-z]+)', css):
        stems[m] = stems.get(m, 0) + 1
    top = ', '.join(f'{k} {v}' for k, v in sorted(stems.items(), key=lambda kv: -kv[1])[:40])
    print(f'{i}: {href} {len(css)} bytes: {top}')
if len(sys.argv) > 2:
    chunks = json.load(open(sys.argv[2]))
    for c in chunks:
        ui = [m for m in c['modules'] if m.startswith('components/ui/')]
        if c['isEntry'] or not c['isDynamicEntry']:
            print(('ENTRY ' if c['isEntry'] else 'SHARED ') + c['file'], 'css', c['css'], 'ui', ui, 'n_modules', len(c['modules']), 'first', c['modules'][:3])
