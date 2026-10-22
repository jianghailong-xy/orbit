#!/bin/bash
# One upgrade of a D6 test host's deployment, run inside its dind in /work/orbit:
#   upgrade.sh <label> <commit to deploy> [<path of the /upgrade script to run, relative to the checkout>]
# Checks out <commit> on a local branch d6-<label>, adds the one-line runner source change every D6 upgrade
# carries (a commit made here only, never pushed), and runs /upgrade's script as the default path runs it — no
# flags; the branch is not main, so it does not pull — with every `docker` call it makes logged
# (kit/docker-shim.sh) to evidence/docker-calls-<label>.log.
set -euo pipefail
LABEL="$1"; COMMIT="$2"; SCRIPT="${3:-.claude/skills/upgrade/upgrade.sh}"
cd /work/orbit
export GIT_AUTHOR_NAME=d6-test GIT_AUTHOR_EMAIL=d6-test@example.invalid GIT_COMMITTER_NAME=d6-test GIT_COMMITTER_EMAIL=d6-test@example.invalid
git checkout -q -B "d6-$LABEL" "$COMMIT"
# The runner source change: a marker line in the runner's main package.
printf '\n// D6 isolated upgrade test (%s): a runner source change, committed in this test checkout only.\n' "$LABEL" >>src/runner-go/main.go
git commit -q -am "test(d6): runner source change for the $LABEL upgrade"
echo "+ $(date -u +%FT%TZ) deploying $(git rev-parse HEAD) ($(git symbolic-ref --short HEAD)), $COMMIT plus the runner source change"
git show --stat --format='  %h %s' HEAD | sed 's/^/  /'
echo "+ $SCRIPT (no flags)"
start=$(date +%s)
set +e
PATH=/usr/local/d6-shim:$PATH D6_DOCKER_LOG=/work/evidence/docker-calls-$LABEL.log "./$SCRIPT"
rc=$?
set -e
echo "+ $(date -u +%FT%TZ) upgrade exit=$rc after $(( $(date +%s) - start )) s"
exit $rc
