#!/bin/bash
# Make (or move) the test deployment's checkout, inside the D8 test host: /work/orbit, on its tmpfs.
#   checkout.sh <branch in /repo.git>
# Only the working tree lands on the tmpfs: the checkout's own `.git` (a directory, as the web image's build needs)
# reads every object from /repo.git through its alternates file, so a fetch from it copies nothing. `git clone
# --shared` would do this, but ignores --shared for a shallow source and copies everything. docs/evidence is left
# out of the working tree. A later call moves the same checkout to another branch, as an operator's `git checkout`
# before /upgrade does.
set -euo pipefail
BRANCH="$1"
if [ ! -d /work/orbit/.git ]; then
  git init -q /work/orbit
  echo /repo.git/objects >/work/orbit/.git/objects/info/alternates
  git -C /work/orbit remote add origin /repo.git
  git -C /work/orbit sparse-checkout set --no-cone '/*' '!/docs/evidence/'
fi
cd /work/orbit
cp /repo.git/shallow .git/shallow
git fetch -q origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
git checkout -q -B "$BRANCH" "origin/$BRANCH"
echo "checkout: $(git rev-parse HEAD) on $(git symbolic-ref --short HEAD); git status --porcelain: $(git status --porcelain | wc -l) lines"
du -sh /work/orbit/.git /work/orbit | sed 's/^/  /'
df -h /work | tail -1
