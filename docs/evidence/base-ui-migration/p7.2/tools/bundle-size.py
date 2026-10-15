#!/usr/bin/env python3
"""Same-condition bundle measurement, mirroring P0.2's existing-checks/bundle-size.json method.

- Initial set: JS/CSS <script>, <link rel=stylesheet>, <link rel=modulepreload> URLs directly
  referenced by production dist/index.html.
- gzip: Python gzip.compress(data, compresslevel=9, mtime=0), per resource, summed. Byte counts.

Usage: bundle-size.py <dist-dir> <source-commit> <out.json>
"""
import gzip, hashlib, json, re, sys
from pathlib import Path

dist = Path(sys.argv[1]).resolve()
commit = sys.argv[2]
out = Path(sys.argv[3])

html = (dist / "index.html").read_text(encoding="utf-8")
urls = set()
for m in re.finditer(r'<script[^>]+src="([^"]+)"', html):
    urls.add(m.group(1))
for m in re.finditer(r'<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"', html):
    urls.add(m.group(1))
for m in re.finditer(r'<link[^>]+href="([^"]+)"[^>]*rel="stylesheet"', html):
    urls.add(m.group(1))
for m in re.finditer(r'<link[^>]+rel="modulepreload"[^>]*href="([^"]+)"', html):
    urls.add(m.group(1))
for m in re.finditer(r'<link[^>]+href="([^"]+)"[^>]*rel="modulepreload"', html):
    urls.add(m.group(1))

initial = set()
for u in urls:
    p = u.split("?")[0].lstrip("/")
    if p.startswith("assets/") or p.endswith((".js", ".css")):
        initial.add(p)

assets = []
for f in sorted((dist / "assets").rglob("*")):
    if not f.is_file() or f.suffix not in (".js", ".css"):
        continue
    data = f.read_bytes()
    rel = str(f.relative_to(dist))
    assets.append({
        "path": rel,
        "kind": f.suffix.lstrip("."),
        "bytes": len(data),
        "gzipBytes": len(gzip.compress(data, compresslevel=9, mtime=0)),
        "sha256": hashlib.sha256(data).hexdigest(),
        "initialHtmlReference": rel in initial,
    })

missing = initial - {a["path"] for a in assets}
if missing:
    sys.exit(f"initial references not found under dist/assets: {sorted(missing)}")

def total(sel, kind, key):
    return sum(a[key] for a in assets if sel(a) and a["kind"] == kind)

res = {
    "sourceCommit": commit,
    "command": "NO_COLOR=1 npm run build -w @orbit/web",
    "compression": "Python gzip.compress(data, compresslevel=9, mtime=0); byte counts, not rounded kB. Vite console gzip uses its own defaults.",
    "initialDefinition": "JS/CSS script, stylesheet, or modulepreload URLs directly referenced by production dist/index.html; excludes lazy route imports until loaded.",
    "assets": assets,
    "initialTotals": {
        "js": {"bytes": total(lambda a: a["initialHtmlReference"], "js", "bytes"), "gzipBytes": total(lambda a: a["initialHtmlReference"], "js", "gzipBytes")},
        "css": {"bytes": total(lambda a: a["initialHtmlReference"], "css", "bytes"), "gzipBytes": total(lambda a: a["initialHtmlReference"], "css", "gzipBytes")},
    },
    "allAssetTotals": {
        "js": {"bytes": total(lambda a: True, "js", "bytes"), "gzipBytes": total(lambda a: True, "js", "gzipBytes")},
        "css": {"bytes": total(lambda a: True, "css", "bytes"), "gzipBytes": total(lambda a: True, "css", "gzipBytes")},
    },
}
out.write_text(json.dumps(res, indent=1) + "\n")
print(json.dumps({"initial": res["initialTotals"], "all": res["allAssetTotals"]}, indent=1))
print(f"files: {len(assets)} (initial {sum(1 for a in assets if a['initialHtmlReference'])})")
