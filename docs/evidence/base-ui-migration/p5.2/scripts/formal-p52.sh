#!/usr/bin/env bash
# formal-p52.sh RUN: formal.sh with only the P5.2 pair (the P0 steps of the same round stay those of the run they were made in).
# written to v1/RUN (P4.4's formal.sh, for P5.2):
#  - the P5.2 states on the reference and on the delivery (8 environments each);
#  - the P0 page matrix (reference, a 0-pixel comparison of the delivery against it, delivery);
#  - the standard P0 regression on the delivery and on the base.
# The merge check runs on the task worktree (NVMe), not here (the project's rule since 2026-10-09).
# Every step runs alone, in its own network namespace and in a memory-capped scope with a raised OOM score (the runner
# is OOMPolicy=stop); TMPDIR and every output are on /mnt/data. A step whose log ends with `exit=` is skipped, so the
# chain resumes where a stop left it. Before each step: / must keep 2 GB (stop and report below that).
set -u
RUN=${1:?run name}
T=/mnt/data/tmp/34Za39Mm04q5p66pqUTtj
V=$T/v1
R=$V/$RUN
REF=$V/ref
BASE=$V/base
DEL=$V/del
export TMPDIR=$V/tmp
mkdir -p "$R" "$TMPDIR"
gate() {
  local a; a=$(df --output=avail -BM / | tail -1 | tr -dc '0-9')
  if [ "$a" -lt 2048 ]; then echo "== STOP: / has ${a}M available (< 2 GB) $(date -u +%T)"; exit 3; fi
}
step() {
  local name=$1 tree=$2; shift 2
  if [ -f "$R/$name.txt" ] && grep -q '^exit=' "$R/$name.txt"; then echo "== $name already done ($(grep '^exit=' "$R/$name.txt"))"; return 0; fi
  gate
  { echo "argv: $*"; echo "tree: $tree"; echo "head: $(git -C $tree rev-parse HEAD)"; echo "uncommitted:"; git -C $tree status --short -- src/web
    echo "load: $(cat /proc/loadavg)"; echo "mem: $(free -m | awk '/Mem:/{print $7}')M available"
    echo "disk: / $(df --output=avail -BM / | tail -1 | tr -d ' ') available, TMPDIR $TMPDIR"; echo "started: $(date -u +%FT%TZ)"; echo; } > "$R/$name.txt"
  echo "== $name $(date -u +%T)"
  ( cd "$tree/src/web" && systemd-run --scope --quiet -p MemoryMax=6G sh -c 'echo 500 > /proc/self/oom_score_adj && exec "$@"' sh \
      nice -n -5 unshare -n bash -c 'ip link set lo up && exec "$@"' bash "$@" ) >> "$R/$name.txt" 2>&1
  local code=$?
  { echo "exit=$code"; echo "load: $(cat /proc/loadavg)"; echo "ended: $(date -u +%FT%TZ)"; } >> "$R/$name.txt"
  grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped|did not run)|Test Files|Tests |^exit=|error TS" "$R/$name.txt"
}
step p52-ref $REF env P52_SNAPSHOTS=$R/p52-ref-shots P52_OUTPUT=$R/p52-ref-out npx playwright test --config ui-migration/p52.config.mjs --update-snapshots=all
step p52-del $DEL env P52_SNAPSHOTS=$R/p52-del-shots P52_OUTPUT=$R/p52-del-out npx playwright test --config ui-migration/p52.config.mjs --update-snapshots=all









echo "== done $(date -u +%T)"
