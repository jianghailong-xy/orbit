#!/bin/sh
# Inside the D8 test host: with /usr/local/d8-shim first on PATH, every `docker` call is appended, with its time, to
# $D8_DOCKER_LOG (one line, the arguments as given) before the real docker runs it. D6's shim, renamed.
# Compose's own calls to the engine are API requests, not `docker` processes, so they are not listed.
if [ -n "${D8_DOCKER_LOG:-}" ]; then
  printf '%s\t%s\n' "$(date -u +%H:%M:%S)" "$*" >>"$D8_DOCKER_LOG"
fi
exec /usr/local/bin/docker "$@"
