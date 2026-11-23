#!/bin/bash
# Before (the committed tree), then after (prototype.patch applied), then the tree put back.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
TREE=$(cd "$HERE/../../../.." && pwd)
unshare -n "$HERE/run.sh" "$TREE" /var/tmp/session-phase-mock/before
git -C "$TREE" apply "$HERE/../prototype.patch"
trap 'git -C "$TREE" apply -R "$HERE/../prototype.patch"' EXIT
unshare -n "$HERE/run.sh" "$TREE" /var/tmp/session-phase-mock/after
