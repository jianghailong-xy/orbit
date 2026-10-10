#!/usr/bin/env bash
# audit.sh DELIVERY: the inventory checks of the delivery commit, into v1/checks, v1/inventory-closure.json and
# v1/route-closure.json (the delivery checked out in the scratch checkout rec09c, so the audits name it):
#  - audit-antd.mjs --json on the delivery and on the same-commit reference tree;
#  - --check-owners on the delivery (exit 1 on any unowned point);
#  - verify-record.mjs of 2026-10-09c.json against the audit of its own scan (p4.4/checks/record-09c-audit.json), and of
#    2026-10-09b.json against its own (p4.3a/checks/record-09b-audit.json);
#  - inventory-closure.mjs: reference vs delivery;
#  - route-closure.mjs: what each non-session route still reaches of antd on the delivery.
# Only reads the trees; writes only under v1. (P4.3a's audit.sh, for P4.4.)
set -u
DELIVERY=${1:?delivery commit}
V=/mnt/data/tmp/34Za39J4QY3kDa5p2Wsau/v1
D=/mnt/data/tmp/34Za39J4QY3kDa5p2Wsau/rec09c
WT=/root/.orbit/worktrees/a8fc02e5-256c-58d5-bafe-dbd063f08987
E=docs/evidence/base-ui-migration
C=$V/checks
mkdir -p "$C"
git -C "$D" checkout -q --detach "$DELIVERY" || exit 1
cd "$D"
echo "delivery $(git rev-parse HEAD), reference $(git -C "$V/ref" rev-parse HEAD)"
node src/web/scripts/audit-antd.mjs --json > "$C/delivery-audit.json"; a=$?
(cd "$V/ref" && node src/web/scripts/audit-antd.mjs --json > "$C/reference-audit.json"); b=$?
node src/web/scripts/audit-antd.mjs --check-owners > "$C/delivery-check-owners.json"; c=$?
{ node $E/inventory-delta/verify-record.mjs $E/p4.4/checks/record-09c-audit.json 2026-10-09c.json; echo "exit=$?"
  node $E/inventory-delta/verify-record.mjs $E/p4.3a/checks/record-09b-audit.json 2026-10-09b.json; echo "exit=$?"; } > "$C/verify-record-09c.txt" 2>&1
d=$(grep -c '^exit=0$' "$C/verify-record-09c.txt")
# The two closure scripts come with the evidence (the task worktree); they read the same src/web as the delivery's.
node "$WT/$E/p4.4/inventory-closure.mjs" "$C/reference-audit.json" "$C/delivery-audit.json" > "$V/inventory-closure.json"; e=$?
node "$WT/$E/p4.4/route-closure.mjs" "$C/delivery-audit.json" > "$V/route-closure.json"; f=$?
cat "$C/verify-record-09c.txt"
python3 -I - "$V/inventory-closure.json" "$C/delivery-check-owners.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for side in ('before', 'after'):
    x = d[side]
    print(side, x['baseline']['commit'][:9], 'P4.4 points', len(x['p44']), 'unowned', len(x['unowned']), 'pending', len(x['pending']), json.dumps(x['owners']))
o = json.load(open(sys.argv[2]))
print('check-owners', {k: (len(v) if isinstance(v, (list, dict)) else v) for k, v in o.items() if k in ('unowned', 'pending')})
PY
echo "exits: delivery audit $a, reference audit $b, check-owners $c, verify-record passes $d/2, closure $e, route closure $f"
[ $a -eq 0 ] && [ $b -eq 0 ] && [ $c -eq 0 ] && [ $d -eq 2 ] && [ $e -eq 0 ] && [ $f -eq 0 ]
