#!/bin/bash
# D8: the runbook's "Delete a runner's volume" (docs/managed-runner-docker-operations.md), step by step with its own
# commands, inside the D8 test host on a sleeping, disabled account's volume:
#   docker exec d8-dind bash /kit/delete-volume-drill.sh <data volume> <its volume_uid> <probe runner> <probe volume uid> </dev/null
# Also removes, in the same window, what kit/d8.py probe-create left (a volume and a credential of a runner nobody has).
# Prints no secret: the token goes to curl on its standard input, as the runbook gives it.
set -u
cd /work/orbit
V="$1"; UID_="$2"; PROBE="$3"; PROBE_UID="$4"
channel() {  # the runbook's curl, with the method and path given
  printf 'header = "Authorization: Bearer %s"\n' "$(cat data/managed-runners/token)" |
    curl -s -X "$1" -w ' HTTP %{http_code}\n' --config - --unix-socket data/managed-runners/channel.sock "http://channel$2"
}
set_removal() {  # an operator's edit: the key added or removed, the file otherwise as it was
  python3 -c 'import json,sys; p="data/managed-runners/channel.json"; c=json.load(open(p))
if sys.argv[1] == "on": c["allowVolumeRemoval"] = True
else: c.pop("allowVolumeRemoval", None)
open(p + ".new", "w").write(json.dumps(c, indent=2) + "\n")' "$1"
  chmod 600 data/managed-runners/channel.json.new && mv data/managed-runners/channel.json.new data/managed-runners/channel.json
  grep -n allowVolumeRemoval data/managed-runners/channel.json || echo "  (no allowVolumeRemoval line)"
}
echo "== $(date -u +%FT%TZ) the drill on $V (volume_uid $UID_), checkout $(git rev-parse HEAD)"
echo "-- 1-2. the account is disabled and its runner sleeps; nothing refers to the volume"
docker compose exec -T postgres psql -U orbit -d orbit -AtF ' | ' -c "
  select u.email, u.disabled_at is not null as disabled, m.management_state, m.desired_state, m.generation, m.pvc_name as volume, m.pvc_uid as volume_uid,
         m.pod_name as container from managed_runner m join \"user\" u on u.id = m.owner_id where m.pvc_name = '$V'"
echo "docker ps -a --filter volume=$V: [$(docker ps -a --filter volume="$V" --format '{{.Names}}')]"
echo "-- 3. a backup first"
mkdir -p /work/backups && B=/work/backups/$(date -u +%Y%m%dT%H%M%SZ)
scripts/managed-runner/volume-backup.sh backup "$V" "$B" 2>&1 | tail -n 3
ls -l "$B" | sed 's/^/   /'
echo "-- removal is off: the channel refuses"
grep -c allowVolumeRemoval data/managed-runners/channel.json | sed 's/^/   allowVolumeRemoval lines in channel.json: /'
channel DELETE "/v1/volumes/$V?uid=$UID_"
docker volume inspect "$V" --format '   the volume is there: {{.Name}} uid={{index .Labels "orbit.managed-runner.uid"}}'
echo "-- 4. removal turned on: the file checked, the channel started on it"
volumes_before="$(docker volume ls -q | sort)"
set_removal on
docker compose run --rm docker-channel check-config --config /var/lib/orbit-managed-runners/channel.json
docker compose up -d --force-recreate docker-channel 2>&1 | tail -n 2
for _ in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' orbit-docker-channel)" = healthy ] && break; sleep 2; done
echo "   docker-channel: $(docker inspect -f '{{.State.Health.Status}}' orbit-docker-channel)"
echo "   volumes the check-config run left behind: [$(comm -13 <(echo "$volumes_before") <(docker volume ls -q | sort) | tr '\n' ' ')]"
echo "-- 5. removed through the channel, by its UID (a wrong UID first)"
channel DELETE "/v1/volumes/$V?uid=00000000-0000-4000-8000-000000000000"
channel DELETE "/v1/volumes/$V?uid=$UID_"
echo "   the probe runner's leftovers (kit/d8.py probe-create):"
PROBE_CRED="$(printf 'header = "Authorization: Bearer %s"\n' "$(cat data/managed-runners/token)" | curl -s --config - --unix-socket data/managed-runners/channel.sock "http://channel/v1/resources" | python3 -c 'import json,sys; r=json.load(sys.stdin); print(next(c["uid"] for c in r["credentials"] if c["runnerId"] == sys.argv[1]))' "$PROBE")"
channel DELETE "/v1/credentials/$PROBE?uid=$PROBE_CRED"
channel DELETE "/v1/volumes/mr-data-$PROBE?uid=$PROBE_UID"
echo "-- 6. removal turned off again"
set_removal off
docker compose run --rm docker-channel check-config --config /var/lib/orbit-managed-runners/channel.json
docker compose up -d --force-recreate docker-channel 2>&1 | tail -n 2
for _ in $(seq 1 30); do [ "$(docker inspect -f '{{.State.Health.Status}}' orbit-docker-channel)" = healthy ] && break; sleep 2; done
echo "   docker-channel: $(docker inspect -f '{{.State.Health.Status}}' orbit-docker-channel)"
channel DELETE "/v1/volumes/mr-data-$PROBE?uid=$PROBE_UID"
echo "-- afterwards"
echo "docker volume inspect $V: $(docker volume inspect "$V" >/dev/null 2>&1 && echo still there || echo gone)"
docker compose exec -T postgres psql -U orbit -d orbit -AtF ' | ' -c "
  select u.email, u.disabled_at is not null as disabled, m.management_state, m.pvc_name, m.pvc_uid from managed_runner m join \"user\" u on u.id = m.owner_id order by u.email"
echo "every volume now: $(docker volume ls -q | tr '\n' ' ')"
