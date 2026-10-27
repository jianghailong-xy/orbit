#!/usr/bin/env bash
# A prototype tree: HEAD's web + shared, node_modules hard-linked from the worktree (same fs),
# git-initialised so `git diff` is the board's prototype.patch.
set -euo pipefail
WT=/root/.orbit/worktrees/01a17c4a-2917-730f-b47a-4da0f9b5cd27
P=${1:?usage: setup-proto.sh <dir>}
[ -e "$P" ] && { echo "exists: $P"; exit 1; }
mkdir -p "$P"
git -C "$WT" archive HEAD package.json package-lock.json tsconfig.base.json src/web src/shared | tar -x -C "$P"
cp -al "$WT/node_modules" "$P/node_modules"
cp -al "$WT/src/web/node_modules" "$P/src/web/node_modules"
cp -r "$WT/src/shared/dist" "$P/src/shared/dist"
cd "$P"
printf 'node_modules/\ndist/\n' > .gitignore
git init -q && git add -A && git -c user.name=mock -c user.email=mock@local commit -qm base
echo "ready: $P"
