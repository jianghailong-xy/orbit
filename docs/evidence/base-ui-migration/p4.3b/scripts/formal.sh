#!/usr/bin/env bash
# The P4.3b formal runs, one at a time, each in its own network namespace (fixed ports stay private).
# Trees (make-trees.sh): ref = the delivery with the business switch reverted, del = the delivery,
# start = the batch's base, the project tip abc0a4cfa (P4.3a landed) merged with origin/main 4085437ff (a local commit). All on /mnt/data with TMPDIR and outputs, except
# the merge check, which runs in this task's worktree on the root NVMe (the coordinator's 2026-10-08 hand-over); before each run,
# / below 2 GB available (df -BM) stops the chain (exit 3) for a report (the coordinator's disk rule).
#  - P4.3b cases (p43b.browser.mjs, production build) and the decision-card page (p43b-cards, dev server)
#    on ref and del, each writing its own screenshots;
#  - the P0 page matrix, same commit: ref writes its screenshots, del is compared against them at 0 pixels
#    and then writes its own; the standard P0 regression on del and on start;
#  - the P3.2 pilot (task detail with the task graph) on ref and del;
#  - the merge check (build + unit tests) in this task's worktree (the delivery, on NVMe); the overlays matrix (the Dialog's Close)
#    and the controls matrix (Alert, and the shared components this branch carries from P4.3a);
#  - the P4.1 and P4.2 cases on start and del (the shared components under the pages migrated before).
# Logs: runs/<name>.txt with argv, tree, HEAD, uncommitted paths, load, disk and exit code. Resumable: a step
# whose log ends with its exit code is skipped; one without (interrupted) runs again from empty outputs.
# Memory (the coordinator's rules after the 08:30Z OOM stop): one step at a time, every Playwright config here keeps the
# baseline's single worker (the web test script its --maxWorkers=2), each step waits for 3 GB available, and each runs
# in its own systemd scope (MemoryMax=6G, oom_score_adj 500; memgate.sh's scoped), so an OOM kill takes the step, not
# the runner.
set -u
V=/mnt/data/tmp/34blYpxEcHMAf4oafuC2W
R=$V/runs
REF=$V/ref
DEL=$V/del
START=$V/start
WT=/root/.orbit/worktrees/ba9b2bbb-b78b-5991-855c-183de0d5d9e3
export TMPDIR=$V/tmp
mkdir -p "$R" "$TMPDIR"
. $V/scripts/memgate.sh
gate() {
  local a; a=$(df --output=avail -BM / | tail -1 | tr -dc '0-9')
  if [ "$a" -lt 2048 ]; then echo "== STOP: / has ${a}M available (< 2 GB) $(date -u +%T)"; exit 3; fi
}
step() {
  local name=$1 tree=$2; shift 2
  if [ -f "$R/$name.txt" ] && grep -q '^exit=' "$R/$name.txt"; then echo "== $name already done ($(grep '^exit=' "$R/$name.txt"))"; return 0; fi
  gate
  memgate
  rm -rf "$R/$name-out" "$R/$name-shots"
  { echo "argv: $*"; echo "tree: $tree"; echo "head: $(git -C $tree rev-parse HEAD)"; echo "uncommitted:"; git -C $tree status --short -- src/web
    echo "load: $(cat /proc/loadavg)"; memline; echo "disk: / $(df --output=avail -BM / | tail -1 | tr -d ' ') available, TMPDIR $TMPDIR"; echo "started: $(date -u +%FT%TZ)"; echo; } > "$R/$name.txt"
  echo "== $name $(date -u +%T)"
  ( cd "$tree/src/web" && scoped nice -n -5 unshare -n bash -c 'ip link set lo up && exec "$@"' bash "$@" ) >> "$R/$name.txt" 2>&1
  local code=$?
  { echo "exit=$code"; echo "load: $(cat /proc/loadavg)"; memline; echo "ended: $(date -u +%FT%TZ)"; } >> "$R/$name.txt"
  grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped|did not run)|Test Files|Tests |^exit=" "$R/$name.txt"
}
step f-p43b-ref $REF env P43B_SNAPSHOTS=$R/f-p43b-ref-shots P43B_OUTPUT=$R/f-p43b-ref-out npx playwright test --config ui-migration/p43b.config.mjs --update-snapshots=all
step f-p43b-del $DEL env P43B_SNAPSHOTS=$R/f-p43b-del-shots P43B_OUTPUT=$R/f-p43b-del-out npx playwright test --config ui-migration/p43b.config.mjs --update-snapshots=all
step f-cards-ref $REF env P43B_SNAPSHOTS=$R/f-cards-ref-shots P43B_OUTPUT=$R/f-cards-ref-out npx playwright test --config ui-migration/p43b-cards.config.mjs --update-snapshots=all
step f-cards-del $DEL env P43B_SNAPSHOTS=$R/f-cards-del-shots P43B_OUTPUT=$R/f-cards-del-out npx playwright test --config ui-migration/p43b-cards.config.mjs --update-snapshots=all
# The P3.2 same-commit config, copied (untracked) into the two trees that run the P0 matrix.
for t in $REF $DEL; do cp $DEL/docs/evidence/base-ui-migration/p3.2/p32-reference.config.mjs $t/src/web/ui-migration/; done
step f-p0-ref $REF env P32_SNAPSHOTS=$R/f-p0-ref-shots P32_OUTPUT=$R/f-p0-ref-out P32_PORT=4173 npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=all
step f-p0-strict $DEL env P32_SNAPSHOTS=$R/f-p0-ref-shots P32_OUTPUT=$R/f-p0-strict-out P32_PORT=4173 npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=none
step f-p0-del $DEL env P32_SNAPSHOTS=$R/f-p0-del-shots P32_OUTPUT=$R/f-p0-del-out P32_PORT=4173 npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=all
rm -f $REF/src/web/ui-migration/p32-reference.config.mjs $DEL/src/web/ui-migration/p32-reference.config.mjs
# The standard P0 regression writes into the tree's own .ui-migration-results; keep each run's copy here.
step f-p0-standard $DEL npx playwright test --config ui-migration/playwright.config.mjs
mkdir -p $R/f-p0-standard-out && cp -a $DEL/src/web/.ui-migration-results/. $R/f-p0-standard-out/
step f-p0-standard-start $START npx playwright test --config ui-migration/playwright.config.mjs
mkdir -p $R/f-p0-standard-start-out && cp -a $START/src/web/.ui-migration-results/. $R/f-p0-standard-start-out/
step pilot-ref $REF env P32_SNAPSHOTS=$R/pilot-ref-shots P32_OUTPUT=$R/pilot-ref-out P32_PORT=4321 npx playwright test --config ui-migration/pilot.config.mjs --update-snapshots=all
step pilot-del $DEL env P32_SNAPSHOTS=$R/pilot-del-shots P32_OUTPUT=$R/pilot-del-out P32_PORT=4321 npx playwright test --config ui-migration/pilot.config.mjs --update-snapshots=all
step c-merge $WT bash -c 'cd ../.. && npm run build -w @orbit/web && npm run test -w @orbit/web'
step u-related $WT bash -c 'npx vitest run --maxWorkers=2 $(cat /mnt/data/tmp/34blYpxEcHMAf4oafuC2W/related-tests.txt)'
step c-overlays $DEL bash -c 'cd ../.. && npm run test:ui-overlays -w @orbit/web'
cp -a $DEL/src/web/.overlays-results/report.json $R/c-overlays-report.json 2>/dev/null
step c-controls $DEL bash -c 'cd ../.. && npm run test:ui-controls -w @orbit/web'
cp -a $DEL/src/web/.controls-results/report.json $R/c-controls-report.json 2>/dev/null
# The choices matrix (Select, Menu, Combobox and the rest of P2.2's pickers, first frame and submenu geometry), which
# P4.3a also runs: the two batches' shared component changes meet in it. Its outputDir is emptied at the start.
step c-choices $DEL bash -c 'cd ../.. && npm run test:ui-choices -w @orbit/web'
cp -a $DEL/src/web/.choices-results/report.json $R/c-choices-report.json 2>/dev/null
step f-p41-start $START env P41_SNAPSHOTS=$R/f-p41-start-shots P41_OUTPUT=$R/f-p41-start-out P41_PORT=4331 npx playwright test --config ui-migration/p41.config.mjs --update-snapshots=all
step f-p41-del $DEL env P41_SNAPSHOTS=$R/f-p41-del-shots P41_OUTPUT=$R/f-p41-del-out P41_PORT=4331 npx playwright test --config ui-migration/p41.config.mjs --update-snapshots=all
step f-p42-start $START env P42_SNAPSHOTS=$R/f-p42-start-shots P42_OUTPUT=$R/f-p42-start-out P42_PORT=4341 npx playwright test --config ui-migration/p42.config.mjs --update-snapshots=all
step f-p42-del $DEL env P42_SNAPSHOTS=$R/f-p42-del-shots P42_OUTPUT=$R/f-p42-del-out P42_PORT=4341 npx playwright test --config ui-migration/p42.config.mjs --update-snapshots=all
echo "== done $(date -u +%T)"
