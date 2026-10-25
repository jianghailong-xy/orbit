#!/usr/bin/env bash
# make-trees.sh: the two checkouts of the same-commit originals, on /mnt/data (the project's disk rule):
#  - before-8f94ddda9: P5.3's same-commit reference 8f94ddda9 = its delivery b72da6eda with only the business switch
#    c868a02c2 reverted (P5.3's local commit, never pushed; still in the shared object store);
#  - after-b72da6eda: P5.3's delivery b72da6eda (landed on the project line by a167c2ff0, whose src/ is identical).
# Sparse like P5.3's make-trees.sh: root files, src/web, src/shared and the P0 evidence the globalSetup verifies.
# node_modules is this task's worktree install (same lockfile f03a6e323 on all three commits).
set -euo pipefail
B=/mnt/data/tmp/34dTUdzY6mgNk4CGh7ZHl
WT=/root/.orbit/worktrees/987049ab-c5e9-5a28-9ec0-0e4db66893c8
EVIDENCE=(/docs/evidence/base-ui-migration/p0.2/ /docs/evidence/base-ui-migration/p0-drift/ /docs/evidence/base-ui-migration/p3.2/README.md
  /docs/evidence/base-ui-migration/p4.1/README.md /docs/evidence/base-ui-migration/p2.3-b1/README.md
  /docs/evidence/base-ui-migration/p0-drift-2/isolation/profile-validation-b1-fix.json
  /docs/evidence/base-ui-migration/webkit-scroll-lock/README.md /docs/evidence/base-ui-migration/p5.3/README.md)
link_modules() {
  local tree=$1
  ln -sfn "$WT/node_modules" "$tree/node_modules"
  mkdir -p "$tree/src/web/node_modules"
  cp -a "$WT/src/web/node_modules/@orbit" "$WT/src/web/node_modules/@types" "$tree/src/web/node_modules/" 2>/dev/null || true
}
sparse_tree() {
  local tree=$1 commit=$2
  [ -d "$tree" ] || git -C "$WT" worktree add --no-checkout --detach "$tree" "$commit" > /dev/null
  git -C "$tree" sparse-checkout set --no-cone '/*' '!/*/' '/src/' '!/src/*/' '/src/web/' '/src/shared/' '/scripts/worktree-overlay.sh' "${EVIDENCE[@]}"
  git -C "$tree" checkout -q --detach "$commit"
  link_modules "$tree"
  echo "$tree HEAD $(git -C "$tree" rev-parse HEAD) tree $(git -C "$tree" rev-parse HEAD^{tree}) status [$(git -C "$tree" status --porcelain --untracked-files=no | wc -l)]"
}
sparse_tree "$B/trees/before-8f94ddda9" 8f94ddda9069bc2301fefc87f276570b04f4c774
sparse_tree "$B/trees/after-b72da6eda" b72da6eda7656645c343e97bc73111c1499fab32
