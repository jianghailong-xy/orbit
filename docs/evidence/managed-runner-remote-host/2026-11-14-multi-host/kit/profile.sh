#!/usr/bin/env bash
# profile.sh [--no-recreate] <host>...: the server's data/managed-runners/profile.json with these entries in
# docker.hosts, in this order; a host is `a` or `b`, `a:draining` marks it draining. Then the apiserver recreated
# (the profile is read at boot), as the design's "add its entry to docker.hosts, recreate the apiserver". Prints the
# profile's docker.hosts and the apiserver's line naming its hosts. No secret is printed (the profile holds token paths).
set -euo pipefail
source /mnt/data/tmp/34w2jFb/kit/env.sh
source $K/tunnels.env
recreate=1
[ "${1:-}" = --no-recreate ] && { recreate=0; shift; }
entries=()
for spec in "$@"; do
  h=${spec%%:*} flag=${spec#*:}; [ "$flag" = "$spec" ] && flag=""
  case $h in a) inst=$INST_A ip=$CHAN_A_IP ;; b) inst=$INST_B ip=$CHAN_B_IP ;; *) echo "a or b" >&2; exit 2 ;; esac
  d=""; [ "$flag" = draining ] && d=', "draining": true'
  entries+=("      { \"instanceId\": \"$inst\", \"channel\": { \"url\": \"http://$ip:$CHAN_PORT\" }, \"tokenFile\": \"/var/lib/orbit-managed-runners/$inst.token\"$d }")
done
hosts=$(IFS=$'\n'; printf '%s' "${entries[*]}" | sed '$!s/$/,/')
docker exec -i -w /work/orbit "$SERVER" sh -c "umask 077 && cat > data/managed-runners/profile.json" <<J
{
  "schemaVersion": 1,
  "valueKind": "actual",
  "backend": "docker",
  "environmentId": "mrmh-lab",
  "clusterKey": "mrmh-lab",
  "resourceProfileId": "docker-default",
  "docker": {
    "hosts": [
$hosts
    ]
  },
  "storage": { "capacity": "5Gi" },
  "runner": {
    "image": "channel",
    "serverUrl": "$SERVER_URL",
    "maxConcurrent": 2,
    "tmpSizeLimit": "512Mi",
    "resources": { "cpu": "1", "memory": "2Gi", "pids": 4096 }
  },
  "lifecycle": {
    "maxAttempts": 5, "backoffBaseSeconds": 10, "backoffMaxSeconds": 300, "startupDeadlineSeconds": 1800,
    "requestTimeoutSeconds": 60, "leaseSeconds": 60, "pollIntervalSeconds": 5, "heartbeatFreshSeconds": 120,
    "idleSeconds": 3600, "capacityRetrySeconds": 60, "drainSeconds": 600
  }
}
J
echo "==> $(date -u +%FT%TZ) profile.json docker.hosts:"
docker exec -w /work/orbit "$SERVER" jq -c '.docker.hosts[]' data/managed-runners/profile.json
if [ $recreate = 1 ]; then
  echo "==> $(date -u +%FT%TZ) recreating the apiserver to read it"
  docker exec -w /work/orbit "$SERVER" docker compose up -d --no-build --no-deps --force-recreate --wait --wait-timeout 300 apiserver 2>&1 | tail -2
  docker exec -w /work/orbit "$SERVER" sh -c 'docker compose logs --since 5m apiserver 2>&1 | sed "s/\x1b\[[0-9;]*m//g" | grep -E "managed runners are" | tail -1'
fi
