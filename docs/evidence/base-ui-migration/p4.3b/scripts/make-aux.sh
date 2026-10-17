#!/usr/bin/env bash
# make-aux.sh NAME COMMIT [CHERRY]: a sparse scratch tree (src/web, src/shared) at COMMIT under try/aux-NAME, with
# CHERRY cherry-picked on top when given (a modify/delete conflict on a file the base lacks keeps it deleted),
# node_modules from this task's worktree. For the supplementary checks the coordinator asked for on 2026-10-09
# (bundle per resource, lazy styles, the stylesheet test's negative controls), so the formal trees stay untouched.
# Sparse like make-trees.sh's ref tree, with the P0 evidence the Playwright setup verifies.
set -euo pipefail
name=$1; commit=$2; cherry=${3:-}
V=/mnt/data/tmp/34blYpxEcHMAf4oafuC2W
WT=/root/.orbit/worktrees/ba9b2bbb-b78b-5991-855c-183de0d5d9e3
T=$V/try/aux-$name
if [ -d "$T" ]; then git -C "$WT" worktree remove --force "$T"; fi
git -C "$WT" worktree add --no-checkout --detach "$T" "$commit" > /dev/null
EVIDENCE=(/docs/evidence/base-ui-migration/p0.2/ /docs/evidence/base-ui-migration/p0-drift/ /docs/evidence/base-ui-migration/p3.2/README.md
  /docs/evidence/base-ui-migration/p4.1/README.md /docs/evidence/base-ui-migration/p2.3-b1/README.md
  /docs/evidence/base-ui-migration/p0-drift-2/isolation/profile-validation-b1-fix.json
  /docs/evidence/base-ui-migration/webkit-scroll-lock/README.md)
git -C "$T" sparse-checkout set --no-cone '/*' '!/*/' '/src/' '!/src/*/' '/src/web/' '/src/shared/' '/scripts/worktree-overlay.sh' \
  '/docs/evidence/base-ui-migration/p0.2/environment.json' "${EVIDENCE[@]}"
git -C "$T" checkout -q --detach "$commit"
if [ -n "$cherry" ]; then
  if ! git -C "$T" -c user.name=p4.3b-aux -c user.email=p4.3b@aux.local cherry-pick --no-edit "$cherry" > /dev/null 2>&1; then
    for f in $(git -C "$T" diff --name-only --diff-filter=U); do
      if git -C "$T" cat-file -e "HEAD:$f" 2>/dev/null; then echo "conflict in $f"; exit 1; fi
      git -C "$T" rm -q "$f"; echo "kept deleted: $f"
    done
    git -C "$T" -c user.name=p4.3b-aux -c user.email=p4.3b@aux.local -c core.editor=true cherry-pick --continue > /dev/null
  fi
fi
ln -sfn "$WT/node_modules" "$T/node_modules"
mkdir -p "$T/src/web/node_modules"
cp -a "$WT/src/web/node_modules/@orbit" "$WT/src/web/node_modules/@types" "$T/src/web/node_modules/"
echo "aux-$name HEAD $(git -C "$T" rev-parse HEAD)$( [ -n "$cherry" ] && echo " = $commit + $cherry")"
