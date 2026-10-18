#!/bin/sh
# ExecStop of orbit-lab-rbd-release.service, installed as /usr/local/sbin/orbit-lab-release-rbd.
# Runs after k3s has stopped and before Ceph stops. k3s leaves Pod containers running when its
# service stops (KillMode=process); a kernel RBD mount still held at that point blocks shutdown
# once the OSDs are gone. So: stop the containers, unmount every RBD filesystem, unmap the devices.
K3S_DATA_DIR=/var/lib/rancher/k3s

children() { ps -e -o ppid= -o pid= | awk -v parent="$1" '$1 == parent {print $2}'; }
descendants() {
  for pid in "$@"; do
    echo "$pid"
    # shellcheck disable=SC2046
    descendants $(children "$pid")
  done
}
shims=$(ps -e -o pid= -o args= | awk -v dir="$K3S_DATA_DIR/data/" 'index($2, dir) == 1 && $2 ~ /containerd-shim/ {print $1}')
if [ -n "$shims" ]; then
  containers=$(for shim in $shims; do children "$shim"; done)
  echo "stopping the containers of $(echo "$shims" | wc -w) containerd shims"
  # shellcheck disable=SC2046
  [ -n "$containers" ] && kill -TERM $(descendants $containers) 2>/dev/null
  waited=0
  while [ "$waited" -lt 15 ] && [ -n "$(for shim in $shims; do children "$shim"; done)" ]; do
    sleep 1
    waited=$((waited + 1))
  done
  # shellcheck disable=SC2046
  kill -KILL $(descendants $shims) 2>/dev/null
  sleep 1
fi

# Deepest mount first; bind mounts of an RBD filesystem show the same /dev/rbdN source.
findmnt -rn -o TARGET,SOURCE | awk '$2 ~ /^\/dev\/rbd[0-9]+/ {print $1}' | sort -r | while read -r target; do
  if umount "$target"; then echo "unmounted $target"; else echo "could not unmount $target"; fi
done
for device in /sys/bus/rbd/devices/*; do
  [ -e "$device" ] || continue
  id=${device##*/}
  if echo "$id" > /sys/bus/rbd/remove_single_major 2>/dev/null || echo "$id" > /sys/bus/rbd/remove 2>/dev/null; then
    echo "unmapped rbd$id"
  else
    echo "could not unmap rbd$id"
  fi
done
exit 0
