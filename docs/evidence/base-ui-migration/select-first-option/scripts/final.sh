#!/usr/bin/env bash
# final.sh: every run of the final round, one at a time (step.sh: logs, resumable, disk and memory gates, own scope and
# network namespace), on the trees make-trees.sh built (del = the delivery, ref = the same-commit reference).
#  A. the two new resident specs on ref (they must fail) and del (they must pass), all eight environments;
#  B. the choices and overlays entries on del, all eight environments (they include the two new specs);
#  C. the standard P0 regression on del and on ref (its pretest builds shared and the web app in the tree);
#  D. P4.3a's coordinator case (the rebind and choose-workspace dialogs) on ref and del, each writing its screenshots,
#     and the page probe (probes/probe-pages.browser.mjs) on both, on the production build C left in each tree;
#  E. the probes on del (desktop): the icon buttons' hover and the Select openers the resident spec leaves out;
#  F. the P2 keyboard-window suites, chromium-dark-desktop as in P2, files unchanged: select-keys in full on ref and
#     del; the Select sequences of keyboard-window and keyboard-window-2 with 3 burst and 3 paced samples on ref and
#     del; their other sequences (menus, submenus, Popconfirm, dialogs) with 1 + 1 on del;
#  G. the merge check on del: npm run build -w @orbit/web && npm run test -w @orbit/web.
S=$(cd "$(dirname "$0")" && pwd)
P=$(cd "$S/../probes" && pwd)
V=/mnt/data/tmp/34coPBk43ULRuisicUTAy
R=$V/runs
step() { "$S/step.sh" "$@"; [ $? -eq 3 ] && exit 3; return 0; }
probe() { cp "$P"/$2 "$V/$1/src/web/ui-migration/"; }
unprobe() { (cd "$V/$1/src/web/ui-migration" && rm -f $2); }
for t in ref del; do
  step f-close-hover-$t "$V/$t" env P32_BASE_CONFIG=overlays.config.mjs P32_PORT=4511 P32_OUTPUT="$R/f-close-hover-$t-out" \
    npx playwright test --config ui-migration/port.config.mjs ui-migration/overlays-close-hover.browser.mjs
  step f-first-option-$t "$V/$t" env P32_BASE_CONFIG=choices.config.mjs P32_PORT=4512 P32_OUTPUT="$R/f-first-option-$t-out" \
    npx playwright test --config ui-migration/port.config.mjs ui-migration/choices-first-option.browser.mjs
done
step f-choices-del "$V/del" env P32_BASE_CONFIG=choices.config.mjs P32_PORT=4512 P32_OUTPUT="$R/f-choices-del-out" \
  npx playwright test --config ui-migration/port.config.mjs
step f-overlays-del "$V/del" env P32_BASE_CONFIG=overlays.config.mjs P32_PORT=4511 P32_OUTPUT="$R/f-overlays-del-out" \
  npx playwright test --config ui-migration/port.config.mjs
for t in del ref; do
  step f-p0-$t "$V/$t" env MOVE_RESULTS=src/web/.ui-migration-results npm run test:ui-migration
done
for t in ref del; do
  step f-p43a-coordinator-$t "$V/$t" env P43A_SNAPSHOTS="$R/f-p43a-coordinator-$t-shots" P43A_OUTPUT="$R/f-p43a-coordinator-$t-out" P43A_PORT=4541 \
    npx playwright test --config ui-migration/p43a.config.mjs --update-snapshots=all --grep "the coordinator: its menu"
  probe $t 'probe-pages.browser.mjs probe-pages.config.mjs'
  step f-probe-pages-$t "$V/$t" env PROBE_OUTPUT="$R/f-probe-pages-$t-out" PROBE_PORT=4531 \
    npx playwright test --config ui-migration/probe-pages.config.mjs
  unprobe $t 'probe-pages.browser.mjs probe-pages.config.mjs'
done
probe del 'probe.config.mjs probe-icon-hover.browser.mjs probe-select-openers.browser.mjs'
step f-probe-icon-hover-del "$V/del" env PROBE_OUTPUT="$R/f-probe-icon-hover-del-out" PROBE_PORT=4521 \
  npx playwright test --config ui-migration/probe.config.mjs ui-migration/probe-icon-hover.browser.mjs
step f-probe-select-openers-del "$V/del" env PROBE_OUTPUT="$R/f-probe-select-openers-del-out" PROBE_PORT=4521 \
  npx playwright test --config ui-migration/probe.config.mjs ui-migration/probe-select-openers.browser.mjs
unprobe del 'probe.config.mjs probe-icon-hover.browser.mjs probe-select-openers.browser.mjs'
E=../../docs/evidence/base-ui-migration
SELECT_TARGETS='(orbit-field|orbit-sample|antd-sample) select-'
for t in ref del; do
  step f-select-keys-$t "$V/$t" env MOVE_RESULTS=src/web/.choices-results/p2-select-keys-burst \
    npx playwright test --config $E/p2-select-keys/select-keys-burst.config.mjs
  step f-kw1-select-$t "$V/$t" env MOVE_RESULTS=src/web/.choices-results/p2-keyboard-window \
    npx playwright test --config $E/p2-keyboard-window/keyboard-window.config.mjs --project chromium-dark-desktop \
    --grep "$SELECT_TARGETS[a-z0-9-]+ (burst|paced) sample [0-2]\$"
  step f-kw2-select-$t "$V/$t" env KW2_BURST=3 KW2_PACED=3 KW2_RESULTS="$R/f-kw2-select-$t-out" \
    npx playwright test --config $E/p2-keyboard-window-2/keyboard-window-2.config.mjs --project chromium-dark-desktop --grep "$SELECT_TARGETS"
done
step f-kw1-other-del "$V/del" env MOVE_RESULTS=src/web/.choices-results/p2-keyboard-window \
  npx playwright test --config $E/p2-keyboard-window/keyboard-window.config.mjs --project chromium-dark-desktop \
  --grep-invert " select-" --grep "(burst|paced) sample 0\$"
step f-kw2-other-del "$V/del" env KW2_BURST=1 KW2_PACED=1 KW2_RESULTS="$R/f-kw2-other-del-out" \
  npx playwright test --config $E/p2-keyboard-window-2/keyboard-window-2.config.mjs --project chromium-dark-desktop --grep-invert " select-"
step f-merge-check-del "$V/del" bash -c 'cd ../.. && npm run build -w @orbit/web && npm run test -w @orbit/web'
echo "final.sh done $(date -u +%FT%TZ)"
