#!/usr/bin/env bash
# swift-check.sh COMMIT...: OrbitKit's full swift test (the docker command of main's ci.yml "Swift core") on each
# commit, from a `git archive` copy on /mnt/data (the task worktree is not touched) with the build directory there
# too. Prints each run's totals and its `: error:` lines; full logs under v1/swift/<commit>.txt.
set -u
V=/mnt/data/tmp/34Za39GvWRQ08ZmKOpFNe/v1
WT=/root/.orbit/worktrees/8682ce7d-8166-5c60-8bec-942544612de2
S=/mnt/data/tmp/34Za39GvWRQ08ZmKOpFNe/swift
mkdir -p "$V/swift" "$S/build"
status=0
for commit in "$@"; do
  sha=$(git -C "$WT" rev-parse --short=9 "$commit")
  src=$S/src-$sha
  [ -d "$src" ] || { mkdir -p "$src" && git -C "$WT" archive "$sha" | tar -x -C "$src"; }
  nice -n 5 docker run --rm -v "$src":/repo -v "$S/build":/build -w /repo/src/macos/OrbitKit swift:6.1 \
    swift test --scratch-path /build/del > "$V/swift/$sha.txt" 2>&1
  code=$?
  echo "== $sha exit=$code: $(grep -E 'Executed [0-9]+ tests' "$V/swift/$sha.txt" | tail -1 | sed 's/^[[:space:]]*//')"
  grep ': error:' "$V/swift/$sha.txt" | sed 's#^/repo/##'
  [ $code -eq 0 ] || status=1
done
exit $status
