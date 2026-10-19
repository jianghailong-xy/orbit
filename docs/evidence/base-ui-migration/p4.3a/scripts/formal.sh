#!/usr/bin/env bash
# The formal runs of P4.3a's same-commit comparison, one at a time, each in its own network namespace
# (fixed ports stay private). Trees, all on /mnt/data, from make-trees.sh DELIVERY SWITCH BASE:
#  - P4.3a states (p43a.browser.mjs) on the same-commit reference (delivery with the business switch
#    reverted) and on the delivery, each writing its own screenshots;
#  - the P0 page matrix, same commit: the reference writes its screenshots, the delivery is compared
#    against them (0 pixels) and then writes its own; the standard P0 regression on the delivery and, for
#    comparison, on the base (origin/main the batch is delivered on);
#  - the merge check (build + unit tests) and the component matrices this batch's shared changes touch
#    (overlays: ConfirmDialog width, the wrapping footer; controls: Button, Input, Card, Alert, Badge,
#    Empty, Skeleton, Typography, List; choices: Menu groups, MultiSelect options) on the delivery;
#  - shared components on pages migrated before this batch: the P4.1 and P4.2 specs and the P3.2 pilot on
#    the base and on the delivery.
# Checkouts, TMPDIR and outputs all live on /mnt/data; before each run, / below 2 GB available (df -BM)
# stops the chain (exit 3) for a report. Logs: runs/<name>.txt with argv, tree, HEAD, uncommitted paths,
# load, disk and exit code. Resumable: a step whose log ends with its exit code is not run again.
set -u
V=/mnt/data/tmp/34Za39GvWRQ08ZmKOpFNe/v1
R=$V/runs
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
    echo "load: $(cat /proc/loadavg)"; echo "disk: / $(df --output=avail -BM / | tail -1 | tr -d ' ') available, TMPDIR $TMPDIR"; echo "started: $(date -u +%FT%TZ)"; echo; } > "$R/$name.txt"
  echo "== $name $(date -u +%T)"
  ( cd "$tree/src/web" && nice -n -5 unshare -n bash -c 'ip link set lo up && exec "$@"' bash "$@" ) >> "$R/$name.txt" 2>&1
  local code=$?
  { echo "exit=$code"; echo "load: $(cat /proc/loadavg)"; echo "ended: $(date -u +%FT%TZ)"; } >> "$R/$name.txt"
  grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped|did not run)|Test Files|Tests |^exit=" "$R/$name.txt"
}
step p43a-ref $REF env P43A_SNAPSHOTS=$R/p43a-ref-shots P43A_OUTPUT=$R/p43a-ref-out npx playwright test --config ui-migration/p43a.config.mjs --update-snapshots=all
step p43a-del $DEL env P43A_SNAPSHOTS=$R/p43a-del-shots P43A_OUTPUT=$R/p43a-del-out npx playwright test --config ui-migration/p43a.config.mjs --update-snapshots=all
# The P3.2 same-commit config, copied (untracked) into the two trees that run the P0 matrix.
for t in $REF $DEL; do cp $DEL/docs/evidence/base-ui-migration/p3.2/p32-reference.config.mjs $t/src/web/ui-migration/; done
step p0-ref $REF env P32_SNAPSHOTS=$R/p0-ref-shots P32_OUTPUT=$R/p0-ref-out P32_PORT=4173 npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=all
step p0-strict $DEL env P32_SNAPSHOTS=$R/p0-ref-shots P32_OUTPUT=$R/p0-strict-out P32_PORT=4173 npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=none
step p0-del $DEL env P32_SNAPSHOTS=$R/p0-del-shots P32_OUTPUT=$R/p0-del-out P32_PORT=4173 npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=all
rm -f $REF/src/web/ui-migration/p32-reference.config.mjs $DEL/src/web/ui-migration/p32-reference.config.mjs
# The standard P0 regression writes into the tree's own .ui-migration-results; keep each run's copy here.
step p0-standard $DEL npx playwright test --config ui-migration/playwright.config.mjs
mkdir -p $R/p0-standard-out && cp -a $DEL/src/web/.ui-migration-results/. $R/p0-standard-out/
step p0-standard-base $BASE npx playwright test --config ui-migration/playwright.config.mjs
mkdir -p $R/p0-standard-base-out && cp -a $BASE/src/web/.ui-migration-results/. $R/p0-standard-base-out/
step merge $DEL bash -c 'cd ../.. && npm run build -w @orbit/web && npm run test -w @orbit/web'
step overlays $DEL bash -c 'cd ../.. && npm run test:ui-overlays -w @orbit/web'
cp -a $DEL/src/web/.overlays-results/report.json $R/overlays-report.json 2>/dev/null
step controls $DEL bash -c 'cd ../.. && npm run test:ui-controls -w @orbit/web'
cp -a $DEL/src/web/.controls-results/report.json $R/controls-report.json 2>/dev/null
# The choice controls' behaviour matrix (Menu groups and MultiSelect options changed in 619a49996).
step choices $DEL bash -c 'cd ../.. && npm run test:ui-choices -w @orbit/web'
cp -a $DEL/src/web/.choices-results/report.json $R/choices-report.json 2>/dev/null
step p41-base $BASE env P41_SNAPSHOTS=$R/p41-base-shots P41_OUTPUT=$R/p41-base-out P41_PORT=4331 npx playwright test --config ui-migration/p41.config.mjs --update-snapshots=all
step p41-del $DEL env P41_SNAPSHOTS=$R/p41-del-shots P41_OUTPUT=$R/p41-del-out P41_PORT=4331 npx playwright test --config ui-migration/p41.config.mjs --update-snapshots=all
step p42-base $BASE env P42_SNAPSHOTS=$R/p42-base-shots P42_OUTPUT=$R/p42-base-out npx playwright test --config ui-migration/p42.config.mjs --update-snapshots=all
step p42-del $DEL env P42_SNAPSHOTS=$R/p42-del-shots P42_OUTPUT=$R/p42-del-out npx playwright test --config ui-migration/p42.config.mjs --update-snapshots=all
step pilot-base $BASE env P32_SNAPSHOTS=$R/pilot-base-shots P32_OUTPUT=$R/pilot-base-out P32_PORT=4321 npx playwright test --config ui-migration/pilot.config.mjs --update-snapshots=all
step pilot-del $DEL env P32_SNAPSHOTS=$R/pilot-del-shots P32_OUTPUT=$R/pilot-del-out P32_PORT=4321 npx playwright test --config ui-migration/pilot.config.mjs --update-snapshots=all
echo "== done $(date -u +%T)"
