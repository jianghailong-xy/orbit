#!/usr/bin/env bash
# Usage: main-dryrun.sh <outfile> — the branch head against the newest origin/main without merging: fetch, then
# `git merge-tree --write-tree` (exit 0 = no conflicts), the files the merge would bring into the branch (the merged
# tree against the branch head = what main changed that the branch does not have yet), and whether this batch's
# three files come out of the merge as the branch has them.
set -u
W=/root/.orbit/worktrees/3a1c46ee-9958-51c0-b844-89a44ffe9d25
OUT=$1
cd "$W" || exit 2
git fetch origin --quiet
BATCH="src/web/src/lib/toast.tsx src/web/src/components/ui/__fixtures__/OverlaysFixture.tsx src/web/ui-migration/overlays-app-frame.browser.mjs"
{
  echo "date $(date -u +%FT%TZ)"
  echo "branch head $(git rev-parse HEAD)"
  echo "origin/main $(git rev-parse origin/main)"
  echo "origin/project/34ZZeq0e3IR65GVm2kAs7 $(git rev-parse origin/project/34ZZeq0e3IR65GVm2kAs7)"
  echo "project tip in branch: $(git merge-base --is-ancestor origin/project/34ZZeq0e3IR65GVm2kAs7 HEAD && echo yes || echo no)"
  echo "== git merge-tree --write-tree HEAD origin/main"
  TREE=$(git merge-tree --write-tree HEAD origin/main); code=$?
  echo "$TREE"; echo "merge-tree exit $code"
  echo "== commits on origin/main not in the branch"
  git log --oneline HEAD..origin/main
  echo "== files the merge brings into the branch (git diff --name-only HEAD <merged tree>)"
  git diff --name-only HEAD "$TREE" | tee /tmp/34cBi-main-files.txt
  echo "== of them under src/web or src/shared"
  grep -E '^src/(web|shared)/' /tmp/34cBi-main-files.txt || echo none
  echo "== this batch's files in that list"
  printf '%s\n' $BATCH | grep -Fxf - /tmp/34cBi-main-files.txt || echo none
  echo "== this batch's files: merged tree against the branch head (empty = kept as the branch has them)"
  git diff --stat HEAD "$TREE" -- $BATCH
  echo "== the project tip: git merge-tree --write-tree HEAD origin/project/34ZZeq0e3IR65GVm2kAs7"
  PTREE=$(git merge-tree --write-tree HEAD origin/project/34ZZeq0e3IR65GVm2kAs7); pcode=$?
  echo "$PTREE"; echo "merge-tree exit $pcode"
  echo "project tip in origin/main: $(git merge-base --is-ancestor origin/project/34ZZeq0e3IR65GVm2kAs7 origin/main && echo yes || echo no)"
  echo "== commits on the project tip not in the branch"
  git log --oneline HEAD..origin/project/34ZZeq0e3IR65GVm2kAs7 | head -20
  echo "== files that merge brings into the branch"
  git diff --name-only HEAD "$PTREE" | tee /tmp/34cBi-project-files.txt
  echo "== this batch's files in that list"
  printf '%s\n' $BATCH | grep -Fxf - /tmp/34cBi-project-files.txt || echo none
  echo "== P4.3b's a0b33edff (not yet on the project line): git merge-tree --write-tree HEAD a0b33edff"
  if git cat-file -e a0b33edff 2>/dev/null; then git merge-tree --write-tree --name-only HEAD a0b33edff | head -1; echo "merge-tree exit ${PIPESTATUS[0]}"; echo "on origin/project: $(git merge-base --is-ancestor a0b33edff origin/project/34ZZeq0e3IR65GVm2kAs7 && echo yes || echo no), on origin/main: $(git merge-base --is-ancestor a0b33edff origin/main && echo yes || echo no)"; else echo "a0b33edff not available"; fi
  echo "(end)"
} > "$OUT" 2>&1
cat "$OUT"
