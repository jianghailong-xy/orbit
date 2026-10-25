#!/usr/bin/env bash
# Usage: proof.sh
# The delivery's final facts, read in the session worktree after the evidence commit: the branch tip and a clean tree; the
# tip holds the project tip and the main it was verified on; the registration commit touches only the p0-drift layers and
# README; P0.2, the P0 tests, product code, shared and the lockfile are unchanged since the base; and a dry run of the merge
# with the latest origin/main, with what main changed since the base the checks ran on.
set -u
REPO=/root/.orbit/worktrees/29948cd5-4699-56fe-be2f-3864e2bd39a6
BASE=cc16cb2141dff9997d0673975ae90342969675c2
REG=4882b380e44d3b5cbcc511b1c187056b7af26c53
cd "$REPO" || exit 2
git fetch -q origin
echo "HEAD $(git rev-parse HEAD)"; git log --oneline -3
echo "status: $(git status --porcelain | wc -l) changes"
echo "origin/main $(git rev-parse origin/main)"
echo "origin/project/34ZZeq0e3IR65GVm2kAs7 $(git rev-parse origin/project/34ZZeq0e3IR65GVm2kAs7)"
git merge-base --is-ancestor origin/project/34ZZeq0e3IR65GVm2kAs7 HEAD && echo "the project tip is in HEAD"
git merge-base --is-ancestor "$BASE" HEAD && echo "base $BASE is in HEAD"
git merge-base --is-ancestor "$REG" HEAD && echo "registration $REG is in HEAD"
echo "registration commit: $(git log -1 --format='%H %s' "$REG")"
git show --name-only --format= "$REG" | awk -F/ '{print $1"/"$2"/"$3"/"$4}' | sort | uniq -c
echo "P0.2, product code, shared, P0 tests and lockfile since the base (empty = unchanged):"
git diff --stat "$BASE" HEAD -- docs/evidence/base-ui-migration/p0.2 src/web/src src/shared src/web/ui-migration package-lock.json package.json
echo "paths changed since the base:"
git diff --name-only "$BASE" HEAD | awk -F/ '{print $1"/"$2"/"$3"/"$4}' | sort | uniq -c
echo "merge-tree with the latest origin/main:"
git merge-tree --write-tree HEAD origin/main; echo "merge-tree exit $?"
echo "origin/main since the base: $(git log --oneline "$BASE"..origin/main | wc -l) commits"
git diff --name-only "$BASE" origin/main | awk -F/ '{print $1"/"$2"/"$3}' | sort | uniq -c
echo "Web build inputs, P0 tests and this evidence tree changed by main since the base (empty = none):"
git diff --name-only "$BASE" origin/main -- src/web src/shared package-lock.json package.json tsconfig.base.json docs/evidence/base-ui-migration
