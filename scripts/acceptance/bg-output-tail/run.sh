#!/usr/bin/env bash
# The owner's read of a running bg_run job's newest lines, end to end on an isolated stack (loopback only, never production): the
# landing-measured kit's stack (scripts/acceptance/landing-measured/stack.sh: postgres, apiserver, web, link gateway,
# NATS, images built from this checkout) under a Compose project and ports of its own, and a runner `go build` from
# this checkout whose only engine is the kit's fake claude. scenario.mjs drives it; records go to
# $LM_DIR/records/<run>/bg-output-tail/.
#
#   bash scripts/acceptance/bg-output-tail/run.sh
#   LM_PROJECT=orbit-link-bgtail LM_HTTP_PORT=48087 ... bash scripts/acceptance/landing-measured/stack.sh down
set -euo pipefail
HERE=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
KIT=$REPO/scripts/acceptance/landing-measured
export LM_PROJECT=${LM_PROJECT:-orbit-link-bgtail}
export LM_HTTP_PORT=${LM_HTTP_PORT:-48087} LM_LINK_PORT=${LM_LINK_PORT:-48444} LM_METRICS_PORT=${LM_METRICS_PORT:-48465}
export LM_NATS_PORT=${LM_NATS_PORT:-48423} LM_NATS_MONITOR_PORT=${LM_NATS_MONITOR_PORT:-48823} LM_PEBBLE_PORT=${LM_PEBBLE_PORT:-48501}
export LM_DIR=${LM_DIR:-/var/tmp/$LM_PROJECT}
export LM_RUN=${LM_RUN:-$(date -u +%m%d%H%M%S)}
mkdir -p "$LM_DIR/logs"
echo "source: $(git -C "$REPO" rev-parse HEAD)"
bash "$KIT/stack.sh" up > "$LM_DIR/logs/up-$LM_RUN.log" 2>&1 || { tail -40 "$LM_DIR/logs/up-$LM_RUN.log"; exit 1; }
bash "$KIT/stack.sh" build-runner
bash "$KIT/stack.sh" stop-runner
bash "$KIT/stack.sh" start-runner || echo "(not registered yet: bootstrap registers it)"
(cd "$KIT" && node bootstrap.mjs bgtail | grep -E '^(runner|workspace) |"version"' || true)
node "$HERE/scenario.mjs"
