#!/usr/bin/env bash
# The session-release protocol walk (docs/session-three-state-plan.md step 6.2), end to end on an isolated stack
# (loopback only, never production): the landing-measured kit's stack (postgres, apiserver, web, link gateway, NATS,
# images built from this checkout) under a Compose project and ports of its own, and two real runners against it, each
# with the kit's fake claude as its only engine:
#
#   old   `go build` of src/runner-go at SR_OLD_REF (default: where this branch leaves the project branch), which
#         speaks the old protocol
#   new   `go build` of this checkout, which speaks the new one while its server says it offers it
#
# scenario.mjs turns the apiserver's switch ORBIT_SESSION_RELEASE_V1 on, walks both runners through a failed turn, an
# ended session, a resume, a retryable failure and a swallowed delivery, walks the new runner through a failed turn
# whose release never arrives (killed after its turn report), then turns the switch off and walks the new runner
# through the same cases again. It compares the stored rows case by case and prints every query it made. Records go to
# $LM_DIR/records/<run>/session-release/.
#
#   bash scripts/acceptance/session-release/run.sh
#   LM_PROJECT=orbit-link-relwalk LM_HTTP_PORT=53086 ... bash scripts/acceptance/landing-measured/stack.sh down
set -euo pipefail
HERE=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
KIT=$REPO/scripts/acceptance/landing-measured
export LM_PROJECT=${LM_PROJECT:-orbit-link-relwalk}
export LM_HTTP_PORT=${LM_HTTP_PORT:-53086} LM_LINK_PORT=${LM_LINK_PORT:-53443} LM_METRICS_PORT=${LM_METRICS_PORT:-53464}
export LM_NATS_PORT=${LM_NATS_PORT:-53422} LM_NATS_MONITOR_PORT=${LM_NATS_MONITOR_PORT:-53822} LM_PEBBLE_PORT=${LM_PEBBLE_PORT:-53500}
export LM_DIR=${LM_DIR:-/var/tmp/$LM_PROJECT}
export LM_RUN=${LM_RUN:-$(date -u +%m%d%H%M%S)}
SR_OLD_REF=${SR_OLD_REF:-$(git -C "$REPO" merge-base HEAD origin/project/3508bDBDE5xPH43TYuiqP)}
export SR_OLD_SHA=$(git -C "$REPO" rev-parse "$SR_OLD_REF")
export SR_NEW_SHA=$(git -C "$REPO" rev-parse HEAD)
mkdir -p "$LM_DIR/logs" "$LM_DIR/bin"
echo "source (new runner, server): $SR_NEW_SHA"
echo "old runner: $SR_OLD_SHA"
git -C "$REPO" log --oneline -1 "$SR_NEW_SHA"
git -C "$REPO" log --oneline -1 "$SR_OLD_SHA"

bash "$KIT/stack.sh" up > "$LM_DIR/logs/up-$LM_RUN.log" 2>&1 || { tail -40 "$LM_DIR/logs/up-$LM_RUN.log"; exit 1; }
grep -E 'building the apiserver|staging stack .* is up' "$LM_DIR/logs/up-$LM_RUN.log" || true

bash "$KIT/stack.sh" build-runner
# The old runner, from the tree at SR_OLD_SHA (src/runner-go is a module of its own).
rm -rf "$LM_DIR/old-src" && mkdir -p "$LM_DIR/old-src"
git -C "$REPO" archive "$SR_OLD_SHA" src/runner-go | tar -x -C "$LM_DIR/old-src"
ver=$(node -e 'console.log(require(process.argv[1]).version)' "$REPO/package.json")
(cd "$LM_DIR/old-src/src/runner-go" && CGO_ENABLED=0 go build -trimpath -buildvcs=false \
   -ldflags "-s -w -X main.version=$ver -X main.sourceSHA=$SR_OLD_SHA" -o "$LM_DIR/bin/orbit-old" .)
echo "old runner $("$LM_DIR/bin/orbit-old" --version) built from $SR_OLD_SHA"
if grep -q -a 'session-release/v1' "$LM_DIR/bin/orbit-old"; then echo "the old runner names session-release/v1: SR_OLD_REF is not the old protocol"; exit 1; fi
grep -q -a 'session-release/v1' "$LM_DIR/bin/orbit" || { echo "the new runner does not name session-release/v1"; exit 1; }

for r in old new; do LM_RUNNER=$r bash "$KIT/stack.sh" stop-runner || true; done
node "$HERE/scenario.mjs"
