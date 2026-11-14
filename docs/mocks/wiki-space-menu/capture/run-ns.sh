#!/bin/bash
# The capture inside a private network namespace: on this host Chromium aborts loads with
# ERR_NETWORK_CHANGED whenever a docker veth comes or goes, and the builds are served on loopback only.
set -e
ip link set lo up
HERE="$(cd "$(dirname "$0")" && pwd)"
exec node "$HERE/${SCRIPT:-capture.mjs}" "$@"
