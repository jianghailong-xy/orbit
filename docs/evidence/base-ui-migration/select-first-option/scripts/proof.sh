#!/usr/bin/env bash
# proof.sh: the checks run just before the evidence was submitted, printed for the record: the branch holds the two
# delivery commits on the base they were verified on; where origin/main and the project tip are; a dry-run merge of the
# branch with the latest origin/main (the project rule after the final round); whether main's new commits touch this
# batch's files or the global layer it depends on (ui/ components, Toast, overlay and select rules in index.css).
set -u
cd "$(git rev-parse --show-toplevel)"
BASE=9e9787f7969edc460b69848cfc160d358b25a953
git fetch -q origin
echo "branch HEAD $(git rev-parse HEAD)"
for c in 332fcb1eb93f2b637e87e42103547598f5e28249 a755f816a1800280719ecabf060bd6b7ad271776 $BASE; do
  git merge-base --is-ancestor "$c" HEAD && echo "HEAD contains $c" || echo "HEAD does NOT contain $c"
done
echo "origin/main $(git rev-parse origin/main)"
echo "project tip $(git rev-parse origin/project/34ZZeq0e3IR65GVm2kAs7)"
git merge-base --is-ancestor origin/project/34ZZeq0e3IR65GVm2kAs7 origin/main && echo "project tip is in origin/main"
tree=$(git merge-tree --write-tree HEAD origin/main); echo "merge-tree HEAD origin/main: exit $? tree $tree"
echo "main commits since the verified base: $(git rev-list --count $BASE..origin/main)"
overlap=$(git diff --name-only $BASE origin/main | grep -F -x -f <(git diff --name-only $BASE HEAD) || true)
echo "this batch's files changed on main: ${overlap:-none}"
global=$(git diff --name-only $BASE origin/main -- src/web/src/components/ui src/web/src/lib/toast.tsx src/web/src/components/ToastViewport.tsx)
echo "ui/ components, Toast changed on main: ${global:-none}"
echo "index.css lines on main touching select/overlay/dialog rules: $(git diff $BASE origin/main -- src/web/src/index.css | grep -cE '^[-+].*(orbit-select|orbit-overlay|orbit-dialog|orbit-choice|ant-select|ant-modal)')"
echo "uncommitted: $(git status --porcelain | wc -l) paths"
