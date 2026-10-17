#!/usr/bin/env bash
# chain.sh RUN: the round's steps one after another — formal.sh RUN, then the merge check on the task worktree (NVMe,
# the project's rule), then OrbitKit in the swift:6.1 image on the delivery checkout (v1/del, on /mnt/data, its build
# scratch there too). Each prints the commit it ran on. Logs: v1/formal-RUN.log, v1/merge-check-RUN.log, v1/swift-RUN.log.
set -u
RUN=${1:?run name}
T=/mnt/data/tmp/34Za39Ov1yysHZaYL6wgJ
V=$T/v1
WT=/root/.orbit/worktrees/4071e471-3592-5308-a8bb-f597b81ac833
$T/scripts/formal.sh "$RUN" > "$V/formal-$RUN.log" 2>&1; echo "formal exit=$?"
{ echo "head: $(git -C $WT rev-parse HEAD)"; echo "status:"; git -C $WT status --short -- src; echo "mem: $(free -m | awk '/Mem:/{print $7}')M available, load $(cat /proc/loadavg)"
  cd $WT && systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
    sh -c 'npm run build -w @orbit/web && npm run test -w @orbit/web'; echo "exit=$?"; } > "$V/merge-check-$RUN.log" 2>&1
grep -E "^exit=|Test Files|Tests " "$V/merge-check-$RUN.log"
{ echo "head: $(git -C $V/del rev-parse HEAD)"; echo "mem: $(free -m | awk '/Mem:/{print $7}')M available, load $(cat /proc/loadavg)"
  docker run --rm --memory=4g --memory-swap=6g --oom-score-adj=1000 -v $V/del:/repo -w /repo/src/macos/OrbitKit swift:6.1 swift test -j 4 --scratch-path /repo/.swift-build; echo "exit=$?"; } > "$V/swift-$RUN.log" 2>&1
grep -E "^exit=|Executed [0-9]+ tests" "$V/swift-$RUN.log" | tail -3
