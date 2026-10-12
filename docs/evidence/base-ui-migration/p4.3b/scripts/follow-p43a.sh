#!/usr/bin/env bash
# follow-p43a.sh TREE ONTO UPSTREAM HEAD: rebase P4.3b (UPSTREAM..HEAD) onto ONTO in TREE, resolving the conflicts with
# P4.3a by resolve-p43a.py at every stop. Commits whose patch is already upstream (the P4.3a commits this branch carries)
# drop out. Stops, leaving the rebase in progress, at a conflict the resolver does not recognise. rerere is on, so a
# conflict resolved by hand once replays on its own the next time.
set -u
tree=$1; onto=$2; upstream=$3; head=$4
S=/mnt/data/tmp/34blYpxEcHMAf4oafuC2W/scripts
cd "$tree" || exit 2
G() { git -c user.name=coordinator -c user.email=coord@orbit -c rerere.enabled=true -c rerere.autoUpdate=true "$@"; }
G checkout -q --detach "$head" || exit 2
G rebase --onto "$onto" "$upstream" > /tmp/follow-p43a.log 2>&1
while [ -d .git/rebase-merge ] || [ -d "$(git rev-parse --git-path rebase-merge)" ]; do
  stopped=$(git rev-parse --short "$(cat "$(git rev-parse --git-path rebase-merge)/stopped-sha" 2>/dev/null || echo HEAD)")
  files=$(git diff --name-only --diff-filter=U)
  if [ -n "$files" ]; then
    echo "== stop at $stopped: $(echo $files | tr '\n' ' ')"
    # rerere may already have resolved some; the resolver handles the P4.3a hunks it knows.
    python3 -I "$S/resolve-p43a.py" $files || { echo "== unresolved at $stopped; rebase left in progress"; exit 1; }
    git add $files
  fi
  GIT_EDITOR=true G rebase --continue >> /tmp/follow-p43a.log 2>&1 || true
done
echo "== done: $(git rev-parse --short HEAD) ($(git log --oneline "$onto"..HEAD | wc -l) commits on $(git rev-parse --short "$onto"))"
