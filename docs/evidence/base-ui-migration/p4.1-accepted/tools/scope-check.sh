#!/usr/bin/env bash
# Usage: scope-check.sh <registration commit> [head]
# What the registration commit touches, and that nothing protected changed from the project tip it started on
# (3aa26fb97) to <head>: the P0.2 originals and environment, the main drift reference layer, the P0 harness
# (scenarios, assertions, fixtures, comparator options, known-failures) and the expected-screenshot assembly.
set -uo pipefail
REPO=${REPO:-$(cd "$(dirname "$0")" && git rev-parse --show-toplevel)}
REG=$1 HEAD_=${2:-HEAD}
START=3aa26fb97644f24551dc9c70149021f7f7f9453f
cd "$REPO"
echo "registration $(git rev-parse "$REG"), parent $(git rev-parse "$REG^"), head $(git rev-parse "$HEAD_")"
echo "## files the registration commit changes"
git diff --name-status "$REG^" "$REG"
outside=$(git diff --name-only "$REG^" "$REG" | grep -v -E '^docs/evidence/base-ui-migration/p0-drift/(accepted/|README\.md$)' || true)
echo "outside p0-drift/accepted/ and p0-drift/README.md: [${outside}]"
echo "## p0-drift/README.md lines the registration changes"
git diff -U0 "$REG^" "$REG" -- docs/evidence/base-ui-migration/p0-drift/README.md | grep -E '^[-+][^-+]' | cut -c1-160
echo "## protected paths, $START..$HEAD_ (empty = unchanged)"
for p in docs/evidence/base-ui-migration/p0.2 docs/evidence/base-ui-migration/p0-drift/reference src/web/ui-migration src/web/package.json; do
  echo "$p: [$(git diff --stat "$START" "$HEAD_" -- "$p" | tail -1)]"
done
echo "## accepted layer: entries other than P4.1's unchanged"
diff <(git show "$START:docs/evidence/base-ui-migration/p0-drift/accepted/registry.json" | jq -S '.screenshots') \
     <(git show "$HEAD_:docs/evidence/base-ui-migration/p0-drift/accepted/registry.json" | jq -S '[.screenshots[] | select(.decision.taskId != "34Za39Do3N6tkmIMP0GBP")]') \
  && echo "other entries identical"
echo "## commits after the registration (each touches only docs/evidence/base-ui-migration/p4.1-accepted/)"
git log --format='%h %s' "$REG..$HEAD_"
echo "outside p4.1-accepted after the registration: [$(git diff --name-only "$REG" "$HEAD_" | grep -v '^docs/evidence/base-ui-migration/p4.1-accepted/' | tr '\n' ' ')]"
