#!/usr/bin/env bash
# proof.sh: the checks run just before the evidence was submitted, printed for the record. The delivered tip is a
# --no-ff merge of the task's last commit onto the project tip (first parent the tip, second the task). It prints: the
# merge's parents and that it holds the two product commits on the base they were verified on; what the merge adds to
# the project tip (this batch's files); where origin/main and the project tip are; dry-run merges with the latest
# origin/main, of the delivery and of the project tip alone (a conflict both share is the line's, not this batch's);
# whether main's new commits touch this batch's files or the global layer it depends on.
set -u
cd "$(git rev-parse --show-toplevel)"
BASE=9e9787f7969edc460b69848cfc160d358b25a953
TIP=origin/project/34ZZeq0e3IR65GVm2kAs7
git fetch -q origin
echo "branch HEAD $(git rev-parse HEAD), parents: $(git log -1 --format=%P HEAD)"
for c in 332fcb1eb93f2b637e87e42103547598f5e28249 a755f816a1800280719ecabf060bd6b7ad271776 $BASE; do
  git merge-base --is-ancestor "$c" HEAD && echo "HEAD contains $c" || echo "HEAD does NOT contain $c"
done
echo "project tip $(git rev-parse $TIP); HEAD's first parent is it: $([ "$(git rev-parse HEAD^1)" = "$(git rev-parse $TIP)" ] && echo yes || echo no)"
echo "merges since the project tip: $(git rev-list --merges $TIP..HEAD | tr '\n' ' ')"
batch=$(git diff --name-only $TIP HEAD)
echo "what the delivery adds to the project tip: $(echo "$batch" | grep -c .) files, $(echo "$batch" | grep -vc '^docs/evidence/base-ui-migration/select-first-option/') outside this batch's evidence directory:"
echo "$batch" | grep -v '^docs/evidence/base-ui-migration/select-first-option/' | sed 's/^/  /'
echo "origin/main $(git rev-parse origin/main) ($(git rev-list --count $BASE..origin/main) commits since the verified base)"
git merge-base --is-ancestor $TIP origin/main && echo "project tip is in origin/main" || echo "project tip is not in origin/main"
tree=$(git merge-tree --write-tree --name-only HEAD origin/main); echo "merge-tree HEAD origin/main: exit $? $(echo "$tree" | sed -n '2,9p' | tr '\n' ' ')"
tree=$(git merge-tree --write-tree --name-only $TIP origin/main); echo "merge-tree project tip origin/main (without this batch): exit $? $(echo "$tree" | sed -n '2,9p' | tr '\n' ' ')"
overlap=$(git diff --name-only $(git merge-base $TIP origin/main) origin/main | grep -F -x -f <(echo "$batch") || true)
echo "this batch's files changed on main: ${overlap:-none}"
global=$(git diff --name-only $(git merge-base $TIP origin/main) origin/main -- src/web/src/components/ui src/web/src/lib/toast.tsx src/web/src/components/ToastViewport.tsx)
echo "ui/ components, Toast changed on main: ${global:-none}"
echo "uncommitted: $(git status --porcelain | wc -l) paths"
