#!/usr/bin/env bash
# final-audit.sh: the inventory re-scan on the delivery (this task's worktree) and on the same-commit
# reference tree (ref: the delivery with the business switch reverted), and the closure record from the
# two. The reference is a sparse tree without docs/, so --check-owners runs on the delivery only; the
# closure script applies the same owner rules to both audits. Writes to final/.
set -u
V=/mnt/data/tmp/34blYpxEcHMAf4oafuC2W
WT=/root/.orbit/worktrees/ba9b2bbb-b78b-5991-855c-183de0d5d9e3
F=$V/final
mkdir -p "$F"
cd "$WT" || exit 1
echo "delivery HEAD $(git rev-parse HEAD), reference HEAD $(git -C $V/ref rev-parse HEAD)"
node src/web/scripts/audit-antd.mjs --json > "$F/del-audit.json"; echo "delivery audit exit $?"
node src/web/scripts/audit-antd.mjs > "$F/del-audit-summary.txt"
node src/web/scripts/audit-antd.mjs --check-owners > "$F/del-check-owners.txt"; echo "delivery check-owners exit $?"
(cd "$V/ref" && node src/web/scripts/audit-antd.mjs --json > "$F/ref-audit.json"; echo "reference audit exit $?"; node src/web/scripts/audit-antd.mjs > "$F/ref-audit-summary.txt")
node docs/evidence/base-ui-migration/p4.3b/inventory-closure.mjs "$F/ref-audit.json" "$F/del-audit.json" > "$F/inventory-closure.json"; echo "closure exit $?"
