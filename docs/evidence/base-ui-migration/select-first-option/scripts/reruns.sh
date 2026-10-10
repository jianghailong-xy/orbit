#!/usr/bin/env bash
# reruns.sh: the choices entry's three timeouts in the final round (f-choices-del: submenu geometry on Chromium light
# phone; the menu and submenu first-frame tests on Chromium dark phone; 90 s test timeouts, one "session closed", while
# the host had global OOM kills at 21:35-21:36Z), each run again alone, on the delivery and on the reference.
# Then the reference's P0, P4.3a coordinator case and page probe, which did not run in the final round: make-trees.sh's
# first version left the reference tree an empty @types/react-dom (a hardlink copy across filesystems failed half way),
# so its web build stopped at tsc (runs-setup-failed/). The tree was repaired with a plain copy; nothing else changed.
# And the three probes on the delivery: final.sh's probe() copied only the first file it was given (the others lost
# the probes directory), so each stopped before a test (runs-setup-failed/). Here every file is copied by name.
S=$(cd "$(dirname "$0")" && pwd)
V=/mnt/data/tmp/34coPBk43ULRuisicUTAy
R=$V/runs
step() { "$S/step.sh" "$@"; [ $? -eq 3 ] && exit 3; return 0; }
# step.sh moves a config's in-tree results only when MOVE_RESULTS is in its own environment; final.sh passed it
# through `env` to the command instead, so those runs left their results in the trees. They are moved here by hand.
moved() { [ -d "$1" ] && [ ! -e "$2" ] && mv "$1" "$2" && echo "moved $1 -> $2"; return 0; }
moved "$V/del/src/web/.choices-results/p2-keyboard-window" "$R/f-kw1-other-del-out"
for t in del ref; do
  step f-rerun-submenu-geometry-$t "$V/$t" env P32_BASE_CONFIG=choices.config.mjs P32_PORT=4512 P32_OUTPUT="$R/f-rerun-submenu-geometry-$t-out" \
    npx playwright test --config ui-migration/port.config.mjs ui-migration/choices-submenu-geometry.browser.mjs --project chromium-light-phone
  step f-rerun-first-frame-$t "$V/$t" env P32_BASE_CONFIG=choices.config.mjs P32_PORT=4512 P32_OUTPUT="$R/f-rerun-first-frame-$t-out" \
    npx playwright test --config ui-migration/port.config.mjs ui-migration/choices-first-frame.browser.mjs --project chromium-dark-phone \
    --grep "menu is drawn where it settles"
done
P=$(cd "$S/../probes" && pwd)
step f-p0-ref "$V/ref" npm run test:ui-migration
moved "$V/ref/src/web/.ui-migration-results" "$R/f-p0-ref-out"
step f-p43a-coordinator-ref "$V/ref" env P43A_SNAPSHOTS="$R/f-p43a-coordinator-ref-shots" P43A_OUTPUT="$R/f-p43a-coordinator-ref-out" P43A_PORT=4541 \
  npx playwright test --config ui-migration/p43a.config.mjs --update-snapshots=all --grep "the coordinator: its menu"
cp "$P"/probe-pages.browser.mjs "$P"/probe-pages.config.mjs "$V/ref/src/web/ui-migration/"
step f-probe-pages-ref "$V/ref" env PROBE_OUTPUT="$R/f-probe-pages-ref-out" PROBE_PORT=4531 npx playwright test --config ui-migration/probe-pages.config.mjs
rm -f "$V/ref/src/web/ui-migration/probe-pages.browser.mjs" "$V/ref/src/web/ui-migration/probe-pages.config.mjs"
cp "$P"/probe-pages.browser.mjs "$P"/probe-pages.config.mjs "$V/del/src/web/ui-migration/"
step f-probe-pages-del "$V/del" env PROBE_OUTPUT="$R/f-probe-pages-del-out" PROBE_PORT=4531 npx playwright test --config ui-migration/probe-pages.config.mjs
rm -f "$V/del/src/web/ui-migration/probe-pages.browser.mjs" "$V/del/src/web/ui-migration/probe-pages.config.mjs"
cp "$P"/probe.config.mjs "$P"/probe-icon-hover.browser.mjs "$P"/probe-select-openers.browser.mjs "$V/del/src/web/ui-migration/"
step f-probe-icon-hover-del "$V/del" env PROBE_OUTPUT="$R/f-probe-icon-hover-del-out" PROBE_PORT=4521 \
  npx playwright test --config ui-migration/probe.config.mjs ui-migration/probe-icon-hover.browser.mjs
step f-probe-select-openers-del "$V/del" env PROBE_OUTPUT="$R/f-probe-select-openers-del-out" PROBE_PORT=4521 \
  npx playwright test --config ui-migration/probe.config.mjs ui-migration/probe-select-openers.browser.mjs
rm -f "$V/del/src/web/ui-migration/probe.config.mjs" "$V/del/src/web/ui-migration/probe-icon-hover.browser.mjs" "$V/del/src/web/ui-migration/probe-select-openers.browser.mjs"
# The second keyboard-window batch's other sequences on the delivery: the final round's run was killed by the kernel's
# global OOM killer at 01:07:18Z after 105 samples, the scope's oom_score_adj 500 choosing the test over the runner
# (runs-killed/). The same command again.
step f-kw2-other-del "$V/del" env KW2_BURST=1 KW2_PACED=1 KW2_RESULTS="$R/f-kw2-other-del-out" \
  npx playwright test --config ../../docs/evidence/base-ui-migration/p2-keyboard-window-2/keyboard-window-2.config.mjs --project chromium-dark-desktop --grep-invert " select-"
echo "reruns.sh done $(date -u +%FT%TZ)"
