#!/usr/bin/env bash
# The inventory checks of inventory-delta/2026-10-07d.json, after this branch has merged the project tip: usage
# inventory-check.sh <commit with this branch's last source change>
# 1. This branch's sources: that commit's src/web/src, src/web/package.json and package-lock.json, with HEAD's audit
#    script, P0.1 inventory and inventory-delta records, extracted with git archive into
#    /var/tmp/kw2-246921c8/scratch/inv-branch (.git/HEAD names the commit). There the audit (--json) is the scan the
#    record describes: build-inventory-record.py rebuilds the record byte for byte from it, verify-record.mjs checks
#    it, and --check-owners reads all records.
# 2. The merged tree, HEAD as it is: --check-owners, the audit's self-check and the P0.1 inventory check.
# Every command runs even when one before it fails; the script exits non-zero if any did.
set -u
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
scratch=/var/tmp/kw2-246921c8/scratch
dir=$scratch/inv-branch
evidence=docs/evidence/base-ui-migration
failed=0
step() { echo "\$ $*"; "$@"; local code=$?; echo "exit $code"; [ $code -eq 0 ] || failed=1; return 0; }
cd "$root"
commit=$(git rev-parse "$1")
echo "branch sources $commit, HEAD $(git rev-parse HEAD), HEAD:src/web/src $(git rev-parse HEAD:src/web/src)"
rm -rf "$dir" && mkdir -p "$dir/.git"
git archive "$commit" src/web/src src/web/package.json package-lock.json | tar -x -C "$dir"
git archive HEAD src/web/scripts/audit-antd.mjs $evidence/audit-baseline.json $evidence/ownership.json \
  $evidence/css-ownership.json $evidence/routes-and-tests.md $evidence/inventory-delta | tar -x -C "$dir"
echo "$commit" > "$dir/.git/HEAD"
cd "$dir"
node src/web/scripts/audit-antd.mjs --json > "$scratch/inv-branch-audit.json"
echo "branch audit $(sha256sum "$scratch/inv-branch-audit.json" | cut -c1-64)"
step bash -c "python3 -B '$here/build-inventory-record.py' '$scratch/inv-branch-audit.json' $evidence/inventory-delta/2026-10-07.json | cmp - $evidence/inventory-delta/2026-10-07d.json"
step node $evidence/inventory-delta/verify-record.mjs "$scratch/inv-branch-audit.json" 2026-10-07d.json
step node src/web/scripts/audit-antd.mjs --check-owners
cd "$root"
step node src/web/scripts/audit-antd.mjs --check-owners
step node src/web/scripts/audit-antd-selfcheck.mjs
step node src/web/scripts/verify-antd-inventory.mjs
rm -rf "$dir"
exit $failed
