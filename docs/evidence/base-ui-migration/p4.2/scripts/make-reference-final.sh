#!/usr/bin/env bash
# make-reference-final.sh TIP SWITCH: the inventory closure's reference at the final tip -- TIP (the branch with
# the latest origin/main merged in) with only the page-switch commit SWITCH reverted, committed locally, never
# pushed. Sparse (src/web, src/shared): only the AntD audit runs in it, nothing is built.
set -euo pipefail
tip=$1; switch=$2
V=/mnt/data/tmp/34Za39Feocgj42rrBYwzl/v2
DEL=/root/.orbit/worktrees/2a435fb0-2ac5-5226-839d-0b1389da291c
tree=$V/ref-final
[ -d "$tree" ] || git -C "$DEL" worktree add --no-checkout --detach "$tree" "$tip" > /dev/null
git -C "$tree" sparse-checkout set --no-cone '/*' '!/*/' '/src/' '!/src/*/' '/src/web/' '/src/shared/'
git -C "$tree" checkout -q --detach "$tip"
ln -sfn "$DEL/node_modules" "$tree/node_modules"
git -C "$tree" -c user.name=p4.2-reference -c user.email=p4.2@reference.local revert --no-edit "$switch" > /dev/null
echo "reference HEAD $(git -C "$tree" rev-parse HEAD) = revert of $switch on $tip"
