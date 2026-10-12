#!/usr/bin/env bash
# Builds every first-parent commit of the project line since P0.2 that the attribution did not run
# (no change to Web build inputs outside tests/docs) and records whether its production dist is
# byte-identical to the dist of its first parent's build. Output: dist-check.txt.
set -uo pipefail
REPO=/root/.orbit/worktrees/e65f238b-4789-5587-b24a-cf2d708322d1
B=/var/tmp/p0drift
OUT=$B/dist-check.txt
: > "$OUT"
digest() { sha256sum < "$B/dists/$1.sha256" | cut -c1-64; }
for c in $(git -C "$REPO" rev-list --first-parent --reverse f4d47e853..da13423d3); do
  s=$(git -C "$REPO" rev-parse --short=9 "$c"); p=$(git -C "$REPO" rev-parse --short=9 "$c^1")
  for x in "$p" "$s"; do
    if [ ! -f "$B/dists/$x.sha256" ]; then
      "$B/scripts/prepare-tree.sh" "$x" > /dev/null && git -C "$REPO" worktree remove --force "$B/trees/$x"
    fi
  done
  if [ "$(digest "$p")" = "$(digest "$s")" ]; then same=identical; else same=changed; fi
  echo "$s parent=$p dist=$(digest "$s" | cut -c1-16) vs-parent=$same $(git -C "$REPO" log -1 --format=%s "$c" | cut -c1-70)" >> "$OUT"
done
cat "$OUT"
