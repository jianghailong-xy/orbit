#!/usr/bin/env python3
"""bundle-compare.py OUT.json NAME=TREE ...: the first page's resources of each production build (try/bundle/NAME,
bundle-build.sh), measured as p0.2/existing-checks/bundle-size.json and p3.1/bundle-size.py do: every JS/CSS file
dist/index.html references (script src, modulepreload, stylesheet), raw bytes and gzip level 9 per file
(gzip.compress(data, compresslevel=9, mtime=0)). Also: the first page's CSS file count; the lazy chunks the app
loads later (with their CSS); and, between consecutive builds, where the first page's bytes moved: JS by module
(rolldown's rendered length, before minification) and CSS by source stylesheet (the source file's bytes in that
tree). TREE is the checkout the build came from, for reading the stylesheet sources."""
import gzip, json, re, sys
from pathlib import Path
V = Path('/mnt/data/tmp/34blYpxEcHMAf4oafuC2W')
out = Path(sys.argv[1])
builds = [a.split('=', 1) for a in sys.argv[2:]]
def gz(data): return len(gzip.compress(data, compresslevel=9, mtime=0))
def source(tree, css_module):
    if css_module.startswith('node_modules/'):
        p = Path('/root/.orbit/worktrees/ba9b2bbb-b78b-5991-855c-183de0d5d9e3') / css_module
    else:
        p = Path(tree) / 'src/web' / css_module
    return p.stat().st_size if p.exists() else None
result = {'method': __doc__.strip(), 'builds': {}}
for name, tree in builds:
    d = V / 'try/bundle' / name
    dist = d / 'dist'
    html = (dist / 'index.html').read_text()
    initial = re.findall(r'<(?:script|link)[^>]*(?:src|href)="/(assets/[^"]+\.(?:js|css))"', html)
    stylesheets = re.findall(r'<link rel="stylesheet"[^>]*href="/(assets/[^"]+\.css)"', html)
    chunks = json.loads((d / 'chunks.json').read_text())
    by_file = {c['file']: c for c in chunks}
    resources = []
    for f in initial:
        data = (dist / f).read_bytes()
        resources.append({'path': f, 'kind': 'css' if f.endswith('.css') else 'js', 'bytes': len(data), 'gzipBytes': gz(data)})
    lazy = []
    for c in chunks:
        if c['isDynamicEntry'] and c['file'] not in initial:
            for f in [c['file'], *c['css']]:
                if (dist / f).exists():
                    data = (dist / f).read_bytes()
                    lazy.append({'path': f, 'kind': 'css' if f.endswith('.css') else 'js', 'bytes': len(data), 'gzipBytes': gz(data)})
    totals = {k: {'bytes': sum(r['bytes'] for r in resources if r['kind'] == k), 'gzipBytes': sum(r['gzipBytes'] for r in resources if r['kind'] == k)} for k in ('js', 'css')}
    # The first page's modules: those of the chunks index.html loads (initial JS), and its CSS modules in link order.
    js_modules = {}
    for f in initial:
        if f in by_file:
            for mid, length in by_file[f]['modules']:
                js_modules[mid] = js_modules.get(mid, 0) + length
    css_modules = []
    for sheet in stylesheets:
        owners = [c for c in chunks if sheet in c['css'] and c['cssModules']]
        for c in owners[:1]:
            css_modules += c['cssModules']
    result['builds'][name] = {
        'tree': tree, 'commit': None, 'resources': resources, 'firstPageCssFiles': len(stylesheets), 'stylesheets': stylesheets,
        'totals': totals, 'lazy': lazy, 'cssModulesInLinkOrder': css_modules,
        '_js': js_modules, '_css': {m: source(tree, m) for m in css_modules},
    }
names = [n for n, _ in builds]
moves = []
for a, b in zip(names, names[1:]):
    A, B = result['builds'][a], result['builds'][b]
    js = []
    for m in sorted(set(A['_js']) | set(B['_js'])):
        x, y = A['_js'].get(m, 0), B['_js'].get(m, 0)
        if x != y: js.append({'module': m, 'from': x, 'to': y, 'delta': y - x})
    js.sort(key=lambda r: -abs(r['delta']))
    css = []
    for m in sorted(set(A['_css']) | set(B['_css'])):
        x, y = A['_css'].get(m), B['_css'].get(m)
        if x != y: css.append({'stylesheet': m, 'from': x, 'to': y, 'delta': (y or 0) - (x or 0)})
    css.sort(key=lambda r: -abs(r['delta']))
    moves.append({'from': a, 'to': b,
                  'gzip': {k: B['totals'][k]['gzipBytes'] - A['totals'][k]['gzipBytes'] for k in ('js', 'css')},
                  'bytes': {k: B['totals'][k]['bytes'] - A['totals'][k]['bytes'] for k in ('js', 'css')},
                  'jsModules': js, 'cssSources': css})
for b in result['builds'].values():
    b.pop('_js'); b.pop('_css')
result['moves'] = moves
out.write_text(json.dumps(result, indent=1))
for name in names:
    b = result['builds'][name]
    print(f"{name}: first-page CSS files {b['firstPageCssFiles']}; JS {b['totals']['js']['bytes']} B / gzip {b['totals']['js']['gzipBytes']}; CSS {b['totals']['css']['bytes']} B / gzip {b['totals']['css']['gzipBytes']}")
    for r in b['resources']: print(f"    {r['kind']} {r['path']} {r['bytes']} gzip {r['gzipBytes']}")
for m in moves:
    print(f"{m['from']} -> {m['to']}: gzip js {m['gzip']['js']:+d} css {m['gzip']['css']:+d}; bytes js {m['bytes']['js']:+d} css {m['bytes']['css']:+d}")
    print('   js modules:', ', '.join(f"{r['module']} {r['delta']:+d}" for r in m['jsModules'][:14]))
    print('   css sources:', ', '.join(f"{r['stylesheet']} {r['delta']:+d}" for r in m['cssSources'][:14]))
