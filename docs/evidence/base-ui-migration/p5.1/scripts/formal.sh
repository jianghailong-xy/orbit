#!/usr/bin/env bash
# formal.sh RUN: P5.1's same-commit comparison and final checks on the three trees make-trees.sh laid down, written to
# v1/RUN (P4.4's formal.sh, for P5.1):
#  - the P5.1 states on the reference and on the delivery (8 environments each);
#  - the P0 page matrix (reference, a 0-pixel comparison of the delivery against it, delivery);
#  - the standard P0 regression on the delivery and on the base;
#  - the merge check (npm run build -w @orbit/web && npm run test -w @orbit/web) on the delivery's full checkout;
#  - the overlays, controls and choices matrices on the delivery (choices one environment per step).
# Every step runs alone, in its own network namespace and in a memory-capped scope with a raised OOM score (the runner
# is OOMPolicy=stop); TMPDIR and every output are on /mnt/data. A step whose log ends with `exit=` is skipped, so the
# chain resumes where a stop left it. Before each step: / must keep 2 GB (stop and report below that).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
RUN=${1:?run name}
T=/mnt/data/tmp/34Za39L1H6V82d2sobzPY
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
  ( cd "$tree/src/web" && "$HERE/capped.sh" 6G nice -n -5 unshare -n bash -c 'ip link set lo up && exec "$@"' bash "$@" ) >> "$R/$name.txt" 2>&1
  local code=$?
  { echo "exit=$code"; echo "load: $(cat /proc/loadavg)"; echo "ended: $(date -u +%FT%TZ)"; } >> "$R/$name.txt"
  grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped|did not run)|Test Files|Tests |^exit=|error TS" "$R/$name.txt"
}
step p51-ref $REF env P51_SNAPSHOTS=$R/p51-ref-shots P51_OUTPUT=$R/p51-ref-out npx playwright test --config ui-migration/p51.config.mjs --update-snapshots=all
step p51-del $DEL env P51_SNAPSHOTS=$R/p51-del-shots P51_OUTPUT=$R/p51-del-out npx playwright test --config ui-migration/p51.config.mjs --update-snapshots=all
for t in $REF $DEL; do cp $DEL/docs/evidence/base-ui-migration/p3.2/p32-reference.config.mjs $t/src/web/ui-migration/; done
step p0-ref $REF env P32_SNAPSHOTS=$R/p0-ref-shots P32_OUTPUT=$R/p0-ref-out P32_PORT=4173 npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=all
step p0-strict $DEL env P32_SNAPSHOTS=$R/p0-ref-shots P32_OUTPUT=$R/p0-strict-out P32_PORT=4173 npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=none
step p0-del $DEL env P32_SNAPSHOTS=$R/p0-del-shots P32_OUTPUT=$R/p0-del-out P32_PORT=4173 npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=all
rm -f $REF/src/web/ui-migration/p32-reference.config.mjs $DEL/src/web/ui-migration/p32-reference.config.mjs
step p0-standard $DEL npx playwright test --config ui-migration/playwright.config.mjs
mkdir -p $R/p0-standard-out && cp -a $DEL/src/web/.ui-migration-results/. $R/p0-standard-out/
step p0-standard-base $BASE npx playwright test --config ui-migration/playwright.config.mjs
mkdir -p $R/p0-standard-base-out && cp -a $BASE/src/web/.ui-migration-results/. $R/p0-standard-base-out/
step merge $DEL bash -c 'cd ../.. && npm run build -w @orbit/web && npm run test -w @orbit/web'
step overlays $DEL bash -c 'cd ../.. && npm run test:ui-overlays -w @orbit/web'
cp -a $DEL/src/web/.overlays-results/report.json $R/overlays-report.json 2>/dev/null
step controls $DEL bash -c 'cd ../.. && npm run test:ui-controls -w @orbit/web'
cp -a $DEL/src/web/.controls-results/report.json $R/controls-report.json 2>/dev/null
for env in chromium-light-desktop chromium-light-phone chromium-dark-desktop chromium-dark-phone \
           webkit-light-desktop webkit-light-phone webkit-dark-desktop webkit-dark-phone; do
  if [ -f "$R/choices-$env.txt" ] && grep -q '^exit=' "$R/choices-$env.txt"; then echo "== choices-$env already done ($(grep '^exit=' "$R/choices-$env.txt"))"; continue; fi
  step choices-$env $DEL bash -c "cd ../.. && npm run test:ui-choices -w @orbit/web -- --project $env"
  cp -a $DEL/src/web/.choices-results/report.json $R/choices-$env-report.json
done
echo "== done $(date -u +%T)"
