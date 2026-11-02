#!/bin/bash
# mkprobe.sh <base-rev> <branch>: a commit on <base-rev> carrying .wdg-probe/ and the probe workflow as
# .github/workflows/client.yml, built in a temporary index (no checkout), pushed to refs/heads/<branch>.
# Adapted from docs/evidence/claude-region-check-apple/kit/mkprobe.sh.
set -euo pipefail
WT=/root/.orbit/worktrees/e208d235-2d67-573a-ac32-191dff8c9b3a
H=/mnt/data/tmp/wkdiagram-probe/harness/.wdg-probe
base=$(git -C "$WT" rev-parse "$1"); branch=$2
export GIT_INDEX_FILE=/mnt/data/tmp/wkdiagram-probe/probe-index
rm -f "$GIT_INDEX_FILE"
cd "$WT"
git read-tree "$base"
for f in $(cd "$H" && find . -type f ! -name '*.pyc' ! -path './shots/*' | sed 's|^\./||' | sort); do
  mode=100644; [ -x "$H/$f" ] && mode=100755
  blob=$(git hash-object -w "$H/$f")
  git update-index --add --cacheinfo "$mode,$blob,.wdg-probe/$f"
done
blob=$(git hash-object -w "$H/client.probe.yml")
git update-index --cacheinfo "100644,$blob,.github/workflows/client.yml"
tree=$(git write-tree)
commit=$(git commit-tree "$tree" -p "$base" -m "probe: wiki document diagrams on iPhone and Mac (never merged)")
rm -f "$GIT_INDEX_FILE"
echo "$commit"
git push -q -f origin "$commit:refs/heads/$branch" 2>&1 | grep -v "vulnerabilit\|dependabot\|^remote: *$" || true
