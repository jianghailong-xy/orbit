#!/usr/bin/env bash
# red-green.sh: the two new resident specs on the reference (this batch's product files reverted) and on the delivery,
# all eight environments: they must fail on the reference and pass on the delivery. One step at a time (step.sh).
S=$(cd "$(dirname "$0")" && pwd)
V=/mnt/data/tmp/34coPBk43ULRuisicUTAy
R=$V/runs
for t in ref del; do
  "$S/step.sh" close-hover-$t "$V/$t" env P32_BASE_CONFIG=overlays.config.mjs P32_PORT=4511 P32_OUTPUT="$R/close-hover-$t-out" \
    npx playwright test --config ui-migration/port.config.mjs ui-migration/overlays-close-hover.browser.mjs
  [ $? -eq 3 ] && exit 3
done
for t in ref del; do
  "$S/step.sh" first-option-$t "$V/$t" env P32_BASE_CONFIG=choices.config.mjs P32_PORT=4512 P32_OUTPUT="$R/first-option-$t-out" \
    npx playwright test --config ui-migration/port.config.mjs ui-migration/choices-first-option.browser.mjs
  [ $? -eq 3 ] && exit 3
done
exit 0
