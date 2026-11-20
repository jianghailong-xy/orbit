#!/usr/bin/env bash
# Revision 42 part two end to end (docs/project-integration-line-contract.md §12.15), on the isolated stack: start or
# converge the stack from this checkout, build and (re)start the runner from it, then project A (operations, nothing
# committed) and project B (mixed, landing check set by the coordinator, one task exempt). Every query a scenario
# records is printed at the end, so this job's output carries the rows. Exit 0 only if both scenarios passed.
#
#   bash scripts/acceptance/landing-measured/run.sh            # LM_RUN tags the project titles (default: a timestamp)
#   bash scripts/acceptance/landing-measured/stack.sh down     # afterwards: stop the runner, remove the stack
set -uo pipefail
HERE=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
export LM_RUN=${LM_RUN:-$(date -u +%m%d%H%M%S)}
LM_DIR=${LM_DIR:-/var/tmp/${LM_PROJECT:-orbit-link-lm42}}
step() { echo; echo "######## $(date -u +%FT%TZ) $*"; }

step "source: $(git -C "$REPO" rev-parse HEAD) on $(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
git -C "$REPO" log --oneline -1
set -e
step "stack up (images built from this checkout)"
mkdir -p "$LM_DIR/logs"
bash "$HERE/stack.sh" up > "$LM_DIR/logs/up-$LM_RUN.log" 2>&1 || { tail -40 "$LM_DIR/logs/up-$LM_RUN.log"; exit 1; }
grep -E 'building the apiserver|staging stack .* is up' "$LM_DIR/logs/up-$LM_RUN.log"
bash "$HERE/stack.sh" status
docker inspect --format '{{.Name}} {{.Image}} {{.Created}}' "${LM_PROJECT:-orbit-link-lm42}-apiserver" "${LM_PROJECT:-orbit-link-lm42}-web"
step "runner: build from this checkout and restart"
bash "$HERE/stack.sh" build-runner
bash "$HERE/stack.sh" stop-runner
bash "$HERE/stack.sh" start-runner || echo "(not registered yet: bootstrap registers it)"
cd "$HERE"
node bootstrap.mjs lm-ops lm-mixed | grep -E '^(runner|workspace) |"version"' || true
set +e
step "project A: operations, nothing committed (run $LM_RUN)"
node a-ops.mjs; a=$?
step "project B: mixed, coordinator landing check, one exempt (run $LM_RUN)"
node b-mixed.mjs; b=$?
for s in a-ops b-mixed; do
  step "recorded queries: $s ($LM_DIR/records/$LM_RUN/$s/queries.txt)"
  cat "$LM_DIR/records/$LM_RUN/$s/queries.txt"
done
step "result: project A exit $a, project B exit $b"
[ "$a" = 0 ] && [ "$b" = 0 ]
