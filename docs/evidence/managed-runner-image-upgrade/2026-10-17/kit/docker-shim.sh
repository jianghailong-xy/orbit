#!/bin/sh
# Inside a D6 test host: put /usr/local/d6-shim first on PATH and every `docker` call is appended, with
# its time, to $D6_DOCKER_LOG (one line, the arguments as given) before the real docker runs it.
# Compose's own calls to the engine are API requests, not `docker` processes, so they are not listed.
if [ -n "${D6_DOCKER_LOG:-}" ]; then
  printf '%s\t%s\n' "$(date -u +%H:%M:%S)" "$*" >>"$D6_DOCKER_LOG"
fi
exec /usr/local/bin/docker "$@"
