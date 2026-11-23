#!/bin/bash
# The alloy service's entrypoint (docker-compose.yml): the loop that lists this project's log files (log-targets.sh), in
# the background, then Alloy itself in this shell's place. ORBIT_COMPOSE_PROJECT is the Compose project's name, which
# Compose fills in; without it nothing could be told apart, so the container refuses to start. Its storage is the
# alloy-data volume at /alloy-data, which root owns: the image's own /var/lib/alloy belongs to its alloy user, and root
# without capabilities cannot enter it.
set -eu
[ -n "${ORBIT_COMPOSE_PROJECT:-}" ] || { echo "ORBIT_COMPOSE_PROJECT is not set" >&2; exit 1; }
targets=/run/orbit-alloy/targets.json
echo '[]' > "$targets"
/bin/bash /etc/orbit-alloy/log-targets.sh "$ORBIT_COMPOSE_PROJECT" "$targets" &
exec /bin/alloy run /etc/orbit-alloy/config.alloy --storage.path=/alloy-data \
  --server.http.listen-addr=127.0.0.1:12345 --disable-reporting
