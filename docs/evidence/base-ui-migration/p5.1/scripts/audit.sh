#!/usr/bin/env bash
# audit.sh: the inventory checks of the delivery, into v1/checks, v1/inventory-closure.json and v1/route-closure.json
# (P4.4's audit.sh, for P5.1; P5.1 writes no inventory record, so there is no record check):
#  - audit-antd.mjs --json on the delivery tree (v1/del) and on the same-commit reference tree (v1/ref);
#  - --check-owners on the delivery (it exits 1 while main's two points the coordinator assigned to P5.3 — recorded by
#    P5.2 as 2026-10-10 and 2026-10-10b — are not in this tree's records; the script prints them);
#  - inventory-closure.mjs: reference vs delivery, P5.1's points before and after;
#  - p4.4/route-closure.mjs: what each non-session route and the signed-in shell still reach of antd on the delivery.
# Only reads the trees; writes only under v1.
set -u
V=/mnt/data/tmp/34Za39L1H6V82d2sobzPY/v1
E=docs/evidence/base-ui-migration
# This directory's own scripts are read from where this script is (they are committed with the evidence, after the run).
P51=$(cd "$(dirname "$0")/.." && pwd)
C=$V/checks
mkdir -p "$C"
echo "delivery $(git -C "$V/del" rev-parse HEAD), reference $(git -C "$V/ref" rev-parse HEAD)"
(cd "$V/del" && node src/web/scripts/audit-antd.mjs --json > "$C/delivery-audit.json"); a=$?
(cd "$V/ref" && node src/web/scripts/audit-antd.mjs --json > "$C/reference-audit.json"); b=$?
(cd "$V/del" && node src/web/scripts/audit-antd.mjs --check-owners > "$C/delivery-check-owners.json" 2> "$C/delivery-check-owners.stderr.txt"); c=$?
(cd "$V/del" && node "$P51/inventory-closure.mjs" "$C/reference-audit.json" "$C/delivery-audit.json" > "$V/inventory-closure.json"); d=$?
(cd "$V/del" && node "$E/p4.4/route-closure.mjs" "$C/delivery-audit.json" > "$V/route-closure.json"); e=$?
python3 -I - "$V/inventory-closure.json" "$C/delivery-check-owners.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for side in ('before', 'after'):
    x = d[side]
    print(side, x['baseline']['commit'][:9], 'P5.1 points', len(x['p51']), 'unowned', len(x['unowned']), 'pending', len(x['pending']), json.dumps(x['owners']))
o = json.load(open(sys.argv[2]))
print('check-owners unowned', json.dumps(o['unowned'], ensure_ascii=False), 'pending', len(o['pending']))
PY
echo "exits: delivery audit $a, reference audit $b, check-owners $c, closure $d, route closure $e"
[ $a -eq 0 ] && [ $b -eq 0 ] && [ $d -eq 0 ] && [ $e -eq 0 ]
