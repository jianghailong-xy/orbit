#!/usr/bin/env bash
# Boot the lab VM as its own transient systemd service, outside the Orbit runner's cgroup.
# Refuses to boot when the host's MemAvailable is below LAB_MIN_AVAILABLE_MIB.
# Usage: start.sh [--no-wait]   (by default waits for SSH, k3s, Ceph and the CSI driver)
set -euo pipefail
. "$(dirname "$0")/lib.sh"

wait=1
case "${1:-}" in
  --no-wait) wait=0 ;;
  "") ;;
  *) die "usage: start.sh [--no-wait]" ;;
esac
require_root

if vm_running; then
  say "$LAB_UNIT is already running"
  unit_memory_report
  exit 0
fi
for file in disks/root.qcow2 seed/seed.iso ssh/id_ed25519; do
  [ -e "$LAB_DIR/$file" ] || die "missing $LAB_DIR/$file: run create.sh first"
done
for index in $(seq 0 $(( LAB_OSD_COUNT - 1 ))); do
  [ -e "$LAB_DIR/disks/osd-$index.qcow2" ] || die "missing $LAB_DIR/disks/osd-$index.qcow2: run create.sh first"
done
[ -w /dev/kvm ] || die "/dev/kvm is not usable"
for port in "$LAB_SSH_PORT" "$LAB_API_PORT"; do
  if ss -Hltn "sport = :$port" | grep -q .; then die "127.0.0.1:$port is already taken on the host"; fi
done

# The memory guard. The VM may grow to LAB_MEMORY_MIB; booting it into an already short host
# pushes everyone into swap, and an OOM kill inside the runner's cgroup stops the whole runner.
available=$(mem_available_mib)
if [ "$available" -lt "$LAB_MIN_AVAILABLE_MIB" ]; then
  say "refused: host MemAvailable is ${available} MiB, below the ${LAB_MIN_AVAILABLE_MIB} MiB floor."
  say "The VM can take up to ${LAB_MEMORY_MIB} MiB of guest RAM. Wait until other work on this host"
  say "has finished (free -m, systemd-cgtop), then try again."
  exit 3
fi
say "host MemAvailable ${available} MiB (floor ${LAB_MIN_AVAILABLE_MIB} MiB): booting"
mkdir -p "$LAB_DIR/run" "$LAB_DIR/logs" "$LAB_DIR/state"
rm -f "$LAB_QMP" "$LAB_DIR/run/qemu.pid"

drives=()
add_drive() {  # add_drive <id> <file> <serial>
  drives+=(-drive "if=none,id=$1,file=$2,format=qcow2,cache=none,aio=native,discard=unmap,detect-zeroes=unmap"
           -device "virtio-blk-pci,drive=$1,serial=$3")
}
add_drive root "$LAB_DIR/disks/root.qcow2" orbit-root
for index in $(seq 0 $(( LAB_OSD_COUNT - 1 ))); do
  add_drive "osd$index" "$LAB_DIR/disks/osd-$index.qcow2" "orbit-osd-$index"
done

# --collect: a failed or finished run leaves no unit behind, so the next start reuses the name.
# OOMScoreAdjust=1000: under host-wide memory pressure the kernel kills the VM first, not the runner.
systemd-run --unit="$LAB_UNIT" --collect --quiet \
  --description="Orbit managed-runner lab VM (k3s, Ceph, Ceph-CSI; test only)" \
  -p MemoryMax="$LAB_UNIT_MEMORY_MAX" -p OOMScoreAdjust=1000 -p CPUQuota=$(( LAB_VCPUS * 100 ))% \
  -p TimeoutStopSec=30 \
  /usr/bin/qemu-system-x86_64 \
    -name "$LAB_NAME,debug-threads=on" \
    -machine q35,accel=kvm -cpu host -smp "$LAB_VCPUS" -m "$LAB_MEMORY_MIB" \
    -nodefaults -display none -vga none \
    -sandbox on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny \
    -chardev "file,id=console,path=$LAB_DIR/logs/console.log,append=on" -serial chardev:console \
    -chardev "socket,id=qmp,path=$LAB_QMP,server=on,wait=off" -mon chardev=qmp,mode=control \
    -pidfile "$LAB_DIR/run/qemu.pid" \
    -device virtio-balloon-pci,id=balloon0,free-page-reporting=on \
    -object rng-random,id=rng0,filename=/dev/urandom -device virtio-rng-pci,rng=rng0 \
    -netdev "user,id=net0,hostfwd=tcp:127.0.0.1:$LAB_SSH_PORT-:22,hostfwd=tcp:127.0.0.1:$LAB_API_PORT-:6443" \
    -device virtio-net-pci,netdev=net0 \
    "${drives[@]}" \
    -drive "if=none,id=seed,file=$LAB_DIR/seed/seed.iso,format=raw,media=cdrom,readonly=on" \
    -device ide-cd,drive=seed

say "started $LAB_UNIT.service (cgroup $(systemctl show -P ControlGroup "$LAB_UNIT.service"))"
printf '%s\t%s\n' "$(date -u +%FT%TZ)" "$available" >> "$LAB_DIR/state/boots.tsv"
wait_for_ssh 600
say "SSH is up: $(lab_ssh uname -r)"
if [ "$wait" -eq 1 ] && [ -f "$LAB_KUBECONFIG" ]; then
  "$LAB_SCRIPTS/status.sh" --wait 900
  # Starting every daemon and container fills the guest's page cache; give it back to the host.
  lab_ssh sudo /opt/orbit-lab/provision.sh trim
  unit_memory_report
fi
