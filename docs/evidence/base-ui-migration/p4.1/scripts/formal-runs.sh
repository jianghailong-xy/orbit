#!/usr/bin/env bash
# Formal runs, one at a time: P0 matrix on the reference tree (writes its screenshots), on the delivery
# (writes its own; strict check against the reference), the standard P0 regression on the delivery,
# then the P4.1 spec on both trees. Every step logs to runs/<name>.log and leaves exit=<code>.
set -u
R=/var/tmp/p4.1-293463/runs
REF=/var/tmp/p4.1-293463/tip/src/web
DEL=/root/.orbit/worktrees/3402ff96-4293-56f4-8940-d723dd9fa681/src/web
step() { local name=$1 dir=$2; shift 2; echo "== $name $(date -u +%T)"; ( cd "$dir" && "$@" ) > "$R/$name.log" 2>&1; local code=$?; echo "exit=$code" >> "$R/$name.log"; grep -E "^\s+[0-9]+ (passed|failed|flaky|skipped)|^exit=" "$R/$name.log"; }
rm -rf $R/f-*
step f-p0-ref "$REF" env P32_SNAPSHOTS=$R/f-p0-ref-shots P32_OUTPUT=$R/f-p0-ref-out P32_PORT=4173 npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=all
step f-p0-strict "$DEL" env P32_SNAPSHOTS=$R/f-p0-ref-shots P32_OUTPUT=$R/f-p0-strict-out P32_PORT=4173 npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=none
step f-p0-del "$DEL" env P32_SNAPSHOTS=$R/f-p0-del-shots P32_OUTPUT=$R/f-p0-del-out P32_PORT=4173 npx playwright test --config ui-migration/p32-reference.config.mjs --update-snapshots=all
step f-p0-standard "$DEL" npx playwright test --config ui-migration/playwright.config.mjs
step f-p41-ref "$REF" env P41_SNAPSHOTS=$R/f-p41-ref-shots P41_OUTPUT=$R/f-p41-ref-out P41_PORT=4331 npx playwright test --config ui-migration/p41.config.mjs --update-snapshots=all
step f-p41-del "$DEL" env P41_SNAPSHOTS=$R/f-p41-del-shots P41_OUTPUT=$R/f-p41-del-out P41_PORT=4331 npx playwright test --config ui-migration/p41.config.mjs --update-snapshots=all
echo "== done $(date -u +%T)"
