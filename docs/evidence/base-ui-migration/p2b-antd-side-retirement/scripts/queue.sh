#!/usr/bin/env bash
# queue.sh before|after: the runs of this task, one at a time through step.sh (serial, 6G scope, own netns).
#   before: kw2-sel-before (tip, 3+3 selects), kw2-oth-before (tip, 1+1 non-select, the 88 red baseline),
#           kw2-oth-ref-before (743d21ab2, 1+1 non-select, the same reds on the starting tree)
#   after:  the same three / with the antd-* targets retired, plus kw1-after (keyboard-window batch 1),
#           sk-after (select-keys) and merge-check (web build + full Vitest)
set -u
V=/mnt/data/tmp/34dq7m9wxKsEaWbvtNqk2
R=$V/runs
WT=/root/.orbit/worktrees/9492e7a5-a50c-5c6e-bd00-33a8246c5b34
E=$WT/docs/evidence/base-ui-migration
REF=$V/v/ref-743d21ab2
EREF=$REF/docs/evidence/base-ui-migration
KW2=$E/p2-keyboard-window-2/keyboard-window-2.config.mjs
KW2REF=$EREF/p2-keyboard-window-2/keyboard-window-2.config.mjs
KW1=$E/p2-keyboard-window/keyboard-window.config.mjs
SK=$E/p2-select-keys/select-keys-burst.config.mjs
SEL_BEFORE='(orbit-field|orbit-sample|antd-sample) select-'
SEL_AFTER='(orbit-field|orbit-sample) select-'
phase=${1:?usage: queue.sh before|after}

if [ "$phase" = before ]; then
  $V/step.sh kw2-sel-before $WT env KW2_BURST=3 KW2_PACED=3 KW2_RESULTS=$R/kw2-sel-before-out \
    npx playwright test --config $KW2 --project chromium-dark-desktop --grep "$SEL_BEFORE"
  $V/step.sh kw2-oth-before $WT env KW2_BURST=1 KW2_PACED=1 KW2_RESULTS=$R/kw2-oth-before-out \
    npx playwright test --config $KW2 --project chromium-dark-desktop --grep-invert " select-"
  $V/step.sh kw2-oth-ref-before $REF env KW2_BURST=1 KW2_PACED=1 KW2_RESULTS=$R/kw2-oth-ref-before-out \
    npx playwright test --config $KW2REF --project chromium-dark-desktop --grep-invert " select-"
else
  $V/step.sh kw2-sel-after $WT env KW2_BURST=3 KW2_PACED=3 KW2_RESULTS=$R/kw2-sel-after-out \
    npx playwright test --config $KW2 --project chromium-dark-desktop --grep "$SEL_AFTER"
  $V/step.sh kw2-oth-after $WT env KW2_BURST=1 KW2_PACED=1 KW2_RESULTS=$R/kw2-oth-after-out \
    npx playwright test --config $KW2 --project chromium-dark-desktop --grep-invert " select-"
  # the ref tree runs the RETIRED probe; copy the delivered file over its own (the config above reads this path)
  $V/step.sh ref-copy-after $REF cp $E/p2-keyboard-window-2/keyboard-window-2.browser.mjs \
    $EREF/p2-keyboard-window-2/keyboard-window-2.browser.mjs
  $V/step.sh kw2-oth-ref-after $REF env KW2_BURST=1 KW2_PACED=1 KW2_RESULTS=$R/kw2-oth-ref-after-out \
    npx playwright test --config $KW2REF --project chromium-dark-desktop --grep-invert " select-"
  $V/step.sh kw1-after $WT env MOVE_RESULTS=src/web/.choices-results/p2-keyboard-window \
    npx playwright test --config $KW1 --project chromium-dark-desktop --grep "$SEL_AFTER[a-z0-9-]+ (burst|paced) sample [0-2]\$"
  $V/step.sh kw1-other-after $WT env MOVE_RESULTS=src/web/.choices-results/p2-keyboard-window \
    npx playwright test --config $KW1 --project chromium-dark-desktop --grep-invert " select-" --grep "(burst|paced) sample 0\$"
  $V/step.sh sk-after $WT env MOVE_RESULTS=src/web/.choices-results/p2-select-keys-burst \
    npx playwright test --config $SK --project chromium-dark-desktop
  $V/step.sh merge-check $WT bash -c 'cd ../.. && npm run build -w @orbit/web && npm run test -w @orbit/web'
fi
echo "queue.sh $phase done $(date -u +%FT%TZ)"
