#!/bin/bash
# The alloy service's entrypoint (docker-compose.yml): the loop that lists this project's log files (log-targets.sh), in
# the background, then Alloy itself in this shell's place. ORBIT_COMPOSE_PROJECT is the Compose project's name, which
# Compose fills in; without it nothing could be told apart, so the container refuses to start.
set -eu
[ -n "${ORBIT_COMPOSE_PROJECT:-}" ] || { echo "ORBIT_COMPOSE_PROJECT is not set" >&2; exit 1; }
targets=/run/orbit-alloy/targets.json
echo '[]' > "$targets"
/bin/bash /etc/orbit-alloy/log-targets.sh "$ORBIT_COMPOSE_PROJECT" "$targets" &
exec /bin/alloy run /etc/orbit-alloy/config.alloy --storage.path=/var/lib/alloy/data \
  --server.http.listen-addr=127.0.0.1:12345 --disable-reporting
