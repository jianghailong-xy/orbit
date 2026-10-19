#!/usr/bin/env bash
# The probes the README cites, on the same-commit reference (ref) and the delivery (del) built by
# make-trees.sh, one at a time, each in its own network namespace (probe.sh). Outputs: probes-out/<probe>-<tree>.txt.
#  - probe-remove: the task graph's remove button on a phone: focusing it re-centres the canvas (pre-existing).
#  - probe-done-scroll2: the done dialog's "Not yet": focus, focus() calls and the dialog's scroll.
#  - probe-start-scroll3: the start dialog with the spec's steps, every focus()/scroll and Playwright's own
#    action log (retries, scrolling) on the reference.
#  - probe-check-motion: the merge check box's height, frame by frame, as it appears.
#  - probe-line-menu2: the line menu opened as the spec opens it: pointer events and the highlight.
#  - probe-close-hover: the full-screen graph's Close at rest and under the pointer.
#  - probe-tooltip-side: the project graph's full-screen hint: its side and box.
#  - probe-escape-panel: the task graph's full screen closed with Escape: does the task panel under it stay.
set -u
V=/mnt/data/tmp/34blYpxEcHMAf4oafuC2W
O=$V/probes-out
mkdir -p "$O"
. $V/scripts/memgate.sh
run() {
  local probe=$1 grep=$2; shift 2
  for tree in ref del; do
    local out="$O/${probe%.browser.mjs}-$tree.txt"
    if [ -s "$out" ] && grep -q 'passed\|failed' "$out"; then echo "== $probe $tree already done"; continue; fi
    memgate
    { echo "probe: $probe tree: $tree head: $(git -C $V/$tree rev-parse HEAD) projects: $* started: $(date -u +%FT%TZ) load: $(cat /proc/loadavg)"; } > "$out"
    PROBE_DEBUG=${PROBE_DEBUG_FOR:-} PROBE_GREP="$grep" bash $V/scripts/probe.sh "$probe" "$tree" "$@" >> "$out" 2>&1
    echo "== $probe $tree: $(grep -E '[0-9]+ (passed|failed)' "$out" | tr -s ' ' | tr '\n' ' ')"
  done
}
P='PROBE|passed|failed|Error'
run probe-remove.browser.mjs "$P" chromium-light-phone webkit-dark-phone chromium-light-desktop
run probe-done-scroll2.browser.mjs "$P" chromium-light-phone chromium-dark-phone webkit-dark-phone chromium-light-desktop
PROBE_DEBUG_FOR=pw:api run probe-start-scroll3.browser.mjs 'PROBE|retrying|not stable|intercepts|scrolling|passed|failed|Error' chromium-light-desktop webkit-light-desktop
run probe-check-motion.browser.mjs "$P" webkit-light-desktop chromium-light-desktop
run probe-line-menu2.browser.mjs "$P" chromium-light-phone chromium-dark-phone webkit-light-phone chromium-light-desktop
run probe-close-hover.browser.mjs "$P" chromium-light-desktop chromium-dark-desktop webkit-light-desktop webkit-dark-desktop
run probe-tooltip-side.browser.mjs "$P" chromium-light-desktop webkit-light-desktop chromium-dark-desktop webkit-dark-desktop
run probe-escape-panel.browser.mjs "$P" chromium-light-desktop webkit-light-desktop chromium-light-phone webkit-dark-phone
# The start dialog's plan graph: node centres and edge paths as run, and with every animation switched off.
run probe-plan-edges.browser.mjs "$P" chromium-light-desktop webkit-light-desktop webkit-dark-desktop
echo "== probes done $(date -u +%T)"
