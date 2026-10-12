#!/usr/bin/env bash
# The project's inventory rescan (src/web/scripts/audit-antd.mjs) for this branch: usage antd-audit.sh <project tip>
# Each tree's audit inputs are extracted with git archive into /var/tmp/kw2-246921c8/scratch/audit-<name> (no checkout),
# with .git/HEAD holding the commit (for merged: the merge-tree result) that the audit records as its baseline:
#   base    7732f14f8, where this branch started (the project tip then), with its own audit script;
#   final   HEAD, with the same script;
#   merged  HEAD merged with the given project tip (git merge-tree, nothing committed), with the tip's script, which
#           adds --check-owners and reads the owners recorded since in inventory-delta/.
# The reports stay in /var/tmp/kw2-246921c8/scratch; antd-audit-compare.py writes the comparison to antd-audit.json here.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../../.." && pwd)
out=/var/tmp/kw2-246921c8/scratch
cd "$root"
base=$(git rev-parse 7732f14f8) head=$(git rev-parse HEAD) tip=$(git rev-parse "$1")
merged=$(git merge-tree --write-tree HEAD "$tip")
evidence=docs/evidence/base-ui-migration
inputs="src/web/src src/web/package.json package-lock.json src/web/scripts/audit-antd.mjs $evidence/audit-baseline.json
  $evidence/ownership.json $evidence/css-ownership.json $evidence/routes-and-tests.md"
echo "base $base, final $head, project tip $tip, merged tree $merged"
for name in base final merged; do
  case $name in base) rev=$base extra= ;; final) rev=$head extra= ;; merged) rev=$merged extra=$evidence/inventory-delta ;; esac
  dir=$out/audit-$name
  rm -rf "$dir" && mkdir -p "$dir/.git"
  git archive "$rev" $inputs $extra | tar -x -C "$dir"
  echo "$rev" > "$dir/.git/HEAD"
  (cd "$dir" && node src/web/scripts/audit-antd.mjs --json > "$out/antd-audit-$name.json")
  echo "$name: audit $(sha256sum "$out/antd-audit-$name.json" | cut -c1-64)"
done
set +e
(cd "$out/audit-merged" && node src/web/scripts/audit-antd.mjs --check-owners) > "$out/antd-owners-merged.json"
echo "merged: --check-owners exit $?"
set -e
python3 -B "$here/antd-audit-compare.py" "$out" "$tip" > "$here/antd-audit.json"
rm -rf "$out/audit-base" "$out/audit-final" "$out/audit-merged"
echo "wrote antd-audit.json"
