#!/bin/bash
# The capture inside a private network namespace: on this host Chromium aborts loads with
# ERR_NETWORK_CHANGED whenever a docker veth comes or goes, and the app is served on loopback only.
# usage: unshare -n docs/evidence/landing-observation/web/rig/run-ns.sh [scene-theme ...]
set -e
ip link set lo up
HERE="$(cd "$(dirname "$0")" && pwd)"
exec node "$HERE/capture.mjs" "$@"
