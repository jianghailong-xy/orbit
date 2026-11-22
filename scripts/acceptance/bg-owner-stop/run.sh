#!/usr/bin/env bash
# The owner's stop of one bg_run job, end to end on an isolated stack (loopback only, never production): the
# landing-measured kit's stack (scripts/acceptance/landing-measured/stack.sh: postgres, apiserver, web, link gateway,
# NATS, images built from this checkout) under a Compose project and ports of its own, and a runner `go build` from
# this checkout whose only engine is the kit's fake claude. scenario.mjs drives it; records go to
# $LM_DIR/records/<run>/bg-owner-stop/.
#
#   bash scripts/acceptance/bg-owner-stop/run.sh
#   LM_PROJECT=orbit-link-bgstop LM_HTTP_PORT=48086 ... bash scripts/acceptance/landing-measured/stack.sh down
set -euo pipefail
HERE=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
KIT=$REPO/scripts/acceptance/landing-measured
export LM_PROJECT=${LM_PROJECT:-orbit-link-bgstop}
export LM_HTTP_PORT=${LM_HTTP_PORT:-48086} LM_LINK_PORT=${LM_LINK_PORT:-48443} LM_METRICS_PORT=${LM_METRICS_PORT:-48464}
export LM_NATS_PORT=${LM_NATS_PORT:-48422} LM_NATS_MONITOR_PORT=${LM_NATS_MONITOR_PORT:-48822} LM_PEBBLE_PORT=${LM_PEBBLE_PORT:-48500}
export LM_DIR=${LM_DIR:-/var/tmp/$LM_PROJECT}
export LM_RUN=${LM_RUN:-$(date -u +%m%d%H%M%S)}
mkdir -p "$LM_DIR/logs"
echo "source: $(git -C "$REPO" rev-parse HEAD)"
bash "$KIT/stack.sh" up > "$LM_DIR/logs/up-$LM_RUN.log" 2>&1 || { tail -40 "$LM_DIR/logs/up-$LM_RUN.log"; exit 1; }
bash "$KIT/stack.sh" build-runner
bash "$KIT/stack.sh" stop-runner
bash "$KIT/stack.sh" start-runner || echo "(not registered yet: bootstrap registers it)"
(cd "$KIT" && node bootstrap.mjs bgstop | grep -E '^(runner|workspace) |"version"' || true)
node "$HERE/scenario.mjs"
