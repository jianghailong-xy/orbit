#!/usr/bin/env bash
# swift-check.sh [--filter X] COMMIT...: OrbitKit's swift test (the docker command of main's ci.yml "Swift core") on
# each commit, from a `git archive` copy on /mnt/data (the task worktree is not touched), build directory there too,
# docker capped at 6 GB. Prints each run's totals and its `: error:` lines; full logs under v1/swift/<commit>[-filter].txt.
set -u
T=/mnt/data/tmp/34Za39J4QY3kDa5p2Wsau
V=$T/v1
WT=/root/.orbit/worktrees/a8fc02e5-256c-58d5-bafe-dbd063f08987
S=$T/swift
filter=(); tag=""
if [ "${1:-}" = "--filter" ]; then filter=(--filter "$2"); tag="-$2"; shift 2; fi
mkdir -p "$V/swift" "$S/build"
status=0
for commit in "$@"; do
  sha=$(git -C "$WT" rev-parse --short=9 "$commit")
  src=$S/src-$sha
  [ -d "$src" ] || { mkdir -p "$src" && git -C "$WT" archive "$sha" | tar -x -C "$src"; }
  echo "== $sha start $(date -u +%T) mem: $(free -m | awk '/Mem:/{print $7}')M available"
  mkdir -p "$S/home" "$S/tmp"
  # HOME and /tmp on /mnt/data too: module caches stay off the container layer on /.
  nice -n 5 docker run --rm --memory=6g -v "$src":/repo -v "$S/build":/build -v "$S/home":/root -v "$S/tmp":/tmp -w /repo/src/macos/OrbitKit swift:6.1 \
    swift test --scratch-path /build/del "${filter[@]}" > "$V/swift/$sha$tag.txt" 2>&1
  code=$?
  echo "== $sha exit=$code: $(grep -E 'Executed [0-9]+ tests' "$V/swift/$sha$tag.txt" | tail -1 | sed 's/^[[:space:]]*//')"
  grep ': error:' "$V/swift/$sha$tag.txt" | sed 's#^/repo/##'
  [ $code -eq 0 ] || status=1
done
exit $status
