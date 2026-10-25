#!/usr/bin/env bash
# The second version's runs on the final tip a794459b1: the branch (rebased on the project tip dea1d8128, where
# formal-v2.sh ran the comparisons on 822c00ff0) with the latest origin/main 710c66e6d merged in. Main's commits
# since dea1d8128 change the session page's retry cards (WorkspaceView.tsx, Transcript.tsx and a unit test), no
# file of this batch and no page a browser spec here opens. So on the merged tip: the merge check, the standard
# P0 regression, overlays and controls, the P4.1 spec and the P3.2 pilot, and the delivery's own P4.2 states and
# P0 page matrix -- each writing its screenshots, to set beside the same runs on 822c00ff0.
# Tree: make-delivery-tree-v2.sh a794459b1 (full checkout, v2/del). Checkout, TMPDIR and outputs on /mnt/data,
# one run at a time; before each run, / below 2 GB available (df -BM) stops the chain (exit 3) for a report.
# Logs: runs-final/<name>.txt with argv, tree, HEAD, uncommitted paths, load, disk and exit code.
set -u
V=/mnt/data/tmp/34Za39Feocgj42rrBYwzl/v2
R=$V/runs-final
DEL=$V/del
export TMPDIR=$V/tmp
mkdir -p "$R" "$TMPDIR"
gate() {
  local a; a=$(df --output=avail -BM / | tail -1 | tr -dc '0-9')
  if [ "$a" -lt 2048 ]; then echo "== STOP: / has ${a}M available (< 2 GB) $(date -u +%T)"; exit 3; fi
}
step() {
  local name=$1 tree=$2; shift 2
  # Resumable: a step whose log already ends with its exit code ran to the end (e.g. before a disk stop).
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
[ "$(git -C $DEL rev-parse --short=9 HEAD)" = a794459b1 ] || { echo "v2/del is not at a794459b1"; exit 2; }
step g-p0-standard $DEL npx playwright test --config ui-migration/playwright.config.mjs
mkdir -p $R/g-p0-standard-out && cp -a $DEL/src/web/.ui-migration-results/. $R/g-p0-standard-out/
step g-merge $DEL bash -c 'cd ../.. && npm run build -w @orbit/web && npm run test -w @orbit/web'
step g-overlays $DEL bash -c 'cd ../.. && npm run test:ui-overlays -w @orbit/web'
cp -a $DEL/src/web/.overlays-results/report.json $R/g-overlays-report.json 2>/dev/null
step g-controls $DEL bash -c 'cd ../.. && npm run test:ui-controls -w @orbit/web'
cp -a $DEL/src/web/.controls-results/report.json $R/g-controls-report.json 2>/dev/null
step g-p41-del $DEL env P41_SNAPSHOTS=$R/g-p41-del-shots P41_OUTPUT=$R/g-p41-del-out P41_PORT=4331 npx playwright test --config ui-migration/p41.config.mjs --update-snapshots=all
step g-pilot-del $DEL env P32_SNAPSHOTS=$R/g-pilot-del-shots P32_OUTPUT=$R/g-pilot-del-out P32_PORT=4321 npx playwright test --config ui-migration/pilot.config.mjs --update-snapshots=all
step g-p42-del $DEL env P42_SNAPSHOTS=$R/g-p42-del-shots P42_OUTPUT=$R/g-p42-del-out npx playwright test --config ui-migration/p42.config.mjs --update-snapshots=all
# The P3.2 same-commit config, copied (untracked) into the tree for the P0 page matrix, as in formal-v2.sh.
cp $DEL/docs/evidence/base-ui-migration/p3.2/p32-reference.config.mjs $DEL/src/web/ui-migration/
step g-p0-del $DEL env P32_SNAPSHOTS=$R/g-p0-del-shots P32_OUTPUT=$R/g-p0-del-out P32_PORT=4173 npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=all
rm -f $DEL/src/web/ui-migration/p32-reference.config.mjs
echo "== done $(date -u +%T)"
