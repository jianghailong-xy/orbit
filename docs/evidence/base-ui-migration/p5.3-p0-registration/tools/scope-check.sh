#!/usr/bin/env bash
# Usage: scope-check.sh <registration commit> [head]   (p4.1-accepted/tools/scope-check.sh for P5.3)
# What the registration commit touches, and that nothing protected changed from the project tip it started on
# (a167c2ff0) to <head>: the P0.2 originals and environment, the main drift reference layer, the P0 harness
# (scenarios, assertions, fixtures, comparator options, known-failures) and the expected-screenshot assembly,
# and the product code (src/).
set -uo pipefail
REPO=${REPO:-$(cd "$(dirname "$0")" && git rev-parse --show-toplevel)}
REG=$1 HEAD_=${2:-HEAD}
START=a167c2ff0e5bc728f2766f34c90a799c7e6a74a0
cd "$REPO"
echo "registration $(git rev-parse "$REG"), parent $(git rev-parse "$REG^"), head $(git rev-parse "$HEAD_")"
echo "## files the registration commit changes"
git diff --name-status "$REG^" "$REG"
outside=$(git diff --name-only "$REG^" "$REG" | grep -v -E '^docs/evidence/base-ui-migration/p0-drift/(accepted/|README\.md$)' || true)
echo "outside p0-drift/accepted/ and p0-drift/README.md: [${outside}]"
echo "## p0-drift/README.md lines the registration changes"
git diff -U0 "$REG^" "$REG" -- docs/evidence/base-ui-migration/p0-drift/README.md | grep -E '^[-+][^-+]' | cut -c1-160
BASE=$(git rev-parse "$REG^")
echo "## catching up with main: the registration's parent $BASE (origin/main) contains the project tip $START"
git merge-base --is-ancestor "$START" "$BASE" && echo "contains: yes ($(git log --format='%h %s' --merges --first-parent "$START..$BASE" | grep -F "$(git rev-parse --short=9 "$START")" || git log --format='%h %p' --merges "$START..$BASE" | grep -m1 "$(git rev-parse --short=9 "$START")"))"
echo "main's changes beyond the tip, $START..$BASE: $(git diff --shortstat "$START" "$BASE")"
git diff --name-only "$START" "$BASE" | awk -F/ '{ k = ($1 == "src") ? $1 "/" $2 : $1; n[k]++ } END { for (k in n) print "  " k ": " n[k] " files" }' | sort
echo "  under src/web, src/shared, the lockfile or docs/evidence: [$(git diff --name-only "$START" "$BASE" -- src/web src/shared package-lock.json docs/evidence | tr '\n' ' ')]"
echo "## protected paths, $START..$HEAD_ (empty = unchanged)"
for p in docs/evidence/base-ui-migration/p0.2 docs/evidence/base-ui-migration/p0-drift/reference src/web/ui-migration src/web/package.json; do
  echo "$p: [$(git diff --stat "$START" "$HEAD_" -- "$p" | tail -1)]"
done
echo "## product code changed by this task's commits, $BASE..$HEAD_ (empty = none)"
echo "src: [$(git diff --stat "$BASE" "$HEAD_" -- src | tail -1)]"
echo "## known-failures and comparator options at $HEAD_ (unchanged from $START)"
for f in src/web/ui-migration/known-failures.browser.mjs src/web/ui-migration/playwright.config.mjs src/web/ui-migration/expected-screenshots.mjs; do
  echo "$f $(git rev-parse "$START:$f" 2>/dev/null) -> $(git rev-parse "$HEAD_:$f" 2>/dev/null)"
done
git show "$HEAD_:src/web/ui-migration/playwright.config.mjs" | grep -n -E 'maxDiffPixels|threshold' || true
echo "## accepted layer: entries other than P5.3's unchanged"
diff <(git show "$START:docs/evidence/base-ui-migration/p0-drift/accepted/registry.json" | jq -S '.screenshots') \
     <(git show "$HEAD_:docs/evidence/base-ui-migration/p0-drift/accepted/registry.json" | jq -S '[.screenshots[] | select(.decision.taskId != "34Za39Ov1yysHZaYL6wgJ")]') \
  && echo "other entries identical"
echo "## commits after the registration (each touches only docs/evidence/base-ui-migration/p5.3-p0-registration/)"
git log --format='%h %s' "$REG..$HEAD_"
echo "outside p5.3-p0-registration after the registration: [$(git diff --name-only "$REG" "$HEAD_" | grep -v '^docs/evidence/base-ui-migration/p5.3-p0-registration/' | tr '\n' ' ')]"
