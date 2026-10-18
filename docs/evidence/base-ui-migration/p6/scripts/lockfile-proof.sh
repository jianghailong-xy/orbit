#!/usr/bin/env bash
# lockfile-proof.sh BASE DELIVERY OUTDIR: the delivered lockfile is BASE's without the entries only antd reached, and
# nothing else. From each commit's manifests and lockfile alone (git archive; no node_modules, lockfile-only npm runs):
#  1. relocked:    `npm install --package-lock-only` on BASE, nothing changed: what npm rewrites on its own;
#  2. uninstalled: `npm uninstall antd -w @orbit/web --package-lock-only` on BASE;
#  3. minimal-lockfile.py: BASE without the entries 2 drops and 1 keeps (the ones antd took);
#  4. the delivered lockfile against 3, byte for byte;
#  5. `npm install --package-lock-only` on the delivery: what npm rewrites the delivered lockfile to, against 2.
set -u
BASE=${1:?base}; DELIVERY=${2:?delivery}; OUT=${3:?outdir}
HERE=$(cd "$(dirname "$0")" && pwd)
rm -rf "$OUT" && mkdir -p "$OUT"
extract() {
  local commit=$1 dir=$2
  mkdir -p "$dir"
  git archive "$commit" -- package.json package-lock.json src/shared/package.json src/apiserver/package.json src/web/package.json | tar -x -C "$dir"
}
echo "== npm $(npm --version), node $(node --version)"
for step in relocked uninstalled; do extract "$BASE" "$OUT/$step"; done
(cd "$OUT/relocked" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund > npm.log 2>&1); echo "relocked: npm exit=$?"
(cd "$OUT/uninstalled" && npm uninstall antd -w @orbit/web --package-lock-only --ignore-scripts --no-audit --no-fund > npm.log 2>&1); echo "uninstalled: npm exit=$?"
extract "$BASE" "$OUT/base"
python3 -I "$HERE/minimal-lockfile.py" "$OUT/base/package-lock.json" "$OUT/uninstalled/package-lock.json" "$OUT/relocked/package-lock.json" "$OUT/minimal.json" > "$OUT/minimal-summary.json"
echo "minimal-lockfile.py exit=$?"
extract "$DELIVERY" "$OUT/delivery"
cmp "$OUT/minimal.json" "$OUT/delivery/package-lock.json" && echo "delivered lockfile = minimal-lockfile.py's output, byte for byte"
extract "$DELIVERY" "$OUT/delivery-relocked"
(cd "$OUT/delivery-relocked" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund > npm.log 2>&1); echo "delivery relocked: npm exit=$?"
cmp "$OUT/delivery-relocked/package-lock.json" "$OUT/uninstalled/package-lock.json" && echo "npm rewrites the delivered lockfile to what npm uninstall writes, byte for byte"
python3 -I - "$OUT" <<'PY'
import json, sys
o = sys.argv[1]
load = lambda p: json.load(open(f'{o}/{p}'))['packages']
base, relocked, uninstalled, delivery = load('base/package-lock.json'), load('relocked/package-lock.json'), load('uninstalled/package-lock.json'), load('delivery/package-lock.json')
summary = json.load(open(f'{o}/minimal-summary.json'))
gone = sorted(set(base) - set(delivery))
print(json.dumps({
  'entries': {'base': len(base), 'delivery': len(delivery), 'removed': len(gone), 'added': len(set(delivery) - set(base)),
              'changed': sorted(k for k in delivery if k in base and delivery[k] != base[k])},
  'npmAloneDrops': len(set(base) - set(relocked)), 'npmAloneDropsAllEsbuildOptionalPeers': all('esbuild' in k for k in set(base) - set(relocked)),
  'uninstallDrops': len(set(base) - set(uninstalled)),
  'removedEntries': summary['entries'],
  'antdOrInternalsLeft': sorted(k for k in delivery if k.endswith('/antd') or '@ant-design/cssinjs' in k or 'react-slick' in k),
  'antDesignAndRcLeft': sorted(k for k in delivery if '@ant-design/' in k or '@rc-component/' in k),
}, indent=1))
PY
