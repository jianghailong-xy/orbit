#!/usr/bin/env bash
# Formal runs, one at a time, each in its own network namespace (fixed ports stay private):
#  - P4.2 states (p42.browser.mjs) on the same-commit reference (delivery with the business switch
#    reverted) and on the delivery, each writing its own screenshots;
#  - the P0 page matrix, same commit: the reference writes its screenshots, the delivery is compared
#    strictly (0 px) against them and then writes its own; the standard P0 regression on the delivery;
#  - shared components on pages migrated before this batch: the P4.1 spec and the P3.2 pilot on the
#    batch's starting commit (base 3aa26fb97) and on the delivery;
#  - the component matrices this batch's shared changes touch (overlays: ConfirmDialog; controls:
#    Button, Badge, Radio, Switch), then the merge check (build + unit tests);
#  - the two menu-to-editor cases repeated in WebKit desktop.
# Logs: runs/<name>.txt with argv, tree, HEAD, uncommitted paths, load and exit code.
set -u
S=/var/tmp/p4.2-753ee3
R=$S/runs
REF=$S/ref
BASE=$S/base
DEL=/root/.orbit/worktrees/2a435fb0-2ac5-5226-839d-0b1389da291c
step() {
  local name=$1 tree=$2; shift 2
  { echo "argv: $*"; echo "tree: $tree"; echo "head: $(git -C $tree rev-parse HEAD)"; echo "uncommitted:"; git -C $tree status --short -- src/web
    echo "load: $(cat /proc/loadavg)"; echo "started: $(date -u +%FT%TZ)"; echo; } > "$R/$name.txt"
  echo "== $name $(date -u +%T)"
  ( cd "$tree/src/web" && nice -n -5 unshare -n bash -c 'ip link set lo up && exec "$@"' bash "$@" ) >> "$R/$name.txt" 2>&1
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
for t in $REF $DEL; do rm -f $t/src/web/ui-migration/p32-reference.config.mjs; done
step f-p0-standard $DEL npx playwright test --config ui-migration/playwright.config.mjs
mkdir -p $R/f-p0-standard-out && cp -a $DEL/src/web/.ui-migration-results/report.json $DEL/src/web/.ui-migration-results/expected-sources.json $R/f-p0-standard-out/ 2>/dev/null
step f-p41-base $BASE env P41_SNAPSHOTS=$R/f-p41-base-shots P41_OUTPUT=$R/f-p41-base-out P41_PORT=4331 npx playwright test --config ui-migration/p41.config.mjs --update-snapshots=all
step f-p41-del $DEL env P41_SNAPSHOTS=$R/f-p41-del-shots P41_OUTPUT=$R/f-p41-del-out P41_PORT=4331 npx playwright test --config ui-migration/p41.config.mjs --update-snapshots=all
step pilot-base $BASE env P32_SNAPSHOTS=$R/pilot-base-shots P32_OUTPUT=$R/pilot-base-out P32_PORT=4321 npx playwright test --config ui-migration/pilot.config.mjs --update-snapshots=all
step pilot-del $DEL env P32_SNAPSHOTS=$R/pilot-del-shots P32_OUTPUT=$R/pilot-del-out P32_PORT=4321 npx playwright test --config ui-migration/pilot.config.mjs --update-snapshots=all
step c-overlays $DEL bash -c 'cd ../.. && npm run test:ui-overlays -w @orbit/web'
cp -a $DEL/src/web/.overlays-results/report.json $R/c-overlays-report.json 2>/dev/null
step c-controls $DEL bash -c 'cd ../.. && npm run test:ui-controls -w @orbit/web'
cp -a $DEL/src/web/.controls-results/report.json $R/c-controls-report.json 2>/dev/null
step c-merge $DEL bash -c 'cd ../.. && npm run build -w @orbit/web && npm run test -w @orbit/web'
# The two cases that open an inline editor from a menu (an account's Rename, a workspace's Configure),
# five more times each in WebKit desktop, where the editor used to lose focus to the closing menu.
step f-p42-repeat $DEL env P42_SNAPSHOTS=$R/f-p42-repeat-shots P42_OUTPUT=$R/f-p42-repeat-out npx playwright test --config ui-migration/p42.config.mjs --update-snapshots=all --project webkit-dark-desktop --project webkit-light-desktop -g "engines|its menus" --repeat-each=5
echo "== done $(date -u +%T)"
