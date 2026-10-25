#!/bin/bash
# Inside the D10 test host (D9's script): make or move a deployment's checkout /work/<dir> to a branch of /repo.git, as an operator's
# `git checkout` before /upgrade does. docs/evidence stays out of the working tree.
#   checkout.sh <dir> <branch>
set -euo pipefail
DIR="/work/$1"; BRANCH="$2"
if [ ! -d "$DIR/.git" ]; then
  git init -q "$DIR"
  git -C "$DIR" remote add origin /repo.git
  git -C "$DIR" sparse-checkout set --no-cone '/*' '!/docs/evidence/'
fi
cd "$DIR"
git fetch -q origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
git -c advice.detachedHead=false checkout -q -B "$BRANCH" "origin/$BRANCH"
echo "checkout $DIR: $(git rev-parse HEAD) on $(git symbolic-ref --short HEAD); git status --porcelain: $(git status --porcelain | wc -l) lines"
