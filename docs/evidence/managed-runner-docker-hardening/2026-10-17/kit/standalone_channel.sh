#!/bin/bash
# D8: the channel at the checkout's commit, run on its own inside the D8 test host, as a host-level channel runs
# (README "Configuration and running"): its own instance label, ICC-off network, token, state and socket under
# /work/d8-standalone, the managed runner image already on the test host, limits.maxContainers 1. It makes one
# runner container, refuses a second, shows that container's /tmp, refuses a volume removal, then removes
# everything it made by UID and stops.
#   docker exec d8-dind bash /kit/standalone_channel.sh </dev/null
# The runner in the container finds no apiserver at its address and keeps trying: only the template is under test.
# Prints no secret: the token stays in its 0600 file, and credentials are shown by length (chan.py's rule).
set -u
cd /work/orbit
S=/work/d8-standalone
INSTANCE=d8-standalone
IMAGE="$(docker image inspect -f '{{.Id}}' orbit-managed-runner:local)"
rm -rf "$S" && mkdir -p "$S" && chmod 700 "$S"
( umask 077 && openssl rand -hex 32 >"$S/token" )
docker network create --driver bridge --opt com.docker.network.bridge.enable_icc=false orbit-mr-d8-standalone >/dev/null
GATEWAY="$(docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}' orbit-mr-d8-standalone | tr ' ' '\n' | grep -m1 '\.')"
cat >"$S/channel.json" <<EOF
{
  "schemaVersion": 1,
  "instanceId": "$INSTANCE",
  "listen": { "unixSocket": "$S/channel.sock" },
  "tokenFile": "$S/token",
  "dockerSocket": "/var/run/docker.sock",
  "stateDir": "$S/state",
  "image": "$IMAGE",
  "network": "orbit-mr-d8-standalone",
  "limits": { "maxCpuMillis": 1000, "maxMemoryBytes": 1073741824, "maxPids": 512, "maxTmpBytes": 268435456,
              "maxVolumeBytes": 1073741824, "maxConcurrent": 1, "maxContainers": 1 },
  "stopGraceSeconds": 10,
  "diskCheckSeconds": 60,
  "extraLabels": { "orbit.test": "d8-34hXCWEWAgHqtrxZsMBOh" }
}
EOF
chmod 600 "$S/channel.json"
echo "== $(date -u +%FT%TZ) channel.py at $(git rev-parse HEAD) (sha256 $(sha256sum deploy/managed-runner/docker-channel/channel.py | cut -c1-16)…), image $IMAGE"
python3 -I deploy/managed-runner/docker-channel/channel.py serve --config "$S/channel.json" 2>"$S/channel-log.txt" &
CHANNEL=$!
for _ in $(seq 1 50); do [ -S "$S/channel.sock" ] && break; sleep 0.2; done
call() {  # chan.py against this instance's socket and token
  python3 - "$S" "$@" <<'PY'
import http.client, json, socket, sys
S, method, path = sys.argv[1], sys.argv[2], sys.argv[3]
body = sys.argv[4].encode() if len(sys.argv) > 4 else None
class U(http.client.HTTPConnection):
    def __init__(self): super().__init__("localhost", timeout=120)
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX); self.sock.connect(f"{S}/channel.sock")
c = U(); c.request(method, path, body=body, headers={"Authorization": "Bearer " + open(f"{S}/token").read().strip(),
                                                     **({"Content-Type": "application/json"} if body else {})})
r = c.getresponse(); data = r.read(); answer = json.loads(data) if data else None
def redact(v):
    if isinstance(v, dict): return {k: (f"<{len(x)} characters>" if k == "token" and isinstance(x, str) else redact(x)) for k, x in v.items()}
    return [redact(x) for x in v] if isinstance(v, list) else v
print(json.dumps({"request": f"{method} {path}", "status": r.status, "body": redact(answer)}, sort_keys=True))
PY
}
field() { python3 -c 'import json,sys; v=json.loads(sys.stdin.read()); [v := v[k] for k in sys.argv[1:]]; print(v)' "$@"; }
runner_request() {  # $1 runner, $2 owner, $3 volume uid
  printf '{"name": "mr-%s", "image": "%s", "ownerId": "%s", "runnerId": "%s", "generation": 1, "volume": {"name": "mr-data-%s", "uid": "%s"}, "resources": {"cpuMillis": 500, "memoryBytes": 536870912, "pids": 256, "tmpBytes": 67108864}, "runner": {"serverUrl": "http://%s:2086", "maxConcurrent": 1}}' \
    "$1" "$IMAGE" "$2" "$1" "$1" "$3" "$GATEWAY"
}
echo "-- /v1/info: limits and the disk (this channel runs in the test host's own namespace: it sees Docker's data root)"
call GET /v1/info | python3 -c 'import json,sys; b=json.load(sys.stdin)["body"]; print(json.dumps({"limits": b["limits"], "allowVolumeRemoval": b["allowVolumeRemoval"], "disk": b["host"]["disk"]}))'
OWNER=$(python3 -c 'import uuid; print(uuid.uuid4())')
for n in 1 2; do
  R=$(python3 -c 'import uuid; print(uuid.uuid4())')
  VUID=$(call PUT "/v1/volumes/mr-data-$R" "{\"ownerId\": \"$OWNER\", \"runnerId\": \"$R\", \"limitBytes\": 268435456}" | field body uid)
  call PUT "/v1/credentials/$R" "{\"ownerId\": \"$OWNER\", \"generation\": 1, \"token\": \"$(openssl rand -hex 24)\"}" >/dev/null
  echo "-- container $n (runner $R)"
  call POST /v1/containers "$(runner_request "$R" "$OWNER" "$VUID")" | python3 -c 'import json,sys; a=json.load(sys.stdin); b=a["body"]; print(a["status"], b.get("code") or "", b.get("message") or "", b.get("status") or "")'
  eval "R$n=$R V$n=$VUID"
done
echo "-- the first container's /tmp, as its user"
docker exec "mr-$R1" sh -c 'grep " /tmp " /proc/mounts; cp /bin/true /tmp/d8-true && /tmp/d8-true; echo "a program run from /tmp: exit=$?"; rm -f /tmp/d8-true'
docker inspect "mr-$R1" --format 'TmpfsOptions: {{range .HostConfig.Mounts}}{{if eq .Type "tmpfs"}}{{json .TmpfsOptions}}{{end}}{{end}}'
echo "-- removal is off"
call DELETE "/v1/volumes/mr-data-$R2?uid=$V2"
echo "-- every container on the test host now: $(docker ps -a --format '{{.Names}}:{{.State}}' | tr '\n' ' ')"
echo "-- cleaning up by UID: the container stopped and removed through the channel, then the volumes and network directly"
U1=$(call GET "/v1/containers/mr-$R1" | field body uid)
call POST "/v1/containers/mr-$R1/stop?uid=$U1" | python3 -c 'import json,sys; a=json.load(sys.stdin); print(a["request"], a["status"])'
for _ in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Status}}' "mr-$R1")" = exited ] && break; sleep 1; done
call DELETE "/v1/containers/mr-$R1?uid=$U1" | python3 -c 'import json,sys; a=json.load(sys.stdin); print(a["request"], a["status"])'
kill "$CHANNEL"; wait "$CHANNEL" 2>/dev/null
docker volume rm "mr-data-$R1" "mr-data-$R2" >/dev/null && echo "volumes removed (an operator's docker volume rm, with the channel stopped)"
docker network rm orbit-mr-d8-standalone >/dev/null && echo "network removed"
echo "-- the channel's own log"
sed 's/^/   /' "$S/channel-log.txt"
rm -rf "$S"
echo "-- left on the test host: containers [$(docker ps -aq | wc -l)], volumes [$(docker volume ls -q | wc -l)], networks: $(docker network ls --format '{{.Name}}' | tr '\n' ' ')"
