#!/usr/bin/env bash
# The inventory checks of inventory-delta/2026-10-08.json on this branch. Usage: inventory-check.sh <introducing commit>
# 1. The record's scan is the audit (--json) of the commit it names; that commit's audited sources must equal HEAD's.
#    In a scratch copy (git archive: those sources, and HEAD's audit script, P0.1 inventory and inventory-delta, with
#    .git/HEAD naming the scan commit, in /mnt/data/tmp/overlay-first-frame-34brok/scratch/inv-check),
#    build-inventory-record.py rebuilds the record byte for byte from that audit, and verify-record.mjs checks it.
# 2. On HEAD itself: --check-owners, the audit's self-check and the P0.1 inventory check.
# Main brought use points that had no owner while this task ran: 12 on the project tip it started from, 14 after
# merging main on 2026-10-08 (origin/main alone had the same 14). The coordinator gave them owners outside this task
# (P4.2 migrated three and recorded the rest in 2026-10-07c.json), and origin/main 404c5ffce, the base this branch
# now sits on, has none left, so no stand-in record is needed any more and every step must pass.
# Every command runs even when one before it fails; the script exits non-zero if any of them does.
set -u
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
scratch=/mnt/data/tmp/overlay-first-frame-34brok/scratch
dir=$scratch/inv-check
evidence=docs/evidence/base-ui-migration
record=$evidence/inventory-delta/2026-10-08.json
introduced=$(git -C "$root" rev-parse "$1")
failed=0
step() { echo "\$ $*"; "$@"; local code=$?; echo "exit $code"; [ $code -eq 0 ] || failed=1; return 0; }
cd "$root"
mkdir -p "$scratch"
scan=$(python3 -c "import json, sys; print(json.load(open(sys.argv[1]))['scan']['commit'])" "$record")
echo "HEAD $(git rev-parse HEAD), record scan $scan, import introduced by $introduced"
step git diff --quiet "$scan" HEAD -- src/web/src src/web/package.json package-lock.json
rm -rf "$dir" && mkdir -p "$dir/.git"
git archive "$scan" src/web/src src/web/package.json package-lock.json | tar -x -C "$dir"
git archive HEAD src/web/scripts/audit-antd.mjs src/web/scripts/audit-antd-selfcheck.mjs src/web/scripts/verify-antd-inventory.mjs \
  $evidence/audit-baseline.json $evidence/ownership.json $evidence/css-ownership.json $evidence/routes-and-tests.md \
  $evidence/inventory-delta | tar -x -C "$dir"
echo "$scan" > "$dir/.git/HEAD"
cd "$dir"
node src/web/scripts/audit-antd.mjs --json > "$scratch/inv-check-audit.json"
echo "scan audit $(sha256sum "$scratch/inv-check-audit.json" | cut -c1-64)"
step bash -c "python3 -B '$here/build-inventory-record.py' '$scratch/inv-check-audit.json' $evidence/inventory-delta/2026-10-07d.json $introduced | cmp - $record"
step node $evidence/inventory-delta/verify-record.mjs "$scratch/inv-check-audit.json" 2026-10-08.json
cd "$root"
step node src/web/scripts/audit-antd.mjs --check-owners
step node src/web/scripts/audit-antd-selfcheck.mjs
step node src/web/scripts/verify-antd-inventory.mjs
rm -rf "$dir"
exit $failed
