#!/usr/bin/env bash
# audit.sh: the inventory checks of the delivery, into v1/checks and v1/inventory-closure.json:
#  - audit-antd.mjs --json on the delivery (the task worktree's HEAD) and on the same-commit reference tree;
#  - --check-owners on the delivery (exit 1 on any unowned point);
#  - verify-record.mjs of 2026-10-08b.json against the audit of its own scan (checks/record-08b-audit.json);
#  - inventory-closure.mjs: reference vs delivery.
# Only reads the trees; writes only under v1.
set -u
V=/mnt/data/tmp/34Za39GvWRQ08ZmKOpFNe/v1
WT=/root/.orbit/worktrees/8682ce7d-8166-5c60-8bec-942544612de2
C=$V/checks
mkdir -p "$C"
cd "$WT"
echo "delivery $(git rev-parse HEAD), reference $(git -C "$V/ref" rev-parse HEAD)"
node src/web/scripts/audit-antd.mjs --json > "$C/delivery-audit.json"; a=$?
(cd "$V/ref" && node src/web/scripts/audit-antd.mjs --json > "$C/reference-audit.json"); b=$?
node src/web/scripts/audit-antd.mjs --check-owners > "$C/delivery-check-owners.json"; c=$?
node docs/evidence/base-ui-migration/inventory-delta/verify-record.mjs docs/evidence/base-ui-migration/p4.3a/checks/record-08b-audit.json 2026-10-08b.json > "$C/verify-record-08b.txt" 2>&1; d=$?
node docs/evidence/base-ui-migration/p4.3a/inventory-closure.mjs "$C/reference-audit.json" "$C/delivery-audit.json" > "$V/inventory-closure.json"; e=$?
cat "$C/verify-record-08b.txt"
python3 -I - "$V/inventory-closure.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for side in ('before', 'after'):
    x = d[side]
    print(side, x['baseline']['commit'][:9], 'P4.3a points', len(x['p43a']), 'unowned', len(x['unowned']), 'pending', len(x['pending']), json.dumps(x['owners']))
PY
echo "exits: delivery audit $a, reference audit $b, check-owners $c, verify-record $d, closure $e"
[ $a -eq 0 ] && [ $b -eq 0 ] && [ $c -eq 0 ] && [ $d -eq 0 ] && [ $e -eq 0 ]
