#!/usr/bin/env bash
# small.sh: the light checks after the browser suites, one after another, each logged to runs/<name>.txt:
#  - unit-red-base / unit-green-fix: the unit test TaskListView.toolbarHeight.test.tsx on the base (copied in, removed
#    after: red expected) and on the delivery (green expected);
#  - swift-tasklist: OrbitKit's TaskListCopyParityTests (the Swift test that reads TaskListView.tsx) on the delivery, in
#    swift:6.1 with a memory cap, from a git archive copy with its own build directory;
#  - scrollbar-room: exp/scrollbar-room.mjs (which scrollbars take room, WebKit bug 310940's case).
set -u
WT=/root/.orbit/worktrees/cc35355c-dd74-5ffe-b8f0-f16dd56d0d48
T=/mnt/data/tmp/34coPBqt8gi229cVNds0E
R=$T/runs
export TMPDIR=$T/tmp
begin_() { { echo "argv: $*"; echo "load: $(cat /proc/loadavg)"; echo "memory: $(free -m | awk '/Mem:/ {print $7 " MB available"}')"; echo "started: $(date -u +%FT%TZ)"; echo; }; }
tail_() { { echo "exit=$1"; echo "ended: $(date -u +%FT%TZ)"; }; }
test=src/pages/TaskListView.toolbarHeight.test.tsx
if ! grep -q '^exit=' $R/unit-red-base.txt 2>/dev/null; then
  cp "$WT/src/web/$test" "$T/base/src/web/$test"
  { begin_ "base $(git -C $T/base rev-parse HEAD) + $test copied in: npx vitest run $test"
    (cd $T/base/src/web && "$T/scripts/scoped.sh" npx vitest run $test); tail_ $?; } > $R/unit-red-base.txt 2>&1
  rm -f "$T/base/src/web/$test"
  echo "== unit-red-base: $(grep -E 'Tests |^exit=' $R/unit-red-base.txt | tr -s ' ' | tr '\n' ' ')"
fi
if ! grep -q '^exit=' $R/unit-green-fix.txt 2>/dev/null; then
  { begin_ "delivery $(git -C $T/fix rev-parse HEAD): npx vitest run $test"
    (cd $T/fix/src/web && "$T/scripts/scoped.sh" npx vitest run $test); tail_ $?; } > $R/unit-green-fix.txt 2>&1
  echo "== unit-green-fix: $(grep -E 'Tests |^exit=' $R/unit-green-fix.txt | tr -s ' ' | tr '\n' ' ')"
fi
if ! grep -q '^exit=' $R/swift-tasklist.txt 2>/dev/null; then
  src=$T/swift/src-$(git -C $T/fix rev-parse --short=9 HEAD)
  [ -d "$src" ] || { mkdir -p "$src" "$T/swift/build" && git -C $T/fix archive HEAD | tar -x -C "$src"; }
  { begin_ "delivery $(git -C $T/fix rev-parse HEAD) (git archive): docker swift:6.1 swift test --filter TaskListCopyParityTests"
    nice -n 5 docker run --rm --memory=4g -v "$src":/repo -v "$T/swift/build":/build -w /repo/src/macos/OrbitKit swift:6.1 \
      swift test --scratch-path /build/del --filter TaskListCopyParityTests; tail_ $?; } > $R/swift-tasklist.txt 2>&1
  echo "== swift-tasklist: $(grep -E 'Executed [0-9]+ test|^exit=' $R/swift-tasklist.txt | tail -2 | tr -s ' ' | tr '\n' ' ')"
fi
if ! grep -q '^exit=' $T/exp/scrollbar-room.txt 2>/dev/null; then
  cp $T/exp/scrollbar-room.mjs $T/fix/src/web/scrollbar-room.tmp.mjs
  { begin_ "node exp/scrollbar-room.mjs (from the delivery's src/web)"; (cd $T/fix/src/web && node scrollbar-room.tmp.mjs); tail_ $?; } > $T/exp/scrollbar-room.txt 2>&1
  rm -f $T/fix/src/web/scrollbar-room.tmp.mjs
  echo "== scrollbar-room: $(grep -c 'outer width' $T/exp/scrollbar-room.txt) lines"
fi
