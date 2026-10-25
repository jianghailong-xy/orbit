#!/usr/bin/env bash
# Where each negative control's actual differs from the newly registered expectation it failed against: the failure's
# expected and actual images (the expected one must be the registered after original in p0-drift/accepted/screenshots)
# laid out as {project}/{name}.png, then p3.2-accepted/tools/regions.py (differing pixels, those beyond 2 levels and
# their clusters, crops of expected | actual | difference x4). Writes /mnt/data/tmp/34cfhmpygHQdZxRznyVH9/regions/.
set -euo pipefail
WT=/root/.orbit/worktrees/63507a7e-d688-5155-900e-de51850b6416
S=/mnt/data/tmp/34cfhmpygHQdZxRznyVH9; R=$S/runs; OUT=$S/regions
ACC=$WT/docs/evidence/base-ui-migration/p0-drift/accepted/screenshots
REGIONS="python3 -I $WT/docs/evidence/base-ui-migration/p3.2-accepted/tools/regions.py"
rm -rf $OUT $S/regions-input; mkdir -p $OUT
run() { # <control> <test> <screenshot name>
  local c=$1 test=$2 name=$3 shots=()
  for p in webkit-light-desktop webkit-dark-desktop webkit-dark-phone; do
    local f=$R/nc-$c/failures/pages.browser.mjs-$test-$p
    mkdir -p $S/regions-input/nc-$c/expected/$p $S/regions-input/nc-$c/actual/$p
    cp $f/$name-expected.png $S/regions-input/nc-$c/expected/$p/$name.png
    cp $f/$name-actual.png $S/regions-input/nc-$c/actual/$p/$name.png
    cmp $f/$name-expected.png $ACC/$p/$name.png && echo "nc-$c $p/$name: expected = the registered accepted image"
    shots+=("$p/$name.png")
  done
  $REGIONS $OUT/nc-$c.json $OUT/nc-$c-crops $S/regions-input/nc-$c/expected $S/regions-input/nc-$c/actual "${shots[@]}"
}
run pill settings settings-saved
run error-card session notification-error
