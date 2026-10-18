#!/bin/bash
# Back up, check, restore and verify one managed runner's data volume on a deployment whose managed runners run on
# its own Docker (docs/managed-runner-docker-operations.md). Run it as root from the deployment's checkout.
#
#   scripts/managed-runner/volume-backup.sh backup  <volume> <directory>
#   scripts/managed-runner/volume-backup.sh check   <volume> <directory>
#   scripts/managed-runner/volume-backup.sh restore <volume> <directory>
#   scripts/managed-runner/volume-backup.sh verify  <volume>
#
# <volume> is a runner's data volume, mr-data-<runner uuid>; <directory> holds its backup:
#   <volume>.tar.gz        the volume's files, numeric owners and modes kept
#   <volume>.sha256        the checksum of every file, taken at the backup
#   <volume>.labels        the volume's labels: the manager accepts a volume only with the UID, owner and runner it recorded
#   <volume>.volume.json   docker volume inspect, for the record
#
# backup:  only while no container refers to the volume, which is while its runner sleeps.
# check:   unpacks the archive into a scratch volume, compares every checksum, inspects it (below) and removes it.
#          Nothing of the runner's is touched.
# restore: recreates a volume that is gone, with its labels, unpacks the archive into it, compares and inspects it.
#          It never writes into a volume that exists: remove that one first, knowingly.
# verify:  inspects a volume where it is, as after a host lost power, while no running container refers to it.
#
# To inspect is to run PRAGMA integrity_check on every SQLite file and git fsck on every repository, as the runner's
# user (10001), with the volume where the runner mounts it: what SQLite creates beside a database (its -shm) is then
# the runner's, and a worktree's absolute paths resolve. A SQLite database in WAL mode cannot be opened on a
# read-only volume, so a backup, which reads the volume read-only, leaves that to check.
# Each step runs a throwaway container of the managed runner image that data/managed-runners/channel.json names, with
# no network; archiving and unpacking run as root inside it, so that every file can be read and every owner restored.
set -euo pipefail

die() { echo "volume-backup.sh: $*" >&2; exit 1; }

ACTION="${1:-}"; V="${2:-}"; DIR="${3:-}"
case "$ACTION" in backup|check|restore|verify) ;; *) die "usage: volume-backup.sh backup|check|restore <volume> <directory>, or verify <volume>" ;; esac
[[ "$V" =~ ^mr-data-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] \
  || die "$V is not a managed runner's data volume (mr-data-<runner uuid>)"
[ "$ACTION" = verify ] || [ -n "$DIR" ] || die "name the backup directory"
IMAGE="$(sed -n 's/.*"image": *"\(sha256:[0-9a-f]*\)".*/\1/p' data/managed-runners/channel.json 2>/dev/null || true)"
[[ "$IMAGE" =~ ^sha256:[0-9a-f]{64}$ ]] || die "no managed runner image in data/managed-runners/channel.json: run this from the deployment's checkout"

# What the throwaway containers run, from standard input: $1 is the volume's name, /backup the directory.
ARCHIVE="set -eu
cd /data
find . -type f -print0 | sort -z | xargs -0 -r sha256sum > \"/backup/\$1.sha256\"
tar --numeric-owner -czpf \"/backup/\$1.tar.gz\" .
echo \"archived \$(wc -l < \"/backup/\$1.sha256\") files\""
UNPACK="set -eu
cd /data
[ -z \"\$(ls -A)\" ] || { echo 'the volume is not empty'; exit 3; }
tar --numeric-owner -xzpf \"/backup/\$1.tar.gz\"
find . -type f -print0 | sort -z | xargs -0 -r sha256sum > /tmp/restored.sha256
if cmp -s /tmp/restored.sha256 \"/backup/\$1.sha256\"; then
  echo \"checksums: all \$(wc -l < /tmp/restored.sha256) files match the backup\"
else
  echo 'checksums: DIFFERENT from the backup'; diff /tmp/restored.sha256 \"/backup/\$1.sha256\" | head -n 20; exit 4
fi
stat -c 'volume root: owner %u:%g, mode %a' /data"
# One line per SQLite file and per repository, its result or the error; anything but ok fails.
INSPECT="set -eu
cd /var/lib/orbit
find . -type f \\( -name '*.sqlite' -o -name '*.sqlite3' -o -name '*.db' \\) -print0 | sort -z |
  xargs -0 -r sh -c 'for f; do printf \"sqlite %s: %s\\n\" \"\$f\" \"\$(sqlite3 -readonly \"\$f\" \"pragma integrity_check\" 2>&1 | tr \"\\n\" \" \" | sed \"s/ *\$//\")\"; done' sh > /tmp/inspect.txt
find . -name .git -type d -prune -print0 | sort -z |
  xargs -0 -r sh -c 'for g; do r=\$(dirname \"\$g\"); if out=\$(git -C \"\$r\" fsck --no-progress --no-dangling 2>&1); then echo \"git \$r: ok\"; else echo \"git \$r: \$(printf %s \"\$out\" | tr \"\\n\" \" \")\"; fi; done' sh >> /tmp/inspect.txt
cat /tmp/inspect.txt
if grep -qv ': ok\$' /tmp/inspect.txt; then echo 'inspect: something is not ok'; exit 5; fi
echo \"inspect: \$(grep -c '^sqlite ' /tmp/inspect.txt || true) SQLite files and \$(grep -c '^git ' /tmp/inspect.txt || true) repositories ok\""

helper() {  # helper <volume> <ro|rw> <user> <mount point> <script>
  local backup=()
  [ -z "$DIR" ] || backup=(-v "$DIR:/backup:$([ "$2" = ro ] && echo rw || echo ro)")
  docker run --rm -i --network none --user "$3" -v "$1:$4:$2" ${backup[@]+"${backup[@]}"} --entrypoint sh "$IMAGE" -s "$V" <<<"$5"
}

case "$ACTION" in
backup)
  docker volume inspect "$V" >/dev/null 2>&1 || die "there is no volume $V"
  [ -z "$(docker ps -aq --filter "volume=$V")" ] || die "a container still refers to $V: back it up while its runner sleeps"
  labels="$(docker volume inspect -f '{{range $k, $v := .Labels}}--label {{$k}}={{$v}} {{end}}' "$V")"
  [[ "$labels" == *"--label orbit.managed-runner.kind=data "* ]] || die "$V does not carry a managed runner's data labels"
  # shellcheck disable=SC2086 # split on purpose: a restore passes these words to docker volume create
  set -- $labels
  [ "$#" -eq $((2 * $(docker volume inspect -f '{{len .Labels}}' "$V"))) ] || die "a label of $V holds a space; save its labels by hand"
  mkdir -p -m 700 "$DIR"
  printf '%s\n' "$labels" >"$DIR/$V.labels"
  docker volume inspect "$V" >"$DIR/$V.volume.json"
  helper "$V" ro 0:0 /data "$ARCHIVE"
  ;;
check)
  for f in tar.gz sha256 labels; do [ -s "$DIR/$V.$f" ] || die "$DIR/$V.$f is missing"; done
  scratch="orbit-restore-check-$(date -u +%Y%m%d%H%M%S)-$$"
  docker volume create "$scratch" >/dev/null
  trap 'docker volume rm "$scratch" >/dev/null' EXIT
  helper "$scratch" rw 0:0 /data "$UNPACK"
  helper "$scratch" rw 10001:10001 /var/lib/orbit "$INSPECT"
  ;;
restore)
  for f in tar.gz sha256 labels; do [ -s "$DIR/$V.$f" ] || die "$DIR/$V.$f is missing"; done
  ! docker volume inspect "$V" >/dev/null 2>&1 || die "$V exists: restore never writes into a volume that is there. Remove it first (docker volume rm $V) if it is the one to replace."
  # shellcheck disable=SC2046 # the labels file is a list of --label key=value arguments
  docker volume create $(cat "$DIR/$V.labels") "$V" >/dev/null
  helper "$V" rw 0:0 /data "$UNPACK"
  helper "$V" rw 10001:10001 /var/lib/orbit "$INSPECT"
  ;;
verify)
  docker volume inspect "$V" >/dev/null 2>&1 || die "there is no volume $V"
  [ -z "$(docker ps -q --filter "volume=$V")" ] || die "a running container uses $V: verify it while its runner is down"
  helper "$V" rw 10001:10001 /var/lib/orbit "$INSPECT"
  ;;
esac
