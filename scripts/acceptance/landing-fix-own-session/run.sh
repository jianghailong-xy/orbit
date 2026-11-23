#!/usr/bin/env bash
# Revision 42 part one end to end (docs/project-integration-line-contract.md §12.1–§12.8), on an isolated stack of its
# own: start or converge the stack from this checkout, build and (re)start the runner from it, then the three cases of
# cases.mjs in one project on a project branch. The stack, the runner and the fake engine are part two's kit
# (scripts/acceptance/landing-measured/), under another Compose project, directory and port range so the two never meet.
# Every query the run records is printed at the end, so this job's output carries the rows. Exit 0 only if every check
# passed.
#
#   bash scripts/acceptance/landing-fix-own-session/run.sh     # LM_RUN tags the project title (default: a timestamp)
#   LM_PROJECT=orbit-link-lfx42 LM_DIR=/mnt/tmp/tmp/lfx42 LM_HTTP_PORT=48086 ... \
#     bash scripts/acceptance/landing-measured/stack.sh down   # afterwards: stop the runner, remove the stack
#
# The image build compiles the apiserver (a heavy step): it runs under LFX_HEAVY_LOCK (flock) when that file exists.
set -uo pipefail
HERE=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)
KIT=$(cd "$HERE/../landing-measured" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
export LM_PROJECT=${LM_PROJECT:-orbit-link-lfx42}
export LM_DIR=${LM_DIR:-/mnt/tmp/tmp/lfx42}
export LM_HTTP_PORT=${LM_HTTP_PORT:-48086} LM_LINK_PORT=${LM_LINK_PORT:-48443} LM_METRICS_PORT=${LM_METRICS_PORT:-48464}
export LM_NATS_PORT=${LM_NATS_PORT:-48422} LM_NATS_MONITOR_PORT=${LM_NATS_MONITOR_PORT:-48822} LM_PEBBLE_PORT=${LM_PEBBLE_PORT:-48500}
export LM_RUN=${LM_RUN:-$(date -u +%m%d%H%M%S)}
LOCK=${LFX_HEAVY_LOCK:-/mnt/tmp/34bc-hpc-heavy.lock}
step() { echo; echo "######## $(date -u +%FT%TZ) $*"; }
heavy() { if [ -f "$LOCK" ]; then flock "$LOCK" "$@"; else "$@"; fi; }

step "source: $(git -C "$REPO" rev-parse HEAD) on $(git -C "$REPO" rev-parse --abbrev-ref HEAD); stack $LM_PROJECT in $LM_DIR"
git -C "$REPO" log --oneline -1
set -e
mkdir -p "$LM_DIR/logs"
step "stack up (images built from this checkout; heavy lock $LOCK)"
heavy bash "$KIT/stack.sh" up > "$LM_DIR/logs/up-$LM_RUN.log" 2>&1 || { tail -40 "$LM_DIR/logs/up-$LM_RUN.log"; exit 1; }
grep -E 'building the apiserver|staging stack .* is up' "$LM_DIR/logs/up-$LM_RUN.log" || true
bash "$KIT/stack.sh" status
docker inspect --format '{{.Name}} {{.Image}} {{.Created}}' "$LM_PROJECT-apiserver" "$LM_PROJECT-web"
step "runner: build from this checkout and restart"
heavy bash "$KIT/stack.sh" build-runner
bash "$KIT/stack.sh" stop-runner
bash "$KIT/stack.sh" start-runner || echo "(not registered yet: bootstrap registers it)"
cd "$KIT"
node bootstrap.mjs lfx-line | grep -E '^(runner|workspace) |"version"' || true
set +e
step "the three cases (run $LM_RUN)"
node "$HERE/cases.mjs"; rc=$?
step "recorded queries ($LM_DIR/records/$LM_RUN/lfx-cases/queries.txt)"
cat "$LM_DIR/records/$LM_RUN/lfx-cases/queries.txt"
step "result: cases.mjs exit $rc"
exit "$rc"
