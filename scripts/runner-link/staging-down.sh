#!/usr/bin/env bash
# Stops the runner link staging stack that staging-up.sh started (README.md beside this file). It removes the
# containers and the project's network and keeps the state directory, so the next staging-up.sh comes back with the
# same database, secrets, certificates and seeded account.
#
#   scripts/runner-link/staging-down.sh           # stop; keep the state directory and the images
#   scripts/runner-link/staging-down.sh --purge   # also delete the state directory and the project's volume
#   scripts/runner-link/staging-down.sh --rmi     # also delete the images the stack built
#
# It reads the same ORBIT_LINK_STAGING_PROJECT and ORBIT_LINK_STAGING_DIR as staging-up.sh.
set -euo pipefail
# shellcheck source=staging-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/staging-lib.sh"

purge=0
rmi=0
for arg in "$@"; do
  case "$arg" in
    --purge) purge=1 ;;
    --rmi) rmi=1 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) die "unknown option $arg (see --help)" ;;
  esac
done
lock_state
[ -f "$env_file" ] || die "no staging stack recorded in $state (nothing to stop)"

args=(down --remove-orphans --timeout 100)
[ "$purge" = 1 ] && args+=(--volumes)
[ "$rmi" = 1 ] && args+=(--rmi local)
log "stopping project $project"
# Every profile, so that whatever staging-up.sh started is stopped. The link gateway drains on the way down.
compose --profile runner-link --profile nats "${args[@]}"
if [ "$rmi" = 1 ]; then
  docker image rm "$project-apiserver:local" "$project-link-gateway:local" >/dev/null 2>&1 || true
fi

if [ "$purge" = 1 ]; then
  # The database files belong to the postgres container's user; a container removes what this user may not.
  docker run --rm -v "$state:/state" --entrypoint sh postgres:16-alpine -c 'rm -rf /state/postgres /state/pg-archive'
  rm -rf "$state"
  log "deleted $state"
else
  log "kept $state; staging-up.sh starts the same stack again"
fi
