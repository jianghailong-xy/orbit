#!/usr/bin/env bash
# Build the probe commit on top of the checkout's HEAD without touching its worktree (a private index), and push it
# to probe/t07-managed-runner-replay (PROBE_BRANCH names another, which the probe's workflow must trigger on). The probe
# directory becomes .t07-probe/, its workflow .github/workflows/client.yml.
# Usage: push-probe.sh PROBE_DIR [--dry-run]
set -euo pipefail
WT=/root/.orbit/worktrees/7ddda73b-7127-5859-a253-c2d61bb5aa40
PROBE=$(cd "$1" && pwd)
BRANCH=${PROBE_BRANCH:-probe/t07-managed-runner-replay}
cd "$WT"
export GIT_INDEX_FILE=$(mktemp /tmp/t07probe-index.XXXXXX)
rm -f "$GIT_INDEX_FILE"
git read-tree HEAD
while IFS= read -r -d '' file; do
  rel=${file#"$PROBE"/}
  case "$rel" in client.probe.yml) continue ;; esac
  mode=100644
  [ -x "$file" ] && mode=100755
  sha=$(git hash-object -w "$file")
  git update-index --add --cacheinfo "$mode,$sha,.t07-probe/$rel"
done < <(find "$PROBE" -type f -print0)
sha=$(git hash-object -w "$PROBE/client.probe.yml")
git update-index --add --cacheinfo "100644,$sha,.github/workflows/client.yml"
tree=$(git write-tree)
commit=$(git commit-tree "$tree" -p HEAD -m "TEMPORARY probe (never merged): T07 replay of the test server's recorded answers to the iPhone and Mac apps")
rm -f "$GIT_INDEX_FILE"
echo "probe commit $commit (tree $tree) on $(git rev-parse --short HEAD)"
git show --stat --format='%h %s' "$commit" | tail -5
if [ "${2:-}" != "--dry-run" ]; then
  old=$(git ls-remote origin "refs/heads/$BRANCH" | cut -f1)
  if [ -n "$old" ]; then
    git push --force-with-lease="refs/heads/$BRANCH:$old" origin "$commit:refs/heads/$BRANCH"
  else
    git push origin "$commit:refs/heads/$BRANCH"
  fi
fi
