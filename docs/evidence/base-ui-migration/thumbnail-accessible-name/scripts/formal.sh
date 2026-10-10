#!/usr/bin/env bash
# formal.sh RUN: the before/after browser runs on the two trees make-trees.sh laid down, written to v1/RUN
# (P5.3's formal.sh, for this follow-up):
#  - the P0 page matrix: the reference writes its screenshots, the delivery is compared against them at 0 pixels
#    (strict), and the delivery writes its own set (compared file by file in analyze.sh);
#  - the P5.2 states (p52.browser.mjs, the viewer cases) on both trees;
#  - the P5.3 attachments case (p53.browser.mjs `attachments`: the composer thumbnail pasted, hovered, opened, closed,
#    removed) on both trees: the one browser case that draws this thumbnail and records its name in its trace;
#  - the standard P0 regression on both trees;
#  - the component matrices overlays and choices (8 environments each) on the delivery.
# Every step runs alone, in its own network namespace and in a memory-capped scope with a raised OOM score (the runner is
# OOMPolicy=stop); TMPDIR and every output are on /mnt/data. A step whose log ends with `exit=` is skipped, so the chain
# resumes where a stop left it. Before each step: / must keep 2 GB (stop and report below that).
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
  grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped|did not run)|Test Files|Tests |^exit=|error TS" "$R/$name.txt"
}
for t in $REF $DEL; do cp $DEL/docs/evidence/base-ui-migration/p3.2/p32-reference.config.mjs $t/src/web/ui-migration/; done
step p0-ref $REF env P32_SNAPSHOTS=$R/p0-ref-shots P32_OUTPUT=$R/p0-ref-out P32_PORT=4173 npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=all
step p0-strict $DEL env P32_SNAPSHOTS=$R/p0-ref-shots P32_OUTPUT=$R/p0-strict-out P32_PORT=4173 npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=none
step p0-del $DEL env P32_SNAPSHOTS=$R/p0-del-shots P32_OUTPUT=$R/p0-del-out P32_PORT=4173 npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=all
rm -f $REF/src/web/ui-migration/p32-reference.config.mjs $DEL/src/web/ui-migration/p32-reference.config.mjs
step p52-ref $REF env P52_SNAPSHOTS=$R/p52-ref-shots P52_OUTPUT=$R/p52-ref-out npx playwright test --config ui-migration/p52.config.mjs --update-snapshots=all
step p52-del $DEL env P52_SNAPSHOTS=$R/p52-del-shots P52_OUTPUT=$R/p52-del-out npx playwright test --config ui-migration/p52.config.mjs --update-snapshots=all
step p53att-ref $REF env P53_SNAPSHOTS=$R/p53att-ref-shots P53_OUTPUT=$R/p53att-ref-out npx playwright test --config ui-migration/p53.config.mjs -g attachments --update-snapshots=all
step p53att-del $DEL env P53_SNAPSHOTS=$R/p53att-del-shots P53_OUTPUT=$R/p53att-del-out npx playwright test --config ui-migration/p53.config.mjs -g attachments --update-snapshots=all
step p0-standard $DEL npx playwright test --config ui-migration/playwright.config.mjs
mkdir -p $R/p0-standard-out && cp -a $DEL/src/web/.ui-migration-results/. $R/p0-standard-out/
step p0-standard-base $REF npx playwright test --config ui-migration/playwright.config.mjs
mkdir -p $R/p0-standard-base-out && cp -a $REF/src/web/.ui-migration-results/. $R/p0-standard-base-out/
step overlays $DEL npx playwright test --config ui-migration/overlays.config.mjs
mkdir -p $R/overlays-out && cp -a $DEL/src/web/.overlays-results/. $R/overlays-out/
step choices $DEL npx playwright test --config ui-migration/choices.config.mjs
mkdir -p $R/choices-out && cp -a $DEL/src/web/.choices-results/. $R/choices-out/
echo "== done $(date -u +%T)"
