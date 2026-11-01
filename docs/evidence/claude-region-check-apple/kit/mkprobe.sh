#!/bin/bash
# mkprobe.sh <base-rev> <branch>: a commit on <base-rev> carrying .rgn-probe/ and the probe workflow as
# .github/workflows/client.yml, built in a temporary index (no checkout), pushed to refs/heads/<branch>.
set -euo pipefail
WT=/root/.orbit/worktrees/56867ee8-0393-5994-a045-e70534e40745
H=/mnt/data/tmp/34pVMqwUhJE0RGvrL0ziL/harness/.rgn-probe
base=$(git -C "$WT" rev-parse "$1"); branch=$2
export GIT_INDEX_FILE=/mnt/data/tmp/34pVMqwUhJE0RGvrL0ziL/probe-index
rm -f "$GIT_INDEX_FILE"
cd "$WT"
git read-tree "$base"
for f in $(cd "$H" && find . -type f ! -name '*.pyc' ! -path './shots/*' | sed 's|^\./||' | sort); do
  mode=100644; [ -x "$H/$f" ] && mode=100755
  blob=$(git hash-object -w "$H/$f")
  git update-index --add --cacheinfo "$mode,$blob,.rgn-probe/$f"
done
blob=$(git hash-object -w "$H/client.probe.yml")
git update-index --cacheinfo "100644,$blob,.github/workflows/client.yml"
tree=$(git write-tree)
commit=$(git commit-tree "$tree" -p "$base" -m "probe: Claude region check on iPhone (never merged)")
rm -f "$GIT_INDEX_FILE"
echo "$commit"
git push -q -f origin "$commit:refs/heads/$branch" 2>&1 | grep -v "vulnerabilit\|dependabot\|^remote: *$" || true
