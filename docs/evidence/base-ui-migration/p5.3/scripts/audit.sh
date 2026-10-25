#!/usr/bin/env bash
# audit.sh: the inventory checks of the delivery, into v1/checks, v1/inventory-closure.json and v1/route-closure.json
# (P5.1's audit.sh, for P5.3; P5.3 writes no inventory record, so there is no record check):
#  - audit-antd.mjs --json on the delivery tree (v1/del) and on the same-commit reference tree (v1/ref);
#  - --check-owners on the delivery (nothing unowned and nothing pending is the expected answer);
#  - inventory-closure.mjs: reference vs delivery, P5.3's points before and after;
#  - p4.4/route-closure.mjs: what each non-session route and the signed-in shell still reach of antd on the delivery;
#  - session-route-closure.mjs: what the session workspace's routes reach of antd, on the delivery and the reference.
# Only reads the trees; writes only under v1.
set -u
V=/mnt/data/tmp/34Za39Ov1yysHZaYL6wgJ/v1
E=docs/evidence/base-ui-migration
# This directory's own scripts are read from where this script is (they are committed with the evidence, after the run).
P53=$(cd "$(dirname "$0")/.." && pwd)
C=$V/checks
mkdir -p "$C"
echo "delivery $(git -C "$V/del" rev-parse HEAD), reference $(git -C "$V/ref" rev-parse HEAD)"
(cd "$V/del" && node src/web/scripts/audit-antd.mjs --json > "$C/delivery-audit.json"); a=$?
(cd "$V/ref" && node src/web/scripts/audit-antd.mjs --json > "$C/reference-audit.json"); b=$?
(cd "$V/del" && node src/web/scripts/audit-antd.mjs --check-owners > "$C/delivery-check-owners.json" 2> "$C/delivery-check-owners.stderr.txt"); c=$?
(cd "$V/del" && node "$P53/inventory-closure.mjs" "$C/reference-audit.json" "$C/delivery-audit.json" > "$V/inventory-closure.json"); d=$?
(cd "$V/del" && node "$E/p4.4/route-closure.mjs" "$C/delivery-audit.json" > "$V/route-closure.json"); e=$?
# The session workspace's own routes, which p4.4/route-closure.mjs leaves out, on both trees.
TREE=$V/del node "$P53/session-route-closure.mjs" "$C/delivery-audit.json" > "$V/session-route-closure.json"; f=$?
TREE=$V/ref node "$P53/session-route-closure.mjs" "$C/reference-audit.json" > "$V/session-route-closure-reference.json"; g=$?
python3 -I - "$V/inventory-closure.json" "$C/delivery-check-owners.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for side in ('before', 'after'):
    x = d[side]
    print(side, x['baseline']['commit'][:9], 'P5.3 points', len(x['p53']), 'unowned', len(x['unowned']), 'pending', len(x['pending']), json.dumps(x['owners']))
o = json.load(open(sys.argv[2]))
print('check-owners unowned', json.dumps(o['unowned'], ensure_ascii=False), 'pending', len(o['pending']))
PY
python3 -I - "$V/session-route-closure.json" "$V/session-route-closure-reference.json" <<'PY'
import json, sys
for name, path in (('delivery', sys.argv[1]), ('reference', sys.argv[2])):
    for r in json.load(open(path))['routes']:
        print(name, r['route'], 'modules', r['modules'], 'reaching antd', len(r['antd']), sorted({m['owner'] or '-' for m in r['antd']}))
PY
echo "exits: delivery audit $a, reference audit $b, check-owners $c, closure $d, route closure $e, session routes $f/$g"
[ $a -eq 0 ] && [ $b -eq 0 ] && [ $c -eq 0 ] && [ $d -eq 0 ] && [ $e -eq 0 ] && [ $f -eq 0 ] && [ $g -eq 0 ]
