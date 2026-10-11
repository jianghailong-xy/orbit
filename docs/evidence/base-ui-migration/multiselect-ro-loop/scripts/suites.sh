#!/usr/bin/env bash
# suites.sh [FILTER]: the regression checks of this task, one at a time through step.sh, on the delivery (this
# session's worktree, 62ab70582) unless a step says otherwise — the P0 reference runs on the starting tree
# (exp-pre, 743d21ab2, the same commit without the fix).
#   choices-full   the choices entry, all eight environments, files unchanged
#   overlays-full  the overlays entry, all eight environments
#   p0-del         the standard P0 regression on the delivery
#   p0-ref         the standard P0 regression on the starting tree
#   kw1-del        P2 keyboard-window batch 1 (files unchanged, chromium-dark-desktop as in P2): its Select sequences
#                  3 burst + 3 paced (grep sample [0-2]), every other sequence 1 + 1 (grep sample 0)
#   kw2-del        P2 keyboard-window batch 2, the same split through KW2_BURST/KW2_PACED
#   merge-check    npm run build -w @orbit/web && npm run test -w @orbit/web on the delivery
# FILTER (optional) runs only the steps whose name contains it, e.g. "p0".
# `run NAME TREE env VAR=VAL ... CMD...` puts VAR=VAL in step.sh's OWN environment, which is where its MOVE_RESULTS /
# KW2_RESULTS handling reads it (handing them to the CMD instead is a trap the previous task's README records: the
# results are then never moved out of the tree).
set -u
S=$(cd "$(dirname "$0")" && pwd)
V=/mnt/data/tmp/34dcr9bZPPrl6TDzvXowg
R=$V/runs
WT=/root/.orbit/worktrees/17f5fa0c-dee8-55a3-9637-1996a39597e0
E=$WT/docs/evidence/base-ui-migration
FILTER=${1:-}
run() {
  local name=$1 tree=$2; shift 2
  case "$name" in *"$FILTER"*) ;; *) return 0;; esac
  local envspec=()
  if [ "${1:-}" = env ]; then shift; while [[ "${1:-}" == *=* ]]; do envspec+=("$1"); shift; done; fi
  env "${envspec[@]}" "$S/step.sh" "$name" "$tree" "$@"
}
SELECT_TARGETS='(orbit-field|orbit-sample|antd-sample) select-'
run choices-full $WT npx playwright test --config ui-migration/choices.config.mjs
run overlays-full $WT npx playwright test --config ui-migration/overlays.config.mjs
run p0-del $WT env MOVE_RESULTS=src/web/.ui-migration-results npm run test:ui-migration
run p0-ref $V/v/exp-pre env MOVE_RESULTS=src/web/.ui-migration-results npm run test:ui-migration
run kw1-del $WT env MOVE_RESULTS=src/web/.choices-results/p2-keyboard-window \
  npx playwright test --config $E/p2-keyboard-window/keyboard-window.config.mjs --project chromium-dark-desktop \
  --grep "$SELECT_TARGETS[a-z0-9-]+ (burst|paced) sample [0-2]\$"
run kw1-other-del $WT env MOVE_RESULTS=src/web/.choices-results/p2-keyboard-window \
  npx playwright test --config $E/p2-keyboard-window/keyboard-window.config.mjs --project chromium-dark-desktop \
  --grep-invert " select-" --grep "(burst|paced) sample 0\$"
run kw2-del $WT env KW2_BURST=3 KW2_PACED=3 KW2_RESULTS=$R/kw2-del-out \
  npx playwright test --config $E/p2-keyboard-window-2/keyboard-window-2.config.mjs --project chromium-dark-desktop --grep "$SELECT_TARGETS"
run kw2-other-del $WT env KW2_BURST=1 KW2_PACED=1 KW2_RESULTS=$R/kw2-other-del-out \
  npx playwright test --config $E/p2-keyboard-window-2/keyboard-window-2.config.mjs --project chromium-dark-desktop --grep-invert " select-"
# The control for kw2-other-del: every failure there is an antd-* target whose element P6 deleted from the fixtures;
# the same suite on the starting tree (no fix) must fail the same ones.
run kw2-other-ref $V/v/exp-pre env KW2_BURST=1 KW2_PACED=1 KW2_RESULTS=$R/kw2-other-ref-out \
  npx playwright test --config $E/p2-keyboard-window-2/keyboard-window-2.config.mjs --project chromium-dark-desktop --grep-invert " select-"
run merge-check $WT bash -c 'cd ../.. && npm run build -w @orbit/web && npm run test -w @orbit/web'
echo "suites.sh done (FILTER='$FILTER') $(date -u +%FT%TZ)"
