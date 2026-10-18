#!/usr/bin/env bash
# Usage: main-dry-run.sh <base the branch caught up with>   (the project rule for main moving after the final rounds)
# Fetches origin, dry-runs `git merge-tree --write-tree HEAD origin/main` and lists what main changed since <base>: by
# area, and every file under src/web, src/shared, the lockfile, the P0 harness and the evidence tree, with the files
# outside src/shared's own tests and fixtures that read a changed src/shared file.
set -uo pipefail
REPO=${REPO:-$(cd "$(dirname "$0")" && git rev-parse --show-toplevel)}
BASE=$1
cd "$REPO"
git fetch origin --quiet
M=$(git rev-parse origin/main)
echo "HEAD $(git rev-parse HEAD), origin/main $M, base $(git rev-parse "$BASE"), $(date -u +%FT%TZ)"
git merge-base --is-ancestor "$M" HEAD && { echo "origin/main is already in HEAD"; exit 0; }
tree=$(git merge-tree --write-tree HEAD "$M"); code=$?
echo "merge-tree exit $code (0 = no conflicts), result tree: $tree" | head -3
echo "## main's commits since the base"
git log --format='%h %s' "$BASE..$M"
echo "## main's changes since the base, by area"
git diff --name-only "$BASE" "$M" | awk -F/ '{ k = ($1 == "src") ? $1 "/" $2 : $1; n[k]++ } END { for (k in n) print "  " k ": " n[k] " files" }' | sort
echo "## under src/web, src/shared, the lockfile, scripts/worktree-overlay.sh or docs/evidence"
git diff --name-status "$BASE" "$M" -- src/web src/shared package-lock.json package.json scripts/worktree-overlay.sh docs/evidence
echo "## readers of the changed src/shared files, outside src/shared's tests (none under src/web = the Web build does not read them)"
for f in $(git diff --name-only "$BASE" "$M" -- src/shared); do
  b=$(basename "$f"); echo "$f:"; git grep -l -F "$b" "$M" -- src/web | sed "s|^$M:|  src/web reads it: |"; echo "  under src/web: $(git grep -l -F "$b" "$M" -- src/web | wc -l) files"
done
