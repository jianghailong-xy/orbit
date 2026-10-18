#!/bin/sh
# D8 (task 34hXCWEWAgHqtrxZsMBOh): which disk the storage budget is measured on, read inside the D8 test host:
#   docker exec -i d8-dind sh -s < disk_facts.sh
# The filesystems of Docker's data root and of the checkout (data/managed-runners, the channel's state directory);
# how docker-channel runs and what it mounts; the channel's /v1/info; the disk under the probe volume, if there is
# one; and the capacity pool the apiserver derived. Prints no secret.
cd /work/orbit || exit 1
echo "== disk facts at $(date -u +%FT%TZ), checkout $(git rev-parse HEAD)"
echo "-- filesystems: Docker's data root, the checkout and the channel's state directory (bytes)"
for path in "$(docker info -f '{{.DockerRootDir}}')" /work/orbit /work/orbit/data/managed-runners/state; do
  stat -f -c "$path: type=%T blocks=%b blocksize=%S free=%a fsid=%i" "$path"
done
df -B1 -T "$(docker info -f '{{.DockerRootDir}}')" /work/orbit | sed 's/^/  /'
echo "-- docker-channel: its command and mounts"
docker inspect orbit-docker-channel --format 'cmd={{json .Config.Cmd}} image={{.Config.Image}}'
docker inspect orbit-docker-channel --format '{{range .Mounts}}{{.Type}} name={{.Name}} source={{.Source}} -> {{.Destination}} rw={{.RW}}{{println}}{{end}}'
probe="$(docker inspect orbit-docker-channel --format '{{range .Mounts}}{{if eq .Destination "/var/lib/orbit-docker-volumes"}}{{.Name}}{{end}}{{end}}')"
if [ -n "$probe" ]; then
  echo "-- the probe volume $probe: labels, and the filesystem of its mount point on the host"
  docker volume inspect "$probe" --format 'driver={{.Driver}} mountpoint={{.Mountpoint}} labels={{json .Labels}}'
  stat -f -c "%n: type=%T blocks=%b blocksize=%S free=%a fsid=%i" "$(docker volume inspect "$probe" --format '{{.Mountpoint}}')"
  echo "   files in it: $(find "$(docker volume inspect "$probe" --format '{{.Mountpoint}}')" -mindepth 1 | wc -l)"
  echo "-- writing to it from inside docker-channel:"
  docker exec orbit-docker-channel sh -c 'touch /var/lib/orbit-docker-volumes/x 2>&1; echo "exit=$?"; grep " /var/lib/orbit-docker-volumes " /proc/mounts'
else
  echo "-- no probe volume mounted in docker-channel"
fi
echo "-- the channel's /v1/info (host and limits)"
python3 /kit/chan.py GET /v1/info
echo "-- the capacity pool the apiserver derived (bytes), if it has one yet"
docker exec orbit-postgres psql -U orbit -d orbit -AtF ' | ' -c "select 'storage_usable_bytes=' || storage_usable_bytes, 'storage_headroom_bytes=' || storage_headroom_bytes, 'pods=' || pods, 'durable_bytes_reserved=' || durable_bytes_reserved, 'updated_at=' || updated_at from managed_runner_capacity"
echo "-- docker-channel's log lines about the disk, the cap and /tmp"
docker logs orbit-docker-channel 2>&1 | grep -E 'containers of this instance|disk probe|data root|TmpfsOptions|serving on' | tail -n 8
