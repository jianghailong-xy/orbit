#!/usr/bin/env bash
# Usage: scope-check.sh <registration commit> [head]
# What the registration commit touches, and that nothing protected changed from the project tip it started on
# (b2568f28d) to <head>: the P0.2 originals and environment, the main drift reference layer, the P0 harness
# (scenarios, assertions, fixtures, comparator options, known-failures, expected-screenshot assembly) and the rest
# of src/. p4.1-accepted/tools/scope-check.sh adapted to this registration.
set -uo pipefail
REPO=${REPO:-$(cd "$(dirname "$0")" && git rev-parse --show-toplevel)}
REG=$1 HEAD_=${2:-HEAD}
START=b2568f28d8bb87d12eec762d1f810562503ed2d9
TASK=34cBi0yt6bFcSmbJFgDPj
cd "$REPO"
echo "registration $(git rev-parse "$REG"), parent $(git rev-parse "$REG^"), head $(git rev-parse "$HEAD_")"
echo "## files the registration commit changes"
git diff --name-status "$REG^" "$REG"
outside=$(git diff --name-only "$REG^" "$REG" | grep -v -E '^docs/evidence/base-ui-migration/p0-drift/(accepted/|README\.md$)' || true)
echo "outside p0-drift/accepted/ and p0-drift/README.md: [${outside}]"
echo "## p0-drift/README.md lines the registration changes"
git diff -U0 "$REG^" "$REG" -- docs/evidence/base-ui-migration/p0-drift/README.md | grep -E '^[-+][^-+]' | cut -c1-200
echo "## protected paths, $START..$HEAD_ (empty = unchanged)"
for p in docs/evidence/base-ui-migration/p0.2 docs/evidence/base-ui-migration/p0-drift/reference src/web/ui-migration src/web/package.json src package.json package-lock.json; do
  echo "$p: [$(git diff --stat "$START" "$HEAD_" -- "$p" | tail -1)]"
done
echo "## accepted layer: entries of other batches unchanged; the earlier P4.1 entry kept as previous"
reg() { git show "$1:docs/evidence/base-ui-migration/p0-drift/accepted/registry.json"; }
diff <(reg "$START" | jq -S '[.screenshots[] | select(.decision.taskId != "'$TASK'" and .screenshot != "webkit-dark-phone/profile-validation.png")]') \
     <(reg "$HEAD_" | jq -S '[.screenshots[] | select(.decision.taskId != "'$TASK'")]') \
  && echo "other entries identical ($(reg "$HEAD_" | jq '[.screenshots[] | select(.decision.taskId != "'$TASK'")] | length') entries)"
diff <(reg "$START" | jq -S '[.screenshots[] | select(.screenshot == "webkit-dark-phone/profile-validation.png") | {sha256, decision, difference, sameCommit}]') \
     <(reg "$HEAD_" | jq -S '[.screenshots[] | select(.screenshot == "webkit-dark-phone/profile-validation.png") | .previous[]]') \
  && echo "webkit-dark-phone/profile-validation: previous = the P4.1 entry at $START"
echo "entries: $(reg "$START" | jq '.screenshots | length') at start, $(reg "$HEAD_" | jq '.screenshots | length') at head, $(reg "$HEAD_" | jq '[.screenshots[] | select(.decision.taskId == "'$TASK'")] | length') of $TASK"
echo "## commits after the registration (each touches only docs/evidence/base-ui-migration/webkit-scroll-lock-accepted/)"
git log --format='%h %s' "$REG..$HEAD_"
echo "outside webkit-scroll-lock-accepted after the registration: [$(git diff --name-only "$REG" "$HEAD_" | grep -v '^docs/evidence/base-ui-migration/webkit-scroll-lock-accepted/' | tr '\n' ' ')]"
