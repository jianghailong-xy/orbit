#!/usr/bin/env bash
# OrbitKit's Swift tests on one commit: bash orbitkit-run.sh <commit> <scratch dir>
# Its copy-parity and wiring tests read web sources (ShareModal.tsx, TaskDetailPanel.tsx, ...) as
# text. The commit is copied with `git archive` (tracked files only; docs/evidence/base-ui-migration,
# which no Swift test reads, is left out) and tested in the swift:6.1 image, as client.yml's OrbitKit
# step does on Linux. Prints the full `swift test` output and exits with its status.
set -u
commit=$(git rev-parse "${1:?commit}")
dir=${2:?scratch dir}
rm -rf "$dir" && mkdir -p "$dir"
git archive "$commit" -- . ':(exclude)docs/evidence/base-ui-migration' | tar -x -C "$dir"
echo "commit $commit"
docker run --rm --memory=8g -v "$dir:/w" -w /w/src/macos/OrbitKit swift:6.1 swift test --scratch-path /w/.swift-build 2>&1
status=$?
rm -rf "$dir"
exit $status
