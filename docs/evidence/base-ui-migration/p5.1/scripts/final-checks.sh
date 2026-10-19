#!/usr/bin/env bash
# final-checks.sh COMMIT RUN: the checks P4.4 ran on its final commit, on this batch's final commit (the delivery plus
# p5.1/): the merge check (some of whose unit tests read files outside src/web), the apiserver's `npm test` (the
# specs that need no database; several read every tracked file, the evidence logs included) and OrbitKit's swift test.
# The delivery tree on /mnt/data is checked out at COMMIT; logs go to v1/RUN as formal.sh writes them (resumable).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
COMMIT=${1:?commit}; RUN=${2:?run name}
T=/mnt/data/tmp/34Za39L1H6V82d2sobzPY
V=$T/v1
R=$V/$RUN
DEL=$V/del
WT=/root/.orbit/worktrees/9f22d16e-3f30-5541-a5ef-91972ffc7911
export TMPDIR=$V/tmp
mkdir -p "$R" "$TMPDIR"
git -C "$DEL" checkout -q --detach "$COMMIT" || exit 1
[ -e "$DEL/src/apiserver/node_modules" ] || ln -s "$WT/src/apiserver/node_modules" "$DEL/src/apiserver/node_modules"
gate() {
  local a; a=$(df --output=avail -BM / | tail -1 | tr -dc '0-9')
  if [ "$a" -lt 2048 ]; then echo "== STOP: / has ${a}M available (< 2 GB) $(date -u +%T)"; exit 3; fi
}
step() {
  local name=$1 dir=$2; shift 2
  if [ -f "$R/$name.txt" ] && grep -q '^exit=' "$R/$name.txt"; then echo "== $name already done ($(grep '^exit=' "$R/$name.txt"))"; return 0; fi
  gate
  { echo "argv: $*"; echo "dir: $dir"; echo "head: $(git -C "$DEL" rev-parse HEAD)"; echo "uncommitted:"; git -C "$DEL" status --short | grep -v '^?? src/apiserver/node_modules$'
    echo "load: $(cat /proc/loadavg)"; echo "mem: $(free -m | awk '/Mem:/{print $7}')M available"
    echo "disk: / $(df --output=avail -BM / | tail -1 | tr -d ' ') available, TMPDIR $TMPDIR"; echo "started: $(date -u +%FT%TZ)"; echo; } > "$R/$name.txt"
  echo "== $name $(date -u +%T)"
  ( cd "$dir" && "$HERE/capped.sh" 6G nice -n -5 "$@" ) >> "$R/$name.txt" 2>&1
  local code=$?
  { echo "exit=$code"; echo "load: $(cat /proc/loadavg)"; echo "ended: $(date -u +%FT%TZ)"; } >> "$R/$name.txt"
  grep -E "Test Files|Tests |^# (tests|pass|fail)|^exit=|error TS" "$R/$name.txt" | tail -8
}
step merge "$DEL" bash -c 'npm run build -w @orbit/web && npm run test -w @orbit/web'
step apiserver "$DEL/src/apiserver" bash -c 'rm -rf build && npm test'
if [ -f "$R/swift.txt" ] && grep -q '^exit=' "$R/swift.txt"; then echo "== swift already done"; else
  { echo "argv: swift-check.sh $COMMIT"; echo "started: $(date -u +%FT%TZ)"; } > "$R/swift.txt"
  "$HERE/swift-check.sh" "$COMMIT" >> "$R/swift.txt" 2>&1; echo "exit=$?" >> "$R/swift.txt"; tail -3 "$R/swift.txt"
fi
echo "== done $(date -u +%T)"
