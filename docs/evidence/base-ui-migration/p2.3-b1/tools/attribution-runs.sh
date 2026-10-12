#!/usr/bin/env bash
# Usage: attribution-runs.sh — same-environment checks that name the main commit behind each new P0
# failure on the project tip: the unchanged P0 tests of the project tip (runner trees/tip) against the
# production builds of main first-parent commits before/after each attributed merge. Screenshots are
# written as actuals (--update-snapshots=all) and compared afterwards; a locator failure fails the test.
set -uo pipefail
B=/var/tmp/p23b1
build() { for sha in "$@"; do "$B/scripts/prepare-tree.sh" "$sha" "m-$sha" & done; wait; }
build 85b18b646 86c6d2d4d 383594ee2 4920dab40
build 0982d8ed8 dcfb5adf6 51f0cdfee be0f8c22a
build b2e05492f 30cf89786 f86211ec3
DESK=(--project=chromium-light-desktop --project=chromium-dark-desktop --project=webkit-light-desktop --project=webkit-dark-desktop)
for sha in 383594ee2 4920dab40 0982d8ed8 dcfb5adf6 51f0cdfee be0f8c22a b2e05492f 30cf89786 f86211ec3; do
  B1_MATCH=breakpoints.browser.mjs "$B/scripts/run-diag.sh" "m-$sha" "attr-breakpoints-$sha" "${DESK[@]}"
done
for sha in 85b18b646 86c6d2d4d; do B1_MATCH=pages.browser.mjs "$B/scripts/run-diag.sh" "m-$sha" "attr-profile-$sha" -g 'profile$'; done
for sha in 51f0cdfee be0f8c22a; do B1_MATCH=pages.browser.mjs "$B/scripts/run-diag.sh" "m-$sha" "attr-wiki-$sha" -g 'wiki$'; done
echo "attribution runs done"
