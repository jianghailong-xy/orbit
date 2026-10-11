#!/usr/bin/env bash
# dev-all.sh [PROJECT...]: dev runs of the spec on both trees for each project (default: light desktop and phone), in turn.
S=/mnt/data/tmp/34Za39J4QY3kDa5p2Wsau/scripts
projects=("$@"); [ ${#projects[@]} -eq 0 ] && projects=(chromium-light-desktop chromium-light-phone)
for p in "${projects[@]}"; do
  for t in del ref; do
    echo "== $t $p $(date -u +%H:%M:%S)"; "$S/dev-run.sh" "$t" "$p" | grep -E "exit=|passed|failed|✘" | head -8
    # the copied spec files would block the next make-trees checkout
    d=/mnt/data/tmp/34Za39J4QY3kDa5p2Wsau/v1/$t/src/web/ui-migration
    git -C "$d" checkout -q -- p44-fixtures.mjs p44.browser.mjs p44.config.mjs playwright.config.mjs 2>/dev/null
  done
done
echo "done $(date -u +%H:%M:%S)"
