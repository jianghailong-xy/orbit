#!/usr/bin/env bash
# sync-fix.sh: copy the session worktree's changed and new files into the fix tree (both on the same base commit), and
# rebuild the fix tree's web bundle when anything under src/web/src changed.
set -eu
WT=/root/.orbit/worktrees/cc35355c-dd74-5ffe-b8f0-f16dd56d0d48
T=/mnt/data/tmp/34coPBqt8gi229cVNds0E
[ "$(git -C "$WT" rev-parse HEAD)" = "$(git -C "$T/fix" rev-parse HEAD)" ] || { echo "fix tree is on $(git -C "$T/fix" rev-parse HEAD), worktree on $(git -C "$WT" rev-parse HEAD)"; exit 1; }
changed=$( (git -C "$WT" diff --name-only HEAD; git -C "$WT" ls-files --others --exclude-standard) | sort -u)
rebuild=0
for f in $changed; do
  if [ -f "$WT/$f" ]; then
    if ! cmp -s "$WT/$f" "$T/fix/$f"; then mkdir -p "$(dirname "$T/fix/$f")"; cp "$WT/$f" "$T/fix/$f"; echo "synced $f"; case $f in src/web/src/*) rebuild=1;; esac; fi
  fi
done
if [ $rebuild = 1 ] || [ "${1:-}" = "--build" ]; then
  (cd "$T/fix/src/web" && TMPDIR=$T/tmp "$T/scripts/scoped.sh" npx vite build > "$T/logs/build-fix.log" 2>&1) && echo "fix rebuilt: $(tail -1 "$T/logs/build-fix.log")"
fi
