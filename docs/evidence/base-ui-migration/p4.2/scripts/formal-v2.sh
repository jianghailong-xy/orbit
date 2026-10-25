#!/usr/bin/env bash
# The second version's formal runs on the project tip dea1d8128 (origin/main 075b7a6c8 + P0 drift batch 5),
# one at a time, each in its own network namespace (fixed ports stay private). Trees, all on /mnt/data:
# make-reference-v2.sh 822c00ff0 865a0a6e3 dea1d8128 822c00ff0 (reference 60f16a6ee; start b478f5f57 =
# dea1d8128 with the delivery's P4.1 spec fix 822c00ff0 cherry-picked) and make-delivery-tree-v2.sh 822c00ff0.
#  - P4.2 states (p42.browser.mjs) on the same-commit reference (delivery with the business switch reverted)
#    and on the delivery, each writing its own screenshots;
#  - the P0 page matrix, same commit: the reference writes its screenshots, the delivery is compared against
#    them and then writes its own; the standard P0 regression on the delivery and, for comparison, on
#    origin/main itself;
#  - the merge check (build + unit tests) and the component matrices this batch's shared changes touch
#    (overlays: ConfirmDialog; controls: Button, Badge, Radio, Switch) on the delivery;
#  - shared components on pages migrated before this batch: the P4.1 spec and the P3.2 pilot on origin/main
#    and on the delivery;
#  - the menu-to-editor cases repeated in WebKit desktop;
#  - probes: geometry (dialog scroll lock and gutter, switch widths, Always allowed) on the reference and the
#    delivery; the Rename / Configure focus probe on the dev server before the fix (tree `prefix`: the
#    delivery with the fix reversed, committed locally, never pushed) and after it.
# Checkouts, TMPDIR and outputs all live on /mnt/data, so by the coordinator's disk rule (2026-10-08) a run
# need not wait for / to have 6 GB; before each run, / below 2 GB available (df -BM) stops the chain (exit 3)
# for a report. Logs: runs/<name>.txt with argv, tree, HEAD, uncommitted paths, load, disk and exit code.
set -u
V=/mnt/data/tmp/34Za39Feocgj42rrBYwzl/v2
P=$V/scripts/dev-probe
R=$V/runs
REF=$V/ref
BASE=$V/base
PRE=$V/prefix
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
  ( cd "$tree/src/web" && PROBE_OUT=$R/$name.jsonl nice -n -5 unshare -n bash -c 'ip link set lo up && exec "$@"' bash "$@" ) >> "$R/$name.txt" 2>&1
  local code=$?
  { echo "exit=$code"; echo "load: $(cat /proc/loadavg)"; echo "ended: $(date -u +%FT%TZ)"; } >> "$R/$name.txt"
  grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped|did not run)|Test Files|Tests |^exit=" "$R/$name.txt"
}
step f-p42-ref $REF env P42_SNAPSHOTS=$R/f-p42-ref-shots P42_OUTPUT=$R/f-p42-ref-out npx playwright test --config ui-migration/p42.config.mjs --update-snapshots=all
step f-p42-del $DEL env P42_SNAPSHOTS=$R/f-p42-del-shots P42_OUTPUT=$R/f-p42-del-out npx playwright test --config ui-migration/p42.config.mjs --update-snapshots=all
# The P3.2 same-commit config, copied (untracked) into the two trees that run the P0 matrix.
for t in $REF $DEL; do cp $DEL/docs/evidence/base-ui-migration/p3.2/p32-reference.config.mjs $t/src/web/ui-migration/; done
step f-p0-ref $REF env P32_SNAPSHOTS=$R/f-p0-ref-shots P32_OUTPUT=$R/f-p0-ref-out P32_PORT=4173 npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=all
step f-p0-strict $DEL env P32_SNAPSHOTS=$R/f-p0-ref-shots P32_OUTPUT=$R/f-p0-strict-out P32_PORT=4173 npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=none
step f-p0-del $DEL env P32_SNAPSHOTS=$R/f-p0-del-shots P32_OUTPUT=$R/f-p0-del-out P32_PORT=4173 npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=all
rm -f $REF/src/web/ui-migration/p32-reference.config.mjs $DEL/src/web/ui-migration/p32-reference.config.mjs
# The standard P0 regression writes into the tree's own .ui-migration-results; keep each run's copy here.
step f-p0-standard $DEL npx playwright test --config ui-migration/playwright.config.mjs
mkdir -p $R/f-p0-standard-out && cp -a $DEL/src/web/.ui-migration-results/. $R/f-p0-standard-out/
step f-p0-standard-base $BASE npx playwright test --config ui-migration/playwright.config.mjs
mkdir -p $R/f-p0-standard-base-out && cp -a $BASE/src/web/.ui-migration-results/. $R/f-p0-standard-base-out/
step c-merge $DEL bash -c 'cd ../.. && npm run build -w @orbit/web && npm run test -w @orbit/web'
step c-overlays $DEL bash -c 'cd ../.. && npm run test:ui-overlays -w @orbit/web'
cp -a $DEL/src/web/.overlays-results/report.json $R/c-overlays-report.json 2>/dev/null
step c-controls $DEL bash -c 'cd ../.. && npm run test:ui-controls -w @orbit/web'
cp -a $DEL/src/web/.controls-results/report.json $R/c-controls-report.json 2>/dev/null
step f-p41-base $BASE env P41_SNAPSHOTS=$R/f-p41-base-shots P41_OUTPUT=$R/f-p41-base-out P41_PORT=4331 npx playwright test --config ui-migration/p41.config.mjs --update-snapshots=all
step f-p41-del $DEL env P41_SNAPSHOTS=$R/f-p41-del-shots P41_OUTPUT=$R/f-p41-del-out P41_PORT=4331 npx playwright test --config ui-migration/p41.config.mjs --update-snapshots=all
step pilot-base $BASE env P32_SNAPSHOTS=$R/pilot-base-shots P32_OUTPUT=$R/pilot-base-out P32_PORT=4321 npx playwright test --config ui-migration/pilot.config.mjs --update-snapshots=all
step pilot-del $DEL env P32_SNAPSHOTS=$R/pilot-del-shots P32_OUTPUT=$R/pilot-del-out P32_PORT=4321 npx playwright test --config ui-migration/pilot.config.mjs --update-snapshots=all
# The cases that open an inline editor from a menu (an account's Rename, a workspace's Configure; the
# pattern also selects the Codex pool case), five more times each in WebKit desktop.
step f-p42-repeat $DEL env P42_SNAPSHOTS=$R/f-p42-repeat-shots P42_OUTPUT=$R/f-p42-repeat-out npx playwright test --config ui-migration/p42.config.mjs --update-snapshots=all --project webkit-dark-desktop --project webkit-light-desktop -g "engines|its menus" --repeat-each=5
# Geometry probes on both production builds; the probe files are copied in for the run and removed after it.
GEOM=(probe-dialog-scroll.browser.mjs probe-dialog-gutter.browser.mjs probe-switch-widths.browser.mjs probe-always-allowed.browser.mjs probes-v2.config.mjs)
for pair in "ref:$REF" "del:$DEL"; do
  tag=${pair%%:*}; tree=${pair#*:}
  for f in "${GEOM[@]}"; do cp "$P/$f" "$tree/src/web/ui-migration/$f"; done
  step "probe-geometry-$tag" "$tree" env TREE=$tag npx playwright test --config ui-migration/probes-v2.config.mjs
  for f in "${GEOM[@]}"; do rm -f "$tree/src/web/ui-migration/$f"; done
done
# The tree with the Rename / Configure fix reversed, for the focus probe before the fix.
if [ ! -d "$PRE" ]; then
  git -C "$DEL" worktree add --no-checkout --detach "$PRE" 822c00ff0 > /dev/null
  git -C "$PRE" sparse-checkout set --no-cone '/*' '!/*/' '/src/' '!/src/*/' '/src/web/' '/src/shared/' '/docs/evidence/base-ui-migration/p0.2/environment.json'
  git -C "$PRE" checkout -q --detach 822c00ff0
  ln -sfn "$DEL/node_modules" "$PRE/node_modules"
  mkdir -p "$PRE/src/web/node_modules"
  cp -a "$DEL/src/web/node_modules/@orbit" "$DEL/src/web/node_modules/@types" "$PRE/src/web/node_modules/"
  git -C "$PRE" apply "$V/scripts/rename-fix-reversed.patch"
  git -C "$PRE" -c user.name=p4.2-probe -c user.email=p4.2@probe.local commit -q -am "probe only: the Rename/Configure focus fix reversed"
fi
echo "prefix HEAD $(git -C "$PRE" rev-parse HEAD) = 822c00ff0 with the fix reversed"
for pair in "before:$PRE" "after:$DEL"; do
  tag=${pair%%:*}; tree=${pair#*:}
  cp "$P/rename-probe.browser.mjs" "$P/rename-probe-v2.config.mjs" "$tree/src/web/ui-migration/"
  step "rename-$tag" "$tree" env TREE=$tag npx playwright test --config ui-migration/rename-probe-v2.config.mjs \
    --project chromium-light-desktop --project webkit-light-desktop --project webkit-dark-desktop --repeat-each=5
  rm -f "$tree/src/web/ui-migration/rename-probe.browser.mjs" "$tree/src/web/ui-migration/rename-probe-v2.config.mjs"
done
echo "== done $(date -u +%T)"
