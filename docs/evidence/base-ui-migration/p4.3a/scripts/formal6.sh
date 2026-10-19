#!/usr/bin/env bash
# Round 6 of P4.3a's same-commit comparison: round 5's runs (formal5.sh) on origin/main 76d41066d, the final base.
# Main moved after round 5 had started; its new commits merge cleanly, but 9f2f7e9a0 (the WebKit 1px fix: the toast's
# live region no longer makes the document 1px taller, which gave WebKit its 8px page scrollbar) changes Toast, part
# of the global layer this batch depends on, so the project's rule asks to catch up again and rerun the affected
# checks and the same-commit reference. The trees come from make-trees.sh DELIVERY SWITCH BASE on the new base:
#  - the P4.3a states on the reference and on the delivery; the P0 page matrix (reference, 0-pixel comparison of the
#    delivery against it, delivery); the standard P0 regression on the delivery and on the base;
#  - the merge check (npm run build -w @orbit/web && npm run test -w @orbit/web) on the delivery's full checkout;
#  - the overlays, controls and choices matrices on the delivery (overlays: main added overlays-app-frame with the
#    fix; choices one environment per step, as in formal5.sh).
# The start comparisons (P4.1, P4.2, P3.2 pilot) stay round 4's: they measure this batch's shared-component changes
# on pages migrated before it, and both of their trees carry the same main.
# Same disk gate, logs and resumability as formal5.sh; runs go to v1/runs6.
set -u
V=/mnt/data/tmp/34Za39GvWRQ08ZmKOpFNe/v1
R=$V/runs6
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
  grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped|did not run)|Test Files|Tests |^exit=|error TS" "$R/$name.txt"
}
step p43a-ref $REF env P43A_SNAPSHOTS=$R/p43a-ref-shots P43A_OUTPUT=$R/p43a-ref-out npx playwright test --config ui-migration/p43a.config.mjs --update-snapshots=all
step p43a-del $DEL env P43A_SNAPSHOTS=$R/p43a-del-shots P43A_OUTPUT=$R/p43a-del-out npx playwright test --config ui-migration/p43a.config.mjs --update-snapshots=all
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
# The choices matrix one environment at a time, so that a run the runner stops costs one environment, not the whole
# matrix (in round 5 a single run of it was stopped at 528 of 648 when the runner recycled the session).
# Each run empties .choices-results, so its report is copied right after it.
for env in chromium-light-desktop chromium-light-phone chromium-dark-desktop chromium-dark-phone \
           webkit-light-desktop webkit-light-phone webkit-dark-desktop webkit-dark-phone; do
  if [ -f "$R/choices-$env.txt" ] && grep -q '^exit=' "$R/choices-$env.txt"; then echo "== choices-$env already done ($(grep '^exit=' "$R/choices-$env.txt"))"; continue; fi
  step choices-$env $DEL bash -c "cd ../.. && npm run test:ui-choices -w @orbit/web -- --project $env"
  cp -a $DEL/src/web/.choices-results/report.json $R/choices-$env-report.json
done
echo "== done $(date -u +%T)"
