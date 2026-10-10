#!/usr/bin/env bash
# noise.sh RUN: a second run of the P0 page matrix and of the P5.2 states on each tree, into v1/RUN beside the first
# (p0-ref2, p0-del2, p52-ref2, p52-del2), with formal.sh's step rules. Round RUN's first pass leaves a handful of
# screenshots that differ between the trees at antialias level or by the P5.2 case's known 3px scroll settle; neither
# the P0 nor the P5.2 scenes draw a picture staged in the composer, the only DOM the fix changes. The second pass
# measures what two runs of one tree differ by, and which variants of each screenshot each tree draws (analyze-noise.py).
set -u
RUN=${1:?run name}
T=/mnt/data/tmp/34dTUqxH5MjymjtUhs5C5
V=$T/v1
R=$V/$RUN
REF=$V/ref
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
  grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped|did not run)|^exit=" "$R/$name.txt"
}
for t in $REF $DEL; do cp $DEL/docs/evidence/base-ui-migration/p3.2/p32-reference.config.mjs $t/src/web/ui-migration/; done
step p0-ref2 $REF env P32_SNAPSHOTS=$R/p0-ref2-shots P32_OUTPUT=$R/p0-ref2-out P32_PORT=4173 npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=all
step p0-del2 $DEL env P32_SNAPSHOTS=$R/p0-del2-shots P32_OUTPUT=$R/p0-del2-out P32_PORT=4173 npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=all
rm -f $REF/src/web/ui-migration/p32-reference.config.mjs $DEL/src/web/ui-migration/p32-reference.config.mjs
step p52-ref2 $REF env P52_SNAPSHOTS=$R/p52-ref2-shots P52_OUTPUT=$R/p52-ref2-out npx playwright test --config ui-migration/p52.config.mjs --update-snapshots=all
step p52-del2 $DEL env P52_SNAPSHOTS=$R/p52-del2-shots P52_OUTPUT=$R/p52-del2-out npx playwright test --config ui-migration/p52.config.mjs --update-snapshots=all
echo "== done $(date -u +%T)"
