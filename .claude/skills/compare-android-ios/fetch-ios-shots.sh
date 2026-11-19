#!/usr/bin/env bash
# Fetch the Mac's hand-back branch into DEST and delete the branch from origin (it is throwaway; never merge it).
#   fetch-ios-shots.sh BRANCH DEST
set -euo pipefail
branch="${1:?branch}"; dest="${2:?destination dir}"
mkdir -p "$dest"
git fetch -q origin "$branch"
for f in $(git ls-tree -r --name-only FETCH_HEAD -- ios-shots); do
  git show "FETCH_HEAD:$f" > "$dest/$(basename "$f")"
  echo "$dest/$(basename "$f")"
done
git push -q origin --delete "$branch" && echo "deleted origin/$branch"
