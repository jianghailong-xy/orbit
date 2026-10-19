#!/usr/bin/env bash
# export-shots.sh: probe-export-shots.browser.mjs on both scratch trees, all eight projects (the exported file is
# static, so the tree's preview server the probe config starts serves nothing it reads).
set -u
V=/mnt/data/tmp/34blYpxEcHMAf4oafuC2W
for t in ref del; do
  mkdir -p $V/extra/export/shots/$t
  EXPORT_DIR=$V/extra/export EXPORT_SHOTS=$V/extra/export/shots PROBE_GREP='PROBE|passed|failed|Error' \
    bash $V/scripts/probe-aux.sh probe-export-shots.browser.mjs $t chromium-light-desktop chromium-dark-desktop chromium-light-phone chromium-dark-phone \
    webkit-light-desktop webkit-dark-desktop webkit-light-phone webkit-dark-phone > $V/extra/probes/probe-export-shots-$t.txt 2>&1
  echo "== $t: $(grep -E '[0-9]+ (passed|failed)' $V/extra/probes/probe-export-shots-$t.txt | tr -s ' ' | tr '\n' ' ')"
done
