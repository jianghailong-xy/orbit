#!/bin/sh
# PID 1 of the D9 test host (task 34iSiGtPrJ0LWSqn17esR). It runs dockerd through the image's own entrypoint, and again
# whenever dockerd exits, so that `pkill dockerd` restarts dockerd alone, as `systemctl restart docker` does on a host,
# while a restart of this container stands for a host reboot: a new network namespace, so every iptables rule is gone.
# Extra dockerd flags (e.g. --userland-proxy=false) are read from /etc/d9/dockerd-flags at every start.
trap 'kill -TERM "$child" 2>/dev/null; wait "$child"; exit 0' TERM INT
while :; do
  flags="$(cat /etc/d9/dockerd-flags 2>/dev/null || true)"
  echo "supervise: starting dockerd at $(date -u +%FT%TZ) with flags: ${flags:-none}" >&2
  # shellcheck disable=SC2086
  dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock $flags &
  child=$!
  wait "$child"
  echo "supervise: dockerd exited ($?) at $(date -u +%FT%TZ)" >&2
  sleep 1
done
