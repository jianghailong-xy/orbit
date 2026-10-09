#!/usr/bin/env bash
# Usage: REG=<registration commit> main-dryrun.sh [run]
# 跟上 main after the final round started (作业指导「跟上 main」last item): a dry-run merge of the registration commit
# with the latest origin/main (git merge-tree --write-tree), the list of what main brought since the project tip
# b2568f28d, and whether it touches this registration's files or the layer its nine screenshots rest on (the P0
# harness, the p0-drift layers, ui/ components, toast/overlay code, index.css rules of those). With `run`, the
# merged tree is also pinned by a scratch commit (never pushed or delivered) in the scratch worktree and the unchanged
# P0 command runs on it (netns-regression.sh), to show the registration holds on the latest main.
set -uo pipefail
WT=/root/.orbit/worktrees/63507a7e-d688-5155-900e-de51850b6416
S=/mnt/data/tmp/34cfhmpygHQdZxRznyVH9; R=$S/runs; NC=$S/trees/before-15b7b5609
NETNS=$WT/docs/evidence/base-ui-migration/p0-drift-2/tools/netns-regression.sh
START=b2568f28d8bb87d12eec762d1f810562503ed2d9
REG=$(git -C $WT rev-parse "${REG:?registration commit}")
git -C $WT fetch -q origin
MAIN=$(git -C $WT rev-parse origin/main)
echo "registration $REG; origin/main $MAIN; origin/project/34ZZeq0e3IR65GVm2kAs7 $(git -C $WT rev-parse origin/project/34ZZeq0e3IR65GVm2kAs7); $(date -u +%FT%TZ)"
git -C $WT merge-base --is-ancestor origin/project/34ZZeq0e3IR65GVm2kAs7 origin/main && echo "the project tip is in origin/main"
TREE=$(git -C $WT merge-tree --write-tree "$REG" origin/main); code=$?
echo "git merge-tree --write-tree $REG origin/main: exit $code, tree $TREE"
echo "## main since the project tip $START"
git -C $WT log --format='%h %cI %s' "$START..origin/main"
git -C $WT diff --stat=160 "$START" origin/main | tail -1
echo "## main's changed files under src/web, src/shared"
git -C $WT diff --name-status "$START" origin/main -- src/web src/shared
echo "## touches this registration or the layer under its screenshots? (empty = no)"
for p in docs/evidence/base-ui-migration src/web/ui-migration src/web/src/components/ui src/web/src/lib/toast.tsx src/web/src/components/ToastViewport.tsx src/web/src/pages/SettingsPage.tsx src/web/src/pages/ProfilePage.tsx src/web/package.json package-lock.json; do
  echo "$p: [$(git -C $WT diff --name-only "$START" origin/main -- "$p" | tr '\n' ' ')]"
done
echo "## index.css rules main adds or changes (selector lines)"
git -C $WT diff -U0 "$START" origin/main -- src/web/src/index.css | grep -E '^[-+][^-+]' | grep -E '\{\s*$' | sed 's/{\s*$//' | tr '\n' ';' | fold -w 200; echo
echo "## the merged tree against the registration commit, src/ only"
git -C $WT diff --stat=160 "$REG" "$TREE" -- src | tail -1
if [ "${1:-}" = run ] && [ ! -f $R/main-merge/exit.txt ]; then
  MERGE=$(git -C $WT commit-tree "$TREE" -p "$REG" -p "$MAIN" -m "scratch: dry-run merge of the registration with origin/main, never delivered")
  echo "scratch merge commit $MERGE (tree $TREE)"
  git -C $NC checkout -q --detach "$MERGE" && git -C $NC reset -q --hard "$MERGE" || exit 2
  (cd $NC && bash scripts/worktree-overlay.sh) > $S/logs/main-merge-overlay.txt 2>&1 || { echo "overlay failed"; exit 2; }
  rm -rf $R/main-merge; bash $NETNS $NC $R/main-merge; echo "step main-merge exit $?"
  git -C $NC checkout -q --detach "$REG" && git -C $NC reset -q --hard "$REG"
fi
echo "done $(date -u +%FT%TZ)"
