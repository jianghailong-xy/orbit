#!/usr/bin/env bash
# drill.sh before|upgrade <sha>|after: the upgrade drill on channel machine B. `before`/`after` print what the drill is
# judged by: B's channel.json image, its /v1/info image asked from the server machine, the apiserver container's start
# time and the profile's digest (both must not move), and B's runner containers with their images. No token is printed.
set -euo pipefail
source /mnt/data/tmp/34w2jFb/kit/env.sh
look() {
  echo "--- $(date -u +%FT%TZ) $1"
  echo "B channel.json image: $(docker exec $CHAN_B jq -r .image /work/orbit/data/channel-host/channel.json)"
  echo "B checkout: $(docker exec $CHAN_B git -C /work/orbit rev-parse HEAD)"
  echo "B /v1/info from the server machine: $(docker exec $SERVER sh -c "curl -s -H \"Authorization: Bearer \$(cat /work/orbit/data/managed-runners/$INST_B.token)\" http://$CHAN_B_IP:$CHAN_PORT/v1/info" | jq -c '{instanceId, image}')"
  echo "A /v1/info from the server machine: $(docker exec $SERVER sh -c "curl -s -H \"Authorization: Bearer \$(cat /work/orbit/data/managed-runners/$INST_A.token)\" http://$CHAN_A_IP:$CHAN_PORT/v1/info" | jq -c '{instanceId, image}')"
  echo "apiserver container started at: $(docker exec $SERVER docker inspect -f '{{.State.StartedAt}} image {{.Image}}' orbit-apiserver)"
  echo "profile.json sha256: $(docker exec -w /work/orbit $SERVER sha256sum data/managed-runners/profile.json | cut -c1-16), runner.image $(docker exec -w /work/orbit $SERVER jq -c .runner.image data/managed-runners/profile.json)"
  echo "B services: $(docker exec $CHAN_B docker ps --filter name=orbit-docker-channel --filter name=orbit-managed-runner-firewall --format '{{.Names}} {{.Status}}' | tr '\n' ';')"
  echo "B runner containers:"; docker exec $CHAN_B docker ps -a --filter label=orbit.managed-runner.kind=runner --format '  {{.Names}} gen={{.Label "orbit.managed-runner.generation"}} image={{.Image}} {{.Status}}'
}
case $1 in
  before|after) look "$1" ;;
  upgrade) echo "==> $(date -u +%FT%TZ) deploy/managed-runner/remote-host/remote-host.sh upgrade $2 on $CHAN_B"
    docker exec -w /work/orbit $CHAN_B deploy/managed-runner/remote-host/remote-host.sh upgrade "$2"; echo "upgrade exit $?" ;;
esac
