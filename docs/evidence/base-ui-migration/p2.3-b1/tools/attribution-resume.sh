#!/usr/bin/env bash
# Usage: attribution-resume.sh — attribution-runs.sh without its build step, skipping runs whose
# output already ends with '# exit 0' (the runner drained the first attempt part-way).
set -uo pipefail
B=/var/tmp/p23b1
done_ok() { tail -1 "$B/runs/$1/output.txt" 2>/dev/null | grep -q '^# exit 0'; }
DESK=(--project=chromium-light-desktop --project=chromium-dark-desktop --project=webkit-light-desktop --project=webkit-dark-desktop)
for sha in 383594ee2 4920dab40 0982d8ed8 dcfb5adf6 51f0cdfee be0f8c22a b2e05492f 30cf89786 f86211ec3; do
  done_ok "attr-breakpoints-$sha" || { rm -rf "$B/runs/attr-breakpoints-$sha"; B1_MATCH=breakpoints.browser.mjs "$B/scripts/run-diag.sh" "m-$sha" "attr-breakpoints-$sha" "${DESK[@]}"; }
done
for sha in 85b18b646 86c6d2d4d; do done_ok "attr-profile-$sha" || { rm -rf "$B/runs/attr-profile-$sha"; B1_MATCH=pages.browser.mjs "$B/scripts/run-diag.sh" "m-$sha" "attr-profile-$sha" -g 'profile$'; }; done
for sha in 51f0cdfee be0f8c22a; do [ -f "$B/runs/attr-wiki-$sha/output.txt" ] && grep -q '^# exit' "$B/runs/attr-wiki-$sha/output.txt" || { rm -rf "$B/runs/attr-wiki-$sha"; B1_MATCH=pages.browser.mjs "$B/scripts/run-diag.sh" "m-$sha" "attr-wiki-$sha" -g 'wiki$'; }; done
echo "attribution runs done"
