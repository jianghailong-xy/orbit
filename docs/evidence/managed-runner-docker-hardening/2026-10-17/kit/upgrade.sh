#!/bin/bash
# One /upgrade of the D8 test host's deployment, inside it in /work/orbit, as the default path runs it:
#   upgrade.sh <label> <branch in /repo.git> [<the /upgrade script, relative to the checkout>]
# Moves the checkout to the branch (kit/checkout.sh) and runs the script with no flags (the branch is not main, so it
# does not pull), every `docker` call it makes logged (kit/docker-shim.sh) to /evidence/docker-calls-<label>.log.
set -euo pipefail
LABEL="$1"; BRANCH="$2"; SCRIPT="${3:-.claude/skills/upgrade/upgrade.sh}"
mkdir -p /usr/local/d8-shim && cp /kit/docker-shim.sh /usr/local/d8-shim/docker && chmod 0755 /usr/local/d8-shim/docker
bash /kit/checkout.sh "$BRANCH"
cd /work/orbit
echo "+ $(date -u +%FT%TZ) $SCRIPT (no flags) at $(git rev-parse HEAD)"
start=$(date +%s)
set +e
PATH=/usr/local/d8-shim:$PATH D8_DOCKER_LOG=/evidence/docker-calls-$LABEL.log "./$SCRIPT"
rc=$?
set -e
echo "+ $(date -u +%FT%TZ) upgrade exit=$rc after $(( $(date +%s) - start )) s"
exit $rc
