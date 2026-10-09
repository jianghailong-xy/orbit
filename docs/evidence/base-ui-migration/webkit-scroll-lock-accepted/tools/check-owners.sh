#!/usr/bin/env bash
# Usage: check-owners.sh <merge commit>
# src/web/scripts/audit-antd.mjs --check-owners (作业指导「跟上 main」) on this worktree (the registration commit) and on
# the scratch dry-run merge with origin/main (checked out in the scratch tree, which is put back on the registration
# commit afterwards). Writes /mnt/data/tmp/34cfhmpygHQdZxRznyVH9/checks/check-owners-{821e2d501,main-merge}.json.
set -uo pipefail
WT=/root/.orbit/worktrees/63507a7e-d688-5155-900e-de51850b6416
S=/mnt/data/tmp/34cfhmpygHQdZxRznyVH9; NC=$S/trees/before-15b7b5609
MERGE=$(git -C $WT rev-parse "${1:?merge commit}")
(cd $WT && node src/web/scripts/audit-antd.mjs --check-owners) > $S/checks/check-owners-821e2d501.json; echo "registration commit: exit $?"
REG=$(git -C $NC rev-parse HEAD)
git -C $NC checkout -q --detach "$MERGE" || exit 2
(cd $NC && node src/web/scripts/audit-antd.mjs --check-owners) > $S/checks/check-owners-main-merge.json; echo "merge $MERGE: exit $?"
git -C $NC checkout -q --detach "$REG"
for f in 821e2d501 main-merge; do
  python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(sys.argv[2], d["baseline"]["commit"], "unowned", len(d["unowned"]), "pending", len(d["pending"]), d["owners"])' $S/checks/check-owners-$f.json $f
done
