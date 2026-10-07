"""Initial JS/CSS of built web trees, measured like p0.2/existing-checks/bundle-size.json.

Assets referenced by dist/index.html (scripts, modulepreload, stylesheets), raw bytes and per-file
gzip level 9. Usage: bundle-size.py name=<path to src/web/dist> ...  Prints JSON."""
import gzip
import json
import re
import sys
from pathlib import Path

result = {}
for argument in sys.argv[1:]:
    name, dist = argument.split('=', 1)
    dist = Path(dist)
    html = (dist / 'index.html').read_text()
    files = sorted(set(re.findall(r'(?:src|href)="/(assets/[^"]+\.(?:js|css))"', html)))
    totals = {'js': [0, 0], 'css': [0, 0]}
    for file in files:
        data = (dist / file).read_bytes()
        kind = 'css' if file.endswith('.css') else 'js'
        totals[kind][0] += len(data)
        totals[kind][1] += len(gzip.compress(data, compresslevel=9, mtime=0))
    result[name] = {'files': files, 'js': {'raw': totals['js'][0], 'gzip': totals['js'][1]}, 'css': {'raw': totals['css'][0], 'gzip': totals['css'][1]}}
print(json.dumps(result, indent=2))
