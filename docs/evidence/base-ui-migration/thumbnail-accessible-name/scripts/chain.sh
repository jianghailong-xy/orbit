#!/usr/bin/env bash
# chain.sh RUN: the round's steps one after another (P5.3's chain.sh, for this follow-up):
#  1. formal.sh RUN (the browser runs on both trees);
#  2. names-both.sh (the thumbnails' names in both trees' builds, Chromium and WebKit);
#  3. red-green.sh (the fix's unit tests on the source before the fix, then on the delivery);
#  4. the merge check on the task worktree (NVMe, the project's rule);
#  5. OrbitKit in the swift:6.1 image on the delivery checkout (v1/del, on /mnt/data, its build scratch there too):
#     OrbitKit's parity tests read WorkspaceView.tsx, which the fix changes.
# Each prints the commit it ran on. Logs: v1/formal-RUN.log, v1/RUN/names/, v1/unit/, v1/merge-check-RUN.log,
# v1/swift-RUN.log.
set -u
RUN=${1:?run name}
T=/mnt/data/tmp/34dTUqxH5MjymjtUhs5C5
V=$T/v1
WT=/root/.orbit/worktrees/815e244b-5a5b-5984-96fb-3b42c31b28ff
$T/scripts/formal.sh "$RUN" > "$V/formal-$RUN.log" 2>&1; echo "formal exit=$?"
$T/scripts/names-both.sh "$V/$RUN/names"; echo "names exit=$?"
$T/scripts/red-green.sh; echo "red-green exit=$?"
{ echo "head: $(git -C $WT rev-parse HEAD)"; echo "status:"; git -C $WT status --short -- src; echo "mem: $(free -m | awk '/Mem:/{print $7}')M available, load $(cat /proc/loadavg)"
  cd $WT && systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
    sh -c 'npm run build -w @orbit/web && npm run test -w @orbit/web'; echo "exit=$?"; } > "$V/merge-check-$RUN.log" 2>&1
grep -E "^exit=|Test Files|Tests " "$V/merge-check-$RUN.log"
{ echo "head: $(git -C $V/del rev-parse HEAD)"; echo "mem: $(free -m | awk '/Mem:/{print $7}')M available, load $(cat /proc/loadavg)"
  docker run --rm --memory=4g --memory-swap=6g --oom-score-adj=1000 -v $V/del:/repo -w /repo/src/macos/OrbitKit swift:6.1 swift test -j 4 --scratch-path /repo/.swift-build; echo "exit=$?"; } > "$V/swift-$RUN.log" 2>&1
grep -E "^exit=|Executed [0-9]+ tests" "$V/swift-$RUN.log" | tail -3
